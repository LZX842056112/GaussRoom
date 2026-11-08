"""Turn a house-tour video into reconstruction-ready keyframes.

The problem is temporal coverage under a frame budget, not even sampling: the
overlap two neighbouring frames share is set by depth and walking speed, so a
fixed fps is either wasteful or unusable. This module therefore:

1. budgets a target frame count from the clip length (sqrt law, clamped),
2. oversamples candidates on an integer frame-number stride so the ffmpeg and
   OpenCV decoders produce exactly the same candidate set,
3. scores every candidate at a fixed 512 px analysis scale (so thresholds are
   comparable across 1080p/4K and portrait/landscape),
4. drops unusable candidates (head/tail, exposure, blur) and collapses near
   duplicates, then
5. keeps the best candidate inside each equal *time* bucket, so short static
   stretches cannot eat the budget of the walking parts.

Kept frames are cached per video content hash, so re-running prepare (or any
later stage) never decodes the same file twice.

Background: selection policy follows the surveyor team's frame-selection spec
(v1.0). Optical-flow overlap repair and pivot collapsing are deliberately not
implemented here - those thresholds need an A/B registration-rate calibration
that requires real captures, so they are tracked as follow-up work instead of
being shipped unvalidated.

Exit codes follow prepare_project.py: 0 ok, 3 nothing usable, 1 other error.
"""
import argparse
import hashlib
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

# ── Heuristic tuning constants ──────────────────────────────────────────────
# None of the numbers below has been calibrated against labelled data. They are
# engineering estimates from the v1.0 design note, chosen so the gates behave
# sanely on typical phone clips.
#
# Do NOT treat them as measured thresholds, and do not describe the pipeline as
# "quality validated" because the report self-consistency tests pass - those
# check agreement with these formulas, not agreement with human judgement.
#
# Calibration still to do (see docs/CODE_DESIGN.md#视频抽帧):
#   * SHARP_ABS / SHARP_REL - ROC against ~200 hand-labelled usable frame pairs
#   * DHASH_DUP_BITS - false-positive rate on ~200 adjacent hand-held pairs
#   * TEX_MIN - coverage of pure-wall segments in annotated rooms
#   * N_MIN_AUTO / N_MAX_AUTO - A/B reconstruction (gate pass rate vs runtime)
#                               at 40/60/120/200/300 frames
# ---------------------------------------------------------------------------
SCHEMA_VERSION = 1
# Bumping any threshold below must change this: the frame cache is keyed by the
# resulting policy hash, so an upgrade re-extracts instead of silently reusing
# frames chosen by the previous policy.
# Cache invalidation has two independent paths and they do NOT cover each other:
#   * threshold change  -> policy_hash changes -> old cache misses automatically.
#   * selection-logic change (bucketing, dedup, filter order) -> policy_hash is
#     unchanged, so the ONLY way to invalidate is bumping this string, because it
#     is part of the cache *path*. Forget it and stale frames get reused while the
#     report claims the new policy.
# gsr-kf-2: bucket width now divides by the bucket count actually used
# (span/buckets) instead of the requested target - frames chosen before this
# build are not comparable with frames chosen after it.
POLICY_VERSION = "gsr-kf-2"
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".mpg", ".mpeg", ".3gp"}


class VideoError(RuntimeError):
    """Failure with a stable code, so the UI can tell the user what to do.

    Deployment codes (ffmpeg_missing/ffprobe_missing/hdr_requires_ffmpeg/
    probe_timeout/decode_timeout/internal_error) are explicitly *not* the user's
    shooting problem and must not suggest a reshoot or a re-encode.
    """

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

# Frame budget. Cost grows super-linearly with frame count while extra coverage
# of the same room saturates, so a sqrt law is the compromise between the two.
N_ANCHOR = 120
T_ANCHOR = 120.0
N_MIN_AUTO, N_MAX_AUTO = 40, 300
N_MIN_USER, N_MAX_USER = 20, 600
# Candidate pool: at least 2.5x the budget, otherwise bucket-picking degenerates
# into plain even sampling.
CAND_BUDGET_RATIO = 2.5
N_CAND_MAX = 1200
DELTA_CAND_MIN = 0.25
DELTA_CAND_MAX = 2.0

# All metrics are computed at this long edge. Laplacian variance grows with
# resolution, so an absolute threshold is only meaningful at a fixed scale.
ANALYSIS_SIDE = 512
# Output frames match prepare_project.py's working long edge: one resample only.
OUT_LONG_EDGE = 2048

# Sharpness gate: absolute floor ("physically matchable") and a relative floor
# ("worst in this clip") - the max of the two adapts to soft optics without
# accepting a fully blurred clip.
SHARP_ABS = 80.0
SHARP_REL = 0.45
# Texture density (share of pixels with a strong gradient). Blank walls score
# low even when perfectly focused, which is why they need their own signal.
TEX_MIN = 0.010
TEX_REF = 0.060

OVER_FRAC_MAX = 0.35
UNDER_FRAC_MAX = 0.45
LUMA_MIN, LUMA_MAX = 30.0, 225.0
# A luma jump this large between consecutive candidates is an exposure change
# (auto-exposure hunting, torch), not a change of scene.
LUMA_JUMP = 60.0
DHASH_DUP_BITS = 6
# Neighbours above this distance share too little view for COLMAP to match.
OVERLAP_GAP_BITS = 20

HEAD_TRIM_S = 0.3
TAIL_TRIM_S = 0.3
MIN_CLIP_S = 2.0
# Below this a frame cannot pass prepare's own resolution floor, so extracting
# it would only produce "low_resolution" exclusions downstream.
MIN_SOURCE_LONG_EDGE = 1000
MAX_GAP_FACTOR = 2.5

