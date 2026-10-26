"""Build geometric matches from clean regional tracks and measured shared points."""
from collections import defaultdict
from contextlib import closing
from itertools import combinations
from pathlib import Path
import sqlite3
import numpy as np
import pycolmap as pc
from assistance_inputs import snapshot_database
from assisted_features import rejected_pairs,conflicts_with_rejections


def build_geometry_database(source,destination,models,observations,alignments,constraints,config):
    denied=rejected_pairs(constraints)
    if any(conflicts_with_rejections([o['photoId'] for o in p['observations']],denied) for p in observations['landmarks']):
        raise ValueError('对应点与用户否定的共同内容冲突。请先修正回答或观察。')
    destination=Path(destination)
    snapshot_database(source,destination)
    catalog={p['photoId']:p for p in observations['catalog']}
    by_name={p['name']:p['photoId'] for p in catalog.values()}
    with closing(sqlite3.connect(destination)) as db:
        image_ids={name:image_id for image_id,name in db.execute('select image_id,name from images')}
        camera_ids={name:camera_id for name,camera_id in db.execute('select name,camera_id from images')}
    photo_by_image_id={image_id:by_name[name] for name,image_id in image_ids.items() if name in by_name}
    views=observations['views'];coords=defaultdict(list);lookup={};pairs=defaultdict(set)
    duplicate_count=0;regional_counts={};bridge_tracks={};camera_params=defaultdict(list)
    def register(photo_id,xy):
        image_id=image_ids[catalog[photo_id]['name']]
        pixel=np.asarray(xy,dtype='<f4');key=(image_id,pixel.tobytes())
        if key not in lookup:lookup[key]=len(coords[image_id]);coords[image_id].append(pixel.tolist())
        return image_id,lookup[key]
    def add_track(entries):
        if len(entries)>24:
            entries=[entries[i] for i in np.linspace(0,len(entries)-1,24).round().astype(int)]
        for (ia,ka),(ib,kb) in combinations(sorted(entries),2):pairs[(ia,ib)].add((ka,kb))
    for item in models:
        reconstruction=item['reconstruction']
        for region in item['regions']:
            members=set(region['photoIds']);count=0
            for point in reconstruction.points3D.values():
                selected={}
                for element in point.track.elements:
                    image=reconstruction.images[element.image_id];photo_id=by_name.get(image.name)
                    if photo_id not in members:continue
                    pose=image.cam_from_world();camera=reconstruction.cameras[image.camera_id]
                    local=pose.rotation.matrix()@point.xyz+pose.translation
                    predicted=camera.img_from_cam(local) if local[2]>0 else None
                    if predicted is None:continue
                    xy=image.point2D(element.point2D_idx).xy
                    error=float(np.linalg.norm(predicted-xy))
                    if photo_id in selected:duplicate_count+=1
                    if error<=config['maxReprojectionPx'] and (photo_id not in selected or error<selected[photo_id][0]):selected[photo_id]=(error,xy)
                if len(selected)<config['minViewsPerSide']:continue
                if conflicts_with_rejections(selected,denied):continue
                centers=[-np.asarray(views[p]['camFromWorld'])[:,:3].T@np.asarray(views[p]['camFromWorld'])[:,3] for p in selected]
                rays=[(point.xyz-c)/np.linalg.norm(point.xyz-c) for c in centers]
                parallax=max(np.degrees(np.arccos(np.clip(a@b,-1,1))) for a,b in combinations(rays,2))
                if parallax<config['minParallaxDeg']:continue
                add_track([register(p,xy) for p,(_,xy) in sorted(selected.items())]);count+=1
            regional_counts[region['id']]=count
        for image in reconstruction.images.values():
            owner=views.get(by_name.get(image.name))
            if image.name in camera_ids and owner and owner.get('model')==item.get('name'):
                camera_params[camera_ids[image.name]].append(reconstruction.cameras[image.camera_id].params)
    for point in observations['landmarks']:
        selected={}
        for obs in point['observations']:
            if obs['photoId'] not in views:continue
            if obs['photoId'] in selected:duplicate_count+=1;continue
            selected[obs['photoId']]=obs
        entries=[register(photo_id,obs['xy']) for photo_id,obs in sorted(selected.items())]
        if len(entries)<2:continue
        add_track(entries)
        bridge_tracks[point['id']]=[{'imageId':image_id,'point2DIndex':key,'photoId':p,'xy':selected[p]['xy']} for p,(image_id,key) in zip(sorted(selected),entries)]
    rotations={};centers={}
    for photo_id,view in views.items():
        region_id=view['regionId'];transform=np.asarray(alignments['transforms'][region_id])
        scale=float(np.cbrt(np.linalg.det(transform[:3,:3])))
        if not np.isfinite(scale) or scale<=0:raise ValueError('区域变换尺度无效')
        rotation=transform[:3,:3]/scale;pose=np.asarray(view['camFromWorld'])
        image_id=image_ids[catalog[photo_id]['name']]
        rotations[image_id]=pose[:,:3]@rotation.T
        centers[image_id]=transform[:3,:3]@(-pose[:,:3].T@pose[:,3])+transform[:3,3]
    relative_poses={}
    with closing(sqlite3.connect(destination)) as db:
        for table in ('keypoints','descriptors','matches','two_view_geometries','pose_priors'):
            if db.execute("select 1 from sqlite_master where type='table' and name=?",(table,)).fetchone():db.execute(f'delete from {table}')
        for camera_id,values in camera_params.items():
            if len({len(v) for v in values})!=1:raise ValueError('相机组参数模型不一致')
            params=np.median(np.asarray(values),axis=0).astype('<f8')
            db.execute('update cameras set params=? where camera_id=?',(params.tobytes(),camera_id))
        for image_id,xy in coords.items():
            keypoints=np.zeros((len(xy),6),dtype='<f4');keypoints[:,:2]=xy;keypoints[:,2]=1;keypoints[:,5]=1
            db.execute('insert into keypoints (image_id,rows,cols,data) values (?,?,?,?)',(image_id,len(xy),6,keypoints.tobytes()))
        for (ia,ib),matches in sorted(pairs.items()):
            if frozenset([photo_by_image_id[ia],photo_by_image_id[ib]]) in denied:continue
            if len(matches)<config['minSharedPoints']:continue
            relative=rotations[ib]@rotations[ia].T
            translation=rotations[ib]@(centers[ia]-centers[ib]);length=np.linalg.norm(translation)
            if length<1e-10:continue
            translation/=length
            skew=np.array([[0,-translation[2],translation[1]],[translation[2],0,-translation[0]],[-translation[1],translation[0],0]])
            essential=(skew@relative).astype('<f8');q=pc.Rotation3d(relative).quat[[3,0,1,2]].astype('<f8')
            pair_id=ia*2147483647+ib;data=np.asarray(sorted(matches),dtype='<u4').reshape(-1,2)
            db.execute('insert into matches (pair_id,rows,cols,data) values (?,?,?,?)',(pair_id,len(data),2,data.tobytes()))
            db.execute('insert into two_view_geometries (pair_id,rows,cols,data,config,E,qvec,tvec) values (?,?,?,?,?,?,?,?)',
                       (pair_id,len(data),2,data.tobytes(),2,essential.tobytes(),q.tobytes(),translation.astype('<f8').tobytes()))
            relative_poses[str(pair_id)]={'qvec':q.tolist(),'tvec':translation.tolist(),'E':essential.tolist(),'observations':len(data),'source':'validated_regional_geometry_and_measured_shared_tracks'}
        db.commit()
        if db.execute('pragma quick_check').fetchone()[0]!='ok':raise ValueError('几何数据库完整性检查失败')
    return {'duplicateObservationsRemoved':duplicate_count,'regionalTrackCounts':regional_counts,'bridgeTracks':bridge_tracks,
            'relativePoses':relative_poses,'absoluteCameraPositionsSupplied':False,'pairCount':len(relative_poses)}
