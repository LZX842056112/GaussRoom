"""Capture map tests use real pycolmap models, not generated display poses."""
import importlib.util
import tempfile
import unittest
import json
import sqlite3
import os
import subprocess
import sys
import time
import shutil
from contextlib import closing
from pathlib import Path
import numpy as np
import pycolmap as pc
from PIL import Image

spec=importlib.util.spec_from_file_location('capture_analysis',Path(__file__).with_name('capture_analysis.py'))
a=importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

class CaptureAnalysisTests(unittest.TestCase):
    def test_map_uses_actual_names_ids_axis_and_point_limit(self):
        opts=pc.SyntheticDatasetOptions(num_rigs=1,num_frames_per_rig=4,num_points3D=10020)
        model=pc.synthesize_dataset(opts)
        images=list(model.images.values())
        files=[{'id':f'photo-{i}','name':image.name} for i,image in enumerate(images)]
        result=a.export_map([model],files)
        self.assertEqual(len(result['cameras']),4)
        self.assertEqual(len(result['points']),10000)
        image=images[0];camera=next(c for c in result['cameras'] if c['fileId']=='photo-0')
        expected=np.eye(4);expected[:3,:]=image.cam_from_world().matrix()
        change=np.diag([1,-1,-1,1])
        np.testing.assert_allclose(np.array(camera['cameraToWorld']).reshape(4,4,order='F'),change@np.linalg.inv(expected)@change)
        self.assertEqual(result['scale'],'unmeasured')
        self.assertEqual(result['coordinateSystem']['cameraForward'],'-z')

    def test_largest_component_only_and_nonsequential_ids(self):
        model=pc.synthesize_dataset(pc.SyntheticDatasetOptions(num_rigs=1,num_frames_per_rig=5,num_points3D=30))
        ids=sorted(model.images)
        # Keep images 2,4,5. Images 2 and 4 share tracks; image 5 is disconnected.
        for image_id in [ids[0],ids[2]]:model.deregister_frame(model.images[image_id].frame_id)
        isolated=ids[-1]
        for point_id in list(model.points3D):
            point=model.points3D[point_id]
            for e in list(point.track.elements):
                if e.image_id==isolated:model.delete_observation(e.image_id,e.point2D_idx)
        files=[{'id':str(i),'name':model.images[i].name} for i in ids]
        result=a.export_map([model],files)
        self.assertEqual({c['fileId'] for c in result['cameras']},{str(ids[1]),str(ids[3])})
        self.assertEqual(set(result['unlocalized']),{str(ids[0]),str(ids[2]),str(ids[4])})

    def test_new_pairs_are_bounded_and_cached_pairs_are_not_repeated(self):
        files=[{'id':str(i),'name':f'{i}.jpg','dhash':i} for i in range(40)]
        pairs=a.candidate_pairs(files,set(str(i) for i in range(39)),set())
        self.assertEqual(len(pairs),15)
        self.assertTrue(all('39.jpg' in pair for pair in pairs))
        self.assertEqual(a.candidate_pairs(files,set(str(i) for i in range(39)),set(pairs)),[])

    def test_duplicate_hint_requires_nearby_localized_poses_and_similar_direction(self):
        def camera(name,x,turn=False):
            matrix=np.eye(4);matrix[0,3]=x
            if turn:matrix[:3,:3]=np.diag([-1,1,-1])
            return {'fileId':name,'cameraToWorld':matrix.flatten(order='F').tolist()}
        cameras=[camera('first',0),camera('near',.01),camera('turned',.01,True),camera('far',10)]
        self.assertEqual(a.suspected_duplicates(cameras),[{'fileId':'near','similarTo':'first'}])

    def test_thumbnail_applies_orientation_and_bounds_size(self):
        with tempfile.TemporaryDirectory() as scratch:
            root=Path(scratch);photo=Image.new('RGB',(600,300),'red');exif=Image.Exif();exif[274]=6;photo.save(root/'in.jpg',exif=exif)
            a.thumbnail(root/'in.jpg',root/'out.jpg')
            with Image.open(root/'out.jpg') as out:self.assertEqual(out.size,(128,256));self.assertEqual(out.format,'JPEG')

    @unittest.skipUnless(os.name=='nt','Windows process-tree recovery')
    def test_crashed_parent_does_not_leave_analysis_or_its_child_running(self):
        import ctypes
        from ctypes import wintypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD];kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        worker='''import os,sys,time,json,subprocess
sys.path.insert(0,sys.argv[1])
from capture_analysis import watch_parent
watch_parent(int(sys.argv[2]))
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],creationflags=subprocess.CREATE_NO_WINDOW)
print(json.dumps([os.getpid(),child.pid]),flush=True)
time.sleep(60)
'''
        parent_code='''const {spawn}=require('node:child_process');
const child=spawn(process.argv[2],['-B','-c',process.argv[3],process.argv[1],String(process.pid)],{windowsHide:true,stdio:['ignore','pipe','inherit']});
child.stdout.pipe(process.stdout);setInterval(()=>{},1000);
'''
        if not shutil.which('node'):self.skipTest('Node executable is unavailable')
        parent=subprocess.Popen(['node','-e',parent_code,str(Path(__file__).parent),sys.executable,worker],stdout=subprocess.PIPE,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
        handles=[];pids=[]
        try:
            pids=json.loads(parent.stdout.readline());handles=[kernel.OpenProcess(0x100000,False,pid) for pid in pids]
            self.assertTrue(all(handles));parent.terminate();parent.wait(timeout=5)
            for _ in range(100):
                if all(kernel.WaitForSingleObject(handle,0)==0 for handle in handles):break
                time.sleep(.05)
            self.assertTrue(all(kernel.WaitForSingleObject(handle,0)==0 for handle in handles),'analysis or native child survived its server')
        finally:
            if parent.poll() is None:parent.kill();parent.wait(timeout=5)
            parent.stdout.close()
            for pid,handle in zip(pids,handles):
                if handle and kernel.WaitForSingleObject(handle,0)!=0:subprocess.run(['taskkill','/PID',str(pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
                if handle:kernel.CloseHandle(handle)

    def test_real_colmap_mapping_keeps_existing_database_features(self):
        colmap=Path(__file__).resolve().parents[3]/'tools/colmap-4.2.1-cuda/bin/colmap.exe'
        if not colmap.exists():self.skipTest('local COLMAP executable is unavailable')
        with tempfile.TemporaryDirectory() as scratch:
            root=Path(scratch);work=root/'work';work.mkdir();images=work/'images';images.mkdir()
            with pc.Database.open(work/'features.db') as db:
                model=pc.synthesize_dataset(pc.SyntheticDatasetOptions(num_rigs=1,num_frames_per_rig=6,num_points3D=150),db)
            records=[];inputs=[]
            with closing(sqlite3.connect(work/'features.db')) as db:
                for index,(image_id,image) in enumerate(model.images.items()):
                    file_id=f'fixture-{index}';name=file_id+'.jpg';db.execute('UPDATE images SET name=? WHERE image_id=?',(name,image_id))
                    Image.new('RGB',(1024,768),'white').save(images/name)
                    records.append({'id':file_id,'name':name,'dhash':0,'sha256':str(index)})
                    inputs.append({'id':file_id,'path':str(images/name),'sha256':str(index)})
                before=list(db.execute('SELECT image_id,rows,cols,length(data) FROM keypoints ORDER BY image_id'))
                db.commit()
            (work/'cache.json').write_text(json.dumps({'files':{f['id']:f for f in records},'pairs':[],'processed':[f['id'] for f in records]}))
            request={'workDir':str(work),'files':inputs,'colmap':str(colmap),'gpu':0}
            first=a.analyze(request)
            self.assertEqual(len(first['cameras']),6)
            self.assertGreater(len(first['points']),20)
            second=a.analyze(request)
            self.assertEqual(len(second['cameras']),6)
            with closing(sqlite3.connect(work/'features.db')) as db:
                self.assertEqual(before,list(db.execute('SELECT image_id,rows,cols,length(data) FROM keypoints ORDER BY image_id')))

    def test_real_feature_extraction_and_candidate_matching_are_cached(self):
        colmap=Path(__file__).resolve().parents[3]/'tools/colmap-4.2.1-cuda/bin/colmap.exe'
        if not colmap.exists():self.skipTest('local COLMAP executable is unavailable')
        with tempfile.TemporaryDirectory() as scratch:
            root=Path(scratch);image=Image.fromarray(np.random.default_rng(41).integers(0,256,(1200,2100,3),dtype=np.uint8));files=[]
            for index in range(3):
                path=root/f'input-{index}.jpg';image.crop((index*100,0,index*100+1800,1200)).save(path,quality=94)
                files.append({'id':f'view-{index}','path':str(path),'sha256':str(index)})
            commands=[]
            def run(command,**kwargs):
                commands.append(command[1])
                if command[1]!='mapper':return subprocess.run(command,**kwargs)
            request={'workDir':str(root/'work'),'files':files,'colmap':str(colmap),'gpu':0}
            a.analyze(request,run=run)
            self.assertEqual(commands,['feature_extractor','matches_importer','mapper'])
            with closing(sqlite3.connect(root/'work/features.db')) as db:
                rows=list(db.execute('SELECT image_id,rows,length(data) FROM keypoints ORDER BY image_id'))
                self.assertEqual(len(rows),3);self.assertTrue(all(row[1]>0 for row in rows))
                self.assertGreater(db.execute('SELECT count(*) FROM two_view_geometries WHERE rows>0').fetchone()[0],0)
            for path in (root/'work/images').iterdir():
                with Image.open(path) as picture:self.assertEqual(max(picture.size),1600)
            commands.clear();a.analyze(request,run=run);self.assertEqual(commands,['mapper'])
            with closing(sqlite3.connect(root/'work/features.db')) as db:
                self.assertEqual(rows,list(db.execute('SELECT image_id,rows,length(data) FROM keypoints ORDER BY image_id')))

    def test_real_incremental_round_registers_two_added_photos(self):
        colmap=Path(__file__).resolve().parents[3]/'tools/colmap-4.2.1-cuda/bin/colmap.exe'
        if not colmap.exists():self.skipTest('local COLMAP executable is unavailable')
        with tempfile.TemporaryDirectory() as scratch:
            root=Path(scratch);work=root/'work';work.mkdir();images=work/'images';images.mkdir()
            with pc.Database.open(work/'features.db') as db:
                model=pc.synthesize_dataset(pc.SyntheticDatasetOptions(num_rigs=1,num_frames_per_rig=6,num_points3D=150),db)
            records=[];files=[]
            with closing(sqlite3.connect(work/'features.db')) as db:
                for index,(image_id,image) in enumerate(model.images.items()):
                    name=f'added-{index}.jpg';db.execute('UPDATE images SET name=? WHERE image_id=?',(name,image_id));Image.new('RGB',(1024,768),'white').save(images/name)
                    records.append({'id':f'added-{index}','name':name,'dhash':0,'sha256':str(index)})
                    files.append({'id':f'added-{index}','path':str(images/name),'sha256':str(index)})
                db.commit()
            (work/'cache.json').write_text(json.dumps({'files':{f['id']:f for f in records},'pairs':[],'processed':[f['id'] for f in records]}))
            seed=work/'seed';seed.mkdir();image_list=work/'first-four.txt';image_list.write_text('\n'.join(f['name'] for f in records[:4])+'\n')
            subprocess.run([str(colmap),'mapper','--database_path',str(work/'features.db'),'--image_path',str(images),'--output_path',str(seed),
                            '--Mapper.image_list_path',str(image_list),'--Mapper.min_model_size','2','--Mapper.multiple_models','0','--Mapper.num_threads','4'],
                           check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            seed_model=pc.Reconstruction(next(p for p in seed.iterdir() if p.is_dir() and (p/'images.bin').exists()))
            self.assertEqual(seed_model.num_reg_images(),4);(work/'model').mkdir();seed_model.write(work/'model')
            result=a.analyze({'workDir':str(work),'files':files,'colmap':str(colmap),'gpu':0})
            self.assertEqual(len(result['cameras']),6,'incremental mapper must publish newly registered views')
            self.assertEqual(pc.Reconstruction(work/'model').num_reg_images(),6)

if __name__=='__main__':unittest.main()
