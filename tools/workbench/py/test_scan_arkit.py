import unittest, tempfile, json, zipfile, hashlib, io, sys, subprocess, copy
from pathlib import Path
import numpy as np
from PIL import Image
sys.path.insert(0,str(Path(__file__).parent))

class ScanTests(unittest.TestCase):
    def make_archive(self, root, mutate=None):
        import scan_archive as s
        b=io.BytesIO(); Image.new('RGB',(4,3)).save(b,format='JPEG')
        frame={'id':'f1','timestamp':1.,'image':{'path':'images/a.jpg','width':4,'height':3},'intrinsics':[2,0,0,0,2,0,2,1,1], 'cameraToWorld':np.eye(4).flatten(order='F').tolist(),'depth':{'path':'depth/a.bin','width':2,'height':1,'format':'float32_le'},'confidence':{'path':'confidence/a.bin','width':2,'height':1,'format':'uint8'}}
        second=copy.deepcopy(frame);second['id']='f2';second['timestamp']=2.;second['image']['path']='images/b.jpg';second['depth']['path']='depth/b.bin';second['confidence']['path']='confidence/b.bin'
        b2=io.BytesIO();Image.new('RGB',(4,3),(100,20,30)).save(b2,format='JPEG')
        files={'frames.json':json.dumps({'frames':[frame,second]}).encode(),'mesh.json':b'{"vertices":[],"normals":[],"faces":[]}','edits.json':b'{"crop":null,"measurements":[]}','images/a.jpg':b.getvalue(),'depth/a.bin':np.array([1,2],dtype='<f4').tobytes(),'confidence/a.bin':bytes([1,2]),'images/b.jpg':b2.getvalue(),'depth/b.bin':np.array([1,2],dtype='<f4').tobytes(),'confidence/b.bin':bytes([1,2])}
        m={'format':'gaussroom_scan_v1','scanId':'b13fe83a-a22f-48b9-bc99-c01bd133c941','sessionId':'b13fe83a-a22f-48b9-bc99-c01bd133c941','createdAt':'2026-01-01T00:00:00Z','device':{'model':'iPhone','systemVersion':'17'},'coordinateSystem':{'handedness':'right','up':'y','units':'metres','cameraForward':'-z','matrixOrder':'column-major','imageOrientation':'sensor'},'frames':'frames.json','mesh':'mesh.json','edits':'edits.json','files':[{'path':k,'bytes':len(v),'sha256':hashlib.sha256(v).hexdigest()} for k,v in files.items()]}
        if mutate: mutate(m,files,frame)
        z=root/'scan.zip'
        with zipfile.ZipFile(z,'w') as out:
            out.writestr('manifest.json',json.dumps(m));
            for k,v in files.items():out.writestr(k,v)
        return z
    def test_valid_and_hash_failure(self):
        import scan_archive as s
        with tempfile.TemporaryDirectory() as t:
            p=Path(t); z=self.make_archive(p); self.assertEqual(s.extract_scan(z,p/'out')['frameCount'],2)
            z=self.make_archive(p,lambda m,f,fr:m['files'][0].update(sha256='0'*64))
            with self.assertRaises(ValueError):s.extract_scan(z,p/'bad')
            self.assertFalse((p/'bad').exists())
    def test_reject_hash_valid_unindexed_image(self):
        import scan_archive as s
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)
            def orphan(m,files,frame):
                files['images/orphan.jpg']=files['images/a.jpg']
                data=files['images/orphan.jpg']
                m['files'].append({'path':'images/orphan.jpg','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
            for name in ('images/orphan.jpg','Images/orphan.jpg'):
                def add_orphan(m,files,frame):
                    orphan(m,files,frame)
                    if name != 'images/orphan.jpg':
                        files[name]=files.pop('images/orphan.jpg');m['files'][-1]['path']=name
                with self.assertRaisesRegex(ValueError,'unindexed image'):s.extract_scan(self.make_archive(p,add_orphan),p/'out')
                self.assertFalse((p/'out').exists())
            def extra_metadata(m,files,frame):
                data=b'additional metadata';files['extra.json']=data
                m['files'].append({'path':'extra.json','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
            s.extract_scan(self.make_archive(p,extra_metadata),p/'valid')
            self.assertEqual((p/'valid'/'extra.json').read_bytes(),b'additional metadata')

    def test_reject_image_directory_file_used_only_as_depth(self):
        import scan_archive as s
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)
            def wrong_role(m,files,frame):
                image=files['images/a.jpg']
                image+=bytes((-len(image))%4)
                files['images/depth.jpg']=image
                data=json.loads(files['frames.json']); first=data['frames'][0]
                first['depth'].update(path='images/depth.jpg',width=len(image)//4,height=1)
                first['confidence'].update(width=len(image)//4,height=1)
                files[first['confidence']['path']]=bytes(len(image)//4)
                files['frames.json']=json.dumps(data).encode()
                m['files']=[{'path':name,'bytes':len(value),'sha256':hashlib.sha256(value).hexdigest()} for name,value in files.items()]
            with self.assertRaisesRegex(ValueError,'unindexed image'):s.extract_scan(self.make_archive(p,wrong_role),p/'out')
            self.assertFalse((p/'out').exists())

    def test_paths_and_links_and_limits(self):
        import scan_archive as s
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)
            for name in ('../escape','C:/escape','images/../../escape','images\\escape'):
                with zipfile.ZipFile(p/'x.zip','w') as z:z.writestr(name,'x')
                with self.assertRaises(ValueError):s.extract_scan(p/'x.zip',p/'out')
            with zipfile.ZipFile(p/'x.zip','w') as z:
                info=zipfile.ZipInfo('link'); info.create_system=3; info.external_attr=(0o120777<<16); z.writestr(info,'target')
            with self.assertRaises(ValueError):s.extract_scan(p/'x.zip',p/'out')
            z=self.make_archive(p)
            with self.assertRaises(ValueError):s.extract_scan(z,p/'out',max_total_bytes=10)
    def test_existing_output_and_cli_result(self):
        import scan_archive as s
        with tempfile.TemporaryDirectory() as t:
            p=Path(t);z=self.make_archive(p);(p/'existing').mkdir();(p/'existing'/'keep').write_text('keep')
            with self.assertRaises(ValueError):s.extract_scan(z,p/'existing')
            self.assertEqual((p/'existing'/'keep').read_text(),'keep')
            cli=subprocess.run([sys.executable,'-X','utf8','-B',str(Path(s.__file__)),'--archive',str(z),'--output',str(p/'cli')],capture_output=True,text=True,encoding='utf8')
            self.assertEqual(cli.returncode,0,cli.stderr);self.assertEqual(json.loads(cli.stdout)['frameCount'],2)

    def test_invalid_camera_calibration(self):
        import scan_archive as s
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)
            def corrupt(m,files,frame):
                data=json.loads(files['frames.json']);data['frames'][0]['cameraToWorld'][0]=0
                files['frames.json']=json.dumps(data).encode();m['files'][0].update(bytes=len(files['frames.json']),sha256=hashlib.sha256(files['frames.json']).hexdigest())
            with self.assertRaises(ValueError):s.extract_scan(self.make_archive(p,corrupt),p/'out')

    def test_reject_one_frame_or_unsupported_image_location(self):
        import scan_archive as s
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)
            def one(m,files,frame):
                data=json.loads(files['frames.json']);data['frames']=data['frames'][:1]
                files['frames.json']=json.dumps(data).encode();m['files'][0].update(bytes=len(files['frames.json']),sha256=hashlib.sha256(files['frames.json']).hexdigest())
            with self.assertRaises(ValueError):s.extract_scan(self.make_archive(p,one),p/'out')
            def duplicate(m,files,frame):
                files['images/b.jpg']=files['images/a.jpg']
                for entry in m['files']:
                    if entry['path']=='images/b.jpg':entry.update(bytes=len(files['images/b.jpg']),sha256=hashlib.sha256(files['images/b.jpg']).hexdigest())
            with self.assertRaises(ValueError):s.extract_scan(self.make_archive(p,duplicate),p/'out')
            def nested(m,files,frame):
                data=json.loads(files['frames.json']);data['frames'][0]['image']['path']='images/nested/a.jpg';files['images/nested/a.jpg']=files.pop('images/a.jpg')
                for entry in m['files']:
                    if entry['path']=='images/a.jpg':entry['path']='images/nested/a.jpg'
                files['frames.json']=json.dumps(data).encode();m['files'][0].update(bytes=len(files['frames.json']),sha256=hashlib.sha256(files['frames.json']).hexdigest())
            with self.assertRaises(ValueError):s.extract_scan(self.make_archive(p,nested),p/'out')

    def test_reject_truncated_jpeg_with_matching_hash(self):
        import scan_archive as s
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)
            def corrupt(m,files,frame):
                files['images/a.jpg']=files['images/a.jpg'][:-2]
                for entry in m['files']:
                    if entry['path']=='images/a.jpg':entry.update(bytes=len(files['images/a.jpg']),sha256=hashlib.sha256(files['images/a.jpg']).hexdigest())
            with self.assertRaises((ValueError,OSError)):s.extract_scan(self.make_archive(p,corrupt),p/'out')
            self.assertFalse((p/'out').exists())

    def test_reject_missing_or_unsupported_confidence_format(self):
        import scan_archive as s
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)
            for value in (None,'unsupported_uint16_be'):
                with self.subTest(format=value):
                    def corrupt(m,files,frame):
                        data=json.loads(files['frames.json']);confidence=data['frames'][0]['confidence']
                        if value is None:del confidence['format']
                        else:confidence['format']=value
                        files['frames.json']=json.dumps(data).encode();m['files'][0].update(bytes=len(files['frames.json']),sha256=hashlib.sha256(files['frames.json']).hexdigest())
                    output=p/('missing' if value is None else 'unsupported')
                    with self.assertRaises(ValueError):s.extract_scan(self.make_archive(p,corrupt),output)
                    self.assertFalse(output.exists())

    def test_frame_consistency(self):
        import scan_archive as s
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)
            def corrupt(m,files,frame):
                data=json.loads(files['frames.json']);data['frames'][0]['depth']['width']=3; files['frames.json']=json.dumps(data).encode(); m['files'][0].update(bytes=len(files['frames.json']),sha256=hashlib.sha256(files['frames.json']).hexdigest())
            with self.assertRaises(ValueError):s.extract_scan(self.make_archive(p,corrupt),p/'out')

