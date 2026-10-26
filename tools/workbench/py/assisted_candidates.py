"""Compare regional poses from copied matches; final output is still global SfM."""
import copy
import hashlib
import itertools
import json
from pathlib import Path
import subprocess
import sys
from assistance_inputs import snapshot_database
from assisted_geometry import triangulate_observations

def model_signature(folder):
    digest=hashlib.sha256()
    for name in ['cameras.bin','frames.bin','images.bin','points3D.bin','rigs.bin']:
        path=Path(folder)/name
        if path.exists():
            digest.update(name.encode());digest.update(b'\0')
            with path.open('rb') as stream:
                for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()

def allowed_region_ids(photo_id,regions,constraints):
    known={r['id'] for r in regions}
    return {c['regionId'] for c in constraints.get('coverage',[]) if c['photoId']==photo_id and c['decision']=='existing' and c.get('regionId') in known}

def compare_regions(request,landmarks,output,config,run,load_context,align):
    regions=request['regions']
    supported=any(sum(sum(o['photoId'] in a['photoIds'] for o in p['observations'])>=config['minViewsPerSide']
                      and sum(o['photoId'] in b['photoIds'] for o in p['observations'])>=config['minViewsPerSide'] for p in landmarks)>=config['minSharedPoints']
                  for a,b in itertools.combinations(regions,2))
    if len(regions)<2 or not supported:return None
    folder=Path(output)/'regional-candidates';folder.mkdir()
    cached=request.get('regionalCandidates',[]);command=None
    if cached:
        for item in cached:
            if model_signature(item['path'])!=item['modelSignature']:raise ValueError('冻结的区域候选已改变，不能复用。')
        candidates=list(request['models'])+cached
        message='复用同输入的区域候选，并重新检查所有共同观察。'
    else:
        database=folder/'matching.db';snapshot_database(request['database'],database)
        sparse=folder/'sparse';sparse.mkdir()
        image_list=folder/'images.txt';image_list.write_text(''.join(p['name']+'\n' for p in request['catalog']),encoding='utf8')
        command=[request['colmap'],'mapper','--database_path',str(database),'--image_path',request['images'],'--output_path',str(sparse),
                 '--Mapper.image_list_path',str(image_list),'--Mapper.multiple_models','1','--Mapper.num_threads','12',
                 '--Mapper.random_seed',str(config['seed']),'--log_color','0']
        print('ASSISTANCE_PROGRESS '+json.dumps({'stage':'regional','message':'比较增量式区域位姿。源数据库和原模型保持不变。'},ensure_ascii=False),flush=True)
        run(command,check=True,stdout=sys.stdout,stderr=sys.stderr,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        candidates=list(request['models'])+[{'name':f'incremental-{p.name}','path':str(p)} for p in sorted(sparse.iterdir()) if p.is_dir() and (p/'images.bin').exists()]
        message='重新检查区域候选的共同观察。'
    print('ASSISTANCE_PROGRESS '+json.dumps({'stage':'regional','message':message},ensure_ascii=False),flush=True)
    cache={};options=[]
    for region in regions:
        scored=[]
        for item in candidates:
            proposed={**region,'model':item['name']}
            context=load_context({**request,'models':[item],'regions':[proposed]},cache)
            views=context['regionViews'].get(region['id'],{})
            reliable=sum(triangulate_observations([o for o in p['observations'] if o['photoId'] in region['photoIds']],views,config).get('accepted',False) for p in landmarks)
            by_name={p['name']:p['photoId'] for p in request['catalog']}
            covered=sum(region['id'] in allowed_region_ids(by_name.get(image.name),regions,request['constraints']) for image in cache[item['path']].images.values())
            if reliable>=config['minSharedPoints']:scored.append((reliable,len(views)+covered,item))
        scored.sort(key=lambda value:(value[0],value[1]),reverse=True)
        options.append([value[2] for value in scored[:config.get('maxRegionalCandidates',8)]])
    receipt={'command':command,'reusedCandidates':bool(cached),'candidates':candidates,'comparisons':[],'selected':None}
    result=None;best_score=None;accepted_count=0
    for selection in itertools.islice(itertools.product(*options),config.get('maxRegionAssignments',128)):
        assigned=[{**region,'model':item['name']} for region,item in zip(regions,selection)]
        selected=list({item['name']:item for item in selection}.values())
        candidate_request={**request,'models':selected,'regions':assigned}
        context=load_context(candidate_request,cache)
        checked=align(copy.deepcopy(landmarks),context,assigned,config,allow_pixel=True)
        receipt['comparisons'].append({'models':[i['name'] for i in selection],'accepted':checked['graph']['accepted'],'missing':checked['graph']['missing']})
        if not checked['graph']['accepted']:continue
        # An unregistered photo joins a region only through actual candidate tracks.
        known=set(p for r in assigned for p in r['photoIds']);extended=False
        by_name={p['name']:p['photoId'] for p in request['catalog']}
        for photo in request['catalog']:
            if photo['photoId'] in known:continue
            votes=[]
            for region,item in zip(assigned,selection):
                if region['id'] not in allowed_region_ids(photo['photoId'],assigned,request['constraints']):continue
                model=cache[item['path']];images={image.name:image for image in model.images.values()}
                image=images.get(photo['name'])
                if image is None:continue
                region_ids={view.image_id for view in model.images.values() if by_name.get(view.name) in region['photoIds']}
                support=sum(sum(e.image_id in region_ids for e in model.points3D[p.point3D_id].track.elements)>=config['minViewsPerSide']
                            for p in image.points2D if p.has_point3D())
                if support>=config['minSharedPoints']:votes.append((support,region))
            votes.sort(key=lambda value:value[0],reverse=True)
            if votes and (len(votes)==1 or votes[0][0]>votes[1][0]):
                votes[0][1]['photoIds']=[*votes[0][1]['photoIds'],photo['photoId']];extended=True
        if extended:
            context=load_context(candidate_request,cache)
            checked=align(copy.deepcopy(landmarks),context,assigned,config,allow_pixel=True)
        if not checked['graph']['accepted']:continue
        counts=[len(e['sharedPointIds']) for e in checked['edges'] if e['accepted']]
        errors=[v['maxReprojectionPx'] for p in checked['landmarks'] for v in checked['triangulated'][p['id']].values() if v.get('accepted')]
        score=(min(counts),sum(counts),len(context['views']),-max(errors,default=0.))
        receipt['comparisons'][-1].update(sharedPointCounts=counts,selectionScore=list(score))
        if best_score is None or score>best_score:
            best_score=score;receipt['selected']={'models':selected,'regions':assigned,'selectionScore':list(score)}
            result={'request':candidate_request,'context':context,'aligned':checked,'receipt':receipt}
        accepted_count+=1
        if (min(counts)==len(landmarks) and len(context['views'])==len(request['catalog'])) or accepted_count>=config.get('maxAcceptedRegionAssignments',4):break
    path=Path(output)/'summary/regional-candidates.json';path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(receipt,indent=2,ensure_ascii=False),encoding='utf8')
    return result
