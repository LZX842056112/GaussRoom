"""Initialize native global positioning from validated, measured regional geometry."""
from itertools import combinations
from pathlib import Path
import tempfile
import numpy as np
import pycolmap as pc
from assistance_inputs import snapshot_database,sha256_file
from assisted_features import rejected_pairs,conflicts_with_rejections
from assisted_geometry import triangulate_observations


def _pixel(xy):return tuple(np.asarray(xy,dtype=np.float32))


def _parallax(xyz,centers):
    rays=[(xyz-center)/np.linalg.norm(xyz-center) for center in centers]
    return max((np.degrees(np.arccos(np.clip(a@b,-1,1))) for a,b in combinations(rays,2)),default=0.)


def initialize_from_geometry(request,context,aligned,database):
    config=request['config'];denied=rejected_pairs(request['constraints'])
    if not aligned['graph']['accepted']:raise ValueError('区域几何未验证，不能初始化全局定位。')
    if any(conflicts_with_rejections([o['photoId'] for o in p['observations']],denied) for p in aligned['landmarks']):
        raise ValueError('对应点与已否定的共同内容冲突。')
    # Native Database.open updates SQLite metadata, even when only reading.
    with tempfile.TemporaryDirectory(prefix='gaussroom-geometry-') as temporary:
        copied=Path(temporary)/'database.db';snapshot_database(database,copied)
        with pc.Database.open(copied) as db:
            options=pc.DatabaseCacheOptions();options.min_num_matches=config['minSharedPoints'];options.load_all_images=True
            cache=pc.DatabaseCache.create(db,options)
    model=pc.Reconstruction();model.load(cache)
    if any(len(frame.image_ids)>1 for frame in model.frames.values()):
        raise ValueError('此初始化暂不支持多相机同步帧。原有结果已保留。')
    by_name={i.name:i for i in model.images.values()};photos={p['photoId']:p for p in request['catalog']}
    by_photo_name={p['name']:p['photoId'] for p in photos.values()};views={};lookups={}
    for pid,view in context['views'].items():
        image=by_name[photos[pid]['name']];transform=np.asarray(aligned['graph']['transforms'][view['regionId']],float)
        scale=np.cbrt(np.linalg.det(transform[:3,:3]))
        if not np.isfinite(transform).all() or not np.isfinite(scale) or scale<=0:raise ValueError('区域几何变换无效。')
        pose=np.asarray(view['camFromWorld']);rotation=pose[:,:3]@(transform[:3,:3]/scale).T
        center=transform[:3,:3]@(-pose[:,:3].T@pose[:,3])+transform[:3,3]
        model.frame(image.frame_id).set_cam_from_world(image.camera_id,pc.Rigid3d(pc.Rotation3d(rotation),-rotation@center))
        model.register_frame(image.frame_id)
        views[pid]={'camera':model.camera(image.camera_id),'camFromWorld':image.cam_from_world().matrix()}
        lookups[pid]={_pixel(p.xy):index for index,p in enumerate(image.points2D)}
    used=set();shared=0;regional=0
    for landmark in aligned['landmarks']:
        checked=triangulate_observations(landmark['observations'],views,config)
        if not checked.get('accepted'):continue
        track=pc.Track()
        for obs in checked['observations']:
            image=by_name[photos[obs['photoId']]['name']];index=lookups[obs['photoId']].get(_pixel(obs['xy']))
            if index is not None and (image.image_id,index) not in used:track.add_element(image.image_id,index)
        if len(track.elements)<2*config['minViewsPerSide']:continue
        model.add_point3D(checked['xyz'],track)
        used.update((e.image_id,e.point2D_idx) for e in track.elements);shared+=1
    for item in context['models']:
        source=item['reconstruction']
        for region in item['regions']:
            members=set(region['photoIds']);transform=np.asarray(aligned['graph']['transforms'][region['id']])
            for point in source.points3D.values():
                xyz=transform[:3,:3]@point.xyz+transform[:3,3];selected={}
                for element in point.track.elements:
                    image=source.images[element.image_id];pid=by_photo_name.get(image.name)
                    if pid not in members or pid not in lookups:continue
                    xy=image.point2D(element.point2D_idx).xy;index=lookups[pid].get(_pixel(xy))
                    target=by_name[image.name]
                    if index is None or (target.image_id,index) in used:continue
                    pose=views[pid]['camFromWorld'];local=pose[:,:3]@xyz+pose[:,3]
                    predicted=views[pid]['camera'].img_from_cam(local) if local[2]>0 else None
                    error=float(np.linalg.norm(predicted-xy)) if predicted is not None else float('inf')
                    if error<=config['maxReprojectionPx'] and (pid not in selected or error<selected[pid][0]):
                        selected[pid]=(error,(target.image_id,index),target.projection_center())
                if len(selected)<config['minViewsPerSide'] or conflicts_with_rejections(selected,denied):continue
                if _parallax(xyz,[v[2] for v in selected.values()])<config['minParallaxDeg']:continue
                entries=[v[1] for _,v in sorted(selected.items())]
                if len(entries)>24:entries=[entries[i] for i in np.linspace(0,len(entries)-1,24).round().astype(int)]
                track=pc.Track()
                for entry in entries:track.add_element(*entry)
                model.add_point3D(xyz,track,point.color);used.update(entries);regional+=1
    if not model.is_valid():raise ValueError('初始化模型的观察引用不一致。')
    return model,{'computedCameraPositionsSupplied':True,'userCameraPositionsSupplied':False,
                  'source':'validated_multiview_regional_geometry','initialSharedPoints':shared,'regionalPoints':regional,
                  'registered':model.num_reg_images()}


