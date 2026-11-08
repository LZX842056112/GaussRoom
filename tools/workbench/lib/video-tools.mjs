// Video input capabilities. Probing, decoding and HDR tone mapping are three
// separate requirements that fail differently, so the UI needs them separately:
// a machine can decode H.264 yet have no ffprobe, and a stripped ffmpeg build
// can decode but not convert HLG to SDR.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { TOOLS } from "./paths.mjs";

let cache = null;

/**
 * Resolution order must match video_frames._ffprobe_binary() exactly: the
 * ffmpeg directory first, then PATH. If the two disagree the UI either hides a
 * working feature or promises one that fails at run time.
 */
export function ffprobePath(ffmpeg = TOOLS.ffmpeg) {
  if (!ffmpeg) return null;
  const folder = dirname(ffmpeg);
  const exe = ffmpeg.toLowerCase().endsWith(".exe") ? ".exe" : "";
  for (const name of [`ffprobe${exe}`, "ffprobe.exe", "ffprobe"]) {
    const candidate = join(folder, name);
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ["ffprobe.exe", "ffprobe"]) {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function filterSupport(ffmpeg, probe) {
  if (!ffmpeg) return { zscale: false, tonemap: false, unknown: false };
  try {
    // 5 s, not 20: this call is synchronous and sits on the mobile gateway's
    // event loop, so a slow spawn freezes photo uploads too. A healthy local
    // `ffmpeg -filters` takes 100-200 ms; anything slower is "unknown", which is
    // no longer treated as "missing" (see below), so the short timeout is safe.
    const listing = String(probe(ffmpeg, ["-hide_banner", "-filters"], {
      encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }));
    return { zscale: / zscale\s/.test(listing), tonemap: / tonemap\s/.test(listing), unknown: false };
  } catch {
    // "We could not ask" is not "it does not have": on Windows the first run of a
    // large exe can be held up by antivirus scanning. Only a clean exit proves
    // absence, so a timeout yields `unknown` and never a rejection.
    return { zscale: null, tonemap: null, unknown: true };
  }
}

export function videoCapabilities({ force = false, probe = execFileSync, now = Date.now() } = {}) {
  if (!force && probe === execFileSync && cache && now - cache.at < cache.ttl) return cache.value;
  const ffmpeg = TOOLS.ffmpeg || "";
  const hasFfmpeg = Boolean(ffmpeg) && existsSync(ffmpeg);
  const ffprobe = ffprobePath(ffmpeg);
  const filters = hasFfmpeg ? filterSupport(ffmpeg, probe) : { zscale: false, tonemap: false, unknown: false };
  const value = {
    ffmpeg: { ok: hasFfmpeg, path: ffmpeg || null },
    probe: { ok: Boolean(ffprobe), path: ffprobe },
    decode: { ok: hasFfmpeg, backend: hasFfmpeg ? "ffmpeg" : null },
    tonemap: { ok: filters.zscale === true && filters.tonemap === true, ...filters },
    // What the UI gates the "上传视频"入口 on.
    canIngestVideo: hasFfmpeg && Boolean(ffprobe),
    message: hasFfmpeg
      ? (ffprobe ? null : "缺少 ffprobe：请使用完整的 ffmpeg 发行包，或在 .env 修正 FFMPEG 路径")
      : "未配置 FFMPEG：视频重建需要 ffmpeg（含 ffprobe），请在 .env 填写 FFMPEG 路径",
  };
  // A confident answer holds for a minute; an unknown one only for a few
  // seconds, so a cold start recovers by itself instead of pinning a wrong
  // negative for the rest of the session.
  if (probe === execFileSync) cache = { at: now, value, ttl: filters.unknown ? 5000 : 60000 };
  return value;
}
