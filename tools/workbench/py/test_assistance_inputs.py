import hashlib
import json
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from PIL import Image
from assistance_inputs import build_catalog, snapshot_database, matching_content_signature, fingerprint_inputs
from sparse_reconstruct import reconstruct


class InputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root/'source.db'
        with closing(sqlite3.connect(self.db)) as db:
            db.executescript('create table images(image_id integer primary key,name text); create table matches(pair_id integer primary key,data blob);')
            db.execute('insert into images values (1,?)', ('a.jpg',))
            db.execute('insert into matches values (1,?)', (b'actual matches',))
            db.commit()

    def test_header_counter_does_not_invalidate_matching_content(self):
        changed = self.root/'header.db'
        content = bytearray(self.db.read_bytes())
        counter = struct.unpack('>I', content[24:28])[0]+1
        content[24:28] = struct.pack('>I', counter)
        content[92:96] = struct.pack('>I', counter)
        changed.write_bytes(content)
        self.assertNotEqual(hashlib.sha256(self.db.read_bytes()).digest(), hashlib.sha256(changed.read_bytes()).digest())
        self.assertEqual(matching_content_signature(self.db), matching_content_signature(changed))
        with closing(sqlite3.connect(changed)) as db:
            db.execute('update matches set data=?', (b'changed match',))
            db.commit()
        self.assertNotEqual(matching_content_signature(self.db), matching_content_signature(changed))

    def test_snapshot_is_consistent_and_source_stays_unchanged(self):
        before = self.db.read_bytes()
        target = self.root/'inputs'/'matches.db'
        result = snapshot_database(self.db, target)
        self.assertEqual(self.db.read_bytes(), before)
        self.assertEqual(result['matchingContentSha256'], matching_content_signature(self.db))
        with closing(sqlite3.connect(target)) as db:
            self.assertEqual(db.execute('pragma quick_check').fetchone()[0], 'ok')
        with self.assertRaises(ValueError):
            snapshot_database(self.db, self.db)

    def test_exif_work_image_uses_display_orientation(self):
        source = self.root/'originals'; source.mkdir()
        exif = Image.Exif(); exif[274] = 6
        Image.new('RGB', (16,24), 'red').save(source/'rotated.jpg', exif=exif)
        Image.new('RGB', (16,24), 'blue').save(source/'other.jpg')
        originals = {p.name:p.read_bytes() for p in source.iterdir()}
        output = self.root/'project'
        subprocess.run([sys.executable, str(Path(__file__).with_name('prepare_project.py')), '--source',str(source),'--project',str(output),'--long-edge','64','--min-long-edge','1'], check=True, capture_output=True)
        manifest = json.loads((output/'manifest.json').read_text(encoding='utf8'))
        photos = build_catalog(manifest, output/'images')
        rotated = next(p for p in photos if p['name'].endswith('rotated.jpg'))
        self.assertEqual((rotated['width'],rotated['height']), (24,16))
        self.assertEqual(rotated['sourceSha256'], hashlib.sha256(originals['rotated.jpg']).hexdigest())
        self.assertEqual(rotated['photoId'],rotated['sourceSha256'])
        self.assertEqual({p.name:p.read_bytes() for p in source.iterdir()}, originals)

    def test_both_mappers_preserve_source(self):
        for mapper in ('global','incremental'):
            before = self.db.read_bytes()
            paths = []
            def fake(command, **kwargs):
                path = Path(command[command.index('--database_path')+1]); paths.append(path)
                with closing(sqlite3.connect(path)) as db:
                    db.execute("update images set name='native changed a counter or data'")
                    db.commit()
            reconstruct('colmap', self.db, self.root/'images', self.root/mapper, mapper, run=fake)
            self.assertEqual(self.db.read_bytes(),before)
            self.assertTrue(all(p.resolve()!=self.db.resolve() for p in paths))

    def test_renamed_photos_keep_identity_not_geometry(self):
        a = [{'photoId':'id','name':'before.jpg','workSha256':'work','width':10,'height':20}]
        b = [{**a[0],'name':'after.jpg'}]
        snapshot = self.root/'snapshot.db';snapshot_database(self.db,snapshot)
        self.assertEqual(fingerprint_inputs(a,snapshot,[],{})['photosSha256'],fingerprint_inputs(b,snapshot,[],{})['photosSha256'])

    def test_explicit_component_context_can_fingerprint_geometry_without_matches(self):
        result=fingerprint_inputs([],None,[],{})
        self.assertEqual(result['matchingContentSha256'],'unavailable')
        self.assertIsNone(result['matchingSnapshotSha256'])

    def test_frame_and_rig_changes_invalidate_input_and_gate_geometry_signatures(self):
        from gate_model import geometry_signature
        model=self.root/'model';model.mkdir()
        for name in ['cameras.bin','images.bin','points3D.bin','frames.bin','rigs.bin']:(model/name).write_bytes(name.encode())
        for name in ['frames.bin','rigs.bin']:
            before=fingerprint_inputs([],None,[model],{})['geometrySha256'];gate_before=geometry_signature(model)
            (model/name).write_bytes(b'changed native pose')
            self.assertNotEqual(fingerprint_inputs([],None,[model],{})['geometrySha256'],before,name)
            self.assertNotEqual(geometry_signature(model),gate_before,name)
            present=fingerprint_inputs([],None,[model],{})['geometrySha256'];present_gate=geometry_signature(model)
            (model/name).unlink()
            absent=fingerprint_inputs([],None,[model],{})['geometrySha256'];absent_gate=geometry_signature(model)
            self.assertNotEqual(absent,present,name);self.assertNotEqual(absent_gate,present_gate,name)
            (model/name).write_bytes(b'changed native pose')
            self.assertEqual(fingerprint_inputs([],None,[model],{})['geometrySha256'],present)
            self.assertEqual(geometry_signature(model),present_gate)


if __name__ == '__main__': unittest.main()
