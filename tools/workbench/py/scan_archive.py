import argparse, hashlib, json, math, os, re, shutil, stat, sys, tempfile, uuid, zipfile
from pathlib import Path, PurePosixPath
from datetime import datetime
from PIL import Image
import numpy as np

MAX_FILES=100000
MAX_TOTAL=32*1024**3
MAX_FILE=4*1024**3
MAX_RATIO=1000

def safe_path(name):
    if not isinstance(name,str) or not name or '\\' in name or ':' in name or name.startswith('/') or any(x in ('','.','..') for x in name.split('/')) or any(ord(c)<32 for c in name):
        raise ValueError('unsafe archive path')
    for part in name.split('/'):
        if part.endswith(('.', ' ')) or part.split('.')[0].upper() in {'CON','PRN','AUX','NUL',*(f'COM{i}' for i in range(1,10)),*(f'LPT{i}' for i in range(1,10))}:
            raise ValueError('unsafe archive path')
    return name

def read_json(path):
    return json.loads(path.read_text(encoding='utf8'),parse_constant=lambda v: (_ for _ in ()).throw(ValueError('nonfinite number')))

def finite(values,n):
    if not isinstance(values,list) or len(values)!=n or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in values):raise ValueError('invalid numeric values')

def dimensions(item):
    w,h=item['width'],item['height']
    if type(w)!=int or type(h)!=int or w<=0 or h<=0 or w*h>200_000_000:raise ValueError('invalid dimensions')
    return w,h

def validate(root, manifest, listed):
    if manifest['format']!='gaussroom_scan_v1':raise ValueError('unsupported format')
    uuid.UUID(manifest['scanId']);uuid.UUID(manifest['sessionId']);datetime.fromisoformat(manifest['createdAt'].replace('Z','+00:00'))
    if not all(isinstance(manifest['device'][k],str) and manifest['device'][k] for k in ('model','systemVersion')):raise ValueError('invalid device')
    if manifest['coordinateSystem']!={'handedness':'right','up':'y','units':'metres','cameraForward':'-z','matrixOrder':'column-major','imageOrientation':'sensor'}:raise ValueError('invalid coordinate system')
    for k in ('frames','mesh','edits'):
        if safe_path(manifest[k]) not in listed:raise ValueError('missing metadata file')
    frames=read_json(root/manifest['frames'])['frames']
    if not isinstance(frames,list) or len(frames)<2:raise ValueError('at least two frames required')
    ids=set();paths=set();image_paths=set();image_hashes=set();previous=-math.inf
    for f in frames:
        if not isinstance(f['id'],str) or not f['id'] or f['id'] in ids:raise ValueError('duplicate frame id')
        ids.add(f['id']); timestamp=f['timestamp']
        if isinstance(timestamp,bool) or not isinstance(timestamp,(float,int)) or not math.isfinite(timestamp) or timestamp<=previous:raise ValueError('invalid timestamp')
        previous=timestamp;finite(f['intrinsics'],9);finite(f['cameraToWorld'],16)
        k=np.asarray(f['intrinsics']).reshape(3,3,order='F');transform=np.asarray(f['cameraToWorld']).reshape(4,4,order='F');rotation=transform[:3,:3]
        if k[0,0]<=0 or k[1,1]<=0 or not np.allclose(k,[[k[0,0],0,k[0,2]],[0,k[1,1],k[1,2]],[0,0,1]],atol=1e-5):raise ValueError('invalid intrinsics')
        if not np.allclose(transform[3],[0,0,0,1],atol=1e-6) or not np.allclose(rotation.T@rotation,np.eye(3),atol=1e-4) or not np.isclose(np.linalg.det(rotation),1,atol=1e-4):raise ValueError('invalid camera transform')
        for kind in ('image','depth','confidence'):
            obj=f[kind];name=safe_path(obj['path']);w,h=dimensions(obj)
            if name not in listed or name in paths:raise ValueError('missing or reused frame data')
            paths.add(name)
            if kind=='image':
                image_paths.add(name)
                parts=name.split('/')
                if len(parts)!=2 or parts[0]!='images' or not name.lower().endswith(('.jpg','.jpeg')):raise ValueError('images must be top-level JPEG files')
                image_hashes.add(listed[name]['sha256'])
                with Image.open(root/name) as im:
                    if im.format!='JPEG' or im.size!=(w,h) or im.getexif().get(274,1)!=1:raise ValueError('image dimensions or orientation mismatch')
                    im.load()
            elif kind=='depth':
                if obj['format']!='float32_le' or (root/name).stat().st_size!=w*h*4:raise ValueError('depth layout mismatch')
            else:
                if obj.get('format')!='uint8' or (root/name).stat().st_size!=w*h:raise ValueError('confidence layout mismatch')
                with (root/name).open('rb') as stream:
                    while chunk:=stream.read(1024*1024):
                        if any(c>2 for c in chunk):raise ValueError('invalid confidence')
        if dimensions(f['depth'])!=dimensions(f['confidence']):raise ValueError('depth/confidence dimensions mismatch')
    if any(name.casefold().startswith('images/') and name not in image_paths for name in listed):raise ValueError('unindexed image file')
    if len(image_hashes)<2:raise ValueError('at least two distinct images required')
    mesh=read_json(root/manifest['mesh']);edits=read_json(root/manifest['edits'])
    vertices=mesh['vertices'];normals=mesh['normals'];faces=mesh['faces']
    if not all(isinstance(x,list) for x in (vertices,normals,faces)) or len(vertices)!=len(normals):raise ValueError('invalid mesh')
    for v in vertices+normals:finite(v,3)
    for f in faces:
        if not isinstance(f,list) or len(f)!=3 or any(type(i)!=int or i<0 or i>=len(vertices) for i in f):raise ValueError('invalid faces')
    if edits['crop'] is not None:
        finite(edits['crop']['min'],3);finite(edits['crop']['max'],3)
        if any(a>b for a,b in zip(edits['crop']['min'],edits['crop']['max'])):raise ValueError('invalid crop')
    if not isinstance(edits['measurements'],list):raise ValueError('invalid measurements')
    for m in edits['measurements']:finite(m['start'],3);finite(m['end'],3)
    return len(frames)

