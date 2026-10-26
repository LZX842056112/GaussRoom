import json
import unittest
from pathlib import Path
import numpy as np
import pycolmap
from assisted_geometry import triangulate_observations, estimate_region_alignment, connect_regions, check_dimensions

CONFIG=json.loads((Path(__file__).parents[1]/'assistance-config.json').read_text())


def side(xyz,offset=0):
    return {'accepted':True,'xyz':list(xyz),'views':2,'parallaxDeg':5,'maxReprojectionPx':0.1,
      'spread':[{'photoId':f'v{offset}-{i}','xy':[500+xyz[0]*100+i,400+xyz[1]*100],'diagonal':1280} for i in (0,1)]}


def shared_points(count=12):
    rng=np.random.default_rng(42)
    a=rng.uniform(-2,2,(count,3));a[:,2]=4
    angle=0.2;r=np.array([[np.cos(angle),-np.sin(angle),0],[np.sin(angle),np.cos(angle),0],[0,0,1]])
    b=(1.7*(r@a.T)).T+np.array([2,-1,0.5])
    return [{'id':f'p{i}','a':side(x,0),'b':side(y,1)} for i,(x,y) in enumerate(zip(a,b))],r


class GeometryTests(unittest.TestCase):
    def test_each_side_needs_two_views_and_one_degree(self):
        points,_=shared_points()
        self.assertFalse(estimate_region_alignment(points[:7],CONFIG)['accepted'])
        for key,value in [('views',1),('parallaxDeg',0.9),('maxReprojectionPx',4.1)]:
            bad,_=shared_points()
            for p in bad:p['a'][key]=value
            self.assertFalse(estimate_region_alignment(bad,CONFIG)['accepted'])
        self.assertTrue(estimate_region_alignment(points,CONFIG)['accepted'])
        for point in points:
            point['a']['parallaxDeg']=1
            point['a']['maxReprojectionPx']=4
        self.assertTrue(estimate_region_alignment(points,CONFIG)['accepted'])

    def test_collinear_or_clustered_support_is_rejected(self):
        points,_=shared_points()
        for i,p in enumerate(points):
            p['a']['xyz']=[i,0,4];p['b']['xyz']=[i*2,0,8]
        self.assertFalse(estimate_region_alignment(points,CONFIG)['accepted'])
        points,_=shared_points()
        for p in points:
            for name in ('a','b'):
                for obs in p[name]['spread']:obs['xy']=[500,400]
        self.assertFalse(estimate_region_alignment(points,CONFIG)['accepted'])

    def test_known_planar_sim3_survives_outliers(self):
        points,rotation=shared_points()
        points[-1]['b']['xyz']=[-50,30,50]
        result=estimate_region_alignment(points,CONFIG)
        self.assertTrue(result['accepted'])
        self.assertAlmostEqual(result['sim3']['scale'],1.7,places=6)
        np.testing.assert_allclose(result['sim3']['rotation'],rotation,atol=1e-6)
        np.testing.assert_allclose(result['sim3']['translation'],[2,-1,0.5],atol=1e-6)
        self.assertIn('p11',[p['id'] for p in result['rejected']])

    def test_triangulation_uses_distorted_camera_and_positive_depth(self):
        camera=pycolmap.Camera(model='SIMPLE_RADIAL',width=1000,height=800,params=[800,500,400,0.08])
        views={};observations=[];xyz=np.array([0.4,-0.2,4])
        for i,x in enumerate([-0.4,0.4,0.7]):
            pose=np.column_stack([np.eye(3),[-x,0,0]])
            views[f'p{i}']={'camera':camera,'camFromWorld':pose}
            observations.append({'photoId':f'p{i}','xy':camera.img_from_cam(xyz+[-x,0,0]).tolist(),'origin':'manual'})
        result=triangulate_observations(observations,views,CONFIG)
        self.assertTrue(result['accepted']);np.testing.assert_allclose(result['xyz'],xyz,atol=1e-6)
        self.assertFalse(triangulate_observations(observations[:1],views,CONFIG)['accepted'])
        near_views={k:{**v,'camFromWorld':np.column_stack([np.eye(3),[i*0.0001,0,0]])} for i,(k,v) in enumerate(views.items())}
        near_obs=[{**o,'xy':camera.img_from_cam(xyz+near_views[o['photoId']]['camFromWorld'][:,3]).tolist()} for o in observations]
        self.assertFalse(triangulate_observations(near_obs,near_views,CONFIG)['accepted'])
        behind=[]
        for o in observations:
            local=-xyz+views[o['photoId']]['camFromWorld'][:,3]
            behind.append({**o,'xy':camera.img_from_cam(local/local[2]).tolist()})
        self.assertFalse(triangulate_observations(behind,views,CONFIG)['accepted'])
        bad=[{**o,'xy':list(o['xy'])} for o in observations]
        bad[-1]['xy'][1]+=30
        robust=triangulate_observations(bad,views,CONFIG)
        self.assertTrue(robust['accepted']);self.assertEqual(robust['views'],2)
        self.assertEqual(robust['rejected'][0]['photoId'],'p2')

    def test_third_region_cannot_be_dropped_and_cycles_must_agree(self):
        identity={'scale':1,'rotation':np.eye(3).tolist(),'translation':[0,0,0]}
        ab={'first':'a','second':'b','accepted':True,'sim3':identity}
        regions=[{'id':'a'},{'id':'b'},{'id':'c'}]
        self.assertIn('unconnected_region',[m['code'] for m in connect_regions(regions,[ab],CONFIG)['missing']])
        bc={**ab,'first':'b','second':'c'}
        self.assertTrue(connect_regions(regions,[ab,bc],CONFIG)['accepted'])
        ac={**ab,'second':'c','sim3':{**identity,'scale':2}}
        self.assertFalse(connect_regions(regions,[ab,bc,ac],CONFIG)['accepted'])

    def test_estimated_dimensions_are_hints_and_measured_endpoints_are_required(self):
        points={'p1':{'xyz':[0,0,0],'accepted':True},'p2':{'xyz':[2,0,0],'accepted':True}}
        dimension={'id':'width','value':90,'unit':'cm','source':'estimated','endpoints':[{'landmarkId':'p1'},{'landmarkId':'p2'}]}
        self.assertEqual(check_dimensions([dimension],points,CONFIG)['scale'],'unmeasured')
        measured={**dimension,'source':'measured'}
        self.assertEqual(check_dimensions([measured],{},CONFIG)['scale'],'unmeasured')
        result=check_dimensions([measured],points,CONFIG)
        self.assertEqual(result['scale'],'calibrated');self.assertAlmostEqual(result['factor'],0.45)
        self.assertAlmostEqual(result['residuals'][0]['residualMeters'],0)
        self.assertFalse(check_dimensions([measured,{**measured,'id':'conflict','value':180}],points,CONFIG)['accepted'])


if __name__=='__main__':unittest.main()
