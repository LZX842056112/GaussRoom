"""Frame-selection units that do not need a real capture, plus one ffmpeg-gated
end-to-end run.

Scope note: these tests prove the *implementation* obeys its own formulas and
that the report is internally consistent. They do NOT calibrate thresholds -
SHARP_ABS / SHARP_REL / TEX_MIN / DHASH_DUP_BITS / N_MIN_AUTO / N_MAX_AUTO are
experience values that still need an A/B run on real footage (spec v1.0 §8). Do
not read a green run here as "the thresholds are right".

The pure units pin down the parts that silently change behaviour: the budget law,
the policy hash (which decides cache reuse), integer output sizes, and the
rule that a blurred candidate never displaces a sharp one.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import video_frames  # noqa: E402

FFMPEG = os.environ.get('FFMPEG') or ''
REPO = Path(__file__).resolve().parents[3]


def _configured_ffmpeg():
    """FFMPEG from the repo .env, because tests do not load .env themselves."""
    if FFMPEG:
        return FFMPEG
    env = REPO / '.env'
    if not env.exists():
        return ''
    for line in env.read_text(encoding='utf-8').splitlines():
        if line.startswith('FFMPEG='):
            value = line.split('=', 1)[1].strip()
            return str((REPO / value).resolve()) if value and not Path(value).is_absolute() else value
    return ''


def _meta(duration=120.0, fps=30.0, width=1920, height=1080, **extra):
    return {"duration": duration, "fps": fps, "width": width, "height": height,
            "frameCount": int(duration * fps), **extra}


class Budget(unittest.TestCase):
    def test_sqrt_law_hits_the_anchor(self):
        sampling = video_frames.plan_sampling(_meta(duration=120.0))
        self.assertEqual(sampling["target"], video_frames.N_ANCHOR)
        self.assertEqual(sampling["targetSource"], "auto")

    def test_short_and_long_clips_are_clamped(self):
        self.assertEqual(video_frames.plan_sampling(_meta(duration=4.0))["target"],
                         video_frames.N_MIN_AUTO)
        self.assertEqual(video_frames.plan_sampling(_meta(duration=3600.0))["target"],
                         video_frames.N_MAX_AUTO)

    def test_user_target_wins_within_its_own_bounds(self):
        self.assertEqual(video_frames.plan_sampling(_meta(), 90)["target"], 90)
        self.assertEqual(video_frames.plan_sampling(_meta(), 5)["target"], video_frames.N_MIN_USER)
        self.assertEqual(video_frames.plan_sampling(_meta(), 5000)["target"], video_frames.N_MAX_USER)

    def test_stride_is_an_integer_and_never_zero(self):
        for duration in (3.0, 17.0, 120.0, 600.0):
            for fps in (24.0, 30.0, 60.0):
                sampling = video_frames.plan_sampling(_meta(duration=duration, fps=fps))
                self.assertIsInstance(sampling["strideK"], int)
                self.assertGreaterEqual(sampling["strideK"], 1)
                self.assertLessEqual(sampling["candidates"], int(duration * fps))


class PolicyPin(unittest.TestCase):
    """Tripwires, not assertions about truth.

    Two independent invalidation paths exist and neither covers the other: a
    threshold change moves `policy_hash` (automatic cache miss), while a
    *selection-logic* change (dedupe, bucketing, filter order) moves nothing and
    relies on someone bumping `POLICY_VERSION` by hand. These tests exist to turn
    that convention into a red build.

    When one of them fails, there are exactly two honest answers: bump
    `POLICY_VERSION` (accept that cached frames are stale) or revert the change.
    Do not "fix" the expected value without deciding which.
    """

    # Bump POLICY_VERSION and update this value in the same commit as any
    # intentional threshold change.
    PINNED_POLICY_HASH = "08a52dc4c8c3"

    # The kept frame-index sequence for a fixed synthetic candidate set. This pins
    # the *logic*, not an ffmpeg build: score_frame is stubbed, so the result
    # depends only on our own dedupe/bucket/backfill rules.
    PINNED_KEPT_SEQUENCE = [2, 4, 7, 8]

    def test_policy_hash_is_pinned(self):
        self.assertEqual(
            video_frames.POLICY_HASH, self.PINNED_POLICY_HASH,
            "抽帧阈值或 POLICY_VERSION 变了。确认这是有意的，再同步更新 PINNED_POLICY_HASH；"
            "若改动会改变选出的帧集，必须同时 bump POLICY_VERSION。")

    def test_selection_logic_is_pinned(self):
        golden = 0x9E3779B97F4A7C15

        def fake_score(path):
            index = int(Path(path).stem)
            # Golden-ratio spread: neighbouring views differ by many bits, so only
            # the intended pair below is ever a near-duplicate.
            digest = ((4 if index == 5 else index) * golden) % (2 ** 64)
            # Sharpness cycles 200/260/320, so each bucket has a clear winner.
            return {"sharp": 200.0 + (index % 3) * 60.0, "tex": 0.05, "luma": 120.0,
                    "over": 0.0, "under": 0.0, "dhash": digest}

        candidates = [(index, 0.4 + index * 0.5, Path(f"{index}.png")) for index in range(10)]
        with mock.patch.object(video_frames, "score_frame", fake_score):
            rows, stats = video_frames.analyse(candidates, _meta(duration=6.0), {})
            kept, empty = video_frames._bucket(rows, 4, stats, 6.0)
        self.assertEqual(
            [row["src"] for row in kept], self.PINNED_KEPT_SEQUENCE,
            "选帧逻辑变了（去重/分桶/补位/补帧之一）。若是有意改动，请 bump POLICY_VERSION，"
            "再把这里更新为新的帧号序列；否则回退。")
        self.assertEqual(empty, [])
        # The pair (4,5) exists to prove de-duplication still runs: exactly one of
        # them may survive, and it must be the sharper one.
        self.assertEqual([row["src"] for row in rows if row["reject"] == "near_dup"], [5])


class PolicyHash(unittest.TestCase):
    def test_stable_and_short(self):
        digest = video_frames.policy_fingerprint()
        self.assertRegex(digest, r'^[0-9a-f]{12}$')
        self.assertEqual(digest, video_frames.policy_fingerprint())

    def test_any_threshold_change_changes_the_hash(self):
        before = video_frames.policy_fingerprint()
        with mock.patch.object(video_frames, 'SHARP_REL', video_frames.SHARP_REL + 0.01):
            self.assertNotEqual(before, video_frames.policy_fingerprint())


class OutputSize(unittest.TestCase):
    def test_large_frames_shrink_to_the_working_edge(self):
        self.assertEqual(video_frames._output_size(_meta(width=3840, height=2160)), (2048, 1152))
        self.assertEqual(video_frames._output_size(_meta(width=1080, height=1920)), (1080, 1920))
        self.assertEqual(video_frames._output_size(_meta(width=1440, height=2560)), (1152, 2048))

    def test_small_frames_are_never_upscaled(self):
        self.assertEqual(video_frames._output_size(_meta(width=1280, height=720)), (1280, 720))

    def test_odd_dimensions_become_even(self):
        width, height = video_frames._output_size(_meta(width=1001, height=751))
        self.assertEqual((width % 2, height % 2), (0, 0))


class Selection(unittest.TestCase):
    """Properties, not exact labels.

    Synthetic frames cannot pin down a classifier whose thresholds are calibrated
    on real footage, so these cases assert the invariants the pipeline promises:
    blur never survives, duplicates collapse to one, and a bucket keeps the
    sharper of two views.
    """

    def _write(self, folder, name, sharp, seed=0):
        rng = np.random.default_rng(seed)
        canvas = np.full((240, 320, 3), 128, np.uint8)
        for _ in range(60):
            x, y = rng.integers(4, 300), rng.integers(4, 220)
            canvas[y:y + 8, x:x + 8] = rng.integers(0, 255, (8, 8, 3), dtype=np.uint8)
        for quadrant in range(4):
            row, col = divmod(quadrant, 2)
            if (seed >> quadrant) & 1:
                canvas[row * 120:(row + 1) * 120, col * 160:(col + 1) * 160] = 235
        if not sharp:
            canvas = cv2.GaussianBlur(canvas, (25, 25), 18)
        path = folder / name
        cv2.imwrite(str(path), canvas)
        return path

    def test_blur_falls_below_the_gate_and_never_survives(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            sharp = [self._write(folder, f"s{index}.png", True, seed=index + 1) for index in range(4)]
            blur = self._write(folder, "blur.png", False, seed=42)
            candidates = [(index, 0.5 + index * 0.4, path) for index, path in enumerate(sharp)]
            candidates.append((len(sharp), 1.2, blur))
            rows, stats = video_frames.analyse(candidates, _meta(duration=3.0), {})
            by_path = {row["path"]: row for row in rows}
            self.assertGreater(stats["threshold"], by_path[blur]["sharp"])
            self.assertNotEqual(by_path[blur]["decision"], "candidate")
            # Some sharp frame must survive, otherwise the gate is too aggressive.
            self.assertTrue(any(by_path[path]["decision"] == "candidate" for path in sharp))

    def test_one_physical_view_is_kept_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            path = self._write(folder, "same.png", True, seed=7)
            rows, _ = video_frames.analyse([(0, 0.5, path), (1, 1.0, path), (2, 1.5, path)],
                                           _meta(duration=3.0), {})
            survivors = [row for row in rows if row["decision"] == "candidate"]
            self.assertEqual(len(survivors), 1)
            self.assertEqual([row["decision"] for row in rows].count("rejected"), 2)

    def test_a_bucket_keeps_the_sharper_view(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            soft = self._write(folder, "soft.png", False, seed=98)
            hard = self._write(folder, "hard.png", True, seed=98)
            rows, stats = video_frames.analyse([(0, 0.6, soft), (1, 1.2, hard)], _meta(duration=3.0), {})
            kept, empty = video_frames._bucket(rows, 1, stats, 3.0)
            self.assertEqual(len(kept), 1)
            self.assertEqual(kept[0]["path"], hard)
            self.assertGreater(kept[0]["sharp"], {row["path"]: row["sharp"] for row in rows}[soft])
            self.assertEqual(empty, [])


@unittest.skipUnless(_configured_ffmpeg(), 'ffmpeg is not configured')
class Extraction(unittest.TestCase):
    # The frame cache is keyed by policy version + content hash + frame target
    # (<POLICY_VERSION>/<sha16>-t<N>), not by project, so every case here must
    # pass its own cache directory. Sharing one
    # would let a later case silently reuse an earlier case's frames and turn a
    # broken extractor into a green test.
    def test_extracts_frames_and_reuses_the_cache(self):
        ffmpeg = _configured_ffmpeg()
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'room.mp4'
            subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
                            '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=6',
                            '-vf', "crop=1600:900:x='t*40':y='90'", '-pix_fmt', 'yuv420p', str(source)],
                           check=True, timeout=120)
            cache = Path(temporary) / 'cache'
            first = video_frames.materialise([str(source)], cache, ffmpeg=ffmpeg, target=20)
            self.assertEqual(len(first), 1)
            self.assertNotIn('error', first[0], first[0].get('error'))
            report = first[0]['report']
            self.assertEqual(report['schema_version'], video_frames.SCHEMA_VERSION)
            self.assertEqual(report['policy']['policy_hash'], video_frames.POLICY_HASH)
            self.assertEqual(report['video']['out_w'], 1600)
            self.assertEqual(report['video']['out_h'], 900)
            self.assertGreater(len(report['frames']), 0)
            for row in report['frames']:
                self.assertTrue((Path(first[0]['dir']) / f"frame-{row['i']:05d}.jpg").exists())
            self.assertFalse(first[0]['cached'])

            second = video_frames.materialise([str(source)], cache, ffmpeg=ffmpeg, target=20)
            self.assertTrue(second[0]['cached'])

            # A different budget is a different policy: re-extract, do not reuse.
            third = video_frames.materialise([str(source)], cache, ffmpeg=ffmpeg, target=40)
            self.assertFalse(third[0]['cached'])

            # The same bytes under a second name are skipped, not extracted twice.
            twin = Path(temporary) / 'copy.mp4'
            twin.write_bytes(source.read_bytes())
            both = video_frames.materialise([str(source), str(twin)], cache, ffmpeg=ffmpeg, target=20)
            self.assertIn('内容完全相同', both[1]['error'])

    def test_probe_reports_missing_tooling_as_a_code(self):
        with self.assertRaises(video_frames.VideoError) as missing:
            video_frames.probe(Path('whatever.mp4'), None)
        self.assertEqual(missing.exception.code, 'ffmpeg_missing')

    def test_probe_rejects_a_stripped_ffmpeg(self):
        with tempfile.TemporaryDirectory() as temporary:
            fake = Path(temporary) / 'ffmpeg.exe'
            fake.write_bytes(b'')
            # Hide any PATH installation: this case is about a build that has no
            # sibling ffprobe *and* nothing usable on PATH.
            with mock.patch.object(video_frames.shutil, 'which', return_value=None):
                with self.assertRaises(video_frames.VideoError) as broken:
                    video_frames.probe(Path(temporary) / 'clip.mp4', str(fake))
            self.assertEqual(broken.exception.code, 'ffprobe_missing')

    def test_ffprobe_is_also_found_on_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            fake = Path(temporary) / 'ffmpeg.exe'
            fake.write_bytes(b'')
            sibling = Path(temporary) / 'ffprobe.exe'
            with mock.patch.object(video_frames.shutil, 'which', return_value=str(sibling)):
                self.assertEqual(video_frames._ffprobe_binary(str(fake)), sibling)


if __name__ == '__main__':
    unittest.main()