# Phone HDR clips (HLG on iPhone, PQ on newer Android) decode to washed-out or
# clipped frames unless they are tone-mapped back into sRGB first.
HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}
TONEMAP_CHAIN = ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                 "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p")

REJECT_LABELS = {
    "head_tail": "开头结尾无效段",
    "overexposed": "过曝",
    "underexposed": "欠曝",
    "blown_out": "画面发白",
    "blurry": "运动模糊",
    "near_dup": "与前一帧近重复",
    # Reserved: the flow-based stage that will emit these is not implemented yet,
    # but keeping the labels here means adding it will not touch the UI mapping.
    "occluded": "镜头被遮挡",
    "low_texture": "纹理不足",
}


def _sha256(path, chunk=1024 * 1024):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def _even(value):
    return max(2, int(value) - int(value) % 2)


def _cleanup(folder):
    """Best-effort removal of the candidate scratch directory.

    `shutil.rmtree(ignore_errors=True)` still *raises* for some failures (a
    shutil.Error aggregate, a locked handle on Windows), and that used to abort a
    perfectly successful extraction after the frames were already written. Temp
    files are not worth failing a run over: try the cheap path, then delete file
    by file, then give up quietly.
    """
    folder = Path(folder)
    if not folder.exists():
        return
    try:
        shutil.rmtree(folder)
        return
    except Exception:                      # noqa: BLE001 - cleanup must not raise
        pass
    for child in sorted(folder.rglob("*"), reverse=True):
        try:
            child.unlink() if child.is_file() else child.rmdir()
        except OSError:
            return
    try:
        folder.rmdir()
    except OSError:
        pass


def _target_count(duration, user_target):
    if user_target and user_target > 0:
        return int(max(N_MIN_USER, min(N_MAX_USER, int(user_target)))), "user"
    wanted = int(round(N_ANCHOR * math.sqrt(max(duration, 1.0) / T_ANCHOR)))
    return int(max(N_MIN_AUTO, min(N_MAX_AUTO, wanted))), "auto"


def policy_fingerprint():
    """Canonical hash of every knob that changes the kept frame set."""
    payload = {
        "schema": SCHEMA_VERSION, "version": POLICY_VERSION,
        "n_anchor": N_ANCHOR, "t_anchor": T_ANCHOR,
        "n_auto": [N_MIN_AUTO, N_MAX_AUTO], "n_user": [N_MIN_USER, N_MAX_USER],
        "pool_ratio": CAND_BUDGET_RATIO, "pool_max": N_CAND_MAX,
        "delta": [DELTA_CAND_MIN, DELTA_CAND_MAX],
        "analysis_side": ANALYSIS_SIDE, "out_edge": OUT_LONG_EDGE,
        "sharp": [SHARP_ABS, SHARP_REL], "tex": [TEX_MIN, TEX_REF],
        "exposure": [OVER_FRAC_MAX, UNDER_FRAC_MAX, LUMA_MIN, LUMA_MAX, LUMA_JUMP],
        "dup_bits": DHASH_DUP_BITS, "gap_bits": OVERLAP_GAP_BITS,
        "trim": [HEAD_TRIM_S, TAIL_TRIM_S], "gap_factor": MAX_GAP_FACTOR,
        "min_edge": MIN_SOURCE_LONG_EDGE, "min_clip": MIN_CLIP_S,
        "hdr": sorted(HDR_TRANSFERS), "tonemap": TONEMAP_CHAIN,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"))
                          .encode("utf-8")).hexdigest()[:12]


POLICY_HASH = policy_fingerprint()


def _build_sha():
    """Hash of this file: ties every report/acceptance number to a code version.

    Cheap (600 KB read once per process) and answers the question that otherwise
    costs a bisect: "which extraction logic produced this 143-frame result?"
    """
    try:
        return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:12]
    except OSError:
        return "unknown"


BUILD_SHA = _build_sha()


def _ffprobe_binary(ffmpeg):
    """ffprobe ships beside ffmpeg, but a system install may only be on PATH.

    The resolution order must match video-tools.mjs exactly: a capability probe
    that says "probe available" while extraction says "ffprobe_missing" is the
    worst kind of inconsistency, because the UI looks healthy until the run dies.
    """
    binary = Path(str(ffmpeg))
    for name in ("ffprobe" + (binary.suffix or ".exe"), "ffprobe.exe", "ffprobe"):
        candidate = binary.with_name(name)
        if candidate.exists():
            return candidate
    for name in ("ffprobe.exe", "ffprobe"):
        found = shutil.which(name)
        if found:
            return Path(found)
    return None


def _ffprobe(ffmpeg, path):
    """Stream metadata via ffprobe; None when the container cannot be read."""
    candidate = _ffprobe_binary(ffmpeg)
    if not candidate:
        return None
    try:
        result = subprocess.run(
            [str(candidate), "-v", "error", "-select_streams", "v:0",
             "-show_entries",
             "stream=width,height,avg_frame_rate,codec_name,nb_frames,pix_fmt,"
             "color_transfer,color_primaries,color_space:format=duration",
             "-of", "json", str(path)],
            capture_output=True, timeout=30, check=False)
        if result.returncode != 0:
            return None
        payload = json.loads(result.stdout.decode("utf-8", "replace") or "{}")
        stream = (payload.get("streams") or [{}])[0]
        numerator, _, denominator = str(stream.get("avg_frame_rate") or "0/1").partition("/")
        fps = float(numerator) / float(denominator) if float(denominator or 1) else 0.0
        duration = float((payload.get("format") or {}).get("duration") or 0)
        return {"width": int(stream.get("width") or 0), "height": int(stream.get("height") or 0),
                "fps": fps, "duration": duration, "codec": stream.get("codec_name") or "",
                "frameCount": int(stream.get("nb_frames") or 0),
                "pixFmt": str(stream.get("pix_fmt") or ""),
                "colorTransfer": str(stream.get("color_transfer") or ""),
                "colorPrimaries": str(stream.get("color_primaries") or ""),
                "colorSpace": str(stream.get("color_space") or "")}
    except subprocess.TimeoutExpired:
        # TimeoutExpired is a SubprocessError: folding it into "return None" made
        # a healthy file on a slow disk look corrupt.
        raise
    except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError):
        return None


