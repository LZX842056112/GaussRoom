import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
import prepare_project

class PhotoImportTest(unittest.TestCase):
    def test_multiple_readonly_sources_keep_same_named_different_photos(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);a=root/'a';b=root/'b';a.mkdir();b.mkdir()
            Image.new('RGB',(1200,1000),'red').save(a/'same.png')
            Image.new('RGB',(1200,1000),'blue').save(b/'same.png')
            originals=[p.read_bytes() for p in [a/'same.png',b/'same.png']]
            args=['prepare','--source',str(a),'--source',str(b),'--project',str(root/'result')]
            with patch.object(sys,'argv',args),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                code=prepare_project.main()
            manifest=json.loads((root/'result/manifest.json').read_text(encoding='utf8'))
            self.assertEqual(manifest['source_count'],2)
            self.assertEqual(code,0)
            self.assertEqual(manifest['retained_count'],2)
            self.assertEqual(len({r['work_image'] for r in manifest['records']}),2)
            self.assertEqual([p.read_bytes() for p in [a/'same.png',b/'same.png']],originals)
