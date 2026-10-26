import hashlib
import importlib.util
import os
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest
from contextlib import closing
from pathlib import Path

HERE = Path(__file__).resolve().parent


class SparseTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((HERE/'sparse_reconstruct.py').exists(), '缺少安全的校准与重建入口')
        spec = importlib.util.spec_from_file_location('sparse_reconstruct', HERE/'sparse_reconstruct.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = Path(self.temp.name)/'database.db'
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('create table evidence (value text)')
            db.execute("insert into evidence values ('original')")
            db.commit()

    def test_global_calibrates_copy_then_maps_and_preserves_original(self):
        digest = hashlib.sha256(self.database.read_bytes()).hexdigest()
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            if command[1] == 'view_graph_calibrator':
                with closing(sqlite3.connect(command[command.index('--database_path')+1])) as db:
                    db.execute("update evidence set value='calibrated'")
                    db.commit()
        self.module.reconstruct('colmap', self.database, Path('images'), Path(self.temp.name)/'sparse', 'global', run=run)
        self.assertEqual([c[1] for c in commands], ['view_graph_calibrator', 'global_mapper'])
        self.assertEqual(commands[0][3], commands[1][3])
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), digest)

    def test_calibration_failure_does_not_start_mapper(self):
        commands = []
        def fail(command, **kwargs):
            commands.append(command)
            raise subprocess.CalledProcessError(9, command)
        with self.assertRaises(subprocess.CalledProcessError):
            self.module.reconstruct('colmap', self.database, Path('images'), Path(self.temp.name)/'sparse', 'global', run=fail)
        self.assertEqual(len(commands), 1)

    def test_incremental_does_not_calibrate(self):
        commands = []
        self.module.reconstruct('colmap', self.database, Path('images'), Path(self.temp.name)/'sparse', 'incremental',
                                run=lambda command, **kwargs: commands.append(command))
        self.assertEqual([c[1] for c in commands], ['mapper'])
        self.assertNotEqual(commands[0][3], str(self.database))
        self.assertEqual(Path(commands[0][3]).name, 'database-incremental.db')

    def test_nested_child_logs_reach_workbench_without_console(self):
        # Exercise the Windows process boundary, not just the runner arguments.
        script = textwrap.dedent(f'''
            import subprocess, sys
            sys.path.insert(0, {str(HERE)!r})
            from sparse_reconstruct import reconstruct
            def launch(command, **options):
                return subprocess.run([sys.executable, '-c',
                    "import sys; print('MAPPER_STDOUT', flush=True); print('MAPPER_STDERR', file=sys.stderr, flush=True)"], **options)
            reconstruct('colmap', {str(self.database)!r}, 'images', {str(Path(self.temp.name)/'sparse')!r}, 'incremental', run=launch)
        ''')
        log = Path(self.temp.name)/'nested.log'
        with log.open('w', encoding='utf-8') as output:
            subprocess.run([sys.executable, '-c', script], stdout=output, stderr=output,
                           check=True, env={**os.environ, 'PYTHONUTF8': '1'},
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        content = log.read_text(encoding='utf-8')
        self.assertIn('MAPPER_STDOUT', content)
        self.assertIn('MAPPER_STDERR', content)


if __name__ == '__main__':
    unittest.main()
