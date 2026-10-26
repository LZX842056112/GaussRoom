import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import pycolmap as pc
from test_assistance_solver import fixture,CONFIG
from assistance_inputs import fingerprint_inputs,sha256_file
from assisted_database import build_geometry_database
from assisted_reconstruct import load_context,_align,verify_final_bridges,solve_assisted
from assisted_initialization import initialize_from_geometry,clean_tracks

def _pixel(xy):return tuple(np.asarray(xy,dtype=np.float32))


class InitializationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.request,self.source=fixture(self.root,points=500)

    def inputs(self):
        context=load_context(self.request)
        aligned=_align(copy.deepcopy(self.request['constraints']['landmarks']),context,self.request['regions'],CONFIG)
        self.assertTrue(aligned['graph']['accepted'])
        database=self.root/'geometry.db'
        build_geometry_database(Path(self.request['database']),database,context['models'],
            {'catalog':self.request['catalog'],'views':context['views'],'landmarks':aligned['landmarks']},aligned['graph'],self.request['constraints'],CONFIG)
        return context,aligned,database

    def test_initialization_uses_computed_sim3_and_database_pixels(self):
        second=pc.Reconstruction(self.request['models'][0]['path'])
        second.transform(pc.Sim3d(1.7,pc.Rotation3d(np.array([.1,.2,-.15])),np.array([2.,-1.,.3])))
        folder=self.root/'independent-region';folder.mkdir();second.write(folder)
        self.request['models'].append({'name':'second','path':str(folder)})
        self.request['regions'][1]['model']='second'
        context,aligned,database=self.inputs();before=sha256_file(database)
        model,receipt=initialize_from_geometry(self.request,context,aligned,database)
        path=self.root/'initialized';path.mkdir();model.write(path)
        check=verify_final_bridges(path,self.request,CONFIG)
        self.assertTrue(check['accepted'],check['missing'])
        self.assertEqual(model.num_reg_images(),6);self.assertEqual(check['duplicateObservations'],0)
        self.assertTrue(receipt['computedCameraPositionsSupplied']);self.assertFalse(receipt['userCameraPositionsSupplied'])
        self.assertEqual(sha256_file(database),before)
        for image in model.images.values():
            original=self.source.find_image_with_name(image.name)
            np.testing.assert_allclose(image.cam_from_world().matrix(),original.cam_from_world().matrix(),atol=1e-6)

    def test_duplicate_cleanup_keeps_one_real_observation_and_preserves_bridges(self):
        point=next(iter(self.source.points3D.values()));element=point.track.elements[0]
        point.track.add_element(element.image_id,element.point2D_idx)
        count=clean_tracks(self.source,CONFIG,self.request)
        self.assertEqual(count['duplicateObservationsRemoved'],1)
        path=self.root/'cleaned';path.mkdir();self.source.write(path)
        result=verify_final_bridges(path,self.request,CONFIG)
        self.assertTrue(result['accepted'],result['missing'])

    def test_denied_identity_cannot_be_restored_by_initialization(self):
        context,aligned,database=self.inputs()
        self.request['constraints'].update(questions=[{'id':'denied','photoIds':[self.request['catalog'][0]['photoId'],self.request['catalog'][3]['photoId']]}],answers=[{'questionId':'denied','value':'no'}])
        with self.assertRaisesRegex(ValueError,'否定'):initialize_from_geometry(self.request,context,aligned,database)

    def test_connected_initialized_candidate_with_only_seven_points_is_not_adopted(self):
        root=self.root/'weak-final';root.mkdir();self.request,self.source=fixture(root,points=6200)
        def initialized(request,context,aligned,database,output,progress):
            model,_=initialize_from_geometry(request,context,aligned,database)
            # Remove five distinct measured physical points, while preserving a
            # single component through the seven remaining actual shared points.
            selected=set()
            for landmark in aligned['landmarks'][:5]:
                obs=landmark['observations'][0];image=model.find_image_with_name(next(p['name'] for p in request['catalog'] if p['photoId']==obs['photoId']))
                selected.update(p.point3D_id for p in image.points2D if p.has_point3D() and _pixel(p.xy)==_pixel(obs['xy']))
            for pid in selected:model.delete_point3D(pid)
            model.update_point_3d_errors();sparse=Path(output)/'sfm/initialized-sparse';path=sparse/'0';path.mkdir(parents=True);model.write(path)
            return sparse,{'globalPositioningSucceeded':True,'sourceDatabaseUnchanged':True}
        def split(command,**kwargs):
            if command[1]!='global_mapper':return subprocess.CompletedProcess(command,0)
            context=load_context(self.request);aligned=_align(copy.deepcopy(self.request['constraints']['landmarks']),context,self.request['regions'],CONFIG)
            model,_=initialize_from_geometry(self.request,context,aligned,Path(command[command.index('--database_path')+1]))
            for pid in list(model.points3D):
                point=model.points3D[pid]
                if any(e.image_id<=3 for e in point.track.elements) and any(e.image_id>3 for e in point.track.elements):model.delete_point3D(pid)
            model.update_point_3d_errors();path=Path(command[command.index('--output_path')+1])/'0';path.mkdir();model.write(path)
            return subprocess.CompletedProcess(command,0)
        with patch('assisted_reconstruct.run_initialized_global',side_effect=initialized):result=solve_assisted(self.request,run=split)
        self.assertEqual(result['outcome'],'needs_input')
        root=Path(self.request['outputRoot'])
        checked=json.loads((root/'summary/initialized-global/final-bridges.json').read_text())
        self.assertEqual(checked['geometryComponentSizes'],[6]);self.assertFalse(checked['accepted'])
        self.assertEqual(checked['uniqueSharedPoints'],7)
        self.assertFalse((root/'sfm/random-global-sparse').exists())

    @unittest.skipUnless(os.environ.get('GAUSSROOM_NATIVE_TEST')=='1','Run explicitly with GAUSSROOM_NATIVE_TEST=1')
    def test_failed_random_global_can_use_measured_initialization_and_preserve_failure(self):
        root=self.root/'native';root.mkdir();self.request,self.source=fixture(root,points=6200)
        before=sha256_file(self.request['database'])
        def native(command,**kwargs):
            if command[1]!='global_mapper':return subprocess.run(command,**kwargs)
            context=load_context(self.request);aligned=_align(copy.deepcopy(self.request['constraints']['landmarks']),context,self.request['regions'],CONFIG)
            model,_=initialize_from_geometry(self.request,context,aligned,Path(command[command.index('--database_path')+1]))
            saved=[(p.xyz.copy(),p.color.copy(),[(e.image_id,e.point2D_idx) for e in p.track.elements]) for p in model.points3D.values()]
            for pid in list(model.points3D):model.delete_point3D(pid)
            for xyz,color,entries in saved:
                for ids in [{1,2,3},{4,5,6}]:
                    track=pc.Track()
                    for iid,index in entries:
                        if iid in ids:track.add_element(iid,index)
                    if len(track.elements)>=2:model.add_point3D(xyz,track,color)
            model.update_point_3d_errors();path=Path(command[command.index('--output_path')+1])/'0';path.mkdir();model.write(path)
            return subprocess.CompletedProcess(command,0)
        result=solve_assisted(self.request,run=native)
        self.assertEqual(result['outcome'],'verified',result['missing'] or result['error'])
        self.assertTrue(result['bridges']['accepted']);self.assertEqual(result['bridges']['geometryComponentSizes'],[6])
        self.assertTrue((Path(self.request['outputRoot'])/'sfm/random-global-sparse/0/images.bin').exists())
        receipt=json.loads((Path(self.request['outputRoot'])/'summary/initialized-global.json').read_text())
        self.assertTrue(receipt['globalPositioningSucceeded']);self.assertTrue(receipt['sourceDatabaseUnchanged'])
        self.assertEqual(sha256_file(self.request['database']),before)


if __name__=='__main__':unittest.main()
