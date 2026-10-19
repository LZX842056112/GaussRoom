"""Remove all other cameras from a snapshotted COLMAP model, then check it."""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from gate_model import geometry_components, images


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--colmap', required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--selection', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    selected = json.loads(args.selection.read_text(encoding='utf-8'))
    keep = set(selected['imageIds'])
    views = images(args.source/'images.bin')
    if not keep or not keep.issubset({view['id'] for view in views}):
        raise ValueError('独立区域相机清单无效')
    args.output.mkdir(parents=True, exist_ok=True)
    delete_path = args.output.parent/'delete-image-ids.txt'
    delete_path.write_text('\n'.join(str(view['id']) for view in views if view['id'] not in keep), encoding='utf-8')
    print(f'[workbench] 提取独立区域：{len(keep)} 张照片；整体布局未验证', flush=True)
    subprocess.run([args.colmap, 'image_deleter', '--input_path', str(args.source),
                    '--output_path', str(args.output), '--image_ids_path', str(delete_path), '--log_color', '0'],
                   check=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                   stdout=sys.stdout, stderr=sys.stderr)
    result = images(args.output/'images.bin')
    if {view['id'] for view in result} != keep or len(geometry_components(args.output, result)) != 1:
        raise ValueError('提取结果没有形成单一几何分量，停止训练')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
