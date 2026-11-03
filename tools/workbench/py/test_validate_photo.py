import hashlib
import json
import subprocess
import sys
import tempfile
import struct
import zlib
import unittest
from pathlib import Path
from PIL import Image

SCRIPT = Path(__file__).with_name('validate_photo.py')

class PhotoValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'upload'
        self.addCleanup(self.tmp.cleanup)

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True, timeout=30)

    def validate(self, ext):
        return self.run_cli('--image', self.path, '--extension', ext, '--min-long-edge', '1000')

    def test_valid_jpeg_png_and_exif_preserve_raw(self):
        for fmt, ext in [('JPEG', '.jpeg'), ('PNG', '.png')]:
            exif = Image.Exif(); exif[274] = 6
            Image.new('RGB', (1200, 1000), 'blue').save(self.path, format=fmt, exif=exif)
            original = self.path.read_bytes()
            result = self.validate(ext)
            self.assertEqual(result.returncode, 0, result.stderr)
            info = json.loads(result.stdout)
            self.assertEqual((info['format'], info['extension']), (fmt, '.jpg' if fmt == 'JPEG' else '.png'))
            self.assertEqual((info['width'], info['height']), (1000, 1200))
            self.assertEqual(info['sha256'], hashlib.sha256(original).hexdigest())
            self.assertEqual(info['bytes'], len(original))
            self.assertEqual(self.path.read_bytes(), original)

    def test_rejects_truncated_corrupt_mismatch_and_small(self):
        Image.new('RGB', (1200, 1000), 'red').save(self.path, format='JPEG')
        raw = self.path.read_bytes()
        self.assertNotEqual(self.validate('.png').returncode, 0)
        self.path.write_bytes(raw[:-100])
        with Image.open(self.path) as image: image.verify()  # verify alone misses this truncation
        self.assertNotEqual(self.validate('.jpg').returncode, 0)
        self.path.write_bytes(b'not an image'); self.assertNotEqual(self.validate('.jpg').returncode, 0)
        Image.new('RGB', (999, 999)).save(self.path, format='PNG')
        self.assertNotEqual(self.validate('.png').returncode, 0)

    def test_truncated_png_and_pixel_bomb(self):
        Image.new('RGB', (1200, 1000)).save(self.path, format='PNG')
        raw = self.path.read_bytes()
        self.path.write_bytes(raw[:-20])
        self.assertNotEqual(self.validate('.png').returncode, 0)
        header = struct.pack('>II', 11000, 10000) + raw[24:29]
        crc = zlib.crc32(b'IHDR' + header)
        self.path.write_bytes(raw[:16] + header + struct.pack('>I', crc) + raw[33:])
        self.assertNotEqual(self.validate('.png').returncode, 0)

    def test_configured_decoder_capability_and_real_fixture(self):
        program = '''import {TOOLS} from './tools/workbench/lib/paths.mjs';
import {spawnSync} from 'node:child_process';
if (!TOOLS.ffmpeg) { console.log('unconfigured'); process.exit(0); }
const args = ['tools/workbench/py/validate_photo.py', ...JSON.parse(process.argv[1]), '--ffmpeg', TOOLS.ffmpeg];
const result = spawnSync(TOOLS.python, args, {encoding:'utf8'});
process.stdout.write(JSON.stringify({code:result.status, out:result.stdout, err:result.stderr}));'''
        def invoke(args):
            result = subprocess.run(['node', '--input-type=module', '-e', program, json.dumps(args)],
                                    capture_output=True, text=True, timeout=45)
            self.assertEqual(result.returncode, 0, result.stderr)
            if result.stdout.strip() == 'unconfigured': self.skipTest('ffmpeg is not configured')
            return json.loads(result.stdout)
        caps = invoke(['--capabilities'])
        self.assertEqual(caps['code'], 0, caps['err'])
        if '.heic' not in json.loads(caps['out'])['photoFormats']:
            self.skipTest('configured ffmpeg cannot decode the HEIC fixture')
        self.path.write_bytes((SCRIPT.parent / 'photo_fixtures' / 'basic-8bit-srgb.heic').read_bytes())
        result = invoke(['--image', str(self.path), '--extension', '.heic', '--min-long-edge', '1000'])
        self.assertEqual(result['code'], 0, result['err'])
        self.assertEqual((json.loads(result['out'])['width'], json.loads(result['out'])['height']), (1600, 1200))
        self.path.write_bytes(self.path.read_bytes()[:109836])
        self.assertNotEqual(invoke(['--image', str(self.path), '--extension', '.heic'])['code'], 0)

    def test_oversize_and_unsupported_heic(self):
        with self.path.open('wb') as out: out.truncate(64 * 1024 * 1024 + 1)
        self.assertNotEqual(self.validate('.jpg').returncode, 0)
        self.path.write_bytes(b'not heic')
        self.assertNotEqual(self.validate('.heic').returncode, 0)
        for ffmpeg in (None, self.path, self.path.parent / 'missing-ffmpeg.exe'):
            args = ['--capabilities'] + (['--ffmpeg', ffmpeg] if ffmpeg else [])
            result = self.run_cli(*args)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['photoFormats'], ['.jpg', '.jpeg', '.png'])

if __name__ == '__main__': unittest.main()
