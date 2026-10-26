"""Native job for an explicitly selected local repair in a global model."""
import copy
import json
import subprocess
import sys
from collections import Counter
from itertools import combinations
from pathlib import Path

import pycolmap as pc

from assistance_inputs import snapshot_database
from assisted_local_repair import refine_local_geometry, validate_local_scope, check_camera_groups, MarkedTargetSupportError
from assisted_features import rejected_pairs, collect_observations
from assisted_candidates import model_signature
from gate_model import main as run_gate, geometry_signature


def _native_coverage(model, required, config):
    images = {im.name: im for im in model.images.values()}
    return {'missingRequired': sorted(required - set(images)),
            'weakRequired': [{'name': name, 'points': images[name].num_points3D}
                             for name in sorted(required & set(images))
                             if images[name].num_points3D < config['minSharedPoints']]}


def _combined_final_landmarks(*groups):
    """Overlay verified pixels without losing observations outside this repair."""
    points = {}
    for group in groups:
        for point in group:
            row = copy.deepcopy(point)
            previous = points.get(row['id'])
            if previous is not None:
                observations = {o['photoId']: o for o in previous['observations']}
                observations.update({o['photoId']: o for o in row['observations']})
                row = {**previous, **row, 'observations': list(observations.values())}
            points[row['id']] = row
    return list(points.values())


def _merge_native_candidates(pool, required, request, native_root, sparse, run, options, progress, write_json, tried):
    pairs = []
    for first, second in combinations(pool, 2):
        key = tuple(sorted((str(first[2]), str(second[2]))))
        names_a = {im.name for im in first[3].images.values()}
        names_b = {im.name for im in second[3].images.values()}
        if key in tried or len(names_a & names_b) < 3 or not required <= names_a | names_b:
            continue
        supported = not (_native_coverage(first[3], required, request['config'])['weakRequired'] or
                         _native_coverage(second[3], required, request['config'])['weakRequired'])
        pairs.append((supported, len(names_a & names_b), first[0] + second[0], key, first, second))
    if not pairs:
        return None
    _, _, _, key, first, second = max(pairs, key=lambda item: item[:3])
    tried.add(key)
    before = {path: model_signature(path) for path in key}
    # A native merge can retain a camera but discard almost all its tracks.
    # Both directions are bounded initializers; neither inherits verification.
    for direction, (first, second) in enumerate(((first, second), (second, first))):
        number = 0
        while (native_root/'merge-attempts'/str(number)).exists():
            number += 1
        folder = native_root/'merge-attempts'/str(number); folder.mkdir(parents=True)
        command = [request['colmap'], 'model_merger', '--input_path1', str(first[2]), '--input_path2', str(second[2]),
                   '--output_path', str(folder), '--max_reproj_error', str(request['config']['maxReprojectionPx']),
                   '--default_random_seed', str(request['config']['seed']), '--log_color', '0']
        trace = {'initializationOnly': True, 'command': command, 'success': False,
                 'completeCoverage': False, 'initializerAccepted': False}
        trace_path = Path(request['outputRoot'])/f'summary/local-native-merge-{number}.json'
        write_json(trace_path, trace)
        progress('local_initialization', '检查另一个原生合并方向，保留上次结果。' if direction else
                 '合并覆盖互补的原生候选，随后重新检查全部修正照片。')
        try:
            run(command, **options)
        except subprocess.CalledProcessError as error:
            trace['exitCode'] = error.returncode
            write_json(trace_path, trace)
            continue
        finally:
            if any(model_signature(path) != signature for path, signature in before.items()):
                raise ValueError('原生候选在合并时被改变，不能继续。')
        if not (folder/'images.bin').is_file():
            continue
        merged = pc.Reconstruction(str(folder))
        coverage = _native_coverage(merged, required, request['config'])
        accepted = not any(coverage.values())
        trace.update(success=True, completeCoverage=not coverage['missingRequired'],
                     initializerAccepted=accepted, **coverage)
        write_json(trace_path, trace)
        if not accepted:
            continue
        index = 0
        while (sparse/str(index)).exists():
            index += 1
        published = sparse/str(index); published.mkdir(); merged.write(str(published))
        return (merged.num_reg_images(), merged.num_points3D(), published, merged, f'merged-native-{number}')
    return None