class CalibrationTests(unittest.TestCase):
    def test_pose_and_scaled_intrinsics(self):
        import arkit_reconstruct as a
        pose=np.eye(4);pose[:3,3]=[1,2,3]
        np.testing.assert_allclose(a.colmap_pose(pose.flatten(order='F')),np.diag([1,-1,-1,1])@np.linalg.inv(pose))
        f={'image':{'width':400,'height':300},'intrinsics':[200,0,0,0,210,0,100,120,1]}
        np.testing.assert_allclose(a.scaled_intrinsics(f,[200,150]),[100,105,50,60])
    def test_depth_diagnostic_layout(self):
        import arkit_reconstruct as a
        with tempfile.TemporaryDirectory() as t:
            p=Path(t);(p/'d').write_bytes(np.array([1,2,3,4],dtype='<f4').tobytes());(p/'c').write_bytes(bytes([2,0,1,2]))
            f={'depth':{'path':'d','width':2,'height':2},'confidence':{'path':'c','width':2,'height':2,'format':'uint8'}}
            result=a.depth_sample(p,f,1,0)
            self.assertEqual(result,(2.,0))
            self.assertEqual(a.depth_sample(p,f,0,1),(3.,1))

if __name__=='__main__':unittest.main()

class SparseTests(unittest.TestCase):
    def test_real_tracks_with_nonsequential_ids(self):
        import pycolmap as pc
        import arkit_reconstruct as a
        with tempfile.TemporaryDirectory() as t:
            p=Path(t);scan=p/'scan';scan.mkdir();images=p/'images';images.mkdir();(scan/'depth').mkdir();(scan/'confidence').mkdir()
            frames=[];records=[];points=np.array([[x,y,4+0.03*(x+y)] for x in np.linspace(-1,1,80) for y in np.linspace(-.7,.7,80)])
            dbpath=p/'db.sqlite'
            with pc.Database.open(dbpath) as db:
                for idx,(iid, fid, cameraid, center) in enumerate([(11,37,5,0.),(3,91,8,0.6)]):
                    name=f'{idx}.jpg';Image.new('RGB',(640,480),(idx*50,0,0)).save(images/name)
                    focal=500+idx*70;camera=pc.Camera(camera_id=cameraid,model='PINHOLE',width=640,height=480,params=[focal,focal,320,240]);db.write_camera(camera,True)
                    rig=pc.Rig(rig_id=cameraid);rig.add_ref_sensor(camera.sensor_id);db.write_rig(rig,True)
                    frame=pc.Frame(frame_id=fid,rig_id=cameraid);frame.add_data_id(pc.data_t(camera.sensor_id,iid));db.write_frame(frame,True)
                    image=pc.Image(name=name,camera_id=cameraid,image_id=iid);image.frame_id=fid;db.write_image(image,True)
                    xy=np.column_stack((focal*(points[:,0]-center)/points[:,2]+320,focal*points[:,1]/points[:,2]+240)).astype('float32');db.write_keypoints(iid,xy)
                    c2w=np.diag([1.,-1.,-1.,1.]);c2w[0,3]=center
                    dep=f'depth/{idx}';conf=f'confidence/{idx}';(scan/dep).write_bytes(np.full((2,2),4,dtype='<f4').tobytes());(scan/conf).write_bytes(bytes([2]*4))
                    frames.append({'id':str(idx),'image':{'path':'images/'+name,'width':640,'height':480},'intrinsics':[focal,0,0,0,focal,0,320,240,1],'cameraToWorld':c2w.flatten(order='F').tolist(),'depth':{'path':dep,'width':2,'height':2},'confidence':{'path':conf,'width':2,'height':2,'format':'uint8'}})
                    records.append({'source':str(scan/'images'/name),'work_image':'images/'+name,'work_size':[640,480],'excluded':None})
                match=np.column_stack([np.arange(len(points)),np.arange(len(points))]).astype('uint32');db.write_matches(3,11,match)
                geo=pc.TwoViewGeometry();geo.config=2;geo.inlier_matches=match;db.write_two_view_geometry(3,11,geo)
            (scan/'images').mkdir()
            for f in frames:
                f['timestamp']=int(f['id'])+1;f['depth']['format']='float32_le'
                (scan/f['image']['path']).write_bytes((images/Path(f['image']['path']).name).read_bytes())
            (scan/'frames.json').write_text(json.dumps({'frames':frames}));(scan/'mesh.json').write_text('{"vertices":[],"normals":[],"faces":[]}');(scan/'edits.json').write_text('{"crop":null,"measurements":[]}')
            files=[x for x in scan.rglob('*') if x.is_file()];sm={'format':'gaussroom_scan_v1','scanId':'b13fe83a-a22f-48b9-bc99-c01bd133c941','sessionId':'b13fe83a-a22f-48b9-bc99-c01bd133c941','createdAt':'2026-01-01T00:00:00Z','device':{'model':'iPhone','systemVersion':'17'},'coordinateSystem':{'handedness':'right','up':'y','units':'metres','cameraForward':'-z','matrixOrder':'column-major','imageOrientation':'sensor'},'frames':'frames.json','mesh':'mesh.json','edits':'edits.json','files':[{'path':x.relative_to(scan).as_posix(),'bytes':x.stat().st_size,'sha256':hashlib.sha256(x.read_bytes()).hexdigest()} for x in files]}
            (scan/'manifest.json').write_text(json.dumps(sm));manifest=p/'prep.json';manifest.write_text(json.dumps({'records':records}))
            a.sparse(scan,manifest,dbpath,images,p/'out')
            model=pc.Reconstruction(str(p/'out'/'0'))
            self.assertGreaterEqual(model.num_points3D(),6000)
            self.assertEqual(set(model.images),{3,11})
            self.assertAlmostEqual(model.images[3].cam_from_world().translation[0],-.6,places=5)
            self.assertTrue(all(len(point.track.elements)>=2 for point in model.points3D.values()))
            np.testing.assert_allclose(model.cameras[8].params,[570,570,320,240])
            cli=subprocess.run([sys.executable,'-X','utf8','-B',str(Path(a.__file__)),'sparse','--scan',str(scan),'--manifest',str(manifest),'--database',str(dbpath),'--images',str(images),'--output',str(p/'cli')],capture_output=True,text=True,encoding='utf8')
            self.assertEqual(cli.returncode,0,cli.stderr);self.assertGreaterEqual(json.loads(cli.stdout)['points'],6000)
            report=json.loads((p/'out'/'depth-report.json').read_text());self.assertGreater(report['comparisons'],0)
            gate_dir=p/'gate'
            gate_cli=subprocess.run([sys.executable,'-X','utf8','-B',str(Path(a.__file__).with_name('gate_model.py')),'--model-root',str(p/'out'),'--database',str(dbpath),'--manifest',str(manifest),'--out',str(gate_dir)],capture_output=True,text=True,encoding='utf8')
            self.assertEqual(gate_cli.returncode,0,gate_cli.stderr)
            gate=json.loads((gate_dir/'gate.json').read_text(encoding='utf8'))
            self.assertEqual(gate['verdict'],'pass',gate['message']);self.assertTrue(gate['geometryConnected'])
            self.assertEqual(gate['thresholds'],{'minRatio':0.8,'maxError':2.0,'minPoints':5000,'fragmentShare':0.05})
            self.assertGreaterEqual(gate['models'][0]['points'],6000)
            executable=Path(__file__).resolve().parents[3]/'tools/colmap-4.2.1-cuda/bin/colmap.exe'
            if executable.exists():
                undistorted=p/'undistorted';undistorted.mkdir()
                undistort_cli=subprocess.run([str(executable),'image_undistorter','--image_path',str(images),'--input_path',str(p/'out'/'0'),'--output_path',str(undistorted),'--output_type','COLMAP'],capture_output=True,text=True,encoding='utf8')
                self.assertEqual(undistort_cli.returncode,0,undistort_cli.stderr)
                for file in ('cameras.bin','images.bin','points3D.bin'):
                    self.assertTrue((undistorted/'sparse'/file).is_file(),file)
                undistorted_model=pc.Reconstruction(str(undistorted/'sparse'))
                self.assertEqual(undistorted_model.num_reg_images(),2)
                self.assertGreaterEqual(undistorted_model.num_points3D(),6000)
                for image in undistorted_model.images.values():
                    with Image.open(undistorted/'images'/image.name) as output_image:output_image.load()
                feature_cli=subprocess.run([sys.executable,'-X','utf8','-B',str(Path(a.__file__)),'features','--scan',str(scan),'--manifest',str(manifest),'--database',str(p/'features.db'),'--images',str(images),'--colmap',str(executable),'--gpu','0','--max-features','8192'],capture_output=True,text=True,encoding='utf8')
                self.assertEqual(feature_cli.returncode,0,feature_cli.stderr);self.assertEqual(json.loads(feature_cli.stdout)['images'],2)
                with pc.Database.open(p/'features.db') as extracted:
                    for item in extracted.read_all_images():
                        camera=extracted.read_camera(item.camera_id);focal=500 if item.name=='0.jpg' else 570;np.testing.assert_allclose(camera.params,[focal,focal,320,240])

class RevalidationTests(unittest.TestCase):
    def test_reject_tampered_source_after_import(self):
        import scan_archive as s
        with tempfile.TemporaryDirectory() as t:
            p=Path(t); z=ScanTests().make_archive(p);s.extract_scan(z,p/'out')
            (p/'out'/'frames.json').write_text('{"frames":[]}',encoding='utf8')
            with self.assertRaises(ValueError):s.verify_scan(p/'out')