def clean_tracks(model,config,request):
    denied=rejected_pairs(request['constraints']);photos={p['name']:p['photoId'] for p in request['catalog']}
    duplicates=0;rejected=0
    for point_id in list(model.points3D):
        point=model.points3D[point_id];selected={}
        for element in point.track.elements:
            image=model.images[element.image_id];pose=image.cam_from_world();local=pose.rotation.matrix()@point.xyz+pose.translation
            predicted=model.cameras[image.camera_id].img_from_cam(local) if local[2]>0 else None
            error=float(np.linalg.norm(predicted-image.point2D(element.point2D_idx).xy)) if predicted is not None else float('inf')
            if element.image_id not in selected or error<selected[element.image_id][0]:selected[element.image_id]=(error,element.point2D_idx)
        duplicate_count=len(point.track.elements)-len(selected);duplicates+=duplicate_count
        if conflicts_with_rejections([photos[model.images[iid].name] for iid in selected],denied):
            model.delete_point3D(point_id);rejected+=1;continue
        if not duplicate_count:continue
        xyz=point.xyz.copy();color=point.color.copy();model.delete_point3D(point_id);track=pc.Track()
        for image_id,(error,index) in selected.items():
            if error<=config['maxReprojectionPx']:track.add_element(image_id,index)
        if len(track.elements)>=2:model.add_point3D(xyz,track,color)
    filtered=pc.ObservationManager(model).filter_all_points3D(config['maxReprojectionPx'],config['minParallaxDeg'])
    return {'duplicateObservationsRemoved':duplicates,'rejectedIdentityTracksRemoved':rejected,'filteredObservations':filtered}


def run_initialized_global(request,context,aligned,database,output,progress):
    output=Path(output);folder=output/'sfm/initialized-global';folder.mkdir()
    before=sha256_file(database);working=folder/'database.db';snapshot_database(database,working)
    model,receipt=initialize_from_geometry(request,context,aligned,working)
    initial=folder/'initial/0';initial.mkdir(parents=True);model.write(initial)
    with pc.Database.open(working) as db:
        options=pc.DatabaseCacheOptions();options.min_num_matches=request['config']['minSharedPoints']
        cache=pc.DatabaseCache.create(db,options)
    graph=pc.PoseGraph();graph.load(cache.correspondence_graph)
    options=pc.GlobalPositionerOptions();options.generate_random_positions=False;options.generate_random_points=False
    options.random_seed=request['config']['seed'];options.use_gpu=False
    progress('global','使用已验证的多视角几何初始化，再运行全局定位。')
    receipt['globalPositioningOptions']=options.todict()
    receipt['globalPositioningSucceeded']=pc.run_global_positioning(options,graph,model)
    if not receipt['globalPositioningSucceeded']:raise RuntimeError('使用几何初始值的原生全局定位失败。')
    receipt['beforeBundleCleanup']=clean_tracks(model,request['config'],request)
    ba=pc.BundleAdjustmentOptions();ba.ceres.solver_options.num_threads=12
    ba.ceres.loss_function_type=pc.LossFunctionType.HUBER;ba.ceres.loss_function_scale=1.
    pc.bundle_adjustment(model,ba)
    progress('global','重新三角化真实观察，并执行联合优化。')
    tri=pc.IncrementalPipelineOptions();tri.num_threads=12;tri.random_seed=request['config']['seed']
    tri.triangulation.merge_max_reproj_error=request['config']['maxReprojectionPx']
    tri.triangulation.complete_max_reproj_error=request['config']['maxReprojectionPx']
    tri.triangulation.min_angle=request['config']['minParallaxDeg']
    model=pc.triangulate_points(model,working,request['images'],folder/'native-triangulation',clear_points=False,options=tri,refine_intrinsics=True)
    receipt['afterTriangulationCleanup']=clean_tracks(model,request['config'],request)
    pc.bundle_adjustment(model,ba)
    receipt['finalCleanup']=clean_tracks(model,request['config'],request)
    model.update_point_3d_errors()
    if not model.is_valid():raise ValueError('最终模型的观察引用不一致。')
    sparse=output/'sfm/initialized-sparse';target=sparse/'0';target.mkdir(parents=True);model.write(target)
    receipt.update(sourceDatabaseUnchanged=before==sha256_file(database),finalPoints=model.num_points3D(),
                   finalMeanReprojectionPx=model.compute_mean_reprojection_error(),nativeGlobalPositioning=True,nativeTriangulation=True,nativeJointBundleAdjustment=True)
    if not receipt['sourceDatabaseUnchanged']:raise RuntimeError('全局定位输入数据库发生改变。')
    return sparse,receipt
