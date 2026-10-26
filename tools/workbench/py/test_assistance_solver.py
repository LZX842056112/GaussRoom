import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
import numpy as np
import pycolmap as pc
from PIL import Image
from assistance_inputs import fingerprint_inputs,sha256_file
from assisted_database import build_geometry_database
from assisted_reconstruct import solve_assisted,verify_final_bridges,load_context,calibrate_final_scale,local_repair_improved
from assisted_candidates import compare_regions,model_signature

ROOT=Path(__file__).resolve().parents[3]
CONFIG=json.loads((Path(__file__).parents[1]/'assistance-config.json').read_text())


def fixture(root,points=200,region_count=2):
    source=root/'source';source.mkdir();images=source/'images';images.mkdir()
    options=pc.SyntheticDatasetOptions()
    options.num_rigs=1;options.num_frames_per_rig=6;options.num_points3D=points
    options.two_view_geometry_has_relative_pose=True
    pc.set_random_seed(42)
    with pc.Database.open(str(source/'database.db')) as db: model=pc.synthesize_dataset(options,db)
    model_path=source/'sparse/0';model_path.mkdir(parents=True);model.write(str(model_path))
    catalog=[];records=[]
    for image_id,view in sorted(model.images.items()):
        path=images/view.name;Image.new('RGB',(1024,768),(image_id*20,40,60)).save(path)
        digest=sha256_file(path)
        catalog.append({'photoId':digest,'name':view.name,'path':str(path),'sourceSha256':digest,'workSha256':digest,'width':1024,'height':768})
        records.append({'work_image':'images/'+view.name,'sha256':digest,'excluded':None})
    manifest=source/'manifest.json';manifest.write_text(json.dumps({'records':records}),encoding='utf8')
    regions=[{'id':f'r{i}','model':'0','component':i,'photoIds':[p['photoId'] for j,p in enumerate(catalog) if j//(6//region_count)==i]} for i in range(region_count)]
    by_name={p['name']:p['photoId'] for p in catalog}
    landmarks=[]
    for point_id,point in sorted(model.points3D.items()):
        obs=[{'photoId':by_name[model.images[e.image_id].name],'xy':model.images[e.image_id].point2D(e.point2D_idx).xy.tolist(),'origin':'manual'} for e in point.track.elements]
        if len(obs)==6:landmarks.append({'id':f'point-{point_id}','objectId':None,'observations':obs})
        if len(landmarks)==12:break
    request={'version':1,'inputRevision':1,'catalog':catalog,'regions':regions,'models':[{'name':'0','path':str(model_path)}],
      'database':str(source/'database.db'),'images':str(images),'manifest':str(manifest),'config':CONFIG,
      'constraints':{'landmarks':landmarks,'objects':[],'answers':[],'questions':[],'dimensions':[]},
      'colmap':str(ROOT/'tools/colmap-4.2.1-cuda/bin/colmap.exe'),'outputRoot':str(root/'attempt')}
    request['inputFingerprint']=fingerprint_inputs(catalog,Path(request['database']),[model_path],CONFIG)
    return request,model


class SolverTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.request,self.model=fixture(self.root)

    def test_calibration_failure_stops_before_global_mapper(self):
        commands=[];before=Path(self.request['database']).read_bytes()
        def failed(command,**kwargs):
            commands.append(command)
            raise subprocess.CalledProcessError(9,command)
        result=solve_assisted(self.request,run=failed)
        self.assertEqual(result['outcome'],'failed')
        self.assertTrue(any(c[1]=='view_graph_calibrator' for c in commands))
        calibration=next(c for c in commands if c[1]=='view_graph_calibrator')
        self.assertIn('--relpose_min_num_inliers',calibration)
        self.assertEqual(calibration[calibration.index('--relpose_min_num_inliers')+1],str(CONFIG['minSharedPoints']))
        self.assertFalse(any(c[1]=='global_mapper' for c in commands))
        self.assertEqual(Path(self.request['database']).read_bytes(),before)

    def test_final_weak_bridge_is_not_verified(self):
        model=Path(self.request['models'][0]['path'])
        strong=verify_final_bridges(model,self.request,CONFIG)
        self.assertTrue(strong['accepted'])
        request={**self.request,'constraints':{**self.request['constraints'],'landmarks':self.request['constraints']['landmarks'][:7]}}
        self.assertFalse(verify_final_bridges(model,request,CONFIG)['accepted'])

    def test_final_verification_uses_the_actual_shared_bundle_adjusted_point(self):
        selected={int(p['id'].split('-')[-1]):p for p in self.request['constraints']['landmarks']}
        for point_id in list(self.model.points3D):
            if point_id not in selected:self.model.delete_point3D(point_id)
        for image_id,view in self.model.images.items():
            frame=self.model.frames[view.frame_id]
            frame.rig_from_world=pc.Rigid3d(pc.Rotation3d(),np.array([-.1*(image_id-1),0,0]))
        for index,(point_id,landmark) in enumerate(selected.items()):
            point=self.model.points3D[point_id];point.xyz=np.array([-.9+(index%4)*.6,-.8+(index//4)*.8,5])
            observations=[]
            for element in point.track.elements:
                image=self.model.images[element.image_id];camera=self.model.cameras[image.camera_id];pose=image.cam_from_world()
                xy=camera.img_from_cam(pose.rotation.matrix()@point.xyz+pose.translation)
                local=(element.image_id-1)%3;delta=(.8 if index%2 else -.8)*(1 if element.image_id<=3 else -1)
                xy[0]+=delta*(1 if local==0 else -1 if local==2 else 0)
                image.point2D(element.point2D_idx).xy=xy
                observations.append({'photoId':next(p['photoId'] for p in self.request['catalog'] if p['name']==image.name),'xy':xy.tolist(),'origin':'manual'})
            landmark['observations']=observations
        output=self.root/'actual-shared';output.mkdir();self.model.write(str(output))
        result=verify_final_bridges(output,self.request,CONFIG)
        self.assertTrue(result['accepted'],result.get('missing'))

    def test_final_shared_points_are_counted_by_physical_point_not_annotation_id(self):
        options=pc.SyntheticDatasetOptions();options.num_rigs=1;options.num_frames_per_rig=16;options.num_points3D=1000
        model=pc.synthesize_dataset(options)
        ids=sorted(model.images);first=ids[:4];second=ids[8:12];wanted=set(first+second)
        catalog=[{'photoId':view.name,'name':view.name,'width':1024,'height':768} for view in model.images.values()]
        landmarks=[]
        for point in model.points3D.values():
            entries={e.image_id:e.point2D_idx for e in point.track.elements}
            if not wanted<=set(entries):continue
            for half in [0,1]:
                observations=[{'photoId':model.images[image_id].name,'xy':model.images[image_id].point2D(entries[image_id]).xy.tolist(),'origin':'manual'} for image_id in first[half*2:half*2+2]+second[half*2:half*2+2]]
                landmarks.append({'id':f'label-{len(landmarks)}','objectId':None,'observations':observations})
            if len(landmarks)==8:break
        self.assertEqual(len(landmarks),8)
        path=self.root/'duplicate-labels';path.mkdir();model.write(str(path))
        request={**self.request,'catalog':catalog,'regions':[{'id':'a','photoIds':[model.images[i].name for i in ids[:8]]},{'id':'b','photoIds':[model.images[i].name for i in ids[8:]]}],
                 'constraints':{**self.request['constraints'],'landmarks':landmarks}}
        result=verify_final_bridges(path,request,CONFIG)
        self.assertFalse(result['accepted'],'eight labels on four physical points do not meet the eight-point requirement')

    def test_final_landmark_lookup_uses_the_database_pixel_precision(self):
        by_name={p['name']:p['photoId'] for p in self.request['catalog']}
        for landmark in self.request['constraints']['landmarks']:
            point=self.model.points3D[int(landmark['id'].split('-')[-1])];observations=[]
            for element in point.track.elements:
                image=self.model.images[element.image_id];pixel=image.point2D(element.point2D_idx);xy=pixel.xy.copy()
                base=np.floor(xy[0]*1000)/1000
                options=[base+.0005+delta for delta in [-1e-9,1e-9,-1e-10,1e-10]]
                xy[0]=next(v for v in options if round(v,3)!=round(float(np.float32(v)),3))
                pixel.xy=xy.astype(np.float32).astype(float)
                observations.append({'photoId':by_name[image.name],'xy':xy.tolist(),'origin':'manual'})
            landmark['observations']=observations
        path=self.root/'float32-measurements';path.mkdir();self.model.write(str(path))
        result=verify_final_bridges(path,self.request,CONFIG)
        self.assertTrue(result['accepted'],'float32 storage rounding must not discard measured observations')

    def test_local_position_review_attempts_geometry_instead_of_always_refusing(self):
        request={**self.request,'regions':[{'id':'local','model':'0','component':0,'photoIds':[p['photoId'] for p in self.request['catalog']]}]}
        commands=[]
        def failed(command,**kwargs):
            commands.append(command);raise subprocess.CalledProcessError(9,command)
        result=solve_assisted(request,run=failed)
        self.assertEqual(result['outcome'],'failed')
        self.assertTrue(any(c[1]=='view_graph_calibrator' for c in commands))

    def test_final_scale_requires_measured_reliable_endpoints(self):
        path=self.root/'scaled';path.mkdir();self.model.write(str(path))
        point_id=next(iter(self.model.points3D));before=self.model.points3D[point_id].xyz.copy()
        points={'a':{'region':{'xyz':[0,0,0],'accepted':True}},'b':{'region':{'xyz':[2,0,0],'accepted':True}}}
        dimension={'id':'width','value':90,'unit':'cm','source':'estimated','endpoints':[{'landmarkId':'a'},{'landmarkId':'b'}]}
        self.assertEqual(calibrate_final_scale(path,[dimension],points,CONFIG)['scale'],'unmeasured')
        result=calibrate_final_scale(path,[{**dimension,'source':'measured'}],points,CONFIG)
        self.assertEqual(result['scale'],'calibrated');self.assertAlmostEqual(result['factor'],0.45)
        np.testing.assert_allclose(pc.Reconstruction(str(path)).points3D[point_id].xyz,before*0.45)

    def test_connected_model_does_not_claim_local_repair_without_improvement(self):
        self.assertFalse(local_repair_improved(0.02,0.01,CONFIG))
        self.assertFalse(local_repair_improved(3,3,CONFIG))
        self.assertTrue(local_repair_improved(3,1,CONFIG))

    def test_final_disconnected_model_cannot_pass(self):
        saved=[(p.xyz.copy(),p.color.copy(),[(e.image_id,e.point2D_idx) for e in p.track.elements]) for p in self.model.points3D.values()]
        for point_id in list(self.model.points3D):self.model.delete_point3D(point_id)
        for xyz,color,elements in saved:
            for ids in ({1,2,3},{4,5,6}):
                track=pc.Track()
                for image_id,index in elements:
                    if image_id in ids:track.add_element(image_id,index)
                if len(track.elements)>=2:self.model.add_point3D(xyz,track,color)
        path=self.root/'disconnected';path.mkdir();self.model.write(str(path))
        result=verify_final_bridges(path,self.request,CONFIG)
        self.assertFalse(result['accepted']);self.assertEqual(result['geometryComponentSizes'],[3,3])

    def test_unreliable_source_poses_compare_incremental_before_requesting_more_points(self):
        good=self.root/'good-source';good.mkdir();self.model.write(str(good))
        for image_id in [4,5,6]:
            frame=self.model.frames[self.model.images[image_id].frame_id]
            pose=frame.rig_from_world
            frame.rig_from_world=pc.Rigid3d(pose.rotation,pose.translation+np.array([image_id*8,(-1)**image_id*9,3]))
        self.model.write(self.request['models'][0]['path'])
        self.request['inputFingerprint']=fingerprint_inputs(self.request['catalog'],Path(self.request['database']),[Path(self.request['models'][0]['path'])],CONFIG)
        commands=[]
        def candidate(command,**kwargs):
            commands.append(command)
            if command[1]=='mapper':
                target=Path(command[command.index('--output_path')+1])/'0';target.mkdir(parents=True)
                pc.Reconstruction(str(good)).write(str(target))
                return subprocess.CompletedProcess(command,0)
            raise subprocess.CalledProcessError(9,command)
        result=solve_assisted(self.request,run=candidate)
        self.assertTrue(any(c[1]=='mapper' for c in commands))
        self.assertTrue(any(c[1]=='view_graph_calibrator' for c in commands),'a valid regional alternative must reach the copied-DB calibration stage')
        self.assertEqual(result['outcome'],'failed')

    def test_frozen_regional_candidates_are_rechecked_without_rerunning_incremental_mapper(self):
        good=self.root/'cached-regional';good.mkdir();self.model.write(str(good))
        digest=hashlib.sha256()
        for name in ['cameras.bin','frames.bin','images.bin','points3D.bin','rigs.bin']:
            if (good/name).exists():digest.update(name.encode());digest.update(b'\0');digest.update((good/name).read_bytes())
        self.request['regionalCandidates']=[{'name':'incremental-cached','path':str(good),'modelSignature':digest.hexdigest()}]
        for image_id in [4,5,6]:
            frame=self.model.frames[self.model.images[image_id].frame_id];pose=frame.rig_from_world
            frame.rig_from_world=pc.Rigid3d(pose.rotation,pose.translation+np.array([image_id*8,(-1)**image_id*9,3]))
        self.model.write(self.request['models'][0]['path'])
        self.request['inputFingerprint']=fingerprint_inputs(self.request['catalog'],Path(self.request['database']),[Path(self.request['models'][0]['path'])],CONFIG)
        commands=[]
        def stop(command,**kwargs):commands.append(command);raise subprocess.CalledProcessError(9,command)
        result=solve_assisted(self.request,run=stop)
        self.assertFalse(any(c[1]=='mapper' for c in commands))
        self.assertTrue(any(c[1]=='view_graph_calibrator' for c in commands))
        self.assertEqual(result['outcome'],'failed')

    def test_local_review_does_not_drop_one_side_of_the_requested_observations(self):
        for image_id in [4,5,6]:
            frame=self.model.frames[self.model.images[image_id].frame_id];pose=frame.rig_from_world
            frame.rig_from_world=pc.Rigid3d(pose.rotation,pose.translation+np.array([image_id*8,(-1)**image_id*9,3]))
        self.model.write(self.request['models'][0]['path'])
        self.request['regions']=[{'id':'local','model':'0','component':0,'photoIds':[p['photoId'] for p in self.request['catalog']]}]
        self.request['inputFingerprint']=fingerprint_inputs(self.request['catalog'],Path(self.request['database']),[Path(self.request['models'][0]['path'])],CONFIG)
        commands=[]
        def failed(command,**kwargs):
            commands.append(command);raise subprocess.CalledProcessError(9,command)
        result=solve_assisted(self.request,run=failed)
        self.assertEqual(result['outcome'],'needs_input')
        self.assertFalse(commands,'two or three agreeing views cannot stand in for the requested two-sided observations')

    def test_local_review_checks_each_photo_with_a_full_set_of_manual_markers(self):
        frame=self.model.frames[self.model.images[6].frame_id];pose=frame.rig_from_world
        frame.rig_from_world=pc.Rigid3d(pose.rotation,pose.translation+np.array([30,9,3]))
        self.model.write(self.request['models'][0]['path'])
        self.request['regions']=[{'id':'local','model':'0','component':0,'photoIds':[p['photoId'] for p in self.request['catalog']]}]
        self.request['inputFingerprint']=fingerprint_inputs(self.request['catalog'],Path(self.request['database']),[Path(self.request['models'][0]['path'])],CONFIG)
        def failed(command,**kwargs):raise subprocess.CalledProcessError(9,command)
        result=solve_assisted(self.request,run=failed)
        self.assertEqual(result['outcome'],'needs_input')
        self.assertTrue(any(m.get('code')=='local_photo_unsupported' for m in result['missing']))

    def test_all_three_regions_are_required(self):
        temp=self.root/'three';temp.mkdir();request,model=fixture(temp,region_count=3)
        result=verify_final_bridges(Path(request['models'][0]['path']),request,CONFIG)
        self.assertTrue(result['accepted']);self.assertEqual(len(result['regions']),3)

    def test_tracks_have_one_observation_per_photo(self):
        context=load_context(self.request)
        point=next(iter(context['models'][0]['reconstruction'].points3D.values()))
        element=point.track.elements[0];point.track.add_element(element.image_id,element.point2D_idx)
        output=self.root/'geometry.db'
        alignments={'transforms':{r['id']:np.eye(4).tolist() for r in self.request['regions']}}
        observations={'landmarks':self.request['constraints']['landmarks'],'views':context['views'],'catalog':self.request['catalog']}
        report=build_geometry_database(Path(self.request['database']),output,context['models'],observations,alignments,self.request['constraints'],CONFIG)
        self.assertGreaterEqual(report['duplicateObservationsRemoved'],1)
        self.assertTrue(all(len(t)==len({o['imageId'] for o in t}) for t in report['bridgeTracks'].values()))
        with closing(sqlite3.connect(output)) as db:
            self.assertEqual(db.execute('pragma quick_check').fetchone()[0],'ok')
            for rows,cols,data in db.execute('select rows,cols,data from two_view_geometries'):
                self.assertEqual(cols,2);self.assertEqual(len(data),rows*cols*4)

    def test_database_rejects_manual_tracks_that_override_negative_identity_answers(self):
        context=load_context(self.request);denied=[self.request['catalog'][i]['photoId'] for i in [0,3]]
        constraints={**self.request['constraints'],'questions':[{'id':'denied','photoIds':denied}],'answers':[{'questionId':'denied','value':'no'}]}
        observations={'landmarks':constraints['landmarks'],'views':context['views'],'catalog':self.request['catalog']}
        output=self.root/'rejected-geometry.db';transforms={'transforms':{r['id']:np.eye(4).tolist() for r in self.request['regions']}}
        with self.assertRaisesRegex(ValueError,'否定'):build_geometry_database(Path(self.request['database']),output,context['models'],observations,transforms,constraints,CONFIG)
        self.assertFalse(output.exists(),'contradictory manual facts must be rejected before writing a database')

    def test_conflicting_manual_identity_waits_before_any_native_command(self):
        denied=[self.request['catalog'][i]['photoId'] for i in [0,3]]
        self.request['constraints'].update(questions=[{'id':'denied','photoIds':denied}],answers=[{'questionId':'denied','value':'no'}])
        commands=[]
        def forbidden(command,**kwargs):commands.append(command);raise subprocess.CalledProcessError(9,command)
        result=solve_assisted(self.request,run=forbidden)
        self.assertEqual(result['outcome'],'needs_input');self.assertEqual(commands,[])
        self.assertTrue(any(m['code']=='conflicting_observations' for m in result['missing']))

    def test_regional_candidates_do_not_mix_intrinsics_from_unselected_views(self):
        source=self.root/'two-cameras.db';options=pc.SyntheticDatasetOptions()
        options.num_rigs=2;options.num_frames_per_rig=3;options.num_points3D=200
        with pc.Database.open(str(source)) as database:model=pc.synthesize_dataset(options,database)
        base=self.root/'two-cameras';base.mkdir();model.write(str(base))
        original=pc.Reconstruction(str(base));bad=pc.Reconstruction(str(base))
        camera_ids=sorted(original.cameras);second=camera_ids[1]
        bad.cameras[second].params[0]*=2
        catalog=[{'photoId':view.name,'name':view.name} for view in original.images.values()]
        regions=[{'id':str(camera),'model':'bad' if camera==camera_ids[0] else 'good','photoIds':[v.name for v in original.images.values() if v.camera_id==camera]} for camera in camera_ids]
        views={}
        models=[]
        for region in regions:
            reconstruction=bad if region['model']=='bad' else original
            models.append({'name':region['model'],'regions':[region],'reconstruction':reconstruction})
            for view in reconstruction.images.values():
                if view.name in region['photoIds']:views[view.name]={'camera':reconstruction.cameras[view.camera_id],'camFromWorld':view.cam_from_world().matrix(),'imageId':view.image_id,'model':region['model'],'regionId':region['id']}
        output=self.root/'selected-intrinsics.db'
        build_geometry_database(source,output,models,{'catalog':catalog,'views':views,'landmarks':[]},{'transforms':{r['id']:np.eye(4).tolist() for r in regions}},{},CONFIG)
        with closing(sqlite3.connect(output)) as database:params=np.frombuffer(database.execute('select params from cameras where camera_id=?',(second,)).fetchone()[0],dtype='<f8')
        np.testing.assert_allclose(params,original.cameras[second].params)

    def test_regional_comparison_prefers_more_shared_evidence_over_first_pass(self):
        options=pc.SyntheticDatasetOptions();options.num_rigs=2;options.num_frames_per_rig=3;options.num_points3D=1000
        pc.set_random_seed(42);model=pc.synthesize_dataset(options)
        for camera in model.cameras.values():camera.params=np.array([800.,512.,384.,0.])
        ids=sorted(model.images);by_image={image_id:str(image_id) for image_id in ids}
        for j,image_id in enumerate(ids):model.frames[model.images[image_id].frame_id].rig_from_world=pc.Rigid3d(pc.Rotation3d(),np.array([-.25*j,0.,0.]))
        selected=[]
        for point_id,point in model.points3D.items():
            if {e.image_id for e in point.track.elements}!=set(ids):continue
            j=len(selected);point.xyz=np.array([-.9+(j%4)*.6,-.9+(j//4)*.8,5. if j<8 else 6.+(j-8)*.7])
            obs=[]
            for e in point.track.elements:
                image=model.images[e.image_id];pose=image.cam_from_world();xy=model.cameras[image.camera_id].img_from_cam(pose.rotation.matrix()@point.xyz+pose.translation)
                image.point2D(e.point2D_idx).xy=xy;obs.append({'photoId':by_image[e.image_id],'xy':xy.tolist(),'origin':'manual'})
            selected.append({'id':f'fit-{j}','observations':obs,'objectId':None})
            if len(selected)==12:break
        self.assertEqual(len(selected),12)
        good=self.root/'strong-candidate';good.mkdir();model.write(str(good))
        model.cameras[model.images[ids[0]].camera_id].params[0]*=.8
        bad=self.root/'weak-candidate';bad.mkdir();model.write(str(bad))
        regions=[{'id':f'r{i}','model':'weak','photoIds':[by_image[v] for v in ids[i*3:i*3+3]]} for i in [0,1]]
        catalog=[{'photoId':by_image[v],'name':model.images[v].name} for v in ids]
        request={**self.request,'catalog':catalog,'models':[{'name':'weak','path':str(bad)}],'regions':regions,'constraints':{},
                 'regionalCandidates':[{'name':'strong','path':str(good),'modelSignature':model_signature(good)}]}
        output=self.root/'candidate-ranking';output.mkdir()
        from assisted_reconstruct import _align
        result=compare_regions(request,selected,output,CONFIG,lambda *a,**kw:self.fail('frozen candidates must not launch mapper'),load_context,_align)
        self.assertIsNotNone(result);self.assertEqual(len(result['aligned']['edges'][0]['sharedPointIds']),12,'do not stop at eight points when a later candidate supports all twelve')

    @unittest.skipUnless(os.environ.get('GAUSSROOM_NATIVE_TEST')=='1','Run explicitly with GAUSSROOM_NATIVE_TEST=1')
    def test_native_calibration_global_mapping_and_final_validation(self):
        temp=self.root/'native';temp.mkdir();request,_=fixture(temp,points=6200)
        result=solve_assisted(request)
        self.assertEqual(result['outcome'],'verified',result.get('missing') or result.get('error'))
        self.assertTrue(result['bridges']['accepted']);self.assertEqual(result['gate']['models'][0]['geometryComponentSizes'],[6])

    @unittest.skipUnless(os.environ.get('GAUSSROOM_NATIVE_TEST')=='1','Run explicitly with GAUSSROOM_NATIVE_TEST=1')
    def test_native_automatic_regional_recovery_still_finishes_with_global_mapping(self):
        temp=self.root/'native-recovery';temp.mkdir();request,model=fixture(temp,points=6200)
        for image_id in [4,5,6]:
            frame=model.frames[model.images[image_id].frame_id];pose=frame.rig_from_world
            frame.rig_from_world=pc.Rigid3d(pose.rotation,pose.translation+np.array([image_id*8,(-1)**image_id*9,3]))
        model.write(request['models'][0]['path'])
        request['inputFingerprint']=fingerprint_inputs(request['catalog'],Path(request['database']),[Path(request['models'][0]['path'])],CONFIG)
        result=solve_assisted(request)
        self.assertEqual(result['outcome'],'verified',result.get('missing') or result.get('error'))
        self.assertIsNotNone(result.get('regionalComparison',{}).get('selected'))
        self.assertEqual(result['gate']['models'][0]['geometryComponentSizes'],[6])
        command=json.loads((Path(request['outputRoot'])/'summary/global-command.json').read_text())
        self.assertEqual(command[1],'global_mapper')

    @unittest.skipUnless(os.environ.get('GAUSSROOM_NATIVE_TEST')=='1','Run explicitly with GAUSSROOM_NATIVE_TEST=1')
    def test_renamed_photos_run_the_same_native_global_pipeline(self):
        temp=self.root/'renamed';temp.mkdir();request,model=fixture(temp,points=6200)
        catalog={p['name']:p for p in request['catalog']}
        records=[]
        with closing(sqlite3.connect(request['database'])) as db:
            for image_id,view in model.images.items():
                previous=view.name;name=f'unrelated-name-{image_id:04d}.png'
                (Path(request['images'])/previous).rename(Path(request['images'])/name)
                view.name=name;db.execute('update images set name=? where image_id=?',(name,image_id))
                catalog[previous]['name']=name;catalog[previous]['path']=str(Path(request['images'])/name)
                records.append({'work_image':'images/'+name,'sha256':catalog[previous]['photoId'],'excluded':None})
            db.commit()
        model.write(request['models'][0]['path'])
        Path(request['manifest']).write_text(json.dumps({'records':records}),encoding='utf8')
        request['inputFingerprint']=fingerprint_inputs(request['catalog'],Path(request['database']),[Path(request['models'][0]['path'])],CONFIG)
        before=sha256_file(request['database']);result=solve_assisted(request)
        self.assertEqual(result['outcome'],'verified',result.get('missing') or result.get('error'))
        self.assertEqual(result['gate']['models'][0]['geometryComponentSizes'],[6])
        self.assertTrue(result['bridges']['accepted']);self.assertEqual(sha256_file(request['database']),before)


if __name__=='__main__':unittest.main()
