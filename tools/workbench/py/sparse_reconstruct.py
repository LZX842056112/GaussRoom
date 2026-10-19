"""Run calibration and mapping as one workbench step, preserving the match DB."""
import argparse
import os
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path


def reconstruct(colmap, database, image_path, output_path, mapper, threads=12, seed=42, run=subprocess.run):
    database = Path(database)
    output_path = Path(output_path)
    output_path.mkdir(parents=True, exist_ok=True)
    # Explicit handles are required with CREATE_NO_WINDOW on Windows. Inheriting
    # None loses the nested COLMAP logs when the workbench redirects this wrapper.
    options = {'check': True, 'creationflags': subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
               'stdout': sys.stdout, 'stderr': sys.stderr}
    if mapper == 'global':
        calibrated = database.with_name('database-global.db')
        if calibrated.resolve() == database.resolve():
            raise ValueError('校准输入必须是原始匹配数据库，不能覆盖自身')
        print('[workbench] 子阶段 1/2：复制匹配数据库并校准相机', flush=True)
        with closing(sqlite3.connect(database.resolve().as_uri()+'?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(calibrated)) as target:
                source.backup(target)
        try:
            run([str(colmap), 'view_graph_calibrator', '--database_path', str(calibrated), '--log_color', '0'], **options)
        except subprocess.CalledProcessError:
            print('[workbench] 相机校准失败，未启动全局式重建。请检查上方校准日志。', file=sys.stderr, flush=True)
            raise
        database = calibrated
    stage = '2/2' if mapper == 'global' else '1/1'
    print(f'[workbench] 子阶段 {stage}：运行{"全局式" if mapper == "global" else "增量式"}重建', flush=True)
    prefix = 'GlobalMapper' if mapper == 'global' else 'Mapper'
    run([str(colmap), 'global_mapper' if mapper == 'global' else 'mapper',
         '--database_path', str(database), '--image_path', str(image_path), '--output_path', str(output_path),
         f'--{prefix}.num_threads', str(threads), f'--{prefix}.random_seed', str(seed), '--log_color', '0'], **options)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--colmap', required=True)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--image-path', type=Path, required=True)
    parser.add_argument('--output-path', type=Path, required=True)
    parser.add_argument('--mapper', choices=['global', 'incremental'], required=True)
    args = parser.parse_args()
    try:
        reconstruct(args.colmap, args.database, args.image_path, args.output_path, args.mapper)
    except (OSError, sqlite3.Error, ValueError, subprocess.CalledProcessError) as error:
        print(f'[workbench] 稀疏重建失败：{error}', file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
