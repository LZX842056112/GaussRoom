"""Read-only photo identities and consistent SQLite inputs for reconstruction."""
import argparse
import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path
from PIL import Image


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def json_signature(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def build_catalog(manifest, images):
    images = Path(images).resolve()
    records = manifest.get('records', [])
    catalog, seen = [], set()
    for record in records:
        if record.get('excluded') or not record.get('work_image'):
            continue
        name = record['work_image'].replace('\\', '/')
        if name.startswith(('images/', 'inputs/images/')):
            name = name.split('images/', 1)[1]
        path = (images/name).resolve()
        if not path.is_relative_to(images) or not path.is_file():
            raise ValueError('工作照片不存在或越过项目目录')
        work_sha = sha256_file(path)
        source_sha = record.get('sha256') or record.get('sourceSha256')
        if not source_sha:
            raise ValueError('照片缺少源内容指纹，请重新预处理')
        if source_sha in seen:
            continue
        seen.add(source_sha)
        with Image.open(path) as image:
            if image.getexif().get(274, 1) != 1:
                raise ValueError('工作图片方向尚未统一，请重新预处理')
            width, height = image.size
        catalog.append({'photoId':source_sha, 'name':name, 'sourceSha256':source_sha,
                        'workSha256':work_sha, 'width':width, 'height':height,
                        'cameraGroup':record.get('camera_group')})
    return sorted(catalog, key=lambda photo:photo['photoId'])


def readonly_connection(path):
    return sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro', uri=True)


def _quote(identifier):
    return '"'+identifier.replace('"', '""')+'"'


def matching_content_signature(database):
    """Hash logical rows, not SQLite page layout or transaction header counters."""
    digest = hashlib.sha256()
    def add(value):
        if isinstance(value, bytes):
            encoded, tag = value, b'b'
        else:
            encoded, tag = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode(), b'j'
        digest.update(tag+str(len(encoded)).encode()+b':'+encoded)
    with closing(readonly_connection(database)) as db:
        db.execute('BEGIN')
        for table, sql in db.execute("select name,sql from sqlite_master where type='table' and name not like 'sqlite_%' order by name"):
            add(table); add(sql)
            columns = list(db.execute(f'pragma table_info({_quote(table)})'))
            primary = [c[1] for c in sorted(columns, key=lambda c:c[5]) if c[5]]
            order = primary or [c[1] for c in columns]
            query = f'select * from {_quote(table)} order by '+','.join(_quote(c) for c in order)
            for row in db.execute(query):
                digest.update(b'row:')
                for value in row:
                    add(value)
        db.rollback()
    return digest.hexdigest()


def snapshot_database(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination:
        raise ValueError('匹配快照不能覆盖源数据库')
    if destination.exists():
        raise FileExistsError('匹配快照已存在，不能覆盖')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with closing(readonly_connection(source)) as db, closing(sqlite3.connect(destination)) as out:
        db.backup(out)
        if out.execute('pragma quick_check').fetchone()[0] != 'ok':
            raise ValueError('匹配快照完整性检查失败')
    return {'matchingContentSha256':matching_content_signature(destination),
            'matchingSnapshotSha256':sha256_file(destination)}


def fingerprint_inputs(catalog, snapshot, models, config):
    photos = [{k:p.get(k) for k in ('photoId','workSha256','width','height')} for p in sorted(catalog,key=lambda p:p['photoId'])]
    geometry = []
    for model in sorted(map(Path, models), key=lambda p:str(p)):
        files = [(name,sha256_file(model/name)) for name in ('cameras.bin','images.bin','points3D.bin','frames.bin','rigs.bin') if (model/name).is_file()]
        geometry.append(files)
    return {'photosSha256':json_signature(photos), 'matchingContentSha256':matching_content_signature(snapshot) if snapshot else 'unavailable',
            'matchingSnapshotSha256':sha256_file(snapshot) if snapshot else None, 'geometrySha256':json_signature(geometry),
            'configSha256':json_signature(config)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path, required=True)
    parser.add_argument('--result', type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding='utf8'))
    manifest = json.loads(Path(request['manifest']).read_text(encoding='utf8'))
    catalog = build_catalog(manifest, Path(request['images']))
    if request.get('snapshot'):
        snapshot_database(Path(request['database']), Path(request['snapshot']))
    snapshot_name=request.get('snapshot') or request.get('database')
    snapshot = Path(snapshot_name) if snapshot_name else None
    result = {'catalog':catalog,'inputs':fingerprint_inputs(catalog,snapshot,request.get('models',[]),request['config'])}
    args.result.parent.mkdir(parents=True,exist_ok=True)
    temporary = args.result.with_suffix('.tmp')
    temporary.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    temporary.replace(args.result)


if __name__ == '__main__': main()
