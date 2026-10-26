"""Repair an explicitly selected area from measured tracks and fixed references.

Input models are copied. Pixels are copied from native tracks or measured marks;
projected polygons are used only to exclude automatic observations.
"""
import copy
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np
import pycolmap as pc

from assisted_geometry import _dlt
from assisted_initialization import clean_tracks


def _pixel(xy):
    return tuple(np.asarray(xy, dtype=np.float32))


def refine_measured_corners(landmarks, catalog, corner_ids):
    """Optionally refine measured corners from nearby real image intensities."""
    result = copy.deepcopy(landmarks); photos = {p['photoId']: p for p in catalog}
    receipt = []; cache = {}
    for point in result:
        if point['id'] not in corner_ids:
            continue
        for obs in point['observations']:
            photo = photos[obs['photoId']]
            if photo['photoId'] not in cache:
                path = photo.get('path')
                gray = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_GRAYSCALE) if path else None
                if gray is None or gray.shape != (photo['height'], photo['width']):
                    raise ValueError('角点细化无法读取匹配尺寸的工作照片。')
                cache[photo['photoId']] = gray
            gray = cache[photo['photoId']]; old = np.asarray(obs['xy'], dtype=float)
            x, y = map(int, np.round(old)); radius = 18
            left = max(0, x-radius); top = max(0, y-radius)
            crop = gray[top:min(gray.shape[0], y+radius+1), left:min(gray.shape[1], x+radius+1)]
            detected = cv2.goodFeaturesToTrack(crop, maxCorners=32, qualityLevel=.01, minDistance=2)
            if detected is None:
                continue
            candidates = detected.reshape(-1, 2) + [left, top]
            initial = candidates[np.argmin(np.linalg.norm(candidates-old, axis=1))].astype(np.float32)
            if min(initial) < 6 or initial[0] >= gray.shape[1]-6 or initial[1] >= gray.shape[0]-6:
                continue
            refined = cv2.cornerSubPix(gray, initial.reshape(1, 1, 2), (5, 5), (-1, -1),
                                      (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_MAX_ITER, 40, .001)).reshape(2)
            shift = float(np.linalg.norm(refined-old))
            if not np.isfinite(refined).all() or shift > 15:
                continue
            obs['xy'] = refined.tolist(); obs['origin'] = 'detected'
            receipt.append({'landmarkId': point['id'], 'photoId': photo['photoId'],
                            'originalXY': old.tolist(), 'refinedXY': refined.tolist(),
                            'source': 'image_corner_detector', 'shiftPx': shift})
    return result, receipt


def validate_local_scope(scope, catalog, landmarks, config):
    allowed = {'photoIds', 'referencePhotoIds', 'contextPhotoIds',
               'refineCornerIds', 'excludedPlanarInteriors'}
    if not isinstance(scope, dict) or set(scope) - allowed:
        raise ValueError('修正范围包含不支持的字段。')
    photos = {p['photoId'] for p in catalog}
    result = {}
    for key in ('photoIds', 'referencePhotoIds', 'contextPhotoIds'):
        values = scope.get(key, [])
        if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
            raise ValueError('照片清单格式错误。')
        if len(values) != len(set(values)) or not set(values) <= photos:
            raise ValueError('修正范围含有重复或未知照片。')
        result[key] = list(values)
    if any(set(result[a]) & set(result[b]) for a, b in
           [('photoIds', 'referencePhotoIds'), ('photoIds', 'contextPhotoIds'),
            ('referencePhotoIds', 'contextPhotoIds')]):
        raise ValueError('修正照片、固定参照和背景照片不能重叠。')
    if min(len(result['photoIds']), len(result['referencePhotoIds'])) < config['minViewsPerSide']:
        raise ValueError('修正范围和固定参照各需要至少两张照片。')
    ids = {p['id'] for p in landmarks}
    corners = scope.get('refineCornerIds', [])
    polygons = scope.get('excludedPlanarInteriors', [])
    if not isinstance(corners, list) or any(not isinstance(v, str) or v not in ids for v in corners) or len(set(corners)) != len(corners):
        raise ValueError('角点清单包含未知或重复的对应点。')
    if not isinstance(polygons, list) or any(not isinstance(q, list) or len(q) != 4 or
            any(not isinstance(v, str) or v not in ids for v in q) or len(set(q)) != 4 for q in polygons):
        raise ValueError('排除区域需要四个不同的已标记角点。')
    result.update(refineCornerIds=list(corners), excludedPlanarInteriors=copy.deepcopy(polygons))
    return result


