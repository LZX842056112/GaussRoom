"""Bounded, incremental COLMAP analysis for a photo-upload batch.

These poses are display estimates. They are not training input or metric poses.
"""
import argparse
import json
import shutil
import subprocess
import time
import os
import signal
import threading
from pathlib import Path

import numpy as np
import pycolmap as pc
from PIL import Image, ImageOps
from prepare_project import read_oriented


def watch_parent(parent_pid):
    """A crashed Node server must not leave a COLMAP tree holding the GPU."""
    if os.name=='nt':
        import ctypes
        from ctypes import wintypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
        kernel.OpenProcess.restype=wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD]
        kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        class BasicLimits(ctypes.Structure):
            _fields_=[('process_time',ctypes.c_longlong),('job_time',ctypes.c_longlong),('flags',wintypes.DWORD),
                      ('min_working_set',ctypes.c_size_t),('max_working_set',ctypes.c_size_t),('active_processes',wintypes.DWORD),
                      ('affinity',ctypes.c_size_t),('priority',wintypes.DWORD),('scheduling',wintypes.DWORD)]
        class IOCounters(ctypes.Structure):
            _fields_=[(name,ctypes.c_ulonglong) for name in ('read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes')]
        class ExtendedLimits(ctypes.Structure):
            _fields_=[('basic',BasicLimits),('io',IOCounters),('process_memory',ctypes.c_size_t),('job_memory',ctypes.c_size_t),
                      ('peak_process_memory',ctypes.c_size_t),('peak_job_memory',ctypes.c_size_t)]
        kernel.CreateJobObjectW.argtypes=[ctypes.c_void_p,wintypes.LPCWSTR];kernel.CreateJobObjectW.restype=wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes=[wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
        kernel.AssignProcessToJobObject.argtypes=[wintypes.HANDLE,wintypes.HANDLE]
        kernel.GetCurrentProcess.restype=wintypes.HANDLE
        job=kernel.CreateJobObjectW(None,None);limits=ExtendedLimits();limits.basic.flags=0x2000 # KILL_ON_JOB_CLOSE
        if not job or not kernel.SetInformationJobObject(job,9,ctypes.byref(limits),ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job,kernel.GetCurrentProcess()):
            if job:kernel.CloseHandle(job)
            raise ctypes.WinError(ctypes.get_last_error())
        handle=kernel.OpenProcess(0x100000,False,parent_pid)
        def wait():
            if handle:
                kernel.WaitForSingleObject(handle,0xffffffff);kernel.CloseHandle(handle)
            kernel.CloseHandle(job) # Terminates this process and all native descendants atomically.
    else:
        def wait():
            while True:
                try:os.kill(parent_pid,0)
                except ProcessLookupError:break
                time.sleep(.5)
            if os.getpgrp()==os.getpid():os.killpg(os.getpid(),signal.SIGKILL)
            os._exit(1)
    threading.Thread(target=wait,daemon=True).start()


def oriented(path, ffmpeg=None):
    path=Path(path)
    if path.suffix.lower() in {'.heic','.heif'}:
        return read_oriented(path, ffmpeg)['image']
    with Image.open(path) as source:
        source.load()
        return ImageOps.exif_transpose(source).convert('RGB')


def thumbnail(source, output, ffmpeg=None):
    image=oriented(source,ffmpeg)
    image.thumbnail((256,256),Image.Resampling.LANCZOS)
    image.save(output,'JPEG',quality=80)


def dhash(image):
    pixels=np.asarray(image.convert('L').resize((9,8),Image.Resampling.LANCZOS))
    value=0
    for bit in (pixels[:,1:]>pixels[:,:-1]).flatten():value=(value<<1)|int(bit)
    return value


def candidate_pairs(files, processed_ids, existing_pairs):
    """Match each new view to ten previous views and five older hash candidates."""
    pairs=set()
    for index,item in enumerate(files):
        if item['id'] in processed_ids:continue
        recent=files[max(0,index-10):index]
        historical=sorted(files[:max(0,index-10)],key=lambda old:((int(item['dhash'])^int(old['dhash'])).bit_count(),old['name']))[:5]
        for other in recent+historical:
            pair=tuple(sorted((item['name'],other['name'])))
            if pair not in existing_pairs:pairs.add(pair)
    return sorted(pairs)


def _component(model, known_names):
    active={i for i,image in model.images.items() if image.has_pose and image.name in known_names}
    parent={i:i for i in active}
    def find(i):
        while parent[i]!=i:parent[i]=parent[parent[i]];i=parent[i]
        return i
    for point in model.points3D.values():
        views=[e.image_id for e in point.track.elements if e.image_id in active]
        for other in views[1:]:parent[find(other)]=find(views[0])
    groups={}
    for i in sorted(active):groups.setdefault(find(i),set()).add(i)
    return max(groups.values(),key=lambda g:(len(g),-min(g)),default=set())


def export_map(models,files):
    """Export one connected component, using real image IDs and names."""
    names={f['name']:f['id'] for f in files}
    candidates=[(model,_component(model,names)) for model in models]
    model,component=max(candidates,key=lambda item:(len(item[1]),item[0].num_points3D()),default=(None,set()))
    change=np.diag([1.,-1.,-1.,1.]);cameras=[];points=[]
    if model is not None:
        for image_id in sorted(component):
            image=model.images[image_id];camera=model.cameras[image.camera_id]
            pose=np.eye(4);pose[:3,:]=image.cam_from_world().matrix()
            converted=change@np.linalg.inv(pose)@change
            intrinsics=[float(camera.focal_length_x),float(camera.focal_length_y),float(camera.principal_point_x),float(camera.principal_point_y)]
            if not np.isfinite(converted).all() or not np.isfinite(intrinsics).all():continue
            cameras.append({'fileId':names[image.name],'cameraToWorld':converted.flatten(order='F').tolist(),
                            'intrinsics':intrinsics,'width':camera.width,'height':camera.height})
        available=[point for _,point in sorted(model.points3D.items())
                   if len({e.image_id for e in point.track.elements if e.image_id in component})>=2 and np.isfinite(point.xyz).all()]
        if len(available)>10000:available=[available[i] for i in np.linspace(0,len(available)-1,10000,dtype=int)]
        points=[{'position':(change[:3,:3]@point.xyz).tolist(),'color':[int(c) for c in point.color]} for point in available]
    localized={c['fileId'] for c in cameras}
    return {'scale':'unmeasured','coordinateSystem':{'up':'y','cameraForward':'-z','matrixOrder':'column-major','units':'arbitrary'},
            'cameras':cameras,'points':points,'unlocalized':[f['id'] for f in files if f['id'] not in localized],
            'processedFileIds':[f['id'] for f in files],'suspectedDuplicates':[]}


def atomic_json(path,value):
    path=Path(path);temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value,allow_nan=False),encoding='utf8');temporary.replace(path)


