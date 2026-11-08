"""Golden regression for the video frame selector, in two tracks.

Why two tracks
--------------
A single end-to-end golden run cannot be both *portable* and *exact*:

* the exact selection result depends on the pixels the decoder produced, and
  those depend on the ffmpeg build, its compile options and the OpenCV fallback
  path - so a `src_idx` sequence captured on one machine is not evidence about
  another one;
* but without an exact sequence the regression only proves "something came out",
  which is exactly the gap that let `src_idx` stay unasserted.

So the work is split by what each track is allowed to claim:

**Track A - exact, ffmpeg-free.**  A deterministic pure-Python frame generator
replaces decoding entirely: the candidate frames are rendered from a seeded
generator, written once through the same `cv2.imwrite(quality=98)` call the
OpenCV decode path uses, and fed to `analyse()` / `_bucket()`.  Nothing in the
golden chain touches ffmpeg, so the pinned `src_idx` sequence is reproducible on
any machine with the same numpy/OpenCV/Pillow.  `extract()` is then run with
`probe` and `_decode_opencv` stubbed, which additionally pins the *report* layer
against the selection layer - the `report.json` fields are asserted to describe
exactly what the selector did.

**Track B - portable, invariant-only.**  Four small H.264 fixtures are committed
as bytes and assert their own sha256.  They are decoded by the real ffmpeg (and
cross-checked against OpenCV), so only structural invariants are asserted:
schema, policy hash, output size, non-empty frames, existing frame files,
`src_idx` present and increasing, cache reuse, and the error codes of the four
scenario classes.  No `src_idx` value is pinned here, because a different ffmpeg
build legitimately produces different pixels.

Validation gate (skip, never fail)
----------------------------------
Every pinned number is only meaningful for the exact (input bytes, policy hash,
code bytes, toolchain) tuple it was captured on.  When any of those differs the
test *skips* with the reason, because the golden values are not wrong - they are
inapplicable, and failing would turn every tool upgrade into a red build that
people learn to ignore.  Re-capturing is a deliberate act: bump POLICY_VERSION
and update the numbers in the same commit, exactly as `PolicyPin` requires.

Track A does not use ffmpeg, so it is only gated on the tools it actually calls
(numpy/OpenCV/Pillow/Python).  Track B decodes real video, so it is additionally
gated on the ffmpeg/ffprobe version *and* compile options.

ffmpeg is a hard requirement for Track B, not an optional extra: if it is
missing the test **fails** instead of skipping.  A silently skipped Track B is
how "the golden suite passed" comes to mean nothing.

Scope
-----
Like test_video_frames.py, these tests prove the implementation agrees with its
own formulas and that the report describes the selection faithfully.  They do
NOT calibrate thresholds, and a green run here is not evidence that the chosen
frames are good for reconstruction.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np
import PIL

sys.path.insert(0, str(Path(__file__).resolve().parent))
import video_frames  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]          # <repo>/tools/workbench/py -> <repo>
FIXTURE_DIR = HERE / "fixtures" / "video_frames"
ENVIRONMENT_PATH = REPO / "tools" / "video-golden" / "ENVIRONMENT.json"

# Frozen identity of the build the numbers below were captured on. Update both
# in the same commit as any intentional change, then re-capture.
PINNED_POLICY_HASH = "08a52dc4c8c3"
PINNED_BUILD_SHA = "01e3af85304b"


# ── environment plumbing ────────────────────────────────────────────────────
def _ffmpeg():
    """FFMPEG from the environment or the repo .env (tests do not load .env)."""
    if os.environ.get("FFMPEG"):
        return os.environ["FFMPEG"]
    env = REPO / ".env"
    if not env.exists():
        return ""
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("FFMPEG="):
            value = line.split("=", 1)[1].strip()
            return str((REPO / value).resolve()) if value and not Path(value).is_absolute() else value
    return ""


def _ffprobe(ffmpeg):
    binary = Path(ffmpeg)
    for name in ("ffprobe.exe", "ffprobe"):
        candidate = binary.with_name(name)
        if candidate.exists():
            return candidate
    for name in ("ffprobe.exe", "ffprobe"):
        found = shutil.which(name)
        if found:
            return Path(found)
    return None


def _first_line(command):
    try:
        result = subprocess.run(command, capture_output=True, timeout=60, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    lines = result.stdout.decode("utf-8", "replace").splitlines()
    return lines[0] if lines else ""


def _configuration_line(command):
    try:
        result = subprocess.run(command, capture_output=True, timeout=60, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    for line in result.stdout.decode("utf-8", "replace").splitlines():
        if line.startswith("configuration:"):
            return line
    return ""


def _environment():
    """The frozen toolchain record, or None when it cannot be read."""
    if not ENVIRONMENT_PATH.exists():
        return None
    try:
        return json.loads(ENVIRONMENT_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _toolchain():
    return {"python": sys.version.split()[0], "numpy": np.__version__,
            "opencv": cv2.__version__, "pillow": PIL.__version__}


def _gate_reason(track):
    """Why the pinned numbers do not apply here, or None when they do.

    Track A never invokes ffmpeg, so it is not gated on it: gating it on the
    ffmpeg build would skip a perfectly reproducible test for an unrelated
    reason.
    """
    if video_frames.POLICY_HASH != PINNED_POLICY_HASH:
        return (f"policy_hash 变了（{video_frames.POLICY_HASH} != {PINNED_POLICY_HASH}）："
                "阈值或 POLICY_VERSION 已改动，黄金值必须重抓")
    if video_frames.BUILD_SHA != PINNED_BUILD_SHA:
        return (f"BUILD_SHA 变了（{video_frames.BUILD_SHA} != {PINNED_BUILD_SHA}）："
                "选帧实现已改动，黄金值必须重抓")
    record = _environment()
    if record is None:
        return f"读不到 {ENVIRONMENT_PATH}，无法校验采集时的工具链"
    golden = record.get("golden") or {}
    if golden.get("policy_hash") != PINNED_POLICY_HASH or golden.get("build_sha") != PINNED_BUILD_SHA:
        return "ENVIRONMENT.json 与测试内钉的 policy_hash/BUILD_SHA 不一致，两边必须同一批重抓"
    for key, value in _toolchain().items():
        if record.get(key) != value:
            return f"工具链不符：{key} 当前 {value}，采集时 {record.get(key)}"
    if track != "B":
        return None
    ffmpeg = _ffmpeg()
    if not ffmpeg:
        return None                      # the caller fails instead of skipping
    recorded = record.get("ffmpeg") or {}
    version = _first_line([ffmpeg, "-version"])
    configuration = _configuration_line([ffmpeg, "-version"])
    if recorded.get("version") != version:
        return f"ffmpeg 版本不符：当前 {version!r}，采集时 {recorded.get('version')!r}"
    if recorded.get("configuration") != configuration:
        return "ffmpeg 编译选项不符：解码数值随编译选项变化，黄金值必须重抓"
    probe = _ffprobe(ffmpeg)
    probe_version = _first_line([str(probe), "-version"]) if probe else ""
    if (record.get("ffprobe") or {}).get("version") != probe_version:
        return f"ffprobe 版本不符：当前 {probe_version!r}，采集时 {(record.get('ffprobe') or {}).get('version')!r}"
    return None


class RequiresFfmpeg(unittest.TestCase):
    """Track B decodes real video, so a missing ffmpeg is a broken environment.

    Failing (rather than skipping) is deliberate: the existing Extraction class
    already skips on a clean checkout, and one more silently-skipped class is
    how "the golden suite is green" stops meaning anything.
    """

    def setUp(self):
        self.ffmpeg = _ffmpeg()
        if not self.ffmpeg:
            self.fail("Track B 需要 ffmpeg（含 ffprobe）。请在 .env 配置 FFMPEG 后重跑；"
                      "干净 checkout 上这条失败是预期行为，不是回归。")


# ── Track A: deterministic input ────────────────────────────────────────────
# The candidate frames are rendered here instead of decoded, so the golden chain
# has no ffmpeg in it at all.  Every knob below is part of the pinned input:
# change one and the input digest changes, which skips the case until the golden
# values are re-captured.
SCENE_SEED = 20261108
FRAME_W, FRAME_H = 512, 288          # long edge == ANALYSIS_SIDE: no resampling
CLIP_S = 6.0

CASES = {
    # A normal walkthrough: everything passes, only the head/tail trim bites.
    "animated_6s": {"fps": 30.0, "target": 0, "pan": 12, "blur": (), "dup": (), "dark": 0.0},
    # Camera never moves: every candidate is a near-duplicate of the first.
    "static_6s": {"fps": 30.0, "target": 0, "pan": 0, "blur": (), "dup": (), "dark": 0.0},
    # Underexposed room: nothing survives, extract() writes the zero-frame report.
    "dark_6s": {"fps": 30.0, "target": 0, "pan": 12, "blur": (), "dup": (), "dark": 0.04},
    # One motion-blurred candidate: rejected as blurry, then used as a top-up.
    "blurred_t40": {"fps": 30.0, "target": 0, "pan": 12, "blur": (10,), "dup": (), "dark": 0.0},
    # Camera pauses for one candidate at 24 fps with a user target: the emptied
    # bucket is filled by borrowing an unused neighbour.
    "paused_t20_fps24": {"fps": 24.0, "target": 20, "pan": 12, "blur": (), "dup": (6,), "dark": 0.0},
}

GOLDEN = {
    "animated_6s": {
        "fixture_sha256": "209c2834221cfe64",
        "fps": 30.0, "target": 0, "stride_k": 8, "n_cand": 23, "budget": 23,
        "target_source": "auto",
        "src_idx": [16, 24, 32, 40, 48, 56, 64, 72, 80, 88,
                    96, 104, 112, 120, 128, 136, 144, 152, 160, 168],
        "n_kept": 20, "decisions": ["candidate"] * 20,
        "rejected_by_reason": {"head_tail": 3},
        "empty_buckets": 3, "gap_fill": 0, "borrowed": 0, "topup": 0,
        "tau_sharp": 433.74, "sharp_p50": 963.87,
        "mode_flags": [], "warnings": [], "error": None, "out_size": (1920, 1080),
    },
    "static_6s": {
        "fixture_sha256": "6b905fd2e6e828c9",
        "fps": 30.0, "target": 0, "stride_k": 8, "n_cand": 23, "budget": 23,
        "target_source": "auto",
        "src_idx": [16], "n_kept": 1, "decisions": ["candidate"],
        "rejected_by_reason": {"head_tail": 3, "near_dup": 19},
        "empty_buckets": 22, "gap_fill": 0, "borrowed": 0, "topup": 0,
        "tau_sharp": 435.11, "sharp_p50": 966.92,
        "mode_flags": ["low_view_diversity", "underfilled"],
        "warnings": ["low_view_diversity", "partial_coverage"],
        "error": None, "out_size": (1920, 1080),
    },
    "dark_6s": {
        "fixture_sha256": "e5a63f450e7898d6",
        "fps": 30.0, "target": 0, "stride_k": 8, "n_cand": 23, "budget": 23,
        "target_source": "auto",
        "src_idx": [], "n_kept": 0, "decisions": [],
        "rejected_by_reason": {"head_tail": 3, "underexposed": 20},
        "empty_buckets": 23, "gap_fill": 0, "borrowed": 0, "topup": 0,
        "tau_sharp": 80.0, "sharp_p50": 7.98,
        # The zero-frame report is written by the failure branch of extract(),
        # which deliberately carries a reduced shape: no out_w/out_h, no gap
        # accounting, no tau values. Pinning that asymmetry is the point.
        "mode_flags": [], "warnings": [], "reduced_report": True,
        "error": "insufficient_usable_frames", "out_size": (None, None),
    },
    "blurred_t40": {
        "fixture_sha256": "22b8886badf55c2f",
        "fps": 30.0, "target": 0, "stride_k": 8, "n_cand": 23, "budget": 23,
        "target_source": "auto",
        "src_idx": [16, 24, 32, 40, 48, 56, 64, 72, 80, 88,
                    96, 104, 112, 120, 128, 136, 144, 152, 160, 168],
        "n_kept": 20, "decisions": ["candidate"] * 8 + ["topup"] + ["candidate"] * 11,
        "rejected_by_reason": {"head_tail": 3, "blurry": 1},
        "empty_buckets": 3, "gap_fill": 0, "borrowed": 0, "topup": 1,
        "tau_sharp": 433.74, "sharp_p50": 963.87,
        "mode_flags": [], "warnings": [], "error": None, "out_size": (1920, 1080),
    },
    "paused_t20_fps24": {
        "fixture_sha256": "18bd5647cce927b8",
        "fps": 24.0, "target": 20, "stride_k": 6, "n_cand": 24, "budget": 20,
        "target_source": "user",
        "src_idx": [12, 18, 24, 30, 42, 48, 54, 60, 66, 72,
                    78, 84, 90, 96, 102, 108, 114, 120, 126, 132],
        "n_kept": 20, "decisions": ["candidate"] * 9 + ["borrowed"] + ["candidate"] * 10,
        "rejected_by_reason": {"head_tail": 3, "near_dup": 1},
        "empty_buckets": 0, "gap_fill": 0, "borrowed": 1, "topup": 0,
        "tau_sharp": 437.66, "sharp_p50": 972.57,
        "mode_flags": [], "warnings": [], "error": None, "out_size": (1920, 1080),
    },
}


def _scene(extra_width):
    """A wall with uniform edge density.

    Uniformity is the point: a scene whose texture varies with the window
    position would make the sharpness median depend on where the camera happens
    to be, and the golden values would encode that accident instead of the
    selection rules.
    """
    rng = np.random.default_rng(SCENE_SEED)
    field = rng.normal(0.0, 42.0, (FRAME_H, FRAME_W + extra_width)).astype(np.float32)
    field = cv2.GaussianBlur(field, (0, 0), 1.2)
    return np.clip(118.0 + field, 0.0, 255.0).astype(np.uint8)


def _clip_meta(fps):
    return {"duration": CLIP_S, "fps": fps, "width": 1920, "height": 1080,
            "frameCount": int(CLIP_S * fps), "codec": "h264", "pixFmt": "yuv420p",
            "colorTransfer": "", "colorPrimaries": "", "colorSpace": "bt709",
            "bytes": 4096, "name": "synthetic.mp4", "hdr": False}


def _build_case(case, folder):
    """Render one case's candidate frames exactly as the OpenCV path would."""
    config = CASES[case]
    meta = _clip_meta(config["fps"])
    sampling = video_frames.plan_sampling(meta, config["target"])
    count = sampling["candidates"]
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    # "dup" replays the previous candidate's view: a camera that holds still for
    # one sampling step. It is the only way to get a deterministic near-duplicate
    # without depending on how much a pan happens to move the dHash.
    source_of = {index: (index - 1 if index in config["dup"] else index) for index in range(count)}
    scene = _scene(max(source_of.values()) * config["pan"] + 8)
    paths, pixels = [], []
    for index in range(count):
        offset = source_of[index] * config["pan"]
        view = np.ascontiguousarray(scene[:, offset:offset + FRAME_W])
        if config["dark"]:
            view = np.clip(view.astype(np.float32) * config["dark"], 0, 255).astype(np.uint8)
        if index in config["blur"]:
            view = cv2.GaussianBlur(view, (0, 0), 6.0)
        if view.shape != (FRAME_H, FRAME_W):
            raise AssertionError(f"{case}: frame {index} is {view.shape}, expected "
                                 f"{(FRAME_H, FRAME_W)} - the scene is too narrow for this pan")
        path = folder / f"cand-{index:05d}.jpg"
        cv2.imwrite(str(path), view, [int(cv2.IMWRITE_JPEG_QUALITY), 98])
        paths.append(path)
        # Hash what score_frame will actually see, not the encoded bytes: PNG/JPEG
        # encoding may differ between builds while the decoded pixels do not.
        pixels.append(cv2.imread(str(path), cv2.IMREAD_GRAYSCALE).tobytes())
    digest = hashlib.sha256(b"".join(pixels)).hexdigest()[:16]
    return meta, sampling, paths, digest


