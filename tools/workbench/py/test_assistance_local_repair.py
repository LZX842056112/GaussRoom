import copy
import os
import subprocess
import sys
import json
import textwrap
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import numpy as np
import pycolmap as pc
from assistance_inputs import sha256_file
from test_assistance_solver import fixture,CONFIG
from assisted_local_repair import refine_local_geometry,validate_local_scope


class LocalRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.request,self.clean=fixture(self.root,points=500)
        self.catalog=self.request['catalog'];self.marks=self.request['constraints']['landmarks']
        self.scope={'photoIds':[p['photoId'] for p in self.catalog[3:]],'referencePhotoIds':[p['photoId'] for p in self.catalog[:3]],'contextPhotoIds':[],'refineCornerIds':[],'excludedPlanarInteriors':[]}

    def test_connected_local_pose_recovery_uses_measured_pixels_and_preserves_source(self):
        source=pc.Reconstruction(self.clean);seed=pc.Reconstruction(self.clean)
        seed.transform(pc.Sim3d(1.7,pc.Rotation3d(np.array([.1,.2,-.1])),np.array([2.,-.5,.3])))
        for im in source.images.values():
            if im.name not in {p['name'] for p in self.catalog[3:]}:continue
            pose=im.cam_from_world();source.frame(im.frame_id).set_cam_from_world(im.camera_id,pc.Rigid3d(pose.rotation,pose.translation+np.array([.3,-.2,.1])))
        before={im.name:im.cam_from_world().matrix().copy() for im in source.images.values()};database=Path(self.request['database']);db_sha=sha256_file(database)
        result,receipt=refine_local_geometry(source,seed,self.catalog,self.marks,self.scope,CONFIG)
        self.assertTrue(receipt['manualAnchor']['accepted'])
        self.assertTrue(receipt['boundary']['accepted'])
        self.assertEqual(receipt['targetPhotoCount'],3)
        self.assertTrue(all(v>=8 for v in receipt['targetPhotoSupport'].values()))
        for im in result.images.values():
            truth=self.clean.find_image_with_name(im.name)
            np.testing.assert_allclose(im.cam_from_world().matrix(),truth.cam_from_world().matrix(),atol=1e-4)
            original=source.find_image_with_name(im.name);np.testing.assert_array_equal(original.cam_from_world().matrix(),before[im.name])
            if im.name in {p['name'] for p in self.catalog[:3]}:np.testing.assert_allclose(im.cam_from_world().matrix(),before[im.name],atol=1e-12)
            allowed={tuple(np.asarray(p.xy,dtype=np.float32)) for p in seed.find_image_with_name(im.name).points2D}
            allowed.update(tuple(np.asarray(o['xy'],dtype=np.float32)) for p in self.marks for o in p['observations'] if next(c['name'] for c in self.catalog if c['photoId']==o['photoId'])==im.name)
            self.assertTrue(all(tuple(np.asarray(p.xy,dtype=np.float32)) in allowed for p in im.points2D if p.has_point3D()),'a projected pixel cannot become an observation')
        self.assertEqual(sha256_file(database),db_sha)

    def test_existing_outside_tracks_remain_shared_with_the_repaired_photos(self):
        result,receipt=refine_local_geometry(self.clean,self.clean,self.catalog,self.marks,self.scope,CONFIG)
        first=result.find_image_with_name(self.catalog[0]['name']);last=result.find_image_with_name(self.catalog[-1]['name'])
        original_first=self.clean.find_image_with_name(first.name);original_last=self.clean.find_image_with_name(last.name)
        lookup=lambda im:{tuple(np.asarray(p.xy,dtype=np.float32)):int(p.point3D_id) for p in im.points2D if p.has_point3D()}
        before=lookup(original_first);after=lookup(first);target=lookup(last);shared=0
        for pixel in original_last.points2D:
            if not pixel.has_point3D():continue
            point=self.clean.points3D[pixel.point3D_id];observed=[e for e in point.track.elements if e.image_id==first.image_id]
            if not observed:continue
            reference=tuple(np.asarray(original_first.point2D(observed[0].point2D_idx).xy,dtype=np.float32));key=tuple(np.asarray(pixel.xy,dtype=np.float32))
            if reference in after and key in target and after[reference]==target[key]:shared+=1
        self.assertGreaterEqual(shared,400,'matching actual outside pixels must not become two independent copies of the same physical point')
        self.assertGreaterEqual(receipt['retainedOutsideTrackCount'],400)

    def test_seven_shared_points_cannot_anchor_a_local_repair(self):
        with self.assertRaisesRegex(ValueError,'8|共同点'):
            refine_local_geometry(self.clean,self.clean,self.catalog,self.marks[:7],self.scope,CONFIG)

    def test_points_with_only_one_selected_view_do_not_enter_native_bundle(self):
        scope=copy.deepcopy(self.scope)
        outside=self.catalog[0];target=self.catalog[3]
        scope['referencePhotoIds'].remove(outside['photoId'])
        scope['contextPhotoIds']=[outside['photoId']]
        target_image=self.clean.find_image_with_name(target['name'])
        context_image=self.clean.find_image_with_name(outside['name'])
        pixel=next(p for p in reversed(target_image.points2D) if p.has_point3D())
        context_pixel=next(p for p in context_image.points2D if p.has_point3D() and p.point3D_id==pixel.point3D_id)
        for origin in ('detected','manual'):
            with self.subTest(origin=origin):
                point={'id':'one-selected-view-'+origin,'observations':[
                    {'photoId':target['photoId'],'xy':pixel.xy.tolist(),'origin':origin},
                    {'photoId':outside['photoId'],'xy':context_pixel.xy.tolist(),'origin':origin}]}
                marks=copy.deepcopy(self.marks)+[point];before=copy.deepcopy(marks)
                result,receipt=refine_local_geometry(self.clean,self.clean,self.catalog,marks,scope,CONFIG)
                self.assertTrue(receipt['manualAnchor']['accepted'])
                self.assertTrue(receipt['boundary']['accepted'])
                self.assertTrue(all(count>=8 for count in receipt['targetPhotoSupport'].values()))
                self.assertNotIn(point['id'],{p['id'] for p in receipt['measuredLandmarks']})
                self.assertEqual(marks,before,'unused observations remain in the saved inputs')
                self.assertEqual(self.clean.num_points3D(),500,'the source model remains intact')

    def test_boundary_tracks_keep_one_or_two_targets_with_multiple_fixed_observers(self):
        seed=pc.Reconstruction(self.clean)
        targets=[seed.find_image_with_name(p['name']) for p in self.catalog[3:]]
        for row,point_id in enumerate(sorted(seed.points3D)[20:420]):
            point=seed.points3D[point_id]
            remove={im.image_id for im in targets[:1 if row<200 else 2]}
            for element in list(point.track.elements):
                if element.image_id in remove:seed.delete_observation(element.image_id,element.point2D_idx)
        result,receipt=refine_local_geometry(self.clean,seed,self.catalog,self.marks,self.scope,CONFIG)
        shared=0
        for point in result.points3D.values():
            names={result.images[e.image_id].name for e in point.track.elements}
            if len(names&{p['name'] for p in self.catalog[:3]})>=2 and names&{p['name'] for p in self.catalog[3:]}:shared+=1
        self.assertGreaterEqual(shared,450,'real fixed outside observations must count toward a boundary track; requiring three target views discards the camera-position constraints')
        self.assertGreaterEqual(receipt['retainedOutsideTrackCount'],450)

    def test_two_marks_cannot_freeze_an_extra_target_camera(self):
        marks=copy.deepcopy(self.marks);weak=self.catalog[-1]['photoId']
        for p in marks[2:]:p['observations']=[o for o in p['observations'] if o['photoId']!=weak]
        result,receipt=refine_local_geometry(self.clean,self.clean,self.catalog,marks,self.scope,CONFIG)
        self.assertNotIn(weak,receipt['fixedTargetPhotoIds'])
        self.assertEqual(len(receipt['fixedTargetPhotoIds']),2)

    def test_marked_target_cannot_be_ignored_when_other_marked_targets_pass(self):
        marks=copy.deepcopy(self.marks);weak=self.catalog[-1]['photoId']
        random=np.random.default_rng(93)
        for point in marks:
            for observation in point['observations']:
                if observation['photoId']==weak:
                    observation['xy']=random.uniform([100.,100.],[900.,650.]).tolist()
        with self.assertRaisesRegex(ValueError,'标记|共同点|参照'):
            refine_local_geometry(self.clean,self.clean,self.catalog,marks,self.scope,CONFIG)

    def test_marked_target_is_rechecked_after_track_cleanup(self):
        from assisted_local_repair import clean_tracks
        weak=self.catalog[-1]
        marked_pixels={tuple(np.asarray(o['xy'],dtype=np.float32)) for point in self.marks
                       for o in point['observations'] if o['photoId']==weak['photoId']}
        def remove_marked_observations(model,config,request):
            result=clean_tracks(model,config,request)
            image=model.find_image_with_name(weak['name'])
            for index,pixel in enumerate(image.points2D):
                if pixel.has_point3D() and tuple(np.asarray(pixel.xy,dtype=np.float32)) in marked_pixels:
                    model.delete_observation(image.image_id,index)
            return result
        with patch('assisted_local_repair.clean_tracks',side_effect=remove_marked_observations):
            with self.assertRaisesRegex(ValueError,'标记|共同点|参照'):
                refine_local_geometry(self.clean,self.clean,self.catalog,self.marks,self.scope,CONFIG)

    def test_scope_rejects_unknown_photos_overlap_and_client_paths(self):
        for update in [{'photoIds':['unknown']},{'referencePhotoIds':[self.catalog[3]['photoId']]},{'outputPath':'C:/outside'},{'photoIds':self.scope['photoIds']*2}]:
            with self.assertRaises(ValueError):validate_local_scope({**self.scope,**update},self.catalog,self.marks,CONFIG)

    def test_every_target_photo_requires_actual_support(self):
        seed=pc.Reconstruction(self.clean);missing=self.catalog[-1];image=seed.find_image_with_name(missing['name'])
        for index in range(len(image.points2D)):
            if image.point2D(index).has_point3D():seed.delete_observation(image.image_id,index)
        marks=copy.deepcopy(self.marks)
        for p in marks:p['observations']=[o for o in p['observations'] if o['photoId']!=missing['photoId']]
        with self.assertRaisesRegex(ValueError,'有效观察|支持|未覆盖'):
            refine_local_geometry(self.clean,seed,self.catalog,marks,self.scope,CONFIG)

    def test_one_view_camera_group_cannot_be_verified_as_a_cross_camera_bridge(self):
        from assisted_local_repair import check_camera_groups
        model=pc.Reconstruction(self.clean)
        catalog=copy.deepcopy(self.catalog)
        for i,p in enumerate(catalog):p['cameraGroup']='single' if i==5 else 'other'
        with self.assertRaisesRegex(ValueError,'相机组|两张'):
            check_camera_groups(model,catalog,self.marks,self.scope,CONFIG)

    def test_eight_pixels_in_a_tiny_area_do_not_validate_a_target_photo(self):
        seed=pc.Reconstruction(self.clean);photo=self.catalog[-1];image=seed.find_image_with_name(photo['name'])
        entries=[(idx,p.xy.copy()) for idx,p in enumerate(image.points2D) if p.has_point3D()]
        xy=np.asarray([p for idx,p in entries]);clusters=[np.argsort(np.linalg.norm(xy-center,axis=1))[:8] for center in xy]
        cluster=min(clusters,key=lambda rows:np.linalg.norm(np.ptp(xy[rows],axis=0)))
        self.assertLess(np.linalg.norm(np.ptp(xy[cluster],axis=0))/1280,CONFIG['minImageSpanFraction'])
        keep={entries[i][0] for i in cluster}
        for idx,pixel in enumerate(image.points2D):
            if pixel.has_point3D() and idx not in keep:seed.delete_observation(image.image_id,idx)
        marks=copy.deepcopy(self.marks)
        for p in marks:p['observations']=[o for o in p['observations'] if o['photoId']!=photo['photoId']]
        with self.assertRaisesRegex(ValueError,'分布|范围|支持'):
            refine_local_geometry(self.clean,seed,self.catalog,marks,self.scope,CONFIG)

    def test_denied_identity_cannot_enter_the_manual_bundle(self):
        denied={frozenset([self.catalog[0]['photoId'],self.catalog[3]['photoId']])}
        with self.assertRaisesRegex(ValueError,'否定|冲突'):
            refine_local_geometry(self.clean,self.clean,self.catalog,self.marks,self.scope,CONFIG,denied_pairs=denied)

    def test_denied_native_tracks_cannot_support_an_unmarked_target(self):
        weak=self.catalog[-1]['photoId'];marks=copy.deepcopy(self.marks)
        for p in marks:p['observations']=[o for o in p['observations'] if o['photoId']!=weak]
        denied={frozenset([self.catalog[0]['photoId'],weak])}
        with self.assertRaisesRegex(ValueError,'支持|观察|否定'):
            refine_local_geometry(self.clean,self.clean,self.catalog,marks,self.scope,CONFIG,denied_pairs=denied)

    def test_duplicate_physical_pixels_cannot_count_as_additional_points(self):
        marks=copy.deepcopy(self.marks[:7]);duplicate=copy.deepcopy(marks[0]);duplicate['id']='another-name-for-the-same-point';marks.append(duplicate)
        with self.assertRaisesRegex(ValueError,'重复|物理|共同点'):
            refine_local_geometry(self.clean,self.clean,self.catalog,marks,self.scope,CONFIG)

    def test_corner_refinement_uses_image_evidence_and_does_not_change_user_pixels(self):
        from assisted_local_repair import refine_measured_corners
        import cv2
        photo=self.catalog[0];image=np.full((768,1024),255,np.uint8);image[200:450,300:600]=0
        cv2.imwrite(photo['path'],image)
        marks=[{'id':'corner','observations':[{'photoId':photo['photoId'],'xy':[302.,202.],'origin':'manual'}]}]
        before=copy.deepcopy(marks)
        result,receipt=refine_measured_corners(marks,[photo],['corner'])
        self.assertEqual(marks,before)
        self.assertLess(np.linalg.norm(np.asarray(result[0]['observations'][0]['xy'])-[299.5,199.5]),1.)
        self.assertEqual(receipt[0]['source'],'image_corner_detector')
        self.assertLessEqual(receipt[0]['shiftPx'],15)
        blank=np.full((768,1024),255,np.uint8);cv2.imwrite(photo['path'],blank)
        unchanged,empty=refine_measured_corners(marks,[photo],['corner'])
        self.assertEqual(unchanged,marks);self.assertEqual(empty,[])

    def test_explicit_repair_runs_before_rejecting_old_incorrect_poses(self):
        from assistance_inputs import fingerprint_inputs
        from assisted_reconstruct import solve_assisted
        for im in self.clean.images.values():
            if im.name not in {p['name'] for p in self.catalog[3:]}:continue
            pose=im.cam_from_world();self.clean.frame(im.frame_id).set_cam_from_world(im.camera_id,pc.Rigid3d(pose.rotation,pose.translation+[6.,-5.,3.]))
        self.clean.write(self.request['models'][0]['path'])
        self.request['inputFingerprint']=fingerprint_inputs(self.catalog,Path(self.request['database']),[Path(self.request['models'][0]['path'])],CONFIG)
        self.request['constraints']['localRepair']=self.scope
        self.request['regions']=[{'id':'whole','model':'0','component':0,'photoIds':[p['photoId'] for p in self.catalog]}]
        calls=[]
        def fail(command,**kwargs):
            calls.append(command);raise subprocess.CalledProcessError(9,command)
        before=sha256_file(self.request['database']);result=solve_assisted(self.request,run=fail)
        self.assertEqual(result['outcome'],'failed')
        self.assertEqual(calls[0][1],'view_graph_calibrator')
        self.assertEqual(sha256_file(self.request['database']),before)
        self.assertFalse(any(c[1]=='mapper' for c in calls))

    def test_local_native_child_logs_arrive_without_a_windows_console(self):
        self.request['constraints']['localRepair']=self.scope
        request_path=self.root/'request.json';request_path.write_text(json.dumps(self.request),encoding='utf8')
        script=textwrap.dedent(f'''
            import json,subprocess,sys
            from pathlib import Path
            sys.path.insert(0,{str(Path(__file__).parent)!r})
            from assisted_reconstruct import solve_assisted
            request=json.loads(Path({str(request_path)!r}).read_text(encoding='utf8'))
            def launch(command,**options):
                subprocess.run([sys.executable,'-c',"import sys; print('LOCAL_NATIVE_STDOUT',flush=True); print('LOCAL_NATIVE_STDERR',file=sys.stderr,flush=True)"],**options)
                raise subprocess.CalledProcessError(9,command)
            result=solve_assisted(request,run=launch)
            assert result['outcome']=='failed'
        ''')
        log=self.root/'nested.log'
        with log.open('w',encoding='utf8') as output:
            subprocess.run([sys.executable,'-c',script],stdout=output,stderr=output,check=True,
                           creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),env={**os.environ,'PYTHONUTF8':'1'})
        content=log.read_text(encoding='utf8');self.assertIn('LOCAL_NATIVE_STDOUT',content);self.assertIn('LOCAL_NATIVE_STDERR',content)

    def test_frozen_native_seed_is_rechecked_and_jointly_refined_after_retry(self):
        from assisted_reconstruct import solve_assisted
        from assisted_candidates import model_signature
        temp=self.root/'cached';temp.mkdir();request,model=fixture(temp,points=6200)
        request['constraints']['localRepair']=self.scope
        seed=request['models'][0]['path'];request['regionalCandidates']=[{'name':'saved-seed','path':seed,'modelSignature':model_signature(seed)}]
        commands=[]
        def run(command,**kwargs):
            commands.append(command);self.assertEqual(command[1],'view_graph_calibrator','a complete frozen seed should avoid a fresh random mapper initialization')
            return subprocess.CompletedProcess(command,0)
        result=solve_assisted(request,run=run)
        self.assertEqual(result['outcome'],'verified',result.get('missing') or result.get('error'))
        self.assertEqual(result['localRepair']['reusedNativeSeed'],'saved-seed')
        self.assertTrue(result['bridges']['accepted']);self.assertTrue(result['localRepair']['manualAnchor']['accepted'])
        self.assertEqual(len(commands),1)

    def test_changed_frozen_seed_cannot_be_used_as_reconstruction_evidence(self):
        from assisted_reconstruct import solve_assisted
        self.request['constraints']['localRepair']=self.scope
        self.request['regionalCandidates']=[{'name':'changed','path':self.request['models'][0]['path'],'modelSignature':'0'*64}]
        result=solve_assisted(self.request,run=lambda command,**kwargs:subprocess.CompletedProcess(command,0))
        self.assertEqual(result['outcome'],'failed');self.assertRegex(result['error']['message'],'改变|候选')

    def test_later_local_repair_retains_effective_pixels_outside_its_scope(self):
        from assisted_reconstruct import solve_assisted
        from assisted_candidates import model_signature
        temp=self.root/'preserved-effective';temp.mkdir();request,model=fixture(temp,points=6200)
        original=copy.deepcopy(request['constraints']['landmarks'])
        catalog=request['catalog']
        scope={'photoIds':[p['photoId'] for p in catalog[4:]],'referencePhotoIds':[p['photoId'] for p in catalog[2:4]],
               'contextPhotoIds':[p['photoId'] for p in catalog[:2]],'refineCornerIds':[],'excludedPlanarInteriors':[]}
        outside={p['photoId'] for p in catalog[:2]}
        for obs in request['constraints']['landmarks'][0]['observations']:
            if obs['photoId'] in outside:obs['xy'][0]+=.5
        raw=copy.deepcopy(request['constraints']['landmarks'])
        request['constraints']['localRepair']=scope
        request['preservedLandmarks']=original
        request['regions']=[{'id':'whole','model':'0','photoIds':[p['photoId'] for p in catalog]}]
        path=request['models'][0]['path']
        request['regionalCandidates']=[{'name':'saved-native','path':path,'modelSignature':model_signature(path)}]
        result=solve_assisted(request,run=lambda command,**options:subprocess.CompletedProcess(command,0))
        self.assertEqual(result['outcome'],'verified',result.get('error') or result.get('missing'))
        effective=next(p for p in result['bridges']['retainedLandmarks'] if p['id']==original[0]['id'])
        self.assertEqual(len(effective['observations']),6,'previously refined outside observations must not disappear at final verification')
        for obs in effective['observations']:
            truth=next(o for o in original[0]['observations'] if o['photoId']==obs['photoId'])
            np.testing.assert_allclose(obs['xy'],truth['xy'],atol=1e-4)
        self.assertEqual(request['constraints']['landmarks'],raw,'source aliases cannot rewrite user clicks')

    def test_source_observers_cannot_restore_a_user_rejected_photo_pair(self):
        scope={'photoIds':[p['photoId'] for p in self.catalog[4:]],'referencePhotoIds':[p['photoId'] for p in self.catalog[2:4]],
               'contextPhotoIds':[p['photoId'] for p in self.catalog[:2]],'refineCornerIds':[],'excludedPlanarInteriors':[]}
        denied={frozenset((self.catalog[0]['photoId'],self.catalog[4]['photoId']))}
        result,_=refine_local_geometry(self.clean,self.clean,self.catalog,self.marks,scope,CONFIG,denied_pairs=denied)
        by_name={p['name']:p['photoId'] for p in self.catalog}
        for point in result.points3D.values():
            observed={by_name[result.images[e.image_id].name] for e in point.track.elements}
            self.assertFalse(any(pair<=observed for pair in denied),'source observers cannot reintroduce a denied relation')

    def test_restored_observers_cannot_conflict_with_a_new_measured_target(self):
        scope={'photoIds':[p['photoId'] for p in self.catalog[4:]],'referencePhotoIds':[p['photoId'] for p in self.catalog[2:4]],
               'contextPhotoIds':[p['photoId'] for p in self.catalog[:2]],'refineCornerIds':[],'excludedPlanarInteriors':[]}
        denied={frozenset((self.catalog[0]['photoId'],self.catalog[4]['photoId']))}
        source=pc.Reconstruction(self.clean)
        # These source tracks have no target yet. Their outside observer X is
        # incompatible with T only after current measured targets are added.
        manual_ids={int(point['id'].split('-')[-1]) for point in self.marks}
        for point_id in manual_ids:
            for element in list(source.points3D[point_id].track.elements):
                if source.images[element.image_id].name in {p['name'] for p in self.catalog[4:]}:
                    source.delete_observation(element.image_id,element.point2D_idx)
        before={pid:point.track.length() for pid,point in source.points3D.items()}
        result,_=refine_local_geometry(source,self.clean,self.catalog,self.marks,scope,CONFIG,denied_pairs=denied)
        by_name={p['name']:p['photoId'] for p in self.catalog}
        for point in result.points3D.values():
            observed={by_name[result.images[e.image_id].name] for e in point.track.elements}
            self.assertFalse(any(pair<=observed for pair in denied),'new targets must be included when checking restored outside observers')
        self.assertEqual(before,{pid:point.track.length() for pid,point in source.points3D.items()})

    def test_native_track_merge_checks_new_target_with_restored_outside_observers(self):
        scope={'photoIds':[p['photoId'] for p in self.catalog[4:]],'referencePhotoIds':[p['photoId'] for p in self.catalog[2:4]],
               'contextPhotoIds':[p['photoId'] for p in self.catalog[:2]],'refineCornerIds':[],'excludedPlanarInteriors':[]}
        denied={frozenset((self.catalog[0]['photoId'],self.catalog[4]['photoId']))}
        source,seed=pc.Reconstruction(self.clean),pc.Reconstruction(self.clean)
        manual_ids={int(point['id'].split('-')[-1]) for point in self.marks}
        point_id=next(pid for pid,point in source.points3D.items() if pid not in manual_ids and point.track.length()==6)
        targets={p['name'] for p in self.catalog[4:]}
        for element in list(source.points3D[point_id].track.elements):
            if source.images[element.image_id].name in targets:
                source.delete_observation(element.image_id,element.point2D_idx)
        outside_name=self.catalog[0]['name']
        for element in list(seed.points3D[point_id].track.elements):
            if seed.images[element.image_id].name==outside_name:
                seed.delete_observation(element.image_id,element.point2D_idx)
        before=(source.points3D[point_id].track.length(),seed.points3D[point_id].track.length())
        result,_=refine_local_geometry(source,seed,self.catalog,self.marks,scope,CONFIG,denied_pairs=denied)
        by_name={p['name']:p['photoId'] for p in self.catalog}
        for point in result.points3D.values():
            observed={by_name[result.images[e.image_id].name] for e in point.track.elements}
            self.assertFalse(any(pair<=observed for pair in denied),'native merging cannot create a denied pair absent from both input tracks')
        self.assertEqual(before,(source.points3D[point_id].track.length(),seed.points3D[point_id].track.length()))

    def test_local_roi_features_reach_the_native_bundle_without_client_detected_pixels(self):
        from assisted_reconstruct import solve_assisted
        from assisted_candidates import model_signature
        temp=self.root/'guided';temp.mkdir();request,model=fixture(temp,points=6200)
        measured=copy.deepcopy(request['constraints']['landmarks'])
        for point in measured:
            for observation in point['observations']:observation['origin']='detected'
        request['constraints'].update(landmarks=[],objects=[{'id':'fixed-roi','kind':'points','regions':[],
            'rois':[{'photoId':p['photoId'],'polygon':[[0,0],[1023,0],[1023,767],[0,767]]} for p in request['catalog']],'corners':[]}],localRepair=self.scope)
        seed=request['models'][0]['path'];request['regionalCandidates']=[{'name':'native-seed','path':seed,'modelSignature':model_signature(seed)}]
        with patch('assisted_local_job.collect_observations',create=True,return_value={'landmarks':measured,'missing':[],'rejected':[]}) as extract:
            result=solve_assisted(request,run=lambda command,**kwargs:subprocess.CompletedProcess(command,0))
        self.assertEqual(result['outcome'],'verified',result.get('error') or result.get('missing'))
        extract.assert_called_once()
        self.assertEqual(request['constraints']['landmarks'],[],'native detections must not be written into user input')
        self.assertTrue(any(o['origin']=='detected' for p in result['localRepair']['measuredLandmarks'] for o in p['observations']))

    def test_failed_local_roi_collection_cannot_fall_back_to_old_manual_success(self):
        from assisted_reconstruct import solve_assisted
        from assisted_candidates import model_signature
        temp=self.root/'missing-guided';temp.mkdir();request,model=fixture(temp,points=6200)
        request['constraints'].update(objects=[{'id':'new-roi','kind':'points','regions':[],
            'rois':[{'photoId':p['photoId'],'polygon':[[0,0],[1023,0],[1023,767],[0,767]]} for p in request['catalog']],'corners':[]}],localRepair=self.scope)
        seed=request['models'][0]['path'];request['regionalCandidates']=[{'name':'native-seed','path':seed,'modelSignature':model_signature(seed)}]
        missing={'code':'no_real_features','message':'没有取得真实对应点。'}
        with patch('assisted_local_job.collect_observations',create=True,return_value={'landmarks':[],'missing':[missing],'rejected':[]}):
            result=solve_assisted(request,run=lambda command,**kwargs:subprocess.CompletedProcess(command,0))
        self.assertEqual(result['outcome'],'needs_input')
        self.assertEqual(result['missing'],[missing])

    def test_local_roi_with_seven_points_cannot_be_hidden_by_other_photos(self):
        from assisted_reconstruct import solve_assisted
        from assisted_candidates import model_signature
        temp=self.root/'weak-guided';temp.mkdir();request,model=fixture(temp,points=6200)
        weak=request['catalog'][-1]['photoId']
        for point in request['constraints']['landmarks'][7:]:
            point['observations']=[o for o in point['observations'] if o['photoId']!=weak]
        request['constraints'].update(objects=[{'id':'weak-roi','kind':'points','regions':[],
            'rois':[{'photoId':p['photoId'],'polygon':[[0,0],[1023,0],[1023,767],[0,767]]} for p in request['catalog']],'corners':[]}],localRepair=self.scope)
        seed=request['models'][0]['path'];request['regionalCandidates']=[{'name':'native-seed','path':seed,'modelSignature':model_signature(seed)}]
        with patch('assisted_local_job.collect_observations',create=True,return_value={'landmarks':copy.deepcopy(request['constraints']['landmarks']),'missing':[],'rejected':[]}):
            result=solve_assisted(request,run=lambda command,**kwargs:subprocess.CompletedProcess(command,0))
        self.assertEqual(result['outcome'],'needs_input',result.get('error') or result.get('missing'))
        self.assertIn(weak,json.dumps(result.get('missing')) or '')

    def complementary_native_inputs(self,name):
        from assisted_candidates import model_signature
        temp=self.root/name;temp.mkdir();request,model=fixture(temp,points=6200)
        request['constraints']['localRepair']=self.scope
        request['regionalCandidates']=[]
        for index,photo in enumerate((request['catalog'][0],request['catalog'][-1])):
            partial=pc.Reconstruction(model)
            partial.deregister_frame(partial.find_image_with_name(photo['name']).frame_id)
            folder=temp/f'partial-{index}';folder.mkdir();partial.write(folder)
            request['regionalCandidates'].append({'name':f'partial-{index}','path':str(folder),'modelSignature':model_signature(folder)})
        return request,model

    def test_complementary_native_candidates_are_merged_before_fresh_mapping(self):
        from assisted_reconstruct import solve_assisted
        from assisted_candidates import model_signature
        request,model=self.complementary_native_inputs('merge')
        before={item['path']:model_signature(item['path']) for item in request['regionalCandidates']};commands=[]
        def run(command,**options):
            commands.append(command)
            if command[1]=='model_merger':
                self.assertEqual(command[command.index('--max_reproj_error')+1],str(CONFIG['maxReprojectionPx']))
                model.write(command[command.index('--output_path')+1])
            elif command[1]=='mapper':
                folder=Path(command[command.index('--output_path')+1])/'0';folder.mkdir()
                pc.Reconstruction(request['regionalCandidates'][0]['path']).write(folder)
            return subprocess.CompletedProcess(command,0)
        result=solve_assisted(request,run=run)
        self.assertEqual(result['outcome'],'verified',result.get('error') or result.get('missing'))
        self.assertEqual([command[1] for command in commands],['view_graph_calibrator','model_merger'])
        self.assertEqual(before,{path:model_signature(path) for path in before})
        self.assertTrue(result['localRepair']['accepted'])
        self.assertTrue(all(check['accepted'] for check in result['localRepair']['markedTargetChecks']))

    def test_incomplete_native_merge_cannot_verify_missing_required_photos(self):
        from assisted_reconstruct import solve_assisted
        request,model=self.complementary_native_inputs('incomplete-merge')
        partial=pc.Reconstruction(request['regionalCandidates'][0]['path'])
        def run(command,**options):
            if command[1]=='model_merger':partial.write(command[command.index('--output_path')+1])
            elif command[1]=='mapper':
                folder=Path(command[command.index('--output_path')+1])/'0';folder.mkdir();partial.write(folder)
            return subprocess.CompletedProcess(command,0)
        result=solve_assisted(request,run=run)
        self.assertEqual(result['outcome'],'needs_input',result.get('error'))
        self.assertTrue(any(item['code']=='local_scope_unregistered' for item in result['missing']))

    def weak_native_photo(self,request,model):
        weak=pc.Reconstruction(model);photo=request['catalog'][-1]
        image=weak.find_image_with_name(photo['name'])
        observed=[i for i,p in enumerate(image.points2D) if p.has_point3D()]
        for index in observed[1:]:weak.delete_observation(image.image_id,index)
        self.assertEqual(image.num_points3D,1)
        # This photo needs real native tracks; other marked cameras cannot hide it.
        for point in request['constraints']['landmarks']:
            point['observations']=[o for o in point['observations'] if o['photoId']!=photo['photoId']]
        return weak,photo

    def test_weak_registered_native_merge_retries_reverse_before_adoption(self):
        from assisted_reconstruct import solve_assisted
        from assisted_candidates import model_signature
        request,model=self.complementary_native_inputs('weak-merge-reverse')
        weak,photo=self.weak_native_photo(request,model);commands=[]
        before={item['path']:model_signature(item['path']) for item in request['regionalCandidates']}
        def run(command,**options):
            commands.append(command)
            if command[1]=='model_merger':
                count=sum(c[1]=='model_merger' for c in commands)
                (weak if count==1 else model).write(command[command.index('--output_path')+1])
            else:self.assertEqual(command[1],'view_graph_calibrator')
            return subprocess.CompletedProcess(command,0)
        result=solve_assisted(request,run=run)
        self.assertEqual(result['outcome'],'verified',result.get('error') or result.get('missing'))
        merges=[c for c in commands if c[1]=='model_merger'];self.assertEqual(len(merges),2)
        self.assertEqual(merges[0][merges[0].index('--input_path1')+1],merges[1][merges[1].index('--input_path2')+1])
        self.assertEqual(merges[0][merges[0].index('--input_path2')+1],merges[1][merges[1].index('--input_path1')+1])
        trace=json.loads((Path(request['outputRoot'])/'summary/local-native-merge-0.json').read_text())
        self.assertFalse(trace['initializerAccepted'])
        self.assertIn({'name':photo['name'],'points':1},trace['weakRequired'])
        self.assertTrue((Path(request['outputRoot'])/'sfm/local-native/merge-attempts/0/images.bin').exists())
        self.assertEqual(before,{path:model_signature(path) for path in before})

    def test_weak_frozen_native_candidate_cannot_skip_fresh_mapping(self):
        from assisted_reconstruct import solve_assisted
        from assisted_candidates import model_signature
        temp=self.root/'weak-cache';temp.mkdir();request,model=fixture(temp,points=6200)
        request['constraints']['localRepair']=self.scope
        weak,_=self.weak_native_photo(request,model)
        folder=temp/'weak-seed';folder.mkdir();weak.write(folder)
        signature=model_signature(folder)
        request['regionalCandidates']=[{'name':'weak-seed','path':str(folder),'modelSignature':signature}]
        commands=[]
        def run(command,**options):
            commands.append(command[1])
            if command[1]=='mapper':
                output=Path(command[command.index('--output_path')+1])/'0';output.mkdir();model.write(output)
            else:self.assertEqual(command[1],'view_graph_calibrator')
            return subprocess.CompletedProcess(command,0)
        result=solve_assisted(request,run=run)
        self.assertEqual(result['outcome'],'verified',result.get('error') or result.get('missing'))
        self.assertEqual(commands,['view_graph_calibrator','mapper'])
        self.assertEqual(model_signature(folder),signature)

    def test_both_weak_native_merge_directions_remain_unverified(self):
        from assisted_reconstruct import solve_assisted
        request,model=self.complementary_native_inputs('both-weak-merges')
        weak,_=self.weak_native_photo(request,model);merges=[]
        partial=pc.Reconstruction(request['regionalCandidates'][0]['path'])
        def run(command,**options):
            if command[1]=='model_merger':
                merges.append(command);weak.write(command[command.index('--output_path')+1])
            elif command[1]=='mapper':
                output=Path(command[command.index('--output_path')+1])/'0';output.mkdir();partial.write(output)
            return subprocess.CompletedProcess(command,0)
        result=solve_assisted(request,run=run)
        self.assertEqual(result['outcome'],'needs_input',result.get('error'))
        self.assertTrue(any(m['code']=='local_scope_unregistered' for m in result['missing']))
        self.assertGreaterEqual(len(merges),2)
        self.assertFalse((Path(request['outputRoot'])/'sfm/sparse/0').exists())

    def test_supported_partial_pair_is_preferred_over_a_larger_weak_cache(self):
        from assisted_reconstruct import solve_assisted
        from assisted_candidates import model_signature
        request,model=self.complementary_native_inputs('prefer-supported-pair')
        expected={item['path'] for item in request['regionalCandidates']}
        weak,_=self.weak_native_photo(request,model)
        folder=self.root/'larger-weak-cache';folder.mkdir();weak.write(folder)
        request['regionalCandidates'].append({'name':'larger-weak','path':str(folder),'modelSignature':model_signature(folder)})
        commands=[]
        def run(command,**options):
            commands.append(command)
            if command[1]=='model_merger':model.write(command[command.index('--output_path')+1])
            else:self.assertEqual(command[1],'view_graph_calibrator')
            return subprocess.CompletedProcess(command,0)
        result=solve_assisted(request,run=run)
        self.assertEqual(result['outcome'],'verified',result.get('error') or result.get('missing'))
        merge=next(c for c in commands if c[1]=='model_merger')
        actual={merge[merge.index('--input_path1')+1],merge[merge.index('--input_path2')+1]}
        self.assertEqual(actual,expected,'more registered names cannot outweigh missing real support')

    @unittest.skipUnless(os.environ.get('GAUSSROOM_NATIVE_TEST')=='1','Run explicitly with GAUSSROOM_NATIVE_TEST=1')
    def test_native_model_merger_supplies_only_an_initializer(self):
        from assisted_reconstruct import solve_assisted
        request,model=self.complementary_native_inputs('native-merge')
        commands=[];before=sha256_file(request['database'])
        def run(command,**options):
            commands.append(command[1])
            if command[1]=='model_merger':return subprocess.run(command,**options)
            self.assertEqual(command[1],'view_graph_calibrator')
            return subprocess.CompletedProcess(command,0)
        result=solve_assisted(request,run=run)
        self.assertEqual(result['outcome'],'verified',result.get('error') or result.get('missing'))
        self.assertEqual(commands,['view_graph_calibrator','model_merger'])
        self.assertTrue(result['localRepair']['boundary']['accepted'])
        self.assertTrue(result['localRepair']['markedTargetChecks'])
        self.assertEqual(sha256_file(request['database']),before)

    @unittest.skipUnless(os.environ.get('GAUSSROOM_NATIVE_TEST')=='1','Run explicitly with GAUSSROOM_NATIVE_TEST=1')
    def test_native_complete_local_repair_uses_normal_gate_and_preserves_prior_bridge(self):
        from assisted_reconstruct import solve_assisted
        temp=self.root/'native';temp.mkdir();request,model=fixture(temp,points=6200)
        request['constraints']['localRepair']={**self.scope}
        request['priorBridgeChecks']=[{'regions':request['regions'],'constraints':{'landmarks':copy.deepcopy(request['constraints']['landmarks'])}}]
        request['regions']=[{'id':'whole','model':'0','component':0,'photoIds':[p['photoId'] for p in request['catalog']]}]
        # New fixture hashes are the same; scene/photo filenames carry no room labels.
        before=sha256_file(request['database']);result=solve_assisted(request)
        self.assertEqual(result['outcome'],'verified',result.get('missing') or result.get('error'))
        self.assertTrue(result['localRepair']['accepted'])
        self.assertTrue(result['localRepair']['priorBridgeChecks'][0]['accepted'])
        self.assertTrue(result['bridges']['accepted']);self.assertEqual(result['gate']['models'][0]['geometryComponentSizes'],[6])
        self.assertEqual(sha256_file(request['database']),before)


if __name__=='__main__':unittest.main()
