import json
import tempfile
import unittest
from unittest.mock import patch
import cv2
from pathlib import Path
import numpy as np
from PIL import Image
from assisted_features import collect_observations, detect_features, extend_observations

CONFIG=json.loads((Path(__file__).parents[1]/'assistance-config.json').read_text())


class FeatureTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        rng=np.random.default_rng(42)
        pixels=rng.integers(0,256,(320,400),dtype=np.uint8)
        self.catalog=[]
        for i in range(4):
            path=self.root/f'view-{i}.png';Image.fromarray(pixels).save(path)
            self.catalog.append({'photoId':f'p{i}','name':path.name,'path':str(path),'width':400,'height':320,'regionId':f'r{i//2}'})
        self.object={'id':'fixed-object','kind':'planar','regions':['r0','r1'],'rois':[],
          'corners':[{'photoId':p['photoId'],'xy':[[10,10],[389,10],[389,309],[10,309]]} for p in self.catalog]}

    def collect(self,**constraints):
        return collect_observations(self.catalog,[],constraints,CONFIG)

    def test_same_object_answer_does_not_create_observations(self):
        result=self.collect(answers=[{'questionId':'q','value':'yes'}])
        self.assertEqual(result['landmarks'],[])
        self.assertEqual(result['missing'][0]['code'],'no_real_features')

    def test_homography_search_keeps_detected_pixels(self):
        result=self.collect(objects=[self.object])
        self.assertGreaterEqual(len(result['landmarks']),8)
        detected={p['photoId']:{tuple(xy) for xy in detect_features(p['path'],CONFIG)['xy'].tolist()} for p in self.catalog}
        for point in result['landmarks']:
            self.assertEqual(len({o['photoId'] for o in point['observations']}),len(point['observations']))
            for obs in point['observations']:
                self.assertEqual(obs['origin'],'detected')
                self.assertIn(tuple(obs['xy']),detected[obs['photoId']])
        self.assertTrue(any(len(p['observations'])==4 for p in result['landmarks']))

    def test_detected_tracks_cannot_count_the_same_physical_pixel_twice(self):
        result=self.collect(objects=[self.object])
        pixels=set()
        for point in result['landmarks']:
            for observation in point['observations']:
                key=(observation['photoId'],tuple(np.asarray(observation['xy'],dtype=np.float32)))
                self.assertNotIn(key,pixels,'duplicate SIFT orientations must not become extra physical points')
                pixels.add(key)

    def test_detected_track_does_not_duplicate_an_existing_manual_pixel(self):
        detected=self.collect(objects=[self.object])
        xy=next(o['xy'] for o in detected['landmarks'][0]['observations'] if o['photoId']=='p0')
        manual=[{'id':'keep-measured-corner','objectId':None,'observations':[{'photoId':'p0','xy':xy,'origin':'manual'}]}]
        result=self.collect(objects=[self.object],landmarks=manual)
        self.assertEqual(result['landmarks'][0],manual[0])
        self.assertEqual(sum(o['photoId']=='p0' and np.array_equal(np.asarray(o['xy'],dtype=np.float32),np.asarray(xy,dtype=np.float32))
                             for point in result['landmarks'] for o in point['observations']),1)

    def test_rejected_candidate_is_not_reintroduced(self):
        result=self.collect(objects=[self.object],questions=[{'id':'q','photoIds':['p0','p1','p2','p3']}],answers=[{'questionId':'q','value':'no'}])
        self.assertEqual(result['landmarks'],[])
        self.assertTrue(any(r['code']=='user_rejected' for r in result['rejected']))

    def test_rejected_pair_cannot_return_through_a_third_view(self):
        result=self.collect(objects=[self.object],questions=[{'id':'q','photoIds':['p0','p1']}],answers=[{'questionId':'q','value':'no'}])
        self.assertFalse(any({'p0','p1'}<={o['photoId'] for o in p['observations']} for p in result['landmarks']))
        self.assertTrue(any(r['code']=='user_rejected_track' for r in result['rejected']))

    def test_manual_point_conflicting_with_a_rejected_pair_requires_correction(self):
        manual=[{'id':'conflict','objectId':None,'observations':[{'photoId':p,'xy':[30,40],'origin':'manual'} for p in ['p0','p1']]}]
        result=self.collect(landmarks=manual,questions=[{'id':'q','photoIds':['p0','p1']}],answers=[{'questionId':'q','value':'no'}])
        self.assertEqual(result['landmarks'],[])
        self.assertTrue(any(m['code']=='conflicting_observations' for m in result['missing']))

    def test_observation_extension_never_searches_a_user_rejected_photo_pair(self):
        point={'id':'marked','observations':[{'photoId':'p0','xy':[20,30],'origin':'manual'}]}
        def unexpected(photo_id):raise AssertionError('a rejected pair must not be searched')
        result=extend_observations(point,{'photoIds':['p0','p1']},{'catalog':self.catalog,'features':unexpected,'config':CONFIG,'deniedPairs':{frozenset(['p0','p1'])}})
        self.assertEqual(result,point)

    def test_blank_images_produce_specific_missing_information(self):
        for p in self.catalog:Image.new('L',(400,320),0).save(p['path'])
        result=self.collect(objects=[self.object])
        self.assertEqual(result['landmarks'],[])
        self.assertEqual(result['missing'][0]['code'],'no_real_features')

    def test_degenerate_native_pair_does_not_abort_or_invent_matches(self):
        ordinary={**self.object,'kind':'points','corners':[],
            'rois':[{'photoId':p['photoId'],'polygon':[[0,0],[399,0],[399,319],[0,319]]} for p in self.catalog]}
        manual=[{'id':'keep-user-input','objectId':None,'observations':[
            {'photoId':'p0','xy':[30,40],'origin':'manual'},
            {'photoId':'p2','xy':[35,45],'origin':'manual'}]}]
        with patch('assisted_features.cv2.findFundamentalMat',side_effect=cv2.error('degenerate model')) as fit:
            result=self.collect(objects=[ordinary],landmarks=manual)
        self.assertEqual(fit.call_count,6)
        self.assertEqual(result['landmarks'],manual)
        rejected=[r for r in result['rejected'] if r['code']=='degenerate_feature_pair']
        self.assertEqual(len(rejected),6)
        self.assertTrue(all(r['objectId']=='fixed-object' and len(r['photoIds'])==2 for r in rejected))

    def test_nonplanar_manual_points_keep_only_measured_pixels(self):
        manual=[{'id':'marked','objectId':None,'observations':[{'photoId':'p0','xy':[73.25,120.5],'origin':'manual'},{'photoId':'p2','xy':[12.5,29.5],'origin':'manual'}]}]
        result=self.collect(landmarks=manual)
        self.assertEqual(result['landmarks'],manual)

    def test_extension_does_not_rescan_a_side_with_enough_views(self):
        point={'id':'marked','observations':[{'photoId':f'p{i}','xy':[20,30],'origin':'manual'} for i in (0,1)]}
        def unexpected(photo_id):raise AssertionError('unnecessary full image extraction')
        region={'photoIds':[p['photoId'] for p in self.catalog]}
        self.assertEqual(extend_observations(point,region,{'catalog':self.catalog,'features':unexpected,'config':CONFIG}),point)


if __name__=='__main__':unittest.main()