def probe(path, ffmpeg=None):
    """Resolution, frame rate, duration and frame count of the first video stream.

    ffmpeg + ffprobe are a hard requirement for video input: probing without
    them cannot tell SDR from HDR, and a wrong assumption here silently poisons
    every downstream exposure decision.
    """
    path = Path(path)
    if path.suffix.lower() not in VIDEO_SUFFIXES:
        raise VideoError("unsupported_container", f"不支持的视频格式：{path.suffix or path.name}。请转成 MP4(H.264)")
    if not ffmpeg:
        raise VideoError("ffmpeg_missing", "未配置 FFMPEG。视频重建需要 ffmpeg（含 ffprobe），请在 .env 填写 FFMPEG 路径。")
    if not _ffprobe_binary(ffmpeg):
        raise VideoError("ffprobe_missing", "找不到 ffprobe。请使用完整的 ffmpeg 发行包，或修正 .env 中的 FFMPEG 路径。")
    try:
        meta = _ffprobe(ffmpeg, path)
    except subprocess.TimeoutExpired:
        raise VideoError("probe_timeout",
                         "读取视频信息超时（30 秒）。请重试；若反复出现，文件可能在网络盘上或正被杀毒软件扫描") from None
    if not meta or not meta["width"] or not meta["height"]:
        raise VideoError("decode_failed", f"无法读取视频信息（容器或编码可能损坏）：{path.name}")
    if not meta["fps"] or meta["fps"] <= 0 or meta["fps"] > 480:
        meta["fps"] = 30.0
    if not meta["frameCount"]:
        meta["frameCount"] = int(round(meta["duration"] * meta["fps"]))
    if not meta["duration"] or meta["duration"] <= 0 or not math.isfinite(meta["duration"]):
        # Some containers only expose a frame count; derive the duration from it.
        if meta["frameCount"]:
            meta["duration"] = meta["frameCount"] / meta["fps"]
    if not meta["duration"] or not math.isfinite(meta["duration"]):
        raise VideoError("decode_failed", f"无法读取视频时长：{path.name}")
    if meta["duration"] < MIN_CLIP_S:
        raise VideoError("video_too_short",
                         f"视频过短（{meta['duration']:.1f} 秒），至少需要 {MIN_CLIP_S:.0f} 秒")
    transfer = str(meta.get("colorTransfer") or "").lower()
    pix_fmt = str(meta.get("pixFmt") or "")
    # 10-bit without a declaration is ambiguous: iOS sometimes writes 10-bit SDR
    # with empty color metadata. Treating it as HDR would refuse a good clip;
    # treating it as SDR silently clips. So it is refused with an explicit,
    # non-deployment code that tells the user how to fix it.
    ten_bit = "10" in pix_fmt or "12" in pix_fmt
    if ten_bit and not transfer:
        raise VideoError("hdr_unverified",
                         "视频是 10bit 且没有色彩标记，无法判断 SDR/HDR。请用 ffmpeg 重新导出 H.264 8bit MP4 后再上传")
    return {**meta, "bytes": path.stat().st_size, "name": path.name,
            "pixFmt": pix_fmt, "colorTransfer": transfer,
            "colorPrimaries": meta.get("colorPrimaries") or "",
            "hdr": transfer in HDR_TRANSFERS}


def plan_sampling(meta, user_target=0):
    """Budget, candidate pool and the integer stride used by both decoders."""
    target, source = _target_count(meta["duration"], user_target)
    frames = max(1, meta["frameCount"])
    pool = int(min(N_CAND_MAX, max(target, round(target * CAND_BUDGET_RATIO)), frames))
    delta = min(DELTA_CAND_MAX, max(DELTA_CAND_MIN, meta["duration"] / pool))
    # An integer frame stride is the only way two decoders agree exactly on the
    # candidate set; a float interval would drift between ffmpeg and OpenCV.
    stride = int(max(1, round(0.1 * meta["fps"]), round(delta * meta["fps"])))
    candidates = int(math.ceil(frames / stride))
    return {"target": target, "targetSource": source, "candidates": candidates,
            "strideK": stride, "intervalSec": stride / meta["fps"]}


