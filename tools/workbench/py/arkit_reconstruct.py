import argparse, json, os, subprocess, sys
from pathlib import Path
import numpy as np
import pycolmap as pc
from scan_archive import verify_scan

def colmap_pose(values):
    m=np.asarray(values,dtype=float).reshape((4,4),order='F')
    if not np.isfinite(m).all() or not np.allclose(m[3],[0,0,0,1],atol=1e-6) or not np.allclose(m[:3,:3].T@m[:3,:3],np.eye(3),atol=1e-4) or not np.isclose(np.linalg.det(m[:3,:3]),1,atol=1e-4):raise ValueError('invalid camera transform')
    return np.diag([1,-1,-1,1])@np.linalg.inv(m)

def scaled_intrinsics(frame,size):
    k=np.asarray(frame['intrinsics'],dtype=float).reshape((3,3),order='F');w,h=frame['image']['width'],frame['image']['height'];sx,sy=size[0]/w,size[1]/h
    if not np.isfinite(k).all() or k[0,0]<=0 or k[1,1]<=0 or not np.allclose(k,[[k[0,0],0,k[0,2]],[0,k[1,1],k[1,2]],[0,0,1]],atol=1e-5) or sx<=0 or sy<=0:raise ValueError('invalid intrinsics')
    return [k[0,0]*sx,k[1,1]*sy,k[0,2]*sx,k[1,2]*sy]

def mapping(scan,manifest,images):
    scan=Path(scan).resolve();images=Path(images).resolve();m=verify_scan(scan);frames=json.loads((scan/m['frames']).read_text(encoding='utf8'))['frames'];records=json.loads(Path(manifest).read_text(encoding='utf8'))['records']
    source={str((scan/f['image']['path']).resolve()).casefold():f for f in frames};result={}
    if len(source)!=len(frames):raise ValueError('duplicate scan image')
    for r in records:
        if r.get('excluded') or not r.get('work_image'):continue
        f=source.get(str(Path(r['source']).resolve()).casefold())
        if f is None:raise ValueError('prepared source is not a scan image')
        work=Path(r['work_image']);parts=work.as_posix().split('/')
        if 'images' not in parts:raise ValueError('invalid work image path')
        name='/'.join(parts[parts.index('images')+1:])
        if not name or name in result or '..' in Path(name).parts:raise ValueError('duplicate work image')
        from PIL import Image
        with Image.open(images/name) as im:
            if list(im.size)!=r['work_size']:raise ValueError('prepared image size mismatch')
        result[name]=(f,r['work_size'])
    if len(result)<2:raise ValueError('at least two prepared images required')
    return result

def features(scan,manifest,colmap,database,images,gpu,max_features):
    mapping_data=mapping(scan,manifest,images)
    command=[str(colmap),'feature_extractor','--database_path',str(database),'--image_path',str(images),'--ImageReader.single_camera_per_image','1','--ImageReader.camera_model','PINHOLE','--FeatureExtraction.use_gpu',str(gpu),'--FeatureExtraction.num_threads','12','--SiftExtraction.max_num_features',str(max_features)]
    subprocess.run(command,check=True,stdout=sys.stderr,stderr=sys.stderr)
    with pc.Database.open(database) as db:
        db_images=db.read_all_images()
        if set(i.name for i in db_images)!=set(mapping_data):raise ValueError('database images do not match prepared images')
        if len({i.camera_id for i in db_images})!=len(db_images):raise ValueError('database cameras are shared')
        for i in db_images:
            f,size=mapping_data[i.name];c=db.read_camera(i.camera_id);c.model='PINHOLE';c.width=size[0];c.height=size[1];c.params=scaled_intrinsics(f,size);c.has_prior_focal_length=True;db.update_camera(c)
    return {'images':len(mapping_data),'database':str(database)}

def depth_sample(scan,frame,x,y):
    d=frame['depth'];c=frame['confidence'];w,h=d['width'],d['height']
    depth=np.fromfile(Path(scan)/d['path'],dtype='<f4');confidence=np.fromfile(Path(scan)/c['path'],dtype=np.uint8)
    if depth.size!=w*h or confidence.size!=w*h or (c['width'],c['height'])!=(w,h):raise ValueError('invalid depth layout')
    return float(depth[y*w+x]),int(confidence[y*w+x])

