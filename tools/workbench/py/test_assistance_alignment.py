import importlib
import unittest
import inspect
from types import SimpleNamespace
import numpy as np
import pycolmap as pc
from test_assistance_solver import CONFIG
from assisted_geometry import triangulate_observations,estimate_region_alignment
from assisted_reconstruct import _align
import assisted_candidates
try:alignment=importlib.import_module('assisted_alignment')
except ModuleNotFoundError:alignment=SimpleNamespace()

def measurements():
    camera=pc.Camera(model='SIMPLE_RADIAL',width=1000,height=800,params=[800,500,400,0])
    a_views={f'a{i}':{'camera':camera,'camFromWorld':np.column_stack([np.eye(3),[-x,0,0]])} for i,x in enumerate([-.07,.07])}
    b_views={f'b{i}':{'camera':camera,'camFromWorld':np.column_stack([np.eye(3),[-x,0,0]])} for i,x in enumerate([.3,.44])}
    shared=[];rng=np.random.default_rng(19)
    for i,(x,y) in enumerate((x,y) for x in [-.9,-.3,.3,.9] for y in [-1,-.4,.4,1]):
        xyz=np.array([x,y,5.0]);sides=[]
        for k,views in enumerate([a_views,b_views]):
            observations=[]
            delta=float(rng.uniform(-2.4,2.4))
            for j,(photo_id,view) in enumerate(views.items()):
                xy=camera.img_from_cam(view['camFromWorld'][:,:3]@xyz+view['camFromWorld'][:,3]);xy[0]+=delta*(1 if j==0 else -1)
                observations.append({'photoId':photo_id,'xy':xy.tolist(),'origin':'manual'})
            sides.append(triangulate_observations(observations,views,CONFIG))
        shared.append({'id':f'p{i}','a':sides[0],'b':sides[1]})
    return shared,a_views,b_views

class AlignmentTest(unittest.TestCase):
    def test_joint_pixel_alignment_handles_uncertain_depth_without_relaxing_pixel_limits(self):
        shared,a,b=measurements();self.assertTrue(all(p['a']['accepted'] and p['b']['accepted'] for p in shared))
        self.assertFalse(estimate_region_alignment(shared,CONFIG)['accepted'])
        self.assertTrue(callable(getattr(alignment,'refine_pixel_alignment',None)))
        result=alignment.refine_pixel_alignment(shared,a,b,CONFIG)
        self.assertTrue(result['accepted'],result.get('missing'))
        self.assertGreaterEqual(len(result['sharedPointIds']),8)
        self.assertLessEqual(result['maxJointReprojectionPx'],4)

    def test_incoherent_physical_correspondences_cannot_be_approved(self):
        shared,a,b=measurements();self.assertTrue(callable(getattr(alignment,'refine_pixel_alignment',None)))
        permutation=np.random.default_rng(17).permutation(len(shared))
        wrong=[{**p,'b':shared[j]['b']} for p,j in zip(shared,permutation)]
        self.assertFalse(alignment.refine_pixel_alignment(wrong,a,b,CONFIG)['accepted'])

    def test_regional_comparison_can_use_joint_pixels_after_strict_initial_alignment_fails(self):
        self.assertIn('allow_pixel',inspect.signature(_align).parameters)
        shared,a,b=measurements();landmarks=[{'id':p['id'],'objectId':None,'observations':p['a']['observations']+p['b']['observations']} for p in shared]
        regions=[{'id':'a','photoIds':list(a)},{'id':'b','photoIds':list(b)}]
        result=_align(landmarks,{'regionViews':{'a':a,'b':b}},regions,CONFIG,allow_pixel=True)
        self.assertTrue(result['graph']['accepted']);self.assertEqual(result['edges'][0]['criterion'],'joint_reprojection')

    def test_location_hint_limits_new_photo_membership_without_claiming_a_pose(self):
        self.assertTrue(callable(getattr(assisted_candidates,'allowed_region_ids',None)))
        regions=[{'id':'hall'},{'id':'bed'}]
        self.assertEqual(assisted_candidates.allowed_region_ids('p',regions,{'coverage':[{'photoId':'p','decision':'existing','regionId':'hall'}]}),{'hall'})
        for coverage in [[],[{'photoId':'p','decision':'unknown','regionId':None}],[{'photoId':'p','decision':'new','regionId':None}]]:
            self.assertEqual(assisted_candidates.allowed_region_ids('p',regions,{'coverage':coverage}),set())