def _output_size(meta):
    """Frame size in integer arithmetic: min(long edge, OUT_LONG_EDGE), never upscaled.

    Float scaling can land 2 px off the value prepare later derives, which would
    create a second camera group from rounding alone.
    """
    width, height = meta["width"], meta["height"]
    long_edge = max(width, height)
    out_long = min(long_edge, OUT_LONG_EDGE)
    if width >= height:
        return (out_long // 2 * 2, max(2, (height * out_long // long_edge) // 2 * 2))
    return (max(2, (width * out_long // long_edge) // 2 * 2), out_long // 2 * 2)


_ZSCALE_CACHE = {}


def _zscale_available(ffmpeg):
    """True/False when the filter list could be read, None when it could not.

    A three-state answer matters: "we could not ask" must not be read as "the
    build lacks it", and vice versa.
    """
    key = str(ffmpeg)
    if key not in _ZSCALE_CACHE:
        try:
            listing = subprocess.run([str(ffmpeg), "-hide_banner", "-filters"],
                                     capture_output=True, timeout=20, check=False)
            if listing.returncode != 0:
                _ZSCALE_CACHE[key] = None
            else:
                _ZSCALE_CACHE[key] = (b"zscale" in listing.stdout and b"tonemap" in listing.stdout)
        except subprocess.TimeoutExpired:
            # Do NOT cache: on Windows the first run of a large exe can be held up
            # by antivirus scanning. Caching that would fail every HDR video in
            # this run and send the user to check an installation that is fine.
            return None
        except (OSError, subprocess.SubprocessError):
            _ZSCALE_CACHE[key] = None      # the binary cannot run at all: deterministic
    return _ZSCALE_CACHE[key]


def _decode_ffmpeg(path, out_dir, sampling, meta, ffmpeg, size):
    filters = []
    tonemapped = False
    if meta.get("hdr") and _zscale_available(ffmpeg):
        filters.append(TONEMAP_CHAIN)
        tonemapped = True
    filters.append(f"select='not(mod(n,{sampling['strideK']}))'")
    if (size[0], size[1]) != (meta["width"], meta["height"]):
        filters.append(f"scale={size[0]}:{size[1]}")
    command = [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
               "-i", str(path), "-vf", ",".join(filters), "-fps_mode", "passthrough",
               "-q:v", "2", "-start_number", "0", str(out_dir / "cand-%05d.jpg")]
    result = subprocess.run(command, capture_output=True, timeout=600, check=False)
    if result.returncode != 0:
        raise RuntimeError("ffmpeg 解码失败：" + result.stderr.decode("utf-8", "replace")[:300])
    return sorted(out_dir.glob("cand-*.jpg")), tonemapped


def _decode_opencv(path, out_dir, sampling, meta, size):
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise RuntimeError("OpenCV 无法打开视频")
    scale_needed = (size[0], size[1]) != (meta["width"], meta["height"])
    written, index = [], 0
    try:
        while True:
            if not capture.grab():
                break
            if index % sampling["strideK"] == 0:
                ok, frame = capture.retrieve()
                if not ok or frame is None:
                    break
                if scale_needed:
                    frame = cv2.resize(frame, size, interpolation=cv2.INTER_AREA)
                target = out_dir / f"cand-{index // sampling['strideK']:05d}.jpg"
                if cv2.imwrite(str(target), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 98]):
                    written.append(target)
            index += 1
    finally:
        capture.release()
    if not written:
        raise RuntimeError("OpenCV 没有解出任何画面")
    return sorted(written)


def _dhash(gray):
    small = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return value


def score_frame(path):
    """Quality metrics of one candidate, all computed at ANALYSIS_SIDE."""
    gray = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        return None
    long_edge = max(gray.shape[:2])
    if long_edge > ANALYSIS_SIDE:
        factor = ANALYSIS_SIDE / long_edge
        gray = cv2.resize(gray, (_even(gray.shape[1] * factor), _even(gray.shape[0] * factor)),
                          interpolation=cv2.INTER_AREA)
    sharp = float(cv2.Laplacian(gray.astype(np.float32), cv2.CV_32F, ksize=3).var())
    sobel_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = cv2.magnitude(sobel_x, sobel_y)
    return {"sharp": round(sharp, 3),
            "tex": round(float(np.count_nonzero(magnitude > 12)) / magnitude.size, 5),
            "luma": round(float(gray.mean()), 1),
            "over": round(float(np.count_nonzero(gray >= 250)) / gray.size, 4),
            "under": round(float(np.count_nonzero(gray <= 5)) / gray.size, 4),
            "dhash": _dhash(gray)}


def _exposure_reason(row, duration):
    """Hard rejections that do not depend on the clip's own statistics."""
    time = row["t"]
    if duration >= 3.0 and (time < HEAD_TRIM_S or time > duration - TAIL_TRIM_S):
        return "head_tail"
    if row["over"] > OVER_FRAC_MAX:
        return "overexposed"
    if row["under"] > UNDER_FRAC_MAX or row["luma"] < LUMA_MIN:
        return "underexposed"
    if row["luma"] > LUMA_MAX:
        return "blown_out"
    return None


def _summarise_reasons(counts):
    return "、".join(f"{REJECT_LABELS.get(key, key)} {value} 帧"
                     for key, value in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
                     if value)


def analyse(candidates, meta, sampling):
    """Score candidates, apply hard rejections and collapse near duplicates.

    Order matters: exposure first, then the relative sharpness threshold derived
    from the *exposure-passing* candidates (a black frame would otherwise drag
    the median down and let blurred frames through), and finally de-duplication
    against the previous surviving candidate.
    """
    rows = []
    for source_index, time_seconds, path in candidates:
        scored = score_frame(path)
        if scored is None:
            continue
        rows.append({"src": source_index, "t": time_seconds, "path": path, **scored})
    if not rows:
        return [], {"medianSharp": 0.0, "threshold": SHARP_ABS}

    for row in rows:
        row["reject"] = _exposure_reason(row, meta["duration"])
    # Statistics are taken over exposure-and-trim survivors only: head/tail frames
    # are hand-held and soft, so including them would drag the median down and
    # silently widen the sharpness gate for the whole clip.
    baseline_rows = [row for row in rows if row["reject"] is None]
    baseline = baseline_rows or rows
    sharpness = np.array([row["sharp"] for row in baseline])
    median = float(np.median(sharpness))
    threshold = max(SHARP_ABS, median * SHARP_REL)
    low_texture = float(np.mean([row["tex"] < TEX_MIN for row in rows]))

    counts = {key: 0 for key in REJECT_LABELS}
    previous_hash, previous_luma = None, None
    for row in rows:
        row["lumaJump"] = previous_luma is not None and abs(row["luma"] - previous_luma) > LUMA_JUMP
        previous_luma = row["luma"]
        if row["reject"] is None and row["sharp"] < threshold:
            row["reject"] = "blurry"
        if row["reject"] is None:
            if previous_hash is not None and bin(row["dhash"] ^ previous_hash).count("1") <= DHASH_DUP_BITS:
                row["reject"] = "near_dup"
            else:
                previous_hash = row["dhash"]
        if row["reject"]:
            counts[row["reject"]] += 1
        row["decision"] = "rejected" if row["reject"] else "candidate"
    return rows, {"medianSharp": median, "threshold": threshold,
                  "lowTextureRatio": low_texture, "rejected": counts,
                  "p90Sharp": float(np.percentile([row["sharp"] for row in baseline], 90)),
                  "flickerRatio": float(np.mean([row["lumaJump"] for row in rows]))}


def _score(row, stats):
    """Frame-level quality. Weights renormalised from the spec because the
    motion term needs the optical-flow stage that is not implemented yet."""
    sharp = min(row["sharp"] / max(stats["p90Sharp"], 1.0), 1.5) / 1.5
    texture = min(row["tex"] / TEX_REF, 1.0)
    exposure = 1.0 - (0.5 * abs(row["luma"] - 118) / 118
                      + 2.0 * max(0.0, row["over"] - 0.10)
                      + 2.0 * max(0.0, row["under"] - 0.15))
    if row["lumaJump"]:
        exposure *= 0.5
    return 0.6 * sharp + 0.15 * texture + 0.25 * max(0.0, exposure)


def _bucket(rows, target, stats, duration):
    """Keep the best candidate per equal-time bucket over the walkthrough."""
    start = HEAD_TRIM_S if duration >= 3.0 else 0.0
    end = duration - TAIL_TRIM_S if duration >= 3.0 else duration
    span = max(end - start, 1e-6)
    buckets = max(1, min(target, len(rows)))
    # Index with the bucket count actually in use, not the requested target:
    # otherwise every row lands in the first few buckets when rows < target.
    width = span / buckets
    for row in rows:
        row["bucket"] = min(buckets - 1, max(0, int((row["t"] - start) / width)))
        row["score"] = round(_score(row, stats), 4)

    best, blur_only = {}, {}
    for row in rows:
        if row["decision"] == "candidate":
            pool = best
        elif row["reject"] == "blurry":
            # A blurred view beats a hole in the walkthrough, but a duplicate
            # adds no viewpoint, so only blur is an acceptable stand-in.
            pool = blur_only
        else:
            continue
        current = pool.get(row["bucket"])
        if current is None or row["score"] > current["score"]:
            pool[row["bucket"]] = row
    kept, empty, used = [], [], set()
    for index in range(buckets):
        row = best.get(index)
        if row is None:
            row = blur_only.get(index)
            if row is not None:
                # A blurred view beats a hole in the walkthrough; `id` comparison
                # is the only reliable membership test here (a {**row} copy is
                # never `in` a dict of originals).
                row = {**row, "decision": "topup", "_source": id(row)}
        else:
            row = {**row, "decision": "candidate", "_source": id(row)}
        if row is None:
            empty.append(index)
        else:
            kept.append(row)
            used.add(row["_source"])
    # Borrow a near-by unused candidate for empty buckets instead of leaving a
    # hole. Near-duplicates are excluded on purpose: adding one back would undo
    # the de-duplication and inflate the frame count with no new viewpoint.
    for index in empty[:]:
        centre = start + (index + 0.5) * width
        pool = [row for row in rows if id(row) not in used
                and row["reject"] in (None, "blurry")]
        if not pool:
            break
        row = min(pool, key=lambda item: (abs(item["t"] - centre), -item["score"]))
        kept.append({**row, "bucket": index, "decision": "borrowed", "_source": id(row)})
        used.add(id(row))
        empty.remove(index)
    # Supplements may sit next to a near-identical kept frame; that would undo
    # the de-duplication done above, so they are re-checked here.
    kept = _drop_duplicate_supplements(kept)
    return kept, empty


def _drop_duplicate_supplements(kept):
    ordered = sorted(kept, key=lambda item: item["t"])
    out, previous = [], None
    for row in ordered:
        if (previous is not None and row["decision"] in ("topup", "borrowed")
                and bin(row["dhash"] ^ previous["dhash"]).count("1") <= DHASH_DUP_BITS):
            continue
        out.append(row)
        previous = row
    return out


def _repair_gaps(kept, rows, limit):
    """Insert one unused candidate where neighbours differ so much that COLMAP
    will struggle to match them (dHash Hamming > OVERLAP_GAP_BITS)."""
    ordered = sorted(kept, key=lambda item: item["t"])
    used = {row.get("_source") for row in ordered}
    inserts = []
    for left, right in zip(ordered, ordered[1:]):
        if len(inserts) >= limit:
            break
        if bin(left["dhash"] ^ right["dhash"]).count("1") <= OVERLAP_GAP_BITS:
            continue
        between = [row for row in rows if id(row) not in used
                   and left["t"] < row["t"] < right["t"]
                   and row["reject"] is None]
        if not between:
            continue
        row = max(between, key=lambda item: item["score"])
        inserts.append({**row, "decision": "gap_fill", "_source": id(row)})
        used.add(id(row))
    return ordered + inserts, len(inserts)


def _gap_warning(kept, duration):
    times = sorted(row["t"] for row in kept)
    if len(times) < 4:
        return None
    gaps = np.diff(times)
    median = float(np.median(gaps))
    worst = float(gaps.max())
    if median > 0 and worst > median * MAX_GAP_FACTOR:
        index = int(np.argmax(gaps))
        return {"code": "trajectory_gap",
                "detail": f"{times[index]:.1f} 秒处有 {worst:.1f} 秒没有可用帧（中位间隔 {median:.1f} 秒），可能对应空间断开"}
    return None


def _mode_flags(meta, stats, kept, target, rows, tonemapped=False):
    flags = []
    if stats["medianSharp"] < SHARP_ABS * 0.6:
        flags.append("low_sharpness")
    if stats["lowTextureRatio"] > 0.60:
        flags.append("low_texture")
    static_ratio = (sum(1 for row in rows if row["reject"] == "near_dup") /
                    max(1, len(rows)))
    if static_ratio > 0.5:
        flags.append("low_view_diversity")
    if len(kept) < target * 0.5:
        flags.append("underfilled")
    if stats.get("flickerRatio", 0.0) > 0.15:
        flags.append("flicker_heavy")
    if max(meta["width"], meta["height"]) < 1000:
        flags.append("low_resolution")
    return flags, static_ratio


def _warnings(meta, sampling, flags, kept, stats):
    warnings = []
    if kept and all(row["decision"] == "topup" for row in kept):
        warnings.append({"code": "likely_failure",
                         "detail": "没有任何一帧达到清晰度下限，几何重建大概率失败；建议放慢移动速度、增加光照后重拍"})
    if "low_sharpness" in flags:
        warnings.append({"code": "low_sharpness",
                         "detail": "整段视频偏模糊，已按相对清晰度保留；重建质量会明显下降，建议放慢移动速度重拍"})
    if "low_texture" in flags:
        warnings.append({"code": "low_texture",
                         "detail": "大部分画面缺少纹理（纯色墙面/柜门），已限制帧数；可挂画或摆放物品后补拍"})
    if "low_view_diversity" in flags:
        warnings.append({"code": "low_view_diversity",
                         "detail": "超过一半候选帧与前一帧近重复，有效视角不足；建议补拍其他角度"})
    if "underfilled" in flags and "low_view_diversity" not in flags:
        warnings.append({"code": "underfilled",
                         "detail": f"只保留了 {len(kept)} 帧，明显少于预算；可降低目标帧数或检查画面是否长期模糊"})
    if "flicker_heavy" in flags:
        warnings.append({"code": "flicker_heavy",
                         "detail": "画面亮度反复跳变（自动曝光或手电补光），已降低这类帧的优先级；建议拍摄时锁定曝光"})
    if "low_resolution" in flags:
        warnings.append({"code": "low_resolution",
                         "detail": f"视频长边仅 {max(meta['width'], meta['height'])} 像素，低于预处理下限 1000，抽出的帧会被排除"})
    if sampling["intervalSec"] > 2.0:
        warnings.append({"code": "sparse_interval",
                         "detail": f"平均帧间隔 {sampling['intervalSec']:.1f} 秒，走动较快时相邻帧重叠可能不足；可提高目标帧数或分段拍摄"})
    if kept and (kept[-1]["t"] - kept[0]["t"]) < meta["duration"] * 0.5:
        warnings.append({"code": "partial_coverage",
                         "detail": "保留帧只覆盖了视频的一部分，请检查视频是否被遮挡或过暗"})
    return warnings


def extract(path, out_dir, *, ffmpeg=None, target=0, digest=None, min_long_edge=None):
    """Decode one video and keep evenly spread, sharp frames under out_dir/frames."""
    path = Path(path)
    out_dir = Path(out_dir)
    meta = probe(path, ffmpeg)
    floor = int(min_long_edge or MIN_SOURCE_LONG_EDGE)
    if max(meta["width"], meta["height"]) < floor:
        raise VideoError("source_long_edge_below_1000",
                         f"视频长边仅 {max(meta['width'], meta['height'])} 像素，"
                         f"低于重建下限 {floor}，请用更高分辨率重拍")
    if meta.get("hdr"):
        support = _zscale_available(ffmpeg)
        if support is None:
            # The cheap action first: on Windows the first run of a large exe can
            # be held up by antivirus scanning, so "retry" is far more likely to
            # help than "reinstall". Only a repeat offence means a broken install.
            raise VideoError("ffmpeg_probe_failed",
                             "无法确认 ffmpeg 的色调映射能力（滤镜列表读取失败或超时）。"
                             "请重试；若反复出现，再检查 ffmpeg 安装是否完整")
        if not support:
            # Decoding HLG/PQ without tone mapping yields clipped, washed-out
            # frames whose exposure and sharpness scores are meaningless.
            raise VideoError("hdr_requires_ffmpeg",
                             f"视频是 HDR（{meta.get('colorTransfer')}），当前 ffmpeg 缺少 zscale/tonemap 滤镜，"
                             "无法正确转成 SDR。请换用完整版 ffmpeg，或把视频转成 SDR MP4 后再上传")
    sampling = plan_sampling(meta, target)
    size = _output_size(meta)
    work = out_dir / "candidates"
    _cleanup(work)
    work.mkdir(parents=True, exist_ok=True)
    decoder = "ffmpeg"
    tonemapped = False
    try:
        decoded = None
        if ffmpeg:
            try:
                decoded, tonemapped = _decode_ffmpeg(path, work, sampling, meta, ffmpeg, size)
            except subprocess.TimeoutExpired:
                # A stalled decode means this file is problematic in *this*
                # environment; silently retrying with OpenCV would only move the
                # failure to prepare's 45-minute timeout, and for HDR it would be
                # misreported as "your ffmpeg lacks tone mapping".
                raise VideoError("decode_timeout",
                                 "解码视频超时。请重试；若反复出现，请先在本机把视频转成 MP4(H.264)") from None
            except (RuntimeError, OSError, subprocess.SubprocessError):
                decoded = None
                decoder = "cv2"
        if decoded is None:
            if meta.get("hdr"):
                # OpenCV clips HDR to 8-bit: no tone mapping means the metrics
                # would be computed on wrong pixels, which is worse than failing.
                raise VideoError("hdr_requires_ffmpeg",
                                 "HDR 视频无法用 OpenCV 解码路径处理，请检查 ffmpeg（含 zscale）配置")
            decoder = "cv2"
            decoded = _decode_opencv(path, work, sampling, meta, size)
        if not decoded:
            raise RuntimeError("视频没有解出任何画面")
        candidates = [(index * sampling["strideK"], (index * sampling["strideK"]) / meta["fps"], frame)
                      for index, frame in enumerate(decoded)]
        rows, stats = analyse(candidates, meta, sampling)
        if not rows:
            raise RuntimeError("候选帧全部无法读取")
        # A blank-wall clip gains nothing from a large budget; spend it on the
        # walking parts instead of enforcing a quota nothing can fill.
        budget = sampling["target"]
        if stats["lowTextureRatio"] > 0.60:
            budget = min(budget, N_MIN_AUTO)
        if stats["medianSharp"] < SHARP_ABS * 0.6:
            budget = min(budget, 60)
        # A short clip cannot fill its budget; without this the bucket count
        # exceeds the candidate count and every "target" number in the report is
        # a fiction the UI would repeat.
        budget = min(budget, len(rows))
        kept, empty = _bucket(rows, budget, stats, meta["duration"])
        if not kept:
            reason = _summarise_reasons(stats["rejected"]) or "全部被排除"
            # Write the reason table first: a zero-frame run is exactly when the
            # user needs "why", and the exception alone would discard the counts.
            (out_dir / "report.json").write_text(json.dumps({
                "schema_version": SCHEMA_VERSION,
                "build": {"sha": BUILD_SHA},
                "video": {"name": meta["name"], "duration_s": round(meta["duration"], 3),
                          "src_w": meta["width"], "src_h": meta["height"],
                          "hdr": bool(meta.get("hdr")), "decoder": decoder},
                "policy": {"target_frames": budget, "policy_hash": POLICY_HASH,
                           "policy_version": POLICY_VERSION},
                "stats": {"n_cand": len(rows), "n_kept": 0, "empty_buckets": len(empty),
                          "rejected_by_reason": {key: value for key, value in stats["rejected"].items() if value},
                          "reason_summary": reason},
                "mode_flags": [], "warnings": [], "frames": [],
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            raise VideoError("insufficient_usable_frames", f"没有可用的画面（{reason}）")
        kept, gap_fills = _repair_gaps(kept, rows, limit=max(1, len(kept) // 10))
        frames_dir = out_dir / "frames"
        _cleanup(frames_dir)
        frames_dir.mkdir(parents=True, exist_ok=True)
        frames = []
        for number, row in enumerate(sorted(kept, key=lambda item: item["t"]), start=1):
            name = f"frame-{number:05d}.jpg"
            shutil.copyfile(row["path"], frames_dir / name)
            frames.append({"i": number, "src_idx": row["src"], "t": round(row["t"], 3),
                           "bucket": row["bucket"], "sharp": row["sharp"], "tex": row["tex"],
                           "luma_mean": row["luma"], "score": row["score"],
                           "decision": row["decision"], "reject_reason": row["reject"]})
        flags, static_ratio = _mode_flags(meta, stats, kept, budget, rows, tonemapped)
        gaps = [row for row in [_gap_warning(kept, meta["duration"])] if row]
        counts = stats["rejected"]
        report = {
            "schema_version": SCHEMA_VERSION,
            "build": {"sha": BUILD_SHA},
            "video": {"path": str(path), "name": meta["name"], "bytes": meta["bytes"],
                      "sha256": digest or _sha256(path), "duration_s": round(meta["duration"], 3),
                      "fps": round(meta["fps"], 3), "n_frames": meta["frameCount"],
                      "src_w": meta["width"], "src_h": meta["height"],
                      "out_w": size[0], "out_h": size[1], "codec": meta["codec"],
                      "color_transfer": meta.get("colorTransfer", ""),
                      "hdr": bool(meta.get("hdr")), "tone_mapped": tonemapped,
                      "color_pipeline": ("hdr->sdr(hable)" if tonemapped else
                                         ("hdr->8bit(unmapped)" if meta.get("hdr") else "sdr")),
                      "decoder": decoder},
            "policy": {"target_frames": budget, "target_source": sampling["targetSource"],
                       "policy_hash": POLICY_HASH, "policy_version": POLICY_VERSION,
                       "n_pool": len(candidates), "delta_cand_s": round(sampling["intervalSec"], 3),
                       "stride_k": sampling["strideK"], "analysis_side": ANALYSIS_SIDE,
                       "tau_sharp": round(stats["threshold"], 2), "tau_sharp_abs": SHARP_ABS,
                       "tau_sharp_rel": SHARP_REL, "sharp_p50": round(stats["medianSharp"], 2),
                       "tau_tex_min": TEX_MIN, "dhash_dup_bits": DHASH_DUP_BITS,
                       "head_trim_s": HEAD_TRIM_S, "tail_trim_s": TAIL_TRIM_S,
                       "max_gap_factor": MAX_GAP_FACTOR, "out_long_edge": OUT_LONG_EDGE},
            "analysis": {"sharp": {"p05": round(float(np.percentile([r["sharp"] for r in rows], 5)), 2),
                                   "p50": round(stats["medianSharp"], 2),
                                   "p90": round(stats["p90Sharp"], 2)},
                         "static_ratio": round(static_ratio, 3),
                         "flicker_ratio": round(stats["flickerRatio"], 3)},
            "stats": {"n_cand": len(rows), "n_kept": len(frames),
                      "keep_ratio": round(len(frames) / max(1, len(rows)), 3),
                      "rejected_by_reason": {key: value for key, value in counts.items() if value},
                      "empty_buckets": len(empty), "gap_fill": gap_fills,
                      "borrowed": sum(1 for row in kept if row["decision"] == "borrowed"),
                      "topup": sum(1 for row in kept if row["decision"] == "topup"),
                      "reason_summary": _summarise_reasons(counts) or "所有候选帧均可用"},
            "mode_flags": flags,
            "warnings": gaps + _warnings(meta, sampling, flags, kept, stats)
                        # Unreachable while the hard fail above stands: HDR either
                        # tone-maps or the run stops. Kept as a sentinel because if
                        # that check is ever relaxed, this is the state it would let
                        # through - and an unmapped frame means exposure is measured
                        # on clipped pixels, which is worse than failing.
                        + ([] if tonemapped or not meta.get("hdr") else [{
                            "code": "hdr_untonemapped",
                            "detail": f"视频是 HDR（{meta.get('colorTransfer')}），当前解码器没有做色调映射，画面可能偏灰或过亮"}]),
            "frames": frames,
        }
        (out_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report
    finally:
        _cleanup(work)


def cache_key(digest, target=0):
    # Version directory keeps the tree readable; the target is part of the path
    # because it is a *run* parameter, not a policy constant: asking for 40
    # frames after a 20-frame run must re-extract, not silently reuse.
    return f"{POLICY_VERSION}/{digest[:16]}-t{int(target) if target else 'auto'}"


def materialise(videos, cache_root, *, ffmpeg=None, target=0, min_long_edge=1000, log=None):
    """Extract (or reuse) frames for every video. Returns one entry per video.

    Byte-identical videos are extracted once: two copies would yield two sets of
    identical frames, and prepare would then exclude the whole second set as
    duplicates, halving the usable image count for no reason.
    """
    entries = []
    seen = {}
    for number, raw in enumerate(videos, start=1):
        path = Path(raw)
        if not path.is_file():
            entries.append({"path": str(path), "name": path.name, "error": "视频文件不存在"})
            continue
        digest = _sha256(path)
        if digest in seen:
            if log:
                log(f"视频 {number}/{len(videos)} 与 {seen[digest]} 内容相同，已跳过：{path.name}")
            entries.append({"path": str(path), "name": path.name,
                            "error": f"与 {seen[digest]} 内容完全相同，已跳过"})
            continue
        seen[digest] = path.name
        folder = Path(cache_root) / cache_key(digest, target)
        report_path = folder / "report.json"
        if report_path.exists():
            try:
                report = json.loads(report_path.read_text(encoding="utf-8"))
                if (report.get("schema_version") == SCHEMA_VERSION
                        and report.get("video", {}).get("sha256") == digest
                        and report.get("policy", {}).get("policy_hash") == POLICY_HASH
                        # Frame names are derived from the row index, not from a
                        # stored "file" key, so reuse must check them the same way.
                        # An empty frames list would make the all() below
                        # vacuously true and reuse a report with no images.
                        and report.get("frames")
                        and all((folder / "frames" / f"frame-{row['i']:05d}.jpg").exists()
                                for row in report["frames"])):
                    if log:
                        log(f"视频 {number}/{len(videos)} 复用已抽取的 {len(report['frames'])} 帧：{path.name}")
                    entries.append({"path": str(path), "name": path.name, "dir": str(folder / "frames"),
                                    "report": report, "report_path": str(report_path), "cached": True})
                    continue
                if log and report.get("policy", {}).get("policy_hash") not in (None, POLICY_HASH):
                    log(f"视频 {number}/{len(videos)} 的缓存来自旧策略（policy_hash 不一致），将重新抽帧：{path.name}")
                    _cleanup(folder / "frames")
            except (OSError, ValueError):
                # A truncated or half-written report just means "re-extract";
                # anything unexpected must still surface.
                pass
        folder.mkdir(parents=True, exist_ok=True)
        if log:
            # Two monotone signals: "解码视频 i/n" means i-1 of n finished,
            # "视频完成 i/n" means i of n finished. The parser relies on both.
            log(f"解码视频 {number}/{len(videos)}：{path.name}")
        try:
            report = extract(path, folder, ffmpeg=ffmpeg, target=target, digest=digest,
                             min_long_edge=min_long_edge)
        except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
            if log:
                log(f"视频 {number}/{len(videos)} 抽帧失败：{path.name}（{error}）")
            entry = {"path": str(path), "name": path.name, "error": str(error),
                     "errorCode": getattr(error, "code", "decode_failed")}
            # A zero-frame run still leaves a report explaining which gate killed
            # it; carry it so the manifest (and the UI) can show the reason table.
            try:
                entry["report"] = json.loads(report_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
            entries.append(entry)
            continue
        if log:
            log(f"视频完成 {number}/{len(videos)}：{path.name}，保留 "
                f"{len(report['frames'])}/{report['policy']['target_frames']} 帧")
        entries.append({"path": str(path), "name": path.name, "dir": str(folder / "frames"),
                        "report": report, "report_path": str(report_path),
                        "cached": False})
    return entries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", type=Path)
    parser.add_argument("--video", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--target-frames", type=int, default=0)
    parser.add_argument("--ffmpeg")
    args = parser.parse_args()
    try:
        if args.probe:
            print(json.dumps(probe(args.probe, args.ffmpeg), ensure_ascii=False))
            return 0
        if args.video and args.output:
            report = extract(args.video, args.output, ffmpeg=args.ffmpeg, target=args.target_frames)
            print(json.dumps({k: v for k, v in report.items() if k != "frames"},
                             ensure_ascii=False, indent=2))
            return 0
        parser.error("--probe or --video/--output is required")
    except VideoError as error:
        # A marker line, not JSON: OpenCV's decoder writes native log lines to
        # stderr, so anything structured can be prefixed with noise and fail to
        # parse. A marker is immune to that and still greppable by humans.
        print(f"video-error-code: {error.code}", file=sys.stderr)
        print(f"视频处理失败：{error}", file=sys.stderr)
        return 3
    except Exception as error:                     # noqa: BLE001 - CLI boundary
        # An unexpected Python failure is an environment/implementation problem,
        # not a bad container. Reporting it as decode_failed (400, user domain)
        # would send the user off to re-encode a perfectly good video.
        print("video-error-code: internal_error", file=sys.stderr)
        print(f"视频处理失败：内部错误，请检查运行环境后重试"
              f"（{type(error).__name__}: {error}）", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