def _views(model, catalog):
    names = {im.name: im for im in model.images.values()}
    return {p['photoId']: {'camera': model.cameras[names[p['name']].camera_id],
                         'camFromWorld': names[p['name']].cam_from_world().matrix()}
            for p in catalog if p['name'] in names}


class MarkedTargetSupportError(ValueError):
    def __init__(self, photo_id, photo_name, count, config, phase):
        message = (f"已标记照片 {photo_name} 的共同点未通过{phase}检查："
                   f"{count}/{config['minSharedPoints']}。请检查参照视差和对应点。")
        super().__init__(message)
        self.missing = [{'code': 'local_photo_unsupported', 'photoId': photo_id,
                         'sharedPoints': count, 'requiredPoints': config['minSharedPoints'],
                         'phase': phase, 'message': message}]


def _marked_target_requirements(landmarks, targets, references, config, guided_targets=()):
    submitted = defaultdict(set)
    for point in landmarks:
        observed = {o['photoId'] for o in point['observations']}
        if min(len(observed & targets), len(observed & references)) < config['minViewsPerSide']:
            continue
        for photo_id in observed & targets:
            submitted[photo_id].add(point['id'])
    required = {photo_id: len(ids) for photo_id, ids in submitted.items()
                if len(ids) >= config['minSharedPoints'] or photo_id in guided_targets}
    for photo_id in guided_targets:
        required.setdefault(photo_id, 0)
    return required


def _check_marked_target_support(required, support, catalog, config, phase):
    counts = {photo_id: len(support.get(photo_id, set())) for photo_id in required}
    for photo_id, count in counts.items():
        if count < config['minSharedPoints']:
            raise MarkedTargetSupportError(photo_id, catalog[photo_id]['name'], count, config, phase)
    return counts


def _bundle(model, fixed_names, variable_points, image_names=None, iterations=500):
    settings = pc.BundleAdjustmentOptions()
    settings.refine_focal_length = False
    settings.refine_principal_point = False
    settings.refine_extra_params = False
    settings.ceres.solver_options.num_threads = 12
    settings.ceres.solver_options.max_num_iterations = iterations
    settings.ceres.solver_options.function_tolerance = 1e-12
    settings.ceres.loss_function_type = pc.LossFunctionType.HUBER
    checked = pc.BundleAdjustmentConfig()
    for im in model.images.values():
        if image_names is not None and im.name not in image_names:
            continue
        checked.add_image(im.image_id)
        if im.name in fixed_names:
            checked.set_constant_rig_from_world_pose(im.frame_id)
    for point_id in model.points3D:
        if point_id not in variable_points:
            checked.add_constant_point(point_id)
    summary = pc.create_default_bundle_adjuster(settings, checked, model).solve()
    if summary is None or not summary.is_solution_usable():
        raise ValueError('局部联合优化没有可用结果。')
    return str(summary)


def _matching_points(source, seed, outside, config):
    source_images = {im.name: im for im in source.images.values()}
    links = defaultdict(set)
    for im in seed.images.values():
        if im.name not in outside or im.name not in source_images:
            continue
        target = source_images[im.name]
        lookup = defaultdict(set)
        for p in target.points2D:
            if p.has_point3D():
                lookup[_pixel(p.xy)].add(int(p.point3D_id))
        for p in im.points2D:
            if p.has_point3D():
                for other in lookup.get(_pixel(p.xy), []):
                    links[(int(p.point3D_id), other)].add(im.name)
    pairs = []; used_a = set(); used_b = set()
    for count, a, b in sorted(((len(v), a, b) for (a, b), v in links.items()
                              if len(v) >= config['minViewsPerSide']), reverse=True):
        if a in used_a or b in used_b:
            continue
        used_a.add(a); used_b.add(b); pairs.append((a, b))
    return pairs