def run_local_repair(request, context, catalog, result, run, progress, write_json):
    from assisted_reconstruct import verify_final_bridges, calibrate_final_scale
    config = request['config']; constraints = request['constraints']
    scope = validate_local_scope(constraints['localRepair'], catalog, constraints.get('landmarks', []), config)
    if len(context['models']) != 1:
        raise ValueError('局部位置修正需要先建立一个经过连接检查的全局模型。')
    source = context['models'][0]['reconstruction']
    by_photo = {p['photoId']: p for p in catalog}
    selected = set(scope['photoIds'] + scope['referencePhotoIds'] + scope['contextPhotoIds'])
    # Without explicit context, retain the strongest actual source co-observers.
    # This choice only initializes the native solve; it cannot verify a join.
    if not scope['contextPhotoIds']:
        names = {by_photo[p]['name'] for p in selected}; by_name = {p['name']: p['photoId'] for p in catalog}
        neighbors = Counter()
        for point in source.points3D.values():
            track_names = {source.images[e.image_id].name for e in point.track.elements}
            if track_names & names:
                neighbors.update(n for n in track_names-names if n in by_name)
        selected.update(by_name[n] for n, count in neighbors.most_common(30))
    output = Path(request['outputRoot']); sfm = output/'sfm'; sfm.mkdir(exist_ok=True)
    measured = {'landmarks': copy.deepcopy(constraints.get('landmarks', [])), 'rejected': [], 'missing': []}
    guided_targets = set()
    for obj in constraints.get('objects', []):
        photo_ids = {row['photoId'] for row in obj.get('rois', []) + obj.get('corners', [])}
        if photo_ids & set(scope['referencePhotoIds']):
            guided_targets.update(photo_ids & set(scope['photoIds']))
    if any(obj.get('rois') or obj.get('corners') for obj in constraints.get('objects', [])):
        progress('local_features', '在共同区域搜索实际图像特征。')
        measured = collect_observations(catalog, context['models'], constraints, config)
        write_json(output/'summary/local-feature-matches.json', measured)
        if measured['missing']:
            result.update(outcome='needs_input', missing=measured['missing'])
            return result
    native_root = sfm/'local-native'; native_root.mkdir()
    image_list = native_root/'images.txt'
    image_list.write_text(''.join(by_photo[p]['name']+'\n' for p in sorted(selected)), encoding='utf8')
    working = sfm/'database-global.db'
    snapshot_database(Path(request['database']), working)
    options = {'check': True, 'stdout': sys.stdout, 'stderr': sys.stderr,
               'creationflags': getattr(subprocess, 'CREATE_NO_WINDOW', 0)}
    progress('calibration', '校准匹配副本，准备完整修正范围。')
    run([request['colmap'], 'view_graph_calibrator', '--database_path', str(working),
         '--relpose_min_num_inliers', str(config['minSharedPoints']), '--log_color', '0'], **options)
    write_json(output/'summary/calibration.json', {'success': True, 'sourceDatabasePreserved': True})
    sparse = native_root/'sparse'; sparse.mkdir()
    command = [request['colmap'], 'mapper', '--database_path', str(working),
               '--image_path', request['images'], '--output_path', str(sparse),
               '--Mapper.image_list_path', str(image_list), '--Mapper.num_threads', '12',
               '--Mapper.random_seed', str(config['seed']), '--Mapper.multiple_models', '1', '--log_color', '0']
    required = {by_photo[p]['name'] for p in scope['photoIds']+scope['referencePhotoIds']}
    candidates = []; native_pool = []; tried_merges = set()
    for item in request.get('regionalCandidates', []):
        folder = Path(item['path'])
        if model_signature(folder) != item['modelSignature']:
            raise ValueError('冻结的原生候选已改变，不能复用。')
        seed = pc.Reconstruction(str(folder))
        item_tuple = (seed.num_reg_images(), seed.num_points3D(), folder, seed, item['name'])
        native_pool.append(item_tuple)
        if not any(_native_coverage(seed, required, config).values()):
            candidates.append(item_tuple)
    if not candidates:
        merged = _merge_native_candidates(native_pool, required, request, native_root, sparse,
                                          run, options, progress, write_json, tried_merges)
        if merged is not None:
            candidates.append(merged)
    if candidates:
        progress('local_initialization', '复用同输入的原生候选，重新检查全部修正照片。')
        write_json(output/'summary/local-native-reuse.json', {'initializationOnly': True, 'candidates': [c[4] for c in candidates]})
    else:
        write_json(output/'summary/local-native-command.json', command)
        progress('local_initialization', '从真实匹配重新定位修正照片和固定参照。')
        run(command, **options)
        for folder in sorted(sparse.iterdir()):
            if not (folder/'images.bin').is_file():
                continue
            seed = pc.Reconstruction(str(folder))
            item_tuple = (seed.num_reg_images(), seed.num_points3D(), folder, seed, None)
            native_pool.append(item_tuple)
            if not any(_native_coverage(seed, required, config).values()):
                candidates.append(item_tuple)
        if not candidates:
            merged = _merge_native_candidates(native_pool, required, request, native_root, sparse,
                                              run, options, progress, write_json, tried_merges)
            if merged is not None:
                candidates.append(merged)
    if not candidates:
        result.update(outcome='needs_input', missing=[{'code': 'local_scope_unregistered',
                      'message': '修正照片与固定参照没有完整、可靠的原生初始化。已有模型已保留。'}])
        return result
    _, _, seed_folder, seed, reused = max(candidates, key=lambda row: row[:2])
    progress('local_bundle', '检查实际标记点，然后联合优化完整修正范围。')
    try:
        model, receipt = refine_local_geometry(source, seed, catalog, measured['landmarks'],
                                               scope, config, denied_pairs=rejected_pairs(constraints),
                                               guided_target_ids=guided_targets)
    except MarkedTargetSupportError as error:
        write_json(output/'summary/local-marked-target-check.json', {'accepted': False, 'missing': error.missing})
        result.update(outcome='needs_input', missing=error.missing)
        return result
    original_ids = {point['id'] for point in constraints.get('landmarks', [])}
    receipt['guidedFeatureCollection'] = {'generatedLandmarks': sum(p['id'] not in original_ids for p in measured['landmarks']),
                                         'rejectedCandidates': len(measured['rejected'])}
    receipt['nativeModel'] = seed_folder.name
    receipt['reusedNativeSeed'] = reused
    receipt['selectedPhotoIds'] = sorted(selected)
    final_root = sfm/'sparse'; final = final_root/'0'; final.mkdir(parents=True)
    model.write(str(final))
    final_marks = _combined_final_landmarks(constraints.get('landmarks', []),
                                           request.get('preservedLandmarks', []),
                                           receipt['measuredLandmarks'])
    final_request = {**request, 'constraints': {**constraints, 'landmarks': final_marks}}
    progress('verify', '检查最终连接、全部修正照片和原有区域连接。')
    args = ['--model-root', str(final_root), '--database', str(working),
            '--manifest', request['manifest'], '--out', str(output/'summary')]
    if run_gate(args) != 0:
        raise RuntimeError('局部修正后的模型检查失败。')
    gate = json.loads((output/'summary/gate.json').read_text(encoding='utf8')); result['gate'] = gate
    bridges = verify_final_bridges(final, final_request, config)
    result['bridges'] = bridges
    write_json(output/'summary/final-bridges.json', bridges)
    prior_checks = []
    for check in request.get('priorBridgeChecks', []):
        checked_request = {**request, 'regions': check['regions'],
                           'constraints': {**constraints, 'landmarks': check['constraints']['landmarks']}}
        checked = verify_final_bridges(final, checked_request, config)
        prior_checks.append({'sourceAttemptId': check.get('sourceAttemptId'), **checked})
    receipt['priorBridgeChecks'] = prior_checks
    # Cross-camera connections use actual native points, with two views on each
    # side. Camera group names come from the catalog, never scene filenames.
    camera_checks = check_camera_groups(model,catalog,receipt['nativeLandmarks']+receipt['measuredLandmarks'],scope,config,model_path=final)
    # Keep large triangulation arrays in their own artifact, outside the status
    # response that the browser refreshes while the job runs.
    for i, checked in enumerate(camera_checks):
        write_json(output/f'summary/local-camera-check-{i}.json', checked)
    receipt['cameraGroupChecks'] = [{k: c[k] for k in ('accepted','geometryComponentSizes','missing','duplicateObservations','uniqueSharedPoints')} for c in camera_checks]
    receipt['accepted'] = gate['verdict']=='pass' and bridges['accepted'] and all(c['accepted'] for c in prior_checks+camera_checks)
    # Full native evidence is retained separately so the job result stays small.
    write_json(output/'summary/local-native-landmarks.json', receipt.pop('nativeLandmarks'))
    write_json(output/'summary/local-repair.json', receipt); result['localRepair'] = receipt
    if not receipt['accepted']:
        result.update(outcome='needs_input', missing=[{'code': 'local_final_check_failed',
                      'message': '局部修正未通过最终连接检查。请查看范围和连接报告。'}])
        return result
    scale = calibrate_final_scale(final, constraints.get('dimensions', []), bridges['triangulated'], config)
    result['scale'] = scale; write_json(output/'summary/scale.json', scale)
    if not scale['accepted']:
        result.update(outcome='needs_input', missing=scale['missing']); return result
    if scale['scale']=='calibrated':
        # Global scale does not alter pixel checks, but refresh the signed gate.
        if run_gate(args) != 0:
            raise RuntimeError('尺度校准后的模型检查失败。')
        result['gate'] = json.loads((output/'summary/gate.json').read_text(encoding='utf8'))
    result.update(outcome='verified', model={'name': '0', 'geometrySignature': geometry_signature(final)})
    return result
