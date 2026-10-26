import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
try:
    cli=importlib.import_module('verify_assisted_room')
except ModuleNotFoundError:
    cli=SimpleNamespace()

class AcceptanceCliTest(unittest.TestCase):
    def test_facts_accept_only_editable_assistance_input(self):
        self.assertTrue(callable(getattr(cli,'load_facts',None)))
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'facts.json';path.write_text(json.dumps({'version':1,'patch':{'onlyExistingPhotos':True}}))
            self.assertEqual(cli.load_facts(path),{'onlyExistingPhotos':True})
            for patch in [{'outputRoot':'elsewhere'},{'cameraPoses':[]},{'database':'source.db'}]:
                path.write_text(json.dumps({'version':1,'patch':patch}))
                with self.assertRaises(ValueError):
                    cli.load_facts(path)

    def test_unverified_geometry_never_starts_training(self):
        self.assertTrue(callable(getattr(cli,'drive',None)))
        calls=[]
        def request(method,path,body=None):
            calls.append((method,path,body))
            if path.endswith('/summary'):
                return {'quality':{'geometry':'failed','coverage':'missing'},'gate':{'verdict':'split'}}
            if path.endswith('/assistance'):
                return {'record':{'revision':0,'state':'needs_input','missing':[{'message':'Need observations'}]},'catalog':[]}
            return {'id':'fixture','state':'needs_input','steps':[]}
        result=cli.drive(request,'fixture',None,until='train',poll_seconds=0,timeout_seconds=1)
        self.assertEqual(result['outcome'],'needs_input')
        self.assertFalse(any(method=='POST' for method,_,_ in calls))
