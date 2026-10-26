"""Exercise the public workbench API. Facts contain editable input, never poses."""
import argparse
import hashlib
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

EDITABLE={'answers','regionLabels','objects','landmarks','dimensions','coverage','onlyExistingPhotos'}
SUFFIXES={'.jpg','.jpeg','.png','.webp','.heic','.heif','.tif','.tiff','.bmp'}

def load_facts(path):
    value=json.loads(Path(path).read_text(encoding='utf-8-sig'))
    if not isinstance(value,dict) or set(value)-{'version','patch'} or value.get('version')!=1:
        raise ValueError('Facts must be version 1 with an editable patch')
    patch=value.get('patch')
    if not isinstance(patch,dict) or set(patch)-EDITABLE:
        raise ValueError('Facts cannot contain output paths, databases, poses or verification')
    return patch

def api_client(base_url):
    if not base_url.startswith(('http://127.0.0.1:','http://localhost:')):
        raise ValueError('Use the local workbench URL')
    def request(method,path,body=None):
        data=None if body is None else json.dumps(body,ensure_ascii=False).encode()
        req=urllib.request.Request(base_url.rstrip('/')+path,data=data,method=method,headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=180) as response:
                raw=response.read();return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'HTTP {error.code}: {error.read().decode(errors="replace")}') from error
    return request

def drive(request,project_id,facts,*,until='gate',poll_seconds=2,timeout_seconds=36000):
    prefix=f'/api/projects/{project_id}'
    deadline=time.monotonic()+timeout_seconds
    last=None
    applied=False
    while time.monotonic()<deadline:
        project=request('GET',prefix)
        marker=(project['state'],project.get('currentStep'))
        if marker!=last:
            print(f'{project_id}: {marker[0]} {marker[1] or ""}',flush=True);last=marker
        if project['state'] in ('running','aborting'):
            time.sleep(poll_seconds);continue
        summary=request('GET',prefix+'/summary')
        assistance=request('GET',prefix+'/assistance');record=assistance.get('record')
        if project['state'] in ('failed','aborted'):
            return {'outcome':project['state'],'project':project,'summary':summary,'assistance':assistance}
        if project['state']=='needs_input' or record and record['state'] in ('needs_input','ready','stale'):
            if not facts or applied:
                return {'outcome':'needs_input','project':project,'summary':summary,'assistance':assistance}
            saved=request('PUT',prefix+'/assistance',{'expectedRevision':record['revision'],'patch':facts});applied=True
            if saved['record']['state']!='ready':
                return {'outcome':'needs_input','project':project,'summary':summary,'assistance':saved}
            request('POST',prefix+'/assistance/run',{'expectedRevision':saved['record']['revision'],'untilStep':until})
            continue
        quality=summary.get('quality',{})
        if quality.get('geometry')!='verified' or quality.get('coverage')!='reviewed':
            return {'outcome':'unverified','project':project,'summary':summary,'assistance':assistance}
        if until=='gate':
            return {'outcome':'verified','project':project,'summary':summary,'assistance':assistance}
        if quality.get('trainingComplete'):
            return {'outcome':'model_generated','project':project,'summary':summary,'assistance':assistance}
        request('POST',prefix+'/run',{'fromStep':'undistort','untilStep':'train'})
    raise TimeoutError('Acceptance timed out; the workbench job and artifacts were retained')

def hash_sources(folder):
    files=sorted((p for p in Path(folder).iterdir() if p.is_file() and p.suffix.lower() in SUFFIXES),key=lambda p:p.name.lower())
    result=[]
    for path in files:
        digest=hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
        result.append({'name':path.name,'sha256':digest.hexdigest(),'bytes':path.stat().st_size})
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',required=True);parser.add_argument('--source-dir',type=Path,required=True)
    parser.add_argument('--facts',type=Path);parser.add_argument('--training-preset',choices=['full'],default='full')
    parser.add_argument('--report-dir',type=Path,required=True);parser.add_argument('--until',choices=['gate','train'],default='gate')
    parser.add_argument('--project-id',help='Resume the explicitly named acceptance project')
    parser.add_argument('--timeout-seconds',type=float,default=36000)
    args=parser.parse_args();request=api_client(args.base_url);facts=load_facts(args.facts) if args.facts else None
    args.report_dir.mkdir(parents=True,exist_ok=True)
    source_path=args.report_dir/'source-before.json'
    if source_path.exists():before=json.loads(source_path.read_text(encoding='utf8'))
    else:
        before=hash_sources(args.source_dir);source_path.write_text(json.dumps(before,indent=2,ensure_ascii=False),encoding='utf8')
    if args.project_id:project=request('GET',f'/api/projects/{args.project_id}')
    else:
        project=request('POST','/api/projects',{'name':'assisted-acceptance','sourceDir':str(args.source_dir.resolve()),'trainingPreset':args.training_preset,'useGpu':True,'cameraModel':'SIMPLE_RADIAL','mapper':'global','featurePreset':'enhanced'})
        print(f'Acceptance project ID: {project["id"]}',flush=True)
        request('POST',f'/api/projects/{project["id"]}/run',{'fromStep':'prepare','untilStep':'gate'})
    print(f'Acceptance project ID: {project["id"]}',flush=True)
    result=drive(request,project['id'],facts,until=args.until,timeout_seconds=args.timeout_seconds)
    after=hash_sources(args.source_dir);result['originalsUnchanged']=before==after;result['sourceCount']=len(before)
    result['baseUrl']=args.base_url;result['sourceDirectory']=str(args.source_dir.resolve())
    report=args.report_dir/'acceptance.json';report.write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding='utf8')
    print(json.dumps({'projectId':project['id'],'outcome':result['outcome'],'originalsUnchanged':result['originalsUnchanged'],'report':str(report)},ensure_ascii=False),flush=True)
    return 0 if result['outcome'] in ('verified','model_generated') and before==after else 2

if __name__=='__main__':raise SystemExit(main())
