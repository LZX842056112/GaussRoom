"""The top-level `internal_error` boundary of prepare_project.py.

`main()` returns 0 after writing a manifest for every *content* failure, because
`jobs.mjs` halts on a non-zero exit before `verify()` ever runs - so an
actionable error code that exits 3 never reaches the UI. That contract is easy to
break by accident: a bare `except Exception` around `main()` that exits non-zero
would silently take the whole channel down again.

These tests pin the boundary's five observable behaviours:

1. a genuine crash inside `main()` becomes exit 0 + `error.code =
   "internal_error"` + a traceback on stderr + a clean user-facing message;
2. the content-level `no_input` path is *not* swallowed by the boundary;
3. a deliberate non-zero return (`return 2` for "project already has images")
   survives untouched;
4. when the manifest itself cannot be written the boundary degrades to exit 1
   instead of pretending success;
5. both `--project <path>` and `--project=<path>` are understood, because
   argparse's parsed values are unreachable once `main()` has raised.

The crash is provoked for real rather than mocked: `--images-relative` pointing
outside the project makes `main()` raise `ValueError` on its own.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
PREPARE = HERE / "prepare_project.py"

sys.path.insert(0, str(HERE))
import prepare_project  # noqa: E402


class PrepareBoundary(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)
        self.source = self.root / "src"
        self.source.mkdir()

    def _run(self, *argv):
        # cwd is the scratch tree, never the repository: a regression that writes
        # a relative path must not be able to dirty the working copy.
        result = subprocess.run([sys.executable, "-B", str(PREPARE), *argv],
                                capture_output=True, cwd=str(self.root))
        return (result.returncode,
                result.stdout.decode("utf-8", "replace"),
                result.stderr.decode("utf-8", "replace"))

    def _project(self, name="project"):
        folder = self.root / name
        folder.mkdir(exist_ok=True)
        return folder

    def _manifest(self, project):
        return json.loads((project / "manifest.json").read_text(encoding="utf-8"))

    def _crash_argv(self, project):
        """Arguments that make main() raise ValueError on its own."""
        return ("--source", str(self.source), "--project", str(project),
                "--images-relative", "../outside")

    def test_a_crash_becomes_an_internal_error_manifest(self):
        project = self._project()
        code, _, err = self._run(*self._crash_argv(project))
        self.assertEqual(code, 0, "非零退出会让 jobs 在 verify() 之前停下，错误码就到不了 UI")
        manifest = self._manifest(project)
        self.assertEqual(manifest["error"]["code"], "internal_error")
        self.assertEqual(manifest["error"]["message"], "预处理发生内部错误，请检查运行环境后重试")
        self.assertIn("source_dir", manifest)
        # Operators get the full traceback; the user-facing message does not.
        self.assertIn("Traceback (most recent call last)", err)
        self.assertIn("ValueError", err)
        self.assertNotIn("Traceback", manifest["error"]["message"])
        self.assertNotIn("ValueError", manifest["error"]["message"])

    def test_no_input_is_not_swallowed_by_the_boundary(self):
        project = self._project()
        code, _, _ = self._run("--project", str(project))
        self.assertEqual(code, 0)
        manifest = self._manifest(project)
        self.assertEqual(manifest["error"]["code"], "no_input")
        self.assertIn("至少需要一个图片目录或视频文件", manifest["error"]["message"])

    def test_a_deliberate_nonzero_return_survives(self):
        project = self._project("busy")
        images = project / "images"
        images.mkdir()
        (images / "a.jpg").write_bytes(b"not really a jpeg")
        code, _, err = self._run("--source", str(self.source), "--project", str(project))
        self.assertEqual(code, 2, "项目已有图像且未指定 --force 时必须仍然是 2")
        self.assertIn("--force", err)
        self.assertFalse((project / "manifest.json").exists(),
                         "这条路径不该留下 manifest，更不该被改写成 internal_error")

    def test_an_unwritable_manifest_degrades_to_exit_one(self):
        # --project pointing at a regular file: the boundary cannot create
        # <file>/manifest.json, so it must admit failure instead of exiting 0.
        blocker = self.root / "blocker.txt"
        blocker.write_text("not a directory", encoding="utf-8")
        code, _, err = self._run(*self._crash_argv(blocker))
        self.assertEqual(code, 1)
        self.assertIn("Traceback (most recent call last)", err)
        self.assertFalse((self.root / "blocker.txt" / "manifest.json").exists())

    def test_the_equals_form_of_project_is_understood(self):
        project = self._project()
        code, _, _ = self._run("--source", str(self.source),
                               f"--project={project}", "--images-relative", "../outside")
        self.assertEqual(code, 0)
        self.assertEqual(self._manifest(project)["error"]["code"], "internal_error")

    def test_argv_values_reads_both_option_forms(self):
        self.assertEqual(prepare_project._argv_values(
            ["--project", "/a", "--project=/b", "--other", "/c"], "project"),
            ["/a", "/b"])
        # A dangling option at the end has no value to read, so it yields
        # nothing rather than raising: this is a best-effort recovery path.
        self.assertEqual(prepare_project._argv_values(["--project"], "project"), [])
        self.assertEqual(prepare_project._argv_values(["--source", "/x"], "project"), [])

    def test_internal_error_manifest_needs_a_project(self):
        self.assertFalse(prepare_project._internal_error_manifest([]))
        self.assertFalse(prepare_project._internal_error_manifest(["--source", "/x"]))


if __name__ == "__main__":
    unittest.main()
