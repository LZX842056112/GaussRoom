#!/usr/bin/env bash
# =============================================================================
# tools/video-golden/generate_fixtures.sh
#
# 重新生成 tools/workbench/py/fixtures/video_frames/ 下的 4 个二进制测试视频。
#
# 【一次性手工步骤 —— CI 不运行本脚本】
# 测试运行时不编码任何视频：fixture 以二进制入库，测试只断言它们的 sha256 与
# ENVIRONMENT.json 里记录的一致。本脚本存在的唯一理由是让"重新生成 fixture"
# 这条路可复现，而不是靠记忆敲命令。
#
# 【重新生成后必须做的事，顺序不能反】
#   1. 先跑本脚本，看底部 4 行 sha256 校验是否全部 OK（不一致时先读完下面
#      "已知限制"再决定怎么办）。
#   2. 再用与 test_video_frames_golden.py 同一套程序化逻辑重新捕获
#      tools/video-golden/ENVIRONMENT.json —— 尤其是 golden.fixtures 的 4 条
#      sha256。禁止手抄、禁止只改数字不跑采集。
#   3. 只有"入库 fixture 的字节"与"入库 ENVIRONMENT.json 记录的字节"精确一致
#      时，FrozenIdentity 才不红。二者不一致是仓库缺陷，测试会 fail 而不是
#      skip —— 这是刻意的。
#
# 【轨 A 的黄金值不受本脚本影响】
#   轨 A 的输入是确定性帧生成器渲染的帧，ENVIRONMENT.json 的
#   track_a_input_sha256 记的是解码后灰度像素的摘要，与 ffmpeg 无关。所以
#   重跑本脚本不会让轨 A 的黄金值失效；但 numpy / OpenCV / Pillow 任一升级
#   会让它失效，那时测试会 skip 并提示重抓。
#
# 【已知限制 —— 换机器字节几乎必然不同】
#   x264 的输出字节依赖 ffmpeg 与 libx264 的确切版本和编译选项。同一套命令在
#   另一台机器上跑，字节很可能不同。那不算回归，但你必须重新捕获
#   ENVIRONMENT.json，否则 FrozenIdentity 会 fail。ENVIRONMENT.json 里同时记了
#   ffmpeg 版本行与完整 configuration: 行，就是为了让这种偏差可解释。
#
# 用法：  bash tools/video-golden/generate_fixtures.sh
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$REPO/tools/workbench/py/fixtures/video_frames"

# Guard against a wrong destination. x264 output is deterministic on one
# machine, so a script that writes to the wrong place still produces files
# whose sha256 matches the expected values and passes its own check below -
# the bug is invisible. (An earlier revision of this script resolved the
# output directory one level too high, wrote a byte-identical set of fixtures
# into <repo>/workbench/py/fixtures/video_frames, and reported 4/4 OK.)
# So: pin the path, and refuse to invent a fixture directory that is not
# already in the repository.
case "$OUT" in
  */tools/workbench/py/fixtures/video_frames) ;;
  *) echo "内部错误：输出目录不在 tools/workbench/py/fixtures/video_frames 下：$OUT" >&2; exit 2 ;;
esac
for name in dark-6s.mp4 short-1s.mp4 still-6s.mp4 walk-6s.mp4; do
  if [ ! -f "$OUT/$name" ]; then
    echo "内部错误：$OUT/$name 不存在 —— fixture 应已入库，本脚本只重建、不新建目录。" >&2
    exit 2
  fi
done

cd "$OUT"

echo "── 生成目录：$OUT"
echo "── ffmpeg：$(ffmpeg -version 2>/dev/null | head -1)"
echo

# walk-6s：一台水平移动的相机。testsrc2 源给到 1920x1080，crop 窗口 6 秒内平移
# 640px，运动量足以让相邻候选的 dHash 距离落在"不近重复"区间。初版用 1280x720
# 直接平移，位移太小，n_kept 退化成 1，与静止用例无法区分。
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=24:duration=6" \
  -vf "crop=1280:720:x='640*t/6':y='180'" \
  -pix_fmt yuv420p -c:v libx264 -crf 34 -preset veryslow -g 48 \
  -movflags +faststart walk-6s.mp4

# still-6s：完全静止的画面。用来钉"整段近重复只保留 1 帧"与随之而来的
# low_view_diversity / underfilled 标记。
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=1280x720:rate=24:duration=6" \
  -pix_fmt yuv420p -c:v libx264 -crf 32 -preset veryslow -g 48 \
  -movflags +faststart still-6s.mp4

# dark-6s：严重欠曝。用来钉"零帧可用"失败分支的缩水 report 形状。
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=1280x720:rate=24:duration=6" \
  -vf "eq=brightness=-0.95:saturation=0" \
  -pix_fmt yuv420p -c:v libx264 -crf 34 -preset veryslow -g 48 \
  -movflags +faststart dark-6s.mp4

# short-1s：时长不足 MIN_CLIP_S，必须在解码之前就被拒。钉"拒绝发生在解码前"
# 这件事本身（用例断言没有产生任何帧）。
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=24:duration=1" \
  -pix_fmt yuv420p -c:v libx264 -crf 34 -preset veryslow -g 24 \
  -movflags +faststart short-1s.mp4

echo
echo "── sha256 校验（期望值来自 tools/video-golden/ENVIRONMENT.json 的 golden.fixtures）"
echo "   不一致时：先确认 ffmpeg 版本与编译选项，再按文件头说明重新捕获 ENVIRONMENT.json。"
echo

status=0
check() {
  name="$1"
  expected="$2"
  actual="$(sha256sum "$name" | cut -d' ' -f1)"
  if [ "$actual" = "$expected" ]; then
    printf '  OK    %-14s %s\n' "$name" "$actual"
  else
    printf '  DIFF  %-14s %s\n' "$name" "$actual"
    printf '        %-14s expected %s\n' "" "$expected"
    status=1
  fi
}

check dark-6s.mp4  48a831c877d10814e98cbd08d15794dad8261a51f213ca37ac4c1584026b7699
check short-1s.mp4 79a63d0b294e0977c31f73b0123f41b35bcb55468400bac7d3638d64e4425c2a
check still-6s.mp4 16c901418ecb210b8a753ca1c7127254320482274ab4767dfc8c618eff5979fa
check walk-6s.mp4  0b99a87d86b368fefe7fcbb102ff2414d2439750cda0e7f54bbdfce9c1f1e865

echo
if [ "$status" -eq 0 ]; then
  echo "── 4/4 与入库 ENVIRONMENT.json 一致，无需重捕。"
else
  echo "── 有 fixture 与记录不符：必须重新捕获 ENVIRONMENT.json（程序化，勿手抄），"
  echo "   并同步检查轨 A 黄金值是否因 numpy/OpenCV/Pillow 变化而需要重抓。"
fi
exit "$status"