def _gauge(source, seed, outside, config):
    pairs = _matching_points(source, seed, outside, config)
    if len(pairs) < config['minSharedPoints']:
        raise ValueError('固定参照没有足够的实际轨迹，无法初始化修正范围。')
    a = np.asarray([seed.points3D[i].xyz for i, j in pairs])
    b = np.asarray([source.points3D[j].xyz for i, j in pairs])
    spread = np.median(np.linalg.norm(b - np.median(b, axis=0), axis=1))
    options = pc.RANSACOptions()
    options.max_error = max(spread * .005, 1e-8)
    options.min_inlier_ratio = .05
    options.random_seed = config['seed']
    fit = pc.estimate_sim3d_robust(a, b, options)
    if fit is None:
        raise ValueError('固定参照的坐标初始化失败。')
    return fit['tgt_from_src'] if isinstance(fit, dict) else fit


def _measured_landmarks(landmarks, targets, references, denied_pairs, config):
    selected = []; pixels = set(); ids = set()
    for point in landmarks:
        # Client input accepts manual pixels only. Guided detections are made
        # inside the native job from selected image regions, never projections.
        obs = [copy.deepcopy(o) for o in point['observations']
               if o['photoId'] in targets | references and o.get('origin', 'manual') in ('manual', 'detected')]
        if not any(o['photoId'] in targets for o in obs):
            continue
        photo_ids = [o['photoId'] for o in obs]
        if len(set(photo_ids)) != len(photo_ids) or point['id'] in ids:
            raise ValueError('对应点含有重复观察。')
        # A scoped feature may retain only one of its original observers.
        # Keep its saved pixels, but do not create a one-view native 3D point.
        if len(photo_ids) < 2:
            continue
        if any(pair <= set(photo_ids) for pair in denied_pairs):
            raise ValueError('对应点与用户否定的照片关系冲突。')
        keys = {(o['photoId'], _pixel(o['xy'])) for o in obs}
        if keys & pixels:
            raise ValueError('重复物理像素不能作为新增共同点。')
        pixels.update(keys); ids.add(point['id'])
        selected.append({**copy.deepcopy(point), 'observations': obs})
    shared = [p for p in selected if
              sum(o['photoId'] in targets for o in p['observations']) >= config['minViewsPerSide'] and
              sum(o['photoId'] in references for o in p['observations']) >= config['minViewsPerSide']]
    if len(shared) < config['minSharedPoints']:
        raise ValueError('修正范围与固定参照需要至少 8 个不同的物理共同点。')
    return selected


def _exclusion_masks(seed, catalog, marks, polygons, targets):
    views = _views(seed, catalog); by_id = {p['id']: p for p in marks}
    xyz_polygons = []
    for polygon in polygons:
        corners = [_dlt([o for o in by_id[key]['observations'] if o['photoId'] in targets], views)
                   for key in polygon]
        if any(p is None or not np.isfinite(p).all() for p in corners):
            raise ValueError('排除区域的实际角点没有足够深度依据。')
        xyz_polygons.append(corners)
    result = defaultdict(list)
    for photo_id in targets:
        if photo_id not in views:
            continue
        view = views[photo_id]; pose = view['camFromWorld']
        for polygon in xyz_polygons:
            local = [pose[:, :3] @ xyz + pose[:, 3] for xyz in polygon]
            if any(p[2] <= 0 for p in local):
                continue
            quad = [view['camera'].img_from_cam(p) for p in local]
            if any(p is None or not np.isfinite(p).all() for p in quad):
                continue
            quad = np.asarray(quad, dtype=np.float32)
            if cv2.isContourConvex(quad):
                result[photo_id].append(quad)
    return result


def check_camera_groups(model, catalog, landmarks, scope, config, model_path=None):
    from assisted_reconstruct import verify_final_bridges
    groups = {}
    for photo in catalog:
        if photo['photoId'] in scope['photoIds'] and photo.get('cameraGroup') is not None:
            groups.setdefault(photo['cameraGroup'], []).append(photo['photoId'])
    if len(groups) < 2:
        return []
    if any(len(ids) < config['minViewsPerSide'] for ids in groups.values()):
        raise ValueError('跨相机组检查需要每组至少两张修正照片。')
    request = {'catalog': catalog, 'regions': [{'id': str(key), 'photoIds': ids} for key, ids in groups.items()],
               'constraints': {'landmarks': landmarks}}
    if model_path is not None:
        return [verify_final_bridges(Path(model_path), request, config)]
    with tempfile.TemporaryDirectory() as directory:
        model.write(directory)
        return [verify_final_bridges(Path(directory), request, config)]


