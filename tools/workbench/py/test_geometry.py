"""Behavior tests using tiny COLMAP binary fixtures."""
import importlib.util
import json
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('gate_model', HERE / 'gate_model.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def make_model(folder, tracks, image_count):
    folder.mkdir(parents=True)
    with (folder / 'images.bin').open('wb') as f:
        f.write(struct.pack('<Q', image_count))
        for i in range(1, image_count + 1):
            f.write(struct.pack('<idddddddi', i, 1, 0, 0, 0, 0, 0, 0, 1))
            f.write(f'camera-01/image-{i}.jpg'.encode() + b'\0')
            f.write(struct.pack('<Q', 0))
    with (folder / 'points3D.bin').open('wb') as f:
        f.write(struct.pack('<Q', len(tracks)))
        for point_id, ids in enumerate(tracks, 1):
            f.write(struct.pack('<QdddBBBdQ', point_id, 0, 0, 1, 100, 100, 100, 0.5, len(ids)))
            for image_id in ids:
                f.write(struct.pack('<ii', image_id, 0))


class GeometryTests(unittest.TestCase):
    def test_bridge_candidates_only_report_cross_component_matches(self):
        self.assertTrue(hasattr(gate, 'bridge_candidates'), '缺少跨区域候选匹配报告')
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch)/'db.sqlite'
            db = sqlite3.connect(path)
            db.executescript('create table images(image_id integer,name text); create table two_view_geometries(pair_id integer,rows integer,config integer);')
            db.executemany('insert into images values (?,?)', [(1,'a.jpg'),(2,'b.jpg'),(3,'c.jpg')])
            db.executemany('insert into two_view_geometries values (?,?,?)', [(2147483647+2,500,2),(2147483647+3,31,6)])
            db.commit(); db.close()
            candidates = gate.bridge_candidates(path, [{'name':'0','geometryComponents':[
                {'index':0,'images':['a.jpg','b.jpg']}, {'index':1,'images':['c.jpg']}]}])
            self.assertEqual(len(candidates), 1)
            self.assertEqual(candidates[0]['inliers'], 31)
            self.assertEqual(candidates[0]['configuration'], '平面或纯旋转')

    def run_gate(self, tracks, count, fragment=0.05):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        root = Path(scratch.name)
        make_model(root/'sparse/0', tracks, count)
        manifest = {'records': [{'work_image': f'images/camera-01/image-{i}.jpg', 'excluded': None}
                                for i in range(1, count+1)]}
        (root/'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        subprocess.run([sys.executable, '-B', str(HERE/'gate_model.py'),
                        '--model-root', str(root/'sparse'), '--database', str(root/'missing.db'),
                        '--manifest', str(root/'manifest.json'), '--out', str(root/'summary'),
                        '--min-points', '1', '--fragment-share', str(fragment)],
                       check=True, capture_output=True, text=True)
        return json.loads((root/'summary/gate.json').read_text(encoding='utf-8'))

    def test_connected_model_passes(self):
        result = self.run_gate([[1, 2], [2, 3], [3, 4]], 4)
        self.assertEqual(result['verdict'], 'pass')
        self.assertEqual(result['models'][0]['geometryComponentSizes'], [4])

    def test_attempt_manifest_prefix_uses_image_relative_names(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        root = Path(scratch.name)
        make_model(root/'sparse/0', [[1,2]], 2)
        (root/'manifest.json').write_text(json.dumps({'records':[
            {'work_image':f'inputs/images/camera-01/image-{i}.jpg','excluded':None} for i in (1,2)
        ]}), encoding='utf8')
        subprocess.run([sys.executable,str(HERE/'gate_model.py'),'--model-root',str(root/'sparse'),
                        '--database',str(root/'absent.db'),'--manifest',str(root/'manifest.json'),
                        '--out',str(root/'summary'),'--min-points','1'],check=True,capture_output=True)
        result=json.loads((root/'summary/gate.json').read_text(encoding='utf8'))
        self.assertEqual(result['models'][0]['unregistered'],[])

    def test_one_file_with_two_disconnected_parts_fails(self):
        result = self.run_gate([[1, 2], [3, 4]], 4)
        self.assertEqual(result['verdict'], 'split')
        self.assertEqual(result['models'][0]['geometryComponentSizes'], [2, 2])
        self.assertEqual(len(result['models'][0]['geometryComponents'][0]['images']), 2)

    def test_isolated_camera_is_reported_and_not_called_fully_connected(self):
        result = self.run_gate([list(range(1, 21))], 21)
        self.assertEqual(result['models'][0]['geometryComponentSizes'], [20, 1])
        self.assertFalse(result['geometryConnected'])
        self.assertNotEqual(result['verdict'], 'pass')

    def test_zero_points_cannot_pass_even_with_zero_minimum(self):
        result = self.run_gate([], 4)
        self.assertNotEqual(result['verdict'], 'pass')

    def test_corrupt_existing_database_is_a_tool_failure(self):
        with tempfile.TemporaryDirectory() as scratch:
            root=Path(scratch)
            make_model(root/'sparse/0',[[1,2]],2)
            (root/'broken.db').write_bytes(b'not a sqlite database')
            (root/'manifest.json').write_text(json.dumps({'records':[
                {'work_image':f'images/camera-01/image-{i}.jpg','excluded':None} for i in (1,2)
            ]}),encoding='utf8')
            result=subprocess.run([sys.executable,str(HERE/'gate_model.py'),'--model-root',str(root/'sparse'),
                        '--database',str(root/'broken.db'),'--manifest',str(root/'manifest.json'),
                        '--out',str(root/'summary'),'--min-points','1'],capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse((root/'summary/gate.json').exists())


if __name__ == '__main__':
    unittest.main()