def sparse(scan,manifest,database,images,output):
    mapping_data=mapping(scan,manifest,images);model=pc.Reconstruction();output=Path(output);modeldir=output/'0';modeldir.mkdir(parents=True,exist_ok=True)
    with pc.Database.open(database) as db:
        db_images=db.read_all_images()
        if set(i.name for i in db_images)!=set(mapping_data):raise ValueError('database images do not match prepared images')
        for camera in db.read_all_cameras():model.add_camera(camera)
        for rig in db.read_all_rigs():model.add_rig(rig)
        for frame in db.read_all_frames():model.add_frame(frame)
        for image in db_images:
            f,size=mapping_data[image.name];camera=db.read_camera(image.camera_id)
            if camera.model_name!='PINHOLE' or not np.allclose(camera.params,scaled_intrinsics(f,size),rtol=1e-6,atol=1e-6):raise ValueError('database calibration mismatch')
            keypoints=db.read_keypoints(image.image_id)
            image.points2D=pc.Point2DList([pc.Point2D(xy=xy[:2]) for xy in keypoints])
            model.add_image(image)
            frame=model.frame(image.frame_id);rig=model.rig(frame.rig_id)
            if not rig.is_ref_sensor(camera.sensor_id) or len(frame.image_ids)!=1:raise ValueError('unsupported shared frame or non-reference sensor')
            frame.rig_from_world=pc.Rigid3d(colmap_pose(f['cameraToWorld'])[:3,:]);model.register_frame(frame.frame_id)
    options=pc.IncrementalPipelineOptions();options.ba_refine_focal_length=False;options.ba_refine_principal_point=False;options.ba_refine_extra_params=False;options.fix_existing_frames=True;options.triangulation.ignore_two_view_tracks=False
    model=pc.triangulate_points(model,str(database),str(images),str(modeldir),options=options,refine_intrinsics=False)
    if model.num_points3D()==0:raise ValueError('no triangulated feature tracks')
    for image in model.images.values():
        f,size=mapping_data[image.name]
        if not np.allclose(image.cam_from_world().matrix(),colmap_pose(f['cameraToWorld'])[:3,:],rtol=1e-7,atol=1e-7) or not np.allclose(model.cameras[image.camera_id].params,scaled_intrinsics(f,size),rtol=1e-7,atol=1e-7):raise ValueError('camera pose or calibration changed during triangulation')
    model.write(str(modeldir))
    errors=[]; depth_cache={}
    for point in model.points3D.values():
        for element in point.track.elements:
            image=model.images[element.image_id];f,size=mapping_data[image.name];xy=image.point2D(element.point2D_idx).xy;d=f['depth'];x=int(xy[0]*d['width']/size[0]);y=int(xy[1]*d['height']/size[1])
            if not (0<=x<d['width'] and 0<=y<d['height']):continue
            if image.name not in depth_cache:
                depth_cache[image.name]=(np.memmap(Path(scan)/d['path'],dtype='<f4',mode='r'),np.memmap(Path(scan)/f['confidence']['path'],dtype=np.uint8,mode='r'))
            depths,confidences=depth_cache[image.name];depth=float(depths[y*d['width']+x]);confidence=int(confidences[y*d['width']+x]);projected=(image.cam_from_world().rotation.matrix()@point.xyz+image.cam_from_world().translation)[2]
            if np.isfinite(depth) and depth>0 and confidence>0 and projected>0:errors.append(abs(float(projected)-depth))
    report={'comparisons':len(errors),'medianAbsoluteErrorMetres':float(np.median(errors)) if errors else None,'scaleMeasured':False,'purpose':'diagnostic'}
    (output/'depth-report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    return {'images':model.num_reg_images(),'points':model.num_points3D(),'depthReport':str(output/'depth-report.json')}

def main():
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='command',required=True)
    for name in ('features','sparse'):
        s=sub.add_parser(name)
        for flag in ('scan','manifest','database','images'):s.add_argument('--'+flag,required=True)
        if name=='features':
            s.add_argument('--colmap',required=True);s.add_argument('--gpu',required=True,choices=['0','1']);s.add_argument('--max-features',required=True,choices=['8192','16384'])
        else:s.add_argument('--output',required=True)
    a=p.parse_args()
    try:
        if a.command=='features':result=features(a.scan,a.manifest,a.colmap,a.database,a.images,a.gpu,a.max_features)
        else:
            saved=os.dup(1)
            try:
                os.dup2(2,1);result=sparse(a.scan,a.manifest,a.database,a.images,a.output)
            finally:os.dup2(saved,1);os.close(saved)
        print(json.dumps(result));return 0
    except Exception as e:print(str(e),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