def refine_local_geometry(source, seed, catalog, landmarks, scope, config, denied_pairs=None, guided_target_ids=()):
    # Function-local import avoids a cycle when the main solver selects this path.
    from assisted_reconstruct import _align, verify_final_bridges
    scope = validate_local_scope(scope, catalog, landmarks, config)
    denied_pairs = denied_pairs or set()
    targets = set(scope['photoIds']); references = set(scope['referencePhotoIds'])
    if not set(guided_target_ids) <= targets:
        raise ValueError('圈选修正照片必须位于修正范围内。')
    marks = _measured_landmarks(landmarks, targets, references, denied_pairs or set(), config)
    marks, corner_receipt = refine_measured_corners(marks, catalog, scope['refineCornerIds'])
    model = pc.Reconstruction(source)
    by_photo = {p['photoId']: p for p in catalog}
    by_name = {p['name']: p['photoId'] for p in catalog}
    marked_requirements = _marked_target_requirements(marks, targets, references, config, guided_target_ids)
    images = {im.name: im for im in model.images.values()}
    native = {im.name: im for im in seed.images.values()}
    names = {by_photo[p]['name'] for p in targets}
    outside = set(images) - names
    if not names <= set(images) or not names <= set(native):
        raise ValueError('修正范围包含未覆盖的照片。')
    if any(len(frame.image_ids) != 1 for frame in model.frames.values()):
        raise ValueError('局部修正暂不支持多传感器同步照片。')
    transform = _gauge(model, seed, {by_photo[p]['name'] for p in references}, config)
    outside_point_ids = dict(_matching_points(model, seed, outside, config))
    masks = _exclusion_masks(seed, catalog, marks, scope['excludedPlanarInteriors'], targets)
    index = {name: {_pixel(p.xy): idx for idx, p in enumerate(im.points2D)} for name, im in images.items()}
    for name in names:
        im = images[name]; original = native[name]
        rotation = original.cam_from_world().rotation.matrix() @ transform.rotation.matrix().T
        center = transform * original.projection_center()
        model.frame(im.frame_id).set_cam_from_world(im.camera_id, pc.Rigid3d(pc.Rotation3d(rotation), -rotation @ center))
        for idx in range(len(im.points2D)):
            if im.point2D(idx).has_point3D():
                model.delete_observation(im.image_id, idx)
    # Transfer real outside observers when at least two measured pixels identify
    # the same source point. A local replacement must not erase its old track.
    manual_outside = {}
    for point in marks:
        matches = Counter()
        observed_names = {by_photo[o['photoId']]['name'] for o in point['observations']}
        for obs in point['observations']:
            name = by_photo[obs['photoId']]['name']; idx = index[name].get(_pixel(obs['xy']))
            if idx is None:
                continue
            old_pixel = source.images[images[name].image_id].point2D(idx)
            if old_pixel.has_point3D():
                matches[int(old_pixel.point3D_id)] += 1
        ranked = matches.most_common(2)
        if not ranked or ranked[0][1] < config['minViewsPerSide'] or (len(ranked) > 1 and ranked[0][1] == ranked[1][1]):
            continue
        source_point = source.points3D[ranked[0][0]]
        source_photos = {by_name[source.images[e.image_id].name] for e in source_point.track.elements}
        combined_photos = source_photos | {o['photoId'] for o in point['observations']}
        if any(pair <= combined_photos for pair in denied_pairs):
            continue
        manual_outside[point['id']] = [(e.image_id, e.point2D_idx)
            for e in source_point.track.elements
            if source.images[e.image_id].name in outside
            and source.images[e.image_id].name not in observed_names]
    # Remove a pre-existing point at a manual pixel before adding its measured
    # replacement. Otherwise one physical pixel could support two 3D points.
    manual_pixels = {(by_photo[o['photoId']]['name'], _pixel(o['xy'])) for p in marks for o in p['observations']}
    for name, xy in manual_pixels:
        idx = index[name].get(xy)
        if idx is not None and images[name].point2D(idx).has_point3D():
            model.delete_point3D(images[name].point2D(idx).point3D_id)
    variable = set(); occupied = set(); native_marks = []; retained_outside = 0
    for point_id in list(model.points3D):
        observed = {by_name[model.images[e.image_id].name] for e in model.points3D[point_id].track.elements}
        if any(pair <= observed for pair in denied_pairs):
            model.delete_point3D(point_id)
    for seed_id, point in sorted(seed.points3D.items(), key=lambda pair: len(pair[1].track.elements), reverse=True):
        observed = {by_name[seed.images[e.image_id].name] for e in point.track.elements}
        if any(pair <= observed for pair in denied_pairs):
            continue
        if len({e.image_id for e in point.track.elements}) != len(point.track.elements):
            continue
        rows = []
        for e in point.track.elements:
            im = seed.images[e.image_id]
            if im.name not in names:
                continue
            xy = im.point2D(e.point2D_idx).xy
            if (im.name, _pixel(xy)) in manual_pixels:
                continue
            if any(cv2.pointPolygonTest(q, tuple(map(float, xy)), True) > -3 for q in masks[by_name[im.name]]):
                continue
            target = images[im.name]; idx = index[im.name].get(_pixel(xy))
            if idx is None:
                idx = len(target.points2D); target.points2D.append(pc.Point2D(xy=xy.copy()))
                index[im.name][_pixel(xy)] = idx
            rows.append((target.image_id, idx, {'photoId': by_name[im.name], 'xy': xy.tolist(), 'origin': 'detected'}))
        if not rows:
            continue
        # Two identical measured outside pixels identify an existing physical
        # track. Keep all of its outside observations on the SAME 3D point.
        # The point can move in BA; its outside camera poses remain fixed.
        old_id = outside_point_ids.get(int(seed_id)); outside_rows = []
        xyz = transform * point.xyz; color = point.color
        if old_id is not None and old_id in model.points3D:
            old_point = model.points3D[old_id]
            for e in old_point.track.elements:
                image = model.images[e.image_id]
                if image.name in names:
                    continue
                xy = image.point2D(e.point2D_idx).xy
                outside_rows.append((image.image_id, e.point2D_idx,
                    {'photoId': by_name[image.name], 'xy': xy.tolist(), 'origin': 'detected'}))
            if len({i for i,j,o in outside_rows}) >= config['minViewsPerSide']:
                rows.extend(outside_rows); xyz = old_point.xyz.copy(); color = old_point.color.copy()
            else:
                outside_rows = []
        combined_photos = {o['photoId'] for i, j, o in rows}
        if any(pair <= combined_photos for pair in denied_pairs):
            continue
        # Boundary points often have only one or two target observations.
        # Their actual fixed outside observers supply the remaining views.
        if len(rows) < max(2, min(3, len(targets))):
            continue
        if any((i, j) in occupied for i, j, o in rows):
            continue
        if outside_rows:
            model.delete_point3D(old_id); retained_outside += 1
        track = pc.Track()
        for i, j, o in rows:
            track.add_element(i, j)
        point_id = model.add_point3D(xyz, track, color)
        variable.add(point_id); occupied.update((i, j) for i, j, o in rows)
        native_marks.append({'id': 'local-native-' + str(point_id), 'observations': [o for i, j, o in rows]})
    views = _views(model, catalog); manual_ids = {}
    for point in marks:
        obs = point['observations']; fixed = [o for o in obs if o['photoId'] in references]
        xyz = _dlt(fixed if len(fixed) >= 2 else obs, views)
        if xyz is None or not np.isfinite(xyz).all():
            raise ValueError('标记点没有可用的实际深度依据。')
        track = pc.Track()
        for o in obs:
            im = images[by_photo[o['photoId']]['name']]
            idx = len(im.points2D); im.points2D.append(pc.Point2D(xy=np.asarray(o['xy'], dtype=np.float32)))
            track.add_element(im.image_id, idx)
        for image_id, idx in manual_outside.get(point['id'], []):
            if not model.images[image_id].point2D(idx).has_point3D():
                track.add_element(image_id, idx)
        point_id = model.add_point3D(xyz, track)
        variable.add(point_id); manual_ids[point['id']] = point_id
    regions = [{'id': 'repair', 'photoIds': sorted(targets)}, {'id': 'reference', 'photoIds': sorted(references)}]
    manual_names = {by_photo[o['photoId']]['name'] for p in marks for o in p['observations']}
    anchor = pc.Reconstruction(model)
    for point_id in list(anchor.points3D):
        if point_id not in set(manual_ids.values()):
            anchor.delete_point3D(point_id)
    anchor_summary = _bundle(anchor, outside, set(manual_ids.values()), manual_names, 1000)
    anchor_views = _views(anchor, catalog)
    context = {'regionViews': {r['id']: {pid: anchor_views[pid] for pid in r['photoIds']} for r in regions}}
    fixed = {key: anchor.points3D[pid].xyz.copy() for key, pid in manual_ids.items()}
    aligned = _align(copy.deepcopy(marks), context, regions, config, fixed_points=fixed)
    if not aligned['graph']['accepted']:
        raise ValueError('实际标记点未通过固定参照与修正范围的共同点检查。')
    accepted_ids = {p['id'] for p in aligned['landmarks']}
    anchor_support = defaultdict(set)
    for key in accepted_ids:
        for measured in aligned['triangulated'][key].values():
            if measured.get('accepted'):
                for obs in measured['observations']:
                    anchor_support[obs['photoId']].add(key)
    anchor_marked_support = _check_marked_target_support(marked_requirements, anchor_support,
                                                       by_photo, config, '初始化')
    fixed_target_ids = {pid for pid in targets if len(anchor_support[pid]) >= config['minSharedPoints']}
    if len(fixed_target_ids) < config['minViewsPerSide']:
        raise ValueError('至少两张修正照片需要各有 8 个有效共同点，才能固定相机位置。')
    fixed_target_names = {by_photo[pid]['name'] for pid in fixed_target_ids}
    for name in fixed_target_names:
        im = images[name]
        model.frame(im.frame_id).set_cam_from_world(im.camera_id, anchor.images[im.image_id].cam_from_world())
    for key, point_id in manual_ids.items():
        model.points3D[point_id].xyz = anchor.points3D[point_id].xyz
        if key in accepted_ids:
            variable.discard(point_id)
    def support():
        counts = {pid: images[by_photo[pid]['name']].num_points3D for pid in sorted(targets)}
        if any(v < config['minSharedPoints'] for v in counts.values()):
            raise ValueError('修正范围中的照片没有足够的有效观察支持。')
        for photo_id in targets:
            image = images[by_photo[photo_id]['name']]
            xy = np.asarray([p.xy for p in image.points2D if p.has_point3D()])
            camera = model.cameras[image.camera_id]
            if np.linalg.norm(np.ptp(xy, axis=0))/np.hypot(camera.width,camera.height) < config['minImageSpanFraction']:
                raise ValueError('修正照片的有效观察分布过于集中，位置支持不足。')
        return counts
    support()
    request = {'catalog': catalog, 'regions': regions, 'constraints': {'landmarks': marks, 'answers': [], 'questions': []}}
    first = _bundle(model, outside | fixed_target_names, variable)
    cleaned = clean_tracks(model, config, request)
    second = _bundle(model, outside | fixed_target_names, variable)
    cleaned_again = clean_tracks(model, config, request)
    model.update_point_3d_errors()
    counts = support()
    with tempfile.TemporaryDirectory() as directory:
        model.write(directory)
        boundary = verify_final_bridges(Path(directory), request, config)
    if not boundary['accepted']:
        raise ValueError('修正后的实际共同点未通过最终几何连接检查。')
    final_support = defaultdict(set)
    for point in boundary['retainedLandmarks']:
        for obs in point['observations']:
            final_support[obs['photoId']].add(point['id'])
    final_marked_support = _check_marked_target_support(marked_requirements, final_support,
                                                      by_photo, config, '最终')
    return model, {'manualAnchor': {'accepted': True, 'optimization': anchor_summary, 'alignment': aligned},
                   'boundary': boundary, 'targetPhotoCount': len(targets), 'targetPhotoSupport': counts,
                   'markedTargetChecks': [{'photoId': pid, 'submittedSharedPoints': marked_requirements[pid],
                                          'anchorSharedPoints': anchor_marked_support[pid],
                                          'finalSharedPoints': final_marked_support[pid], 'accepted': True}
                                         for pid in sorted(marked_requirements)],
                   'fixedTargetPhotoIds': sorted(fixed_target_ids),
                   'retainedOutsideTrackCount': retained_outside,
                   'firstOptimization': first, 'secondOptimization': second,
                   'cleanup': cleaned, 'secondCleanup': cleaned_again,
                   'nativeLandmarks': native_marks, 'measuredLandmarks': marks,
                   'cornerRefinement': corner_receipt,
                   'userCameraPositionsSupplied': False, 'projectedPixelsUsedAsObservations': False}