def suspected_duplicates(cameras):
    """Pose hints use model-relative distances. They never remove input photos."""
    if len(cameras)<2:return []
    poses=[np.array(c['cameraToWorld']).reshape(4,4,order='F') for c in cameras]
    centers=np.array([pose[:3,3] for pose in poses])
    threshold=max(float(np.linalg.norm(np.ptp(centers,axis=0)))*.02,1e-6)
    hints=[]
    for index,pose in enumerate(poses):
        for previous in range(index):
            other=poses[previous]
            if np.linalg.norm(pose[:3,3]-other[:3,3])<=threshold and np.dot(pose[:3,2],other[:3,2])>=np.cos(np.deg2rad(15)):
                hints.append({'fileId':cameras[index]['fileId'],'similarTo':cameras[previous]['fileId']});break
    return hints


def analyze(request,run=subprocess.run):
    work=Path(request['workDir']);work.mkdir(parents=True,exist_ok=True)
    image_dir=work/'images';image_dir.mkdir(exist_ok=True)
    cache_path=work/'cache.json'
    cache=json.loads(cache_path.read_text(encoding='utf8')) if cache_path.exists() else {'files':{},'pairs':[],'processed':[]}
    files=[];new_names=[]
    for item in request['files']:
        file_id=item['id'];name=file_id+'.jpg';previous=cache['files'].get(file_id)
        if previous and previous['sha256']!=item['sha256']:raise ValueError('immutable capture input changed')
        if previous and (image_dir/name).exists():record=previous
        else:
            image=oriented(item['path'],request.get('ffmpeg'));image.thumbnail((1600,1600),Image.Resampling.LANCZOS)
            record={'id':file_id,'name':name,'sha256':item['sha256'],'dhash':dhash(image)}
            image.save(image_dir/name,'JPEG',quality=92)
        files.append(record)
        if file_id not in cache.get('processed',[]):new_names.append(name)
    # File removal must reset the cache at the session manager boundary.
    if set(cache.get('processed',[]))-{f['id'] for f in files}:raise ValueError('capture cache needs invalidation')
    database=work/'features.db';colmap=str(request['colmap']);gpu=str(int(bool(request.get('gpu',0))))
    options={'check':True,'stdout':subprocess.DEVNULL,'stderr':subprocess.DEVNULL,'creationflags':getattr(subprocess,'CREATE_NO_WINDOW',0)}
    if new_names:
        image_list=work/'new-images.txt';image_list.write_text('\n'.join(new_names)+'\n',encoding='utf8')
        run([colmap,'feature_extractor','--database_path',str(database),'--image_path',str(image_dir),
             '--image_list_path',str(image_list),'--ImageReader.single_camera_per_image','1',
             '--FeatureExtraction.max_image_size','1600','--FeatureExtraction.num_threads','4',
             '--FeatureExtraction.use_gpu',gpu,'--SiftExtraction.max_num_features','4096'],**options)
    previous_pairs={tuple(pair) for pair in cache['pairs']}
    pairs=candidate_pairs(files,set(cache.get('processed',[])),previous_pairs)
    if pairs:
        pair_list=work/'new-pairs.txt';pair_list.write_text(''.join(f'{a} {b}\n' for a,b in pairs),encoding='utf8')
        run([colmap,'matches_importer','--database_path',str(database),'--match_list_path',str(pair_list),
             '--match_type','pairs','--FeatureMatching.use_gpu',gpu,'--FeatureMatching.num_threads','4'],**options)
    cache={'files':{f['id']:f for f in files},'pairs':sorted(previous_pairs|set(pairs)),'processed':[f['id'] for f in files]}
    atomic_json(cache_path,cache)
    # Each mapping output is fresh. The previous reconstruction stays intact if mapping fails.
    sparse=work/f'sparse-{time.time_ns()}';sparse.mkdir()
    previous=work/'model'
    command=[colmap,'mapper','--database_path',str(database),'--image_path',str(image_dir),'--output_path',str(sparse),
             '--Mapper.num_threads','4','--Mapper.multiple_models','0','--Mapper.min_model_size','2',
             '--Mapper.max_runtime_seconds','100','--Mapper.ba_global_max_num_iterations','30']
    if (previous/'images.bin').exists():command+=['--input_path',str(previous)]
    run(command,**options)
    # Incremental mapper writes at output_path itself; a fresh mapper uses subdirectories.
    paths=([sparse] if (sparse/'images.bin').exists() else [])+[p for p in sparse.iterdir() if p.is_dir() and (p/'images.bin').exists()]
    models=[pc.Reconstruction(p) for p in paths]
    if not models and (previous/'images.bin').exists():models=[pc.Reconstruction(previous)]
    result=export_map(models,files)
    if models:
        known={f['name'] for f in files};best=max(models,key=lambda model:len(_component(model,known)))
        temporary=work/'model-next';shutil.rmtree(temporary,ignore_errors=True);temporary.mkdir();best.write(temporary)
        shutil.rmtree(previous,ignore_errors=True);temporary.replace(previous)
    shutil.rmtree(sparse)
    result['suspectedDuplicates']=suspected_duplicates(result['cameras'])
    return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--request',type=Path);parser.add_argument('--thumbnail',type=Path);parser.add_argument('--parent-pid',type=int)
    parser.add_argument('--output',type=Path,required=True);parser.add_argument('--ffmpeg')
    args=parser.parse_args()
    if args.parent_pid:watch_parent(args.parent_pid)
    if args.thumbnail:thumbnail(args.thumbnail,args.output,args.ffmpeg)
    elif args.request:atomic_json(args.output,analyze(json.loads(args.request.read_text(encoding='utf8'))))
    else:parser.error('--request or --thumbnail is required')


if __name__=='__main__':main()