def _budget_for(target, stats, rows):
    """Mirror of the three clamps extract() applies before bucketing.

    Duplicated on purpose: if extract()'s budget rule changes, the core result
    below and the report produced by extract() disagree, and the comparison test
    fails loudly instead of quietly following the change.
    """
    budget = target
    if stats["lowTextureRatio"] > 0.60:
        budget = min(budget, video_frames.N_MIN_AUTO)
    if stats["medianSharp"] < video_frames.SHARP_ABS * 0.6:
        budget = min(budget, 60)
    return min(budget, rows)


def _selection(meta, sampling, paths):
    """analyse() + _bucket() + gap repair - the whole selector minus decoding."""
    candidates = [(index * sampling["strideK"], (index * sampling["strideK"]) / meta["fps"], path)
                  for index, path in enumerate(paths)]
    rows, stats = video_frames.analyse(candidates, meta, sampling)
    budget = _budget_for(sampling["target"], stats, len(rows))
    kept, empty = video_frames._bucket(rows, budget, stats, meta["duration"])
    kept, gap_fills = video_frames._repair_gaps(kept, rows, limit=max(1, len(kept) // 10))
    return sorted(kept, key=lambda row: row["t"]), stats, budget, len(empty), gap_fills


def _report(case, workspace, meta, sampling, paths):
    """Run extract() with decoding replaced by the deterministic frames."""
    config = CASES[case]
    out_dir = Path(workspace) / "out"
    with mock.patch.object(video_frames, "probe", lambda *args, **kwargs: meta), \
            mock.patch.object(video_frames, "_decode_opencv", lambda *args, **kwargs: list(paths)):
        try:
            return video_frames.extract(Path(workspace) / "synthetic.mp4", out_dir,
                                        ffmpeg=None, target=config["target"],
                                        digest="0" * 64), None
        except video_frames.VideoError as error:
            # A zero-frame run still writes its report first; read it back from
            # disk so the assertions below see exactly what a caller would.
            return json.loads((out_dir / "report.json").read_text(encoding="utf-8")), error.code


class FrozenIdentity(unittest.TestCase):
    """The frozen records must agree with each other, whatever the toolchain.

    These need no ffmpeg and no specific numpy, so they always run: if the
    fixtures were regenerated without updating ENVIRONMENT.json, or the two
    frozen lists drifted apart, that is a repository defect rather than an
    environment mismatch.
    """

    def test_fixture_bytes_are_pinned(self):
        record = _environment()
        self.assertIsNotNone(record, f"缺少 {ENVIRONMENT_PATH}")
        pinned = (record.get("golden") or {}).get("fixtures") or {}
        self.assertEqual(sorted(pinned), ["dark-6s.mp4", "short-1s.mp4", "still-6s.mp4", "walk-6s.mp4"])
        for name, expected in pinned.items():
            path = FIXTURE_DIR / name
            self.assertTrue(path.is_file(), f"fixture 缺失：{path}")
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(actual, expected,
                             f"{name} 的字节变了。fixture 是二进制冻结输入，"
                             "重新生成必须同步更新 ENVIRONMENT.json 与黄金值")

    def test_environment_agrees_with_the_test_file(self):
        record = _environment()
        self.assertIsNotNone(record, f"缺少 {ENVIRONMENT_PATH}")
        golden = record.get("golden") or {}
        self.assertEqual(golden.get("policy_version"), video_frames.POLICY_VERSION)
        self.assertEqual(golden.get("policy_hash"), video_frames.POLICY_HASH)
        self.assertEqual(golden.get("build_sha"), video_frames.BUILD_SHA)
        recorded = golden.get("track_a_input_sha256") or {}
        self.assertEqual(sorted(recorded), sorted(GOLDEN))
        for case, expected in GOLDEN.items():
            self.assertEqual(recorded.get(case), expected["fixture_sha256"],
                             f"{case} 的输入摘要与 ENVIRONMENT.json 不一致")


class TrackASelectionGolden(unittest.TestCase):
    """Exact pinned selection results, gated on the four-way validation."""

    def _prepare(self, case):
        reason = _gate_reason("A")
        meta = sampling = paths = None
        if reason is None:
            workspace = tempfile.TemporaryDirectory()
            self.addCleanup(workspace.cleanup)
            meta, sampling, paths, digest = _build_case(case, Path(workspace.name) / "candidates")
            if digest != GOLDEN[case]["fixture_sha256"]:
                reason = (f"{case} 的输入字节变了（{digest} != {GOLDEN[case]['fixture_sha256']}）："
                          "numpy/OpenCV/Pillow 任一升级都可能改变它，黄金值必须重抓")
        if reason:
            self.skipTest(reason)
        return meta, sampling, paths

    def _extract(self, case, meta, sampling, paths):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        report, error = _report(case, workspace.name, meta, sampling, paths)
        return report, error, Path(workspace.name)

    def _assert_case(self, case):
        expected = GOLDEN[case]
        meta, sampling, paths = self._prepare(case)
        kept, stats, budget, empty, gap_fills = _selection(meta, sampling, paths)

        self.assertEqual(sampling["strideK"], expected["stride_k"], f"{case}: 步长变了")
        self.assertEqual(len(kept), expected["n_kept"], f"{case}: 保留帧数变了")
        self.assertEqual(budget, expected["budget"], f"{case}: 预算变了")
        self.assertEqual(empty, expected["empty_buckets"], f"{case}: 空桶数变了")
        self.assertEqual(gap_fills, expected["gap_fill"], f"{case}: 空隙补帧数变了")
        # src_idx is the only field that records *which* source frames survived;
        # report["frames"][].i is an enumerate ordinal and carries no information.
        self.assertEqual([row["src"] for row in kept], expected["src_idx"], f"{case}: 选中帧序列变了")
        self.assertEqual([row["decision"] for row in kept], expected["decisions"])
        self.assertEqual({key: value for key, value in stats["rejected"].items() if value},
                         expected["rejected_by_reason"], f"{case}: 拒绝原因分布变了")
        # Continuous metrics get a relative tolerance: they are derived from
        # pixels, and only the discrete decisions are exact.
        self.assertAlmostEqual(stats["threshold"], expected["tau_sharp"],
                               delta=max(1.0, expected["tau_sharp"] * 1e-2), msg=f"{case}: tau_sharp")
        self.assertAlmostEqual(stats["medianSharp"], expected["sharp_p50"],
                               delta=max(1.0, expected["sharp_p50"] * 1e-2), msg=f"{case}: sharp_p50")

        report, error, root = self._extract(case, meta, sampling, paths)
        self.assertEqual(error, expected["error"], f"{case}: 错误码变了")
        self.assertEqual(report["schema_version"], video_frames.SCHEMA_VERSION)
        self.assertEqual(report["policy"]["policy_hash"], video_frames.POLICY_HASH)
        self.assertEqual(report["build"]["sha"], video_frames.BUILD_SHA)
        self.assertEqual(report["video"]["decoder"], "cv2")
        self.assertEqual((report["video"].get("out_w"), report["video"].get("out_h")),
                         expected["out_size"], f"{case}: 输出尺寸变了")
        self.assertEqual([row.get("src_idx") for row in report["frames"]], expected["src_idx"],
                         f"{case}: report 的 src_idx 与选帧结果不一致")
        self.assertEqual([row["decision"] for row in report["frames"]], expected["decisions"])
        self.assertEqual(report["stats"].get("n_kept"), expected["n_kept"])
        self.assertEqual(report["stats"].get("rejected_by_reason"), expected["rejected_by_reason"])
        self.assertEqual(report["stats"].get("empty_buckets"), expected["empty_buckets"])
        if expected.get("reduced_report"):
            # The failure branch writes a smaller stats block on purpose; the
            # absent keys are part of the contract, not an oversight.
            for key in ("gap_fill", "borrowed", "topup", "keep_ratio"):
                self.assertIsNone(report["stats"].get(key), f"{case}: 失败报告多出了 {key}")
        else:
            self.assertEqual(report["stats"].get("gap_fill"), expected["gap_fill"])
            self.assertEqual(report["stats"].get("borrowed"), expected["borrowed"])
            self.assertEqual(report["stats"].get("topup"), expected["topup"])
        self.assertEqual(report["mode_flags"], expected["mode_flags"])
        self.assertEqual([warning["code"] for warning in report["warnings"]], expected["warnings"])
        if expected.get("reduced_report"):
            self.assertIsNone(report["policy"].get("tau_sharp"))
            self.assertIsNone(report["policy"].get("sharp_p50"))
        else:
            self.assertAlmostEqual(report["policy"]["tau_sharp"], expected["tau_sharp"],
                                   delta=max(1.0, expected["tau_sharp"] * 1e-2))
            self.assertAlmostEqual(report["policy"]["sharp_p50"], expected["sharp_p50"],
                                   delta=max(1.0, expected["sharp_p50"] * 1e-2))
        # Every reported frame must exist on disk under its reported ordinal.
        frames_dir = root / "out" / "frames"
        self.assertEqual([row["i"] for row in report["frames"]],
                         list(range(1, len(report["frames"]) + 1)))
        if report["frames"]:
            for row in report["frames"]:
                self.assertTrue((frames_dir / f"frame-{row['i']:05d}.jpg").is_file(),
                                f"{case}: frame-{row['i']:05d}.jpg 不存在")

    def test_animated_6s(self):
        self._assert_case("animated_6s")

    def test_static_6s(self):
        self._assert_case("static_6s")

    def test_dark_6s(self):
        self._assert_case("dark_6s")

    def test_blurred_t40(self):
        self._assert_case("blurred_t40")

    def test_paused_t20_fps24(self):
        self._assert_case("paused_t20_fps24")


class TrackAInvariants(unittest.TestCase):
    """Properties that hold on any toolchain, so they never skip.

    The pinned numbers above answer "did the selection change?". These answer
    "is the selection still self-consistent?", which stays meaningful after a
    tool upgrade that legitimately invalidates the pins.
    """

    def _cases(self):
        for case in CASES:
            workspace = tempfile.TemporaryDirectory()
            self.addCleanup(workspace.cleanup)
            yield case, _build_case(case, Path(workspace.name) / "candidates")

    def test_repeated_runs_are_identical(self):
        for case, (meta, sampling, paths, digest) in self._cases():
            with self.subTest(case=case):
                first = _selection(meta, sampling, paths)
                second = _selection(meta, sampling, paths)
                self.assertEqual([[row["src"] for row in first[0]],
                                  [row["decision"] for row in first[0]],
                                  first[2], first[3], first[4], first[1]["threshold"]],
                                 [[row["src"] for row in second[0]],
                                  [row["decision"] for row in second[0]],
                                  second[2], second[3], second[4], second[1]["threshold"]])

    def test_report_layer_matches_the_selection_layer(self):
        for case, (meta, sampling, paths, _) in self._cases():
            with self.subTest(case=case):
                kept, stats, budget, empty, gap_fills = _selection(meta, sampling, paths)
                workspace = tempfile.TemporaryDirectory()
                self.addCleanup(workspace.cleanup)
                report, error = _report(case, workspace.name, meta, sampling, paths)
                self.assertEqual([row["src"] for row in kept],
                                 [row.get("src_idx") for row in report["frames"]],
                                 "report 没有如实反映选帧结果")
                self.assertEqual(len(kept), report["stats"].get("n_kept"))
                self.assertEqual({key: value for key, value in stats["rejected"].items() if value},
                                 report["stats"].get("rejected_by_reason"))
                self.assertEqual(budget, report["policy"]["target_frames"])
                self.assertEqual(empty, report["stats"].get("empty_buckets"))
                if report["frames"]:
                    self.assertIsNone(error)
                    self.assertEqual(gap_fills, report["stats"].get("gap_fill"))
                    self.assertEqual(report["stats"]["n_kept"], len(report["frames"]))
                    self.assertLessEqual(report["stats"]["n_kept"], report["policy"]["target_frames"])
                else:
                    # The zero-frame report is written by the failure branch and
                    # deliberately carries a reduced shape: no gap accounting,
                    # no output size. Assert the reduction instead of comparing
                    # against fields the failure path never writes.
                    self.assertEqual(error, "insufficient_usable_frames")
                    self.assertEqual(report["stats"]["n_kept"], 0)
                    self.assertEqual(report["frames"], [])
                    self.assertIsNone(report["stats"].get("gap_fill"))
                    self.assertIsNone(report["video"].get("out_w"))

    def test_source_indices_are_unique_and_ordered(self):
        for case, (meta, sampling, paths, _) in self._cases():
            with self.subTest(case=case):
                kept, _, _, _, _ = _selection(meta, sampling, paths)
                sources = [row["src"] for row in kept]
                self.assertEqual(len(sources), len(set(sources)), "同一源帧被保留了两次")
                self.assertEqual(sources, sorted(sources), "保留帧未按时间排序")
                self.assertTrue(all(source % sampling["strideK"] == 0 for source in sources),
                                "保留帧不是候选帧（步长不整除）")

    def test_frame_files_are_written_under_their_reported_ordinal(self):
        for case, (meta, sampling, paths, _) in self._cases():
            with self.subTest(case=case):
                workspace = tempfile.TemporaryDirectory()
                self.addCleanup(workspace.cleanup)
                report, _ = _report(case, workspace.name, meta, sampling, paths)
                frames_dir = Path(workspace.name) / "out" / "frames"
                self.assertEqual([row["i"] for row in report["frames"]],
                                 list(range(1, len(report["frames"]) + 1)))
                for row in report["frames"]:
                    self.assertTrue((frames_dir / f"frame-{row['i']:05d}.jpg").is_file())


class TrackBFixtureInvariants(RequiresFfmpeg):
    """Portable invariants over committed binary fixtures.

    No `src_idx` value is pinned here: a different ffmpeg build decodes to
    different pixels, and a sequence captured on one build is not a claim about
    another. What *is* pinned is the shape of the result and the error codes of
    the four scenario classes.
    """

    def setUp(self):
        super().setUp()
        record = _environment()
        self.assertIsNotNone(record, f"缺少 {ENVIRONMENT_PATH}")
        reason = _gate_reason("B")
        if reason:
            self.skipTest(reason)

    def _materialise(self, name, cache, target=0):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        # Copy into the scratch tree: the cache key is the content hash, so a
        # shared fixture path would let cases reuse each other's frames.
        local = Path(workspace.name) / name
        local.write_bytes((FIXTURE_DIR / name).read_bytes())
        return video_frames.materialise([str(local)], cache, ffmpeg=self.ffmpeg, target=target)[0]

    def _assert_report_shape(self, entry, name):
        self.assertNotIn("error", entry, entry.get("error"))
        report = entry["report"]
        self.assertEqual(report["schema_version"], video_frames.SCHEMA_VERSION)
        self.assertEqual(report["policy"]["policy_hash"], video_frames.POLICY_HASH)
        self.assertEqual(report["build"]["sha"], video_frames.BUILD_SHA)
        self.assertEqual(report["policy"]["policy_version"], video_frames.POLICY_VERSION)
        self.assertEqual(report["video"]["sha256"],
                         hashlib.sha256((FIXTURE_DIR / name).read_bytes()).hexdigest())
        self.assertEqual(report["video"]["out_w"], 1280)
        self.assertEqual(report["video"]["out_h"], 720)
        self.assertGreater(len(report["frames"]), 0, "一帧都没留下")
        self.assertEqual([row["i"] for row in report["frames"]],
                         list(range(1, len(report["frames"]) + 1)))
        sources = [row["src_idx"] for row in report["frames"]]
        self.assertEqual(sources, sorted(sources), "src_idx 未单调递增")
        self.assertEqual(len(sources), len(set(sources)), "src_idx 有重复")
        self.assertEqual(report["stats"]["n_kept"], len(report["frames"]))
        self.assertLessEqual(report["stats"]["n_kept"], report["policy"]["target_frames"])
        for row in report["frames"]:
            frame = Path(entry["dir"]) / f"frame-{row['i']:05d}.jpg"
            self.assertTrue(frame.is_file(), f"{frame} 不存在")
        return report

    def test_walk_fixture_yields_a_full_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            entry = self._materialise("walk-6s.mp4", Path(temporary) / "cache")
            report = self._assert_report_shape(entry, "walk-6s.mp4")
            # A panning clip must keep more than a couple of frames, otherwise
            # the fixture has silently become a "static" case.
            self.assertGreaterEqual(len(report["frames"]), 8)
            self.assertNotIn("low_view_diversity", report["mode_flags"])
            self.assertEqual(report["video"]["decoder"], "ffmpeg")
            self.assertFalse(report["video"]["hdr"])
            self.assertEqual(report["video"]["color_pipeline"], "sdr")

    def test_still_fixture_collapses_to_a_few_frames(self):
        with tempfile.TemporaryDirectory() as temporary:
            entry = self._materialise("still-6s.mp4", Path(temporary) / "cache")
            report = self._assert_report_shape(entry, "still-6s.mp4")
            self.assertIn("low_view_diversity", report["mode_flags"])
            self.assertLess(len(report["frames"]), 8)
            self.assertIn("low_view_diversity", [warning["code"] for warning in report["warnings"]])

    def test_dark_fixture_reports_insufficient_usable_frames(self):
        with tempfile.TemporaryDirectory() as temporary:
            entry = self._materialise("dark-6s.mp4", Path(temporary) / "cache")
            self.assertEqual(entry.get("errorCode"), "insufficient_usable_frames")
            report = entry["report"]
            self.assertEqual(report["stats"]["n_kept"], 0)
            self.assertEqual(report["frames"], [])
            self.assertEqual(report["stats"]["rejected_by_reason"].get("underexposed", 0) > 0, True)

    def test_short_fixture_is_rejected_before_decoding(self):
        with tempfile.TemporaryDirectory() as temporary:
            entry = self._materialise("short-1s.mp4", Path(temporary) / "cache")
            self.assertEqual(entry.get("errorCode"), "video_too_short")
            self.assertIn("视频过短", entry["error"])

    def test_byte_identical_videos_are_extracted_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            first = workspace / "a.mp4"
            second = workspace / "b.mp4"
            payload = (FIXTURE_DIR / "walk-6s.mp4").read_bytes()
            first.write_bytes(payload)
            second.write_bytes(payload)
            entries = video_frames.materialise([str(first), str(second)],
                                               workspace / "cache", ffmpeg=self.ffmpeg)
            self.assertNotIn("error", entries[0])
            self.assertIn("内容完全相同", entries[1]["error"])


class CacheInvalidationMatrix(RequiresFfmpeg):
    """Every documented way the frame cache may and may not be reused.

    The matrix exists because cache reuse is the one behaviour that can turn a
    correct-looking report into a lie: the report claims the current policy while
    the frames on disk were chosen by an older one.
    """

    def setUp(self):
        super().setUp()
        record = _environment()
        self.assertIsNotNone(record, f"缺少 {ENVIRONMENT_PATH}")
        reason = _gate_reason("B")
        if reason:
            self.skipTest(reason)

    def _workspace(self):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        root = Path(workspace.name)
        local = root / "walk-6s.mp4"
        local.write_bytes((FIXTURE_DIR / "walk-6s.mp4").read_bytes())
        return root, local

    def _cache_folder(self, root, target=0):
        digest = video_frames._sha256(root / "walk-6s.mp4")
        return root / "cache" / video_frames.cache_key(digest, target)

    def _run(self, root, target=0):
        return video_frames.materialise([str(root / "walk-6s.mp4")], root / "cache",
                                        ffmpeg=self.ffmpeg, target=target)[0]

    def _rewrite_report(self, folder, mutate):
        path = folder / "report.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        mutate(data)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return path

    def test_first_run_extracts_and_second_run_hits(self):
        root, _ = self._workspace()
        first = self._run(root)
        self.assertFalse(first["cached"])
        self.assertGreater(len(first["report"]["frames"]), 0)
        second = self._run(root)
        self.assertTrue(second["cached"], "同 target 二次运行没有命中缓存")
        self.assertEqual(second["report"]["policy"]["policy_hash"], video_frames.POLICY_HASH)

    def test_a_different_target_is_a_different_policy(self):
        root, _ = self._workspace()
        self._run(root)
        other = self._run(root, 40)
        self.assertFalse(other["cached"], "换 target 复用了旧帧")
        # target_frames is the *budget* after clamping, not the request, so the
        # meaningful check is that the run landed in its own cache directory.
        digest = video_frames._sha256(root / "walk-6s.mp4")
        self.assertEqual(Path(other["dir"]).parent.name,
                         video_frames.cache_key(digest, 40).split("/")[-1])
        self.assertNotIn("error", other, other.get("error"))

    def test_a_stale_policy_hash_re_extracts(self):
        root, _ = self._workspace()
        self._run(root)
        folder = self._cache_folder(root)
        self._rewrite_report(folder, lambda data: data["policy"].__setitem__("policy_hash", "deadbeefcafe"))
        again = self._run(root)
        self.assertFalse(again["cached"], "policy_hash 不一致仍然复用了缓存")
        restored = json.loads((folder / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(restored["policy"]["policy_hash"], video_frames.POLICY_HASH)

    def test_a_stale_schema_version_re_extracts(self):
        root, _ = self._workspace()
        self._run(root)
        folder = self._cache_folder(root)
        self._rewrite_report(folder, lambda data: data.__setitem__("schema_version", 999))
        self.assertFalse(self._run(root)["cached"], "schema_version 不一致仍然复用了缓存")

    def test_a_truncated_report_re_extracts(self):
        root, _ = self._workspace()
        self._run(root)
        path = self._cache_folder(root) / "report.json"
        raw = path.read_text(encoding="utf-8")
        path.write_text(raw[:len(raw) // 3], encoding="utf-8")
        again = self._run(root)
        self.assertFalse(again["cached"], "半写的 report.json 被当成有效缓存")
        json.loads(path.read_text(encoding="utf-8"))     # must be valid again

    def test_a_missing_frame_file_re_extracts(self):
        root, _ = self._workspace()
        self._run(root)
        folder = self._cache_folder(root)
        victim = sorted((folder / "frames").glob("frame-*.jpg"))[3]
        victim.unlink()
        again = self._run(root)
        self.assertFalse(again["cached"], "帧文件缺失仍然复用了缓存")
        self.assertTrue(victim.is_file(), "重抽后缺失的帧没有补回")

    def test_a_replaced_frame_file_is_reused(self):
        """Known limitation, pinned so it cannot change silently.

        Reuse validates frame *names*, never frame *bytes*: a frame file that was
        truncated or overwritten in place is still "present", so the cache hits
        and the stale image flows downstream. Nothing in the report can detect
        it. If frame-content validation is ever added, this case must flip to a
        re-extract - and that is the moment to also record the content hash in
        report.json.
        """
        root, _ = self._workspace()
        self._run(root)
        folder = self._cache_folder(root)
        victim = sorted((folder / "frames").glob("frame-*.jpg"))[3]
        victim.write_bytes(b"not a jpeg at all")
        entry = self._run(root)
        self.assertTrue(entry["cached"], "帧内容被替换后行为变了："
                                         "若这是有意修复，请同步更新本用例与文档")
        self.assertEqual(victim.read_bytes(), b"not a jpeg at all")


class DualDecoderConsistency(RequiresFfmpeg):
    """The integer-stride contract between the ffmpeg and OpenCV decode paths.

    CODE_DESIGN claims both decoders yield exactly the same candidate set. That
    claim is what makes the cv2 fallback safe, and until now nothing tested it.
    Only the *candidate set* is asserted: the pixels differ, so the metrics and
    therefore the kept frames may legitimately differ.
    """

    def setUp(self):
        super().setUp()
        record = _environment()
        self.assertIsNotNone(record, f"缺少 {ENVIRONMENT_PATH}")
        reason = _gate_reason("B")
        if reason:
            self.skipTest(reason)

    def _decode_both(self, name):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        root = Path(workspace.name)
        local = root / name
        local.write_bytes((FIXTURE_DIR / name).read_bytes())
        meta = video_frames.probe(local, self.ffmpeg)
        sampling = video_frames.plan_sampling(meta, 0)
        size = video_frames._output_size(meta)
        for label in ("ffmpeg", "opencv"):
            (root / label).mkdir()
        decoded_ffmpeg, _ = video_frames._decode_ffmpeg(local, root / "ffmpeg", sampling, meta,
                                                        self.ffmpeg, size)
        decoded_opencv = video_frames._decode_opencv(local, root / "opencv", sampling, meta, size)
        return meta, sampling, decoded_ffmpeg, decoded_opencv

    def test_both_decoders_select_the_same_candidates(self):
        for name in ("walk-6s.mp4", "still-6s.mp4"):
            with self.subTest(fixture=name):
                meta, sampling, decoded_ffmpeg, decoded_opencv = self._decode_both(name)
                expected = int(-(-meta["frameCount"] // sampling["strideK"]))
                self.assertEqual(len(decoded_ffmpeg), expected,
                                 "ffmpeg 路径的候选数不等于 ceil(nb_frames/stride)")
                self.assertEqual(len(decoded_opencv), len(decoded_ffmpeg),
                                 "两条解码路径的候选集不一致")
                # Candidate identity is the frame number, not the file: the nth
                # candidate of either decoder must be source frame n*strideK.
                self.assertEqual([path.name for path in decoded_ffmpeg],
                                 [f"cand-{index:05d}.jpg" for index in range(len(decoded_ffmpeg))])
                self.assertEqual([path.name for path in decoded_opencv],
                                 [path.name for path in decoded_ffmpeg])

    def test_both_decoders_agree_on_the_sampling_plan(self):
        meta, sampling, decoded_ffmpeg, decoded_opencv = self._decode_both("walk-6s.mp4")
        self.assertIsInstance(sampling["strideK"], int)
        self.assertGreaterEqual(sampling["strideK"], 1)
        self.assertGreater(len(decoded_ffmpeg), 0)
        self.assertEqual(sampling["candidates"], len(decoded_ffmpeg))


if __name__ == "__main__":
    unittest.main()