def extract_scan(archive, output, max_total_bytes=MAX_TOTAL):
    output=Path(output).absolute();parent=output.parent
    if output.exists():raise ValueError('output already exists')
    parent.mkdir(parents=True,exist_ok=True)
    tmp=Path(tempfile.mkdtemp(prefix='.'+output.name+'-',dir=parent))
    try:
        with zipfile.ZipFile(archive) as z:
            infos=z.infolist();seen=set();total=0;files={}
            if len(infos)>MAX_FILES:raise ValueError('too many entries')
            for i in infos:
                name=i.filename[:-1] if i.is_dir() else i.filename;safe_path(name)
                key=name.casefold()
                if key in seen:raise ValueError('duplicate archive path')
                seen.add(key)
                mode=i.external_attr>>16
                if stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR) or (stat.S_IFMT(mode)==stat.S_IFDIR)!=i.is_dir() and stat.S_IFMT(mode)!=0:raise ValueError('archive link or special file')
                if i.flag_bits&1:raise ValueError('encrypted archive')
                if i.is_dir():continue
                total+=i.file_size
                if i.file_size>MAX_FILE or total>max_total_bytes or i.file_size>max(1024*1024,i.compress_size*MAX_RATIO):raise ValueError('archive size limit')
                files[name]=i
            if 'manifest.json' not in files or files['manifest.json'].file_size>16*1024*1024:raise ValueError('missing or oversized manifest')
            raw=z.read(files['manifest.json']); manifest=json.loads(raw.decode('utf8'),parse_constant=lambda v: (_ for _ in ()).throw(ValueError('nonfinite number')))
            entries=manifest['files'];listed={}
            if not isinstance(entries,list):raise ValueError('invalid file list')
            for e in entries:
                name=safe_path(e['path'])
                if name in listed or name=='manifest.json' or type(e['bytes'])!=int or e['bytes']<0 or not re.fullmatch('[0-9a-f]{64}',e['sha256']):raise ValueError('invalid file entry')
                listed[name]=e
            if set(files)!=(set(listed)|{'manifest.json'}):raise ValueError('archive file list mismatch')
            (tmp/'manifest.json').write_bytes(raw)
            for name,e in listed.items():
                info=files[name]
                if info.file_size!=e['bytes']:raise ValueError('file size mismatch')
                target=tmp.joinpath(*name.split('/'));target.parent.mkdir(parents=True,exist_ok=True);digest=hashlib.sha256();count=0
                with z.open(info) as src,target.open('xb') as dst:
                    while chunk:=src.read(1024*1024):
                        count+=len(chunk)
                        if count>e['bytes']:raise ValueError('file exceeds declared size')
                        digest.update(chunk);dst.write(chunk)
                if count!=e['bytes'] or digest.hexdigest()!=e['sha256']:raise ValueError('file hash mismatch')
            count=validate(tmp,manifest,listed)
        os.rename(tmp,output)
        return {'scanId':manifest['scanId'],'frameCount':count,'imageDirectory':str(output/'images'),'manifestSha256':hashlib.sha256(raw).hexdigest()}
    finally:
        if tmp.exists():shutil.rmtree(tmp)

def verify_scan(root):
    root=Path(root).resolve(); manifest=read_json(root/'manifest.json'); listed={}; total=0
    entries=manifest['files']
    if not isinstance(entries,list) or len(entries)>MAX_FILES:raise ValueError('invalid file list')
    for entry in entries:
        name=safe_path(entry['path']); key=name.casefold()
        if key in listed or key=='manifest.json' or type(entry['bytes'])!=int or entry['bytes']<0 or entry['bytes']>MAX_FILE or not re.fullmatch('[0-9a-f]{64}',entry['sha256']):raise ValueError('invalid file entry')
        listed[key]=name; total+=entry['bytes']
        if total>MAX_TOTAL:raise ValueError('scan size limit')
        path=root
        for part in name.split('/'):
            path=path/part
            if path.is_symlink():raise ValueError('scan contains link')
        if not path.is_file() or path.stat().st_size!=entry['bytes']:raise ValueError('scan file size mismatch')
        digest=hashlib.sha256()
        with path.open('rb') as stream:
            while chunk:=stream.read(1024*1024):digest.update(chunk)
        if digest.hexdigest()!=entry['sha256']:raise ValueError('scan file hash mismatch')
    validate(root,manifest,{entry['path']:entry for entry in entries})
    return manifest

def main():
    p=argparse.ArgumentParser();p.add_argument('--archive',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    try:print(json.dumps(extract_scan(a.archive,a.output),ensure_ascii=False));return 0
    except Exception as e:print(str(e),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
