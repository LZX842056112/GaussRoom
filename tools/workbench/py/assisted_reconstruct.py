"""Execute a local assisted global reconstruction and verify final shared tracks."""
import argparse
from contextlib import closing
from itertools import combinations
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import numpy as np
import pycolmap as pc
from assistance_inputs import fingerprint_inputs,snapshot_database
from assisted_features import collect_observations,detect_features,extend_observations,rejected_pairs
from assisted_geometry import triangulate_observations,validate_observed_point,estimate_region_alignment,connect_regions,check_dimensions
from assisted_database import build_geometry_database
from gate_model import geometry_components,images,geometry_signature,main as run_gate
from assisted_candidates import compare_regions
from assisted_alignment import refine_pixel_alignment
from assisted_initialization import run_initialized_global


def _json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(path.suffix+'.tmp');temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8');temporary.replace(path)


def _progress(stage,message):print('ASSISTANCE_PROGRESS '+json.dumps({'stage':stage,'message':message},ensure_ascii=False),flush=True)


def load_context(request,cache=None):
    catalog={p['photoId']:p for p in request['catalog']};by_name={p['name']:p for p in catalog.values()}
    loaded=[];views={};region_views={}
    for item in request['models']:
        if cache is None:model=pc.Reconstruction(item['path'])
        else:
            if item['path'] not in cache:cache[item['path']]=pc.Reconstruction(item['path'])
            model=cache[item['path']]
        regions=[r for r in request['regions'] if r['model']==item['name']]
        by_photo={p:r['id'] for r in regions for p in r['photoIds']}
        loaded.append({**item,'reconstruction':model,'regions':regions})
        for image_id,image in model.images.items():
            photo=by_name.get(image.name)
            if not photo or photo['photoId'] not in by_photo:continue
            photo_id=photo['photoId'];region_id=by_photo[photo_id]
            view={'camera':model.cameras[image.camera_id],'camFromWorld':image.cam_from_world().matrix(),
                  'imageId':image_id,'regionId':region_id,'model':item['name']}
            views[photo_id]=view;region_views.setdefault(region_id,{})[photo_id]=view
    return {'models':loaded,'views':views,'regionViews':region_views}


def _align(landmarks,context,regions,config,fixed_points=None,allow_pixel=False):
    triangulated={};edges=[];kept=set();missing=[]
    for point in landmarks:
        triangulated[point['id']]={}
        for region in regions:
            obs=[o for o in point['observations'] if o['photoId'] in region['photoIds']]
            region_views=context['regionViews'].get(region['id'],{})
            measured=validate_observed_point(fixed_points[point['id']],obs,region_views,config) if fixed_points and point['id'] in fixed_points else triangulate_observations(obs,region_views,config)
            if len(regions)==1 and measured.get('accepted') and measured['views']<2*config['minViewsPerSide']:
                measured={**measured,'accepted':False,'missing':[{'code':'local_observations_needed','message':'局部复查每点至少需要四个可靠观察，不能只保留一侧的照片。'}]}
            triangulated[point['id']][region['id']]=measured
    for first,second in combinations(regions,2):
        shared=[{'id':point['id'],'a':triangulated[point['id']][first['id']],'b':triangulated[point['id']][second['id']]} for point in landmarks]
        result=estimate_region_alignment(shared,config)
        if not result['accepted'] and allow_pixel:
            result=refine_pixel_alignment(shared,context['regionViews'].get(first['id'],{}),context['regionViews'].get(second['id'],{}),config)
            if result['accepted']:
                for point_id,joint in result['jointTriangulated'].items():
                    triangulated[point_id][first['id']]=joint['a'];triangulated[point_id][second['id']]=joint['b']
        edge={**result,'first':first['id'],'second':second['id']};edges.append(edge)
        if result['accepted']:kept.update(result['sharedPointIds'])
    graph=connect_regions(regions,edges,config)
    if len(regions)==1:
        region_id=regions[0]['id']
        support=[{'id':p['id'],'a':triangulated[p['id']][region_id],'b':triangulated[p['id']][region_id]} for p in landmarks]
        local=estimate_region_alignment(support,config)
        if local['accepted']:kept.update(local['sharedPointIds'])
        else:graph.update(accepted=False,missing=local['missing'])
        requested={o['photoId'] for p in landmarks for o in p['observations'] if o.get('origin')=='manual'}
        for photo_id in requested:
            count=sum(any(o['photoId']==photo_id and o.get('origin')=='manual' for o in p['observations']) for p in landmarks)
            supported=sum(p['id'] in kept and any(o['photoId']==photo_id for o in triangulated[p['id']][region_id].get('observations',[])) for p in landmarks)
            if count>=config['minSharedPoints'] and supported<config['minSharedPoints']:
                graph['accepted']=False;graph['missing'].append({'code':'local_photo_unsupported','photoId':photo_id,'message':'这张已标记的问题照片没有足够的有效共同点，局部位置仍未验证。'})
    for point in landmarks:
        if point['id'] not in kept:continue
        clean=[]
        for region in regions:
            result=triangulated[point['id']][region['id']]
            if result.get('accepted'):clean.extend(result['observations'])
        point['observations']=clean
    return {'graph':graph,'edges':edges,'landmarks':[p for p in landmarks if p['id'] in kept],'triangulated':triangulated,'missing':missing}


def verify_final_bridges(model,request,config):
    model=Path(model);reconstruction=pc.Reconstruction(str(model))
    components=geometry_components(model,images(model/'images.bin'))
    catalog={p['photoId']:p for p in request['catalog']};by_name={v.name:v for v in reconstruction.images.values()}
    views={};region_views={}
    for region in request['regions']:
        region_views[region['id']]={}
        for photo_id in region['photoIds']:
            image=by_name.get(catalog[photo_id]['name'])
            if not image:continue
            view={'camera':reconstruction.cameras[image.camera_id],'camFromWorld':image.cam_from_world().matrix()}
            views[photo_id]=view;region_views[region['id']][photo_id]=view
    point_index={}
    for photo_id in views:
        image=by_name[catalog[photo_id]['name']]
        point_index[photo_id]={}
        for p in image.points2D:
            if p.has_point3D():point_index[photo_id].setdefault(tuple(np.asarray(p.xy,dtype=np.float32)),[]).append(p)
    retained=[];duplicates=0;fixed_points={};physical_points={};aliases={}
    for point in reconstruction.points3D.values():
        ids=[e.image_id for e in point.track.elements];duplicates+=len(ids)-len(set(ids))
    for landmark in request['constraints'].get('landmarks',[]):
        grouped={}
        for obs in landmark['observations']:
            if obs['photoId'] not in views:continue
            candidates=point_index[obs['photoId']].get(tuple(np.asarray(obs['xy'],dtype=np.float32)),[])
            for point in candidates:grouped.setdefault(int(point.point3D_id),[]).append({**obs,'xy':point.xy.tolist()})
        if grouped:
            point_id,obs=max(grouped.items(),key=lambda item:len({o['photoId'] for o in item[1]}))
            unique={o['photoId']:o for o in obs}
            if point_id in physical_points:
                canonical=physical_points[point_id];aliases[landmark['id']]=canonical['id']
                canonical['observations']=list({o['photoId']:o for o in canonical['observations']+list(unique.values())}.values())
            else:
                canonical={**landmark,'observations':list(unique.values())};physical_points[point_id]=canonical;retained.append(canonical)
                fixed_points[landmark['id']]=reconstruction.points3D[point_id].xyz.copy()
    context={'regionViews':region_views}
    alignment=_align(retained,context,request['regions'],config,fixed_points=fixed_points)
    for alias,canonical in aliases.items():alignment['triangulated'][alias]=alignment['triangulated'][canonical]
    missing=list(alignment['graph']['missing'])
    if len(components)!=1:missing.append({'code':'final_disconnected','message':'最终模型仍有多个独立分量，不能继续整体训练。'})
    if duplicates:missing.append({'code':'duplicate_final_observations','message':'最终轨迹存在重复照片观察，不能确认连接。'})
    return {'accepted':not missing,'regions':request['regions'],'geometryComponentSizes':[c['registered'] for c in components],
            'edges':alignment['edges'],'missing':missing,'duplicateObservations':duplicates,'duplicateLandmarkPoints':len(aliases),'landmarkAliases':aliases,'uniqueSharedPoints':len(retained),'retainedLandmarks':alignment['landmarks'],
            'triangulated':alignment['triangulated'],'thresholds':config}


def solve_assisted(request,run=subprocess.run):
    result={'outcome':'failed','inputRevision':request.get('inputRevision'),'inputFingerprint':request.get('inputFingerprint'),
            'model':None,'gate':None,'bridges':None,'missing':[],'error':None}
    output=Path(request['outputRoot']);output.mkdir(parents=True,exist_ok=True)
    try:
        config=request['config'];catalog=[{**p,'path':str(Path(request['images'])/p['name'])} for p in request['catalog']]
        fingerprint=fingerprint_inputs(catalog,Path(request['database']),[Path(m['path']) for m in request['models']],config)
        if fingerprint!=request['inputFingerprint']:raise ValueError('输入指纹已改变，请重新确认照片和标记。')
        _progress('diagnosis','检查照片、约束版本和区域成员。')
        context=load_context(request)
        if request['constraints'].get('localRepair') is not None:
            from assisted_local_job import run_local_repair
            return run_local_repair(request,context,catalog,result,run,_progress,_json)
        measured=collect_observations(catalog,context['models'],request['constraints'],config)
        if any(m['code']=='conflicting_observations' for m in measured['missing']):
            result.update(outcome='needs_input',missing=measured['missing']);return result
        denied=rejected_pairs(request['constraints'])
        features={}
        def detect(photo_id):
            if photo_id not in features:features[photo_id]=detect_features(next(p['path'] for p in catalog if p['photoId']==photo_id),config)
            return features[photo_id]
        extended=[]
        for point in measured['landmarks']:
            for region in request['regions']:
                minimum=config['minViewsPerSide']*(2 if len(request['regions'])==1 else 1)
                if len([o for o in point['observations'] if o['photoId'] in region['photoIds']])>=minimum:continue
                point=extend_observations(point,region,{'catalog':catalog,'features':detect,'config':{**config,'minViewsPerSide':minimum},'deniedPairs':denied})
            extended.append(point)
        _progress('features','检查真实特征的多视角深度、视差和误差。')
        aligned=_align(extended,context,request['regions'],config)
        _json(output/'summary/input-bridges.json',aligned)
        if not aligned['graph']['accepted']:
            alternative=compare_regions(request,extended,output,config,run,load_context,_align)
            if alternative:
                request=alternative['request'];context=alternative['context'];aligned=alternative['aligned']
                result['regionalComparison']=alternative['receipt'];_json(output/'summary/input-bridges.json',aligned)
            else:
                result.update(outcome='needs_input',missing=aligned['graph']['missing'] or measured['missing']);return result
        local_review=len(request['regions'])==1
        sfm=output/'sfm';sfm.mkdir(exist_ok=True)
        geometric=sfm/'database.db'
        recipe=build_geometry_database(Path(request['database']),geometric,context['models'],{'landmarks':aligned['landmarks'],'views':context['views'],'catalog':catalog},aligned['graph'],request['constraints'],config)
        _json(output/'summary/geometry-recipe.json',recipe)
        working=sfm/'database-global.db';snapshot_database(geometric,working)
        options={'check':True,'stdout':sys.stdout,'stderr':sys.stderr,'creationflags':getattr(subprocess,'CREATE_NO_WINDOW',0)}
        _progress('calibration','校准匹配数据库副本。')
        run([request['colmap'],'view_graph_calibrator','--database_path',str(working),
             '--relpose_min_num_inliers',str(config['minSharedPoints']),'--log_color','0'],**options)
        restored=[]
        with closing(sqlite3.connect(working)) as db:
            for pair,pose in recipe['relativePoses'].items():
                if local_review:continue
                row=db.execute('select qvec,tvec from two_view_geometries where pair_id=?',(int(pair),)).fetchone()
                q=np.asarray(pose['qvec'],dtype='<f8');t=np.asarray(pose['tvec'],dtype='<f8')
                changed=not row or row[0] is None or row[1] is None
                if not changed:
                    oldq=np.frombuffer(row[0],dtype='<f8');oldt=np.frombuffer(row[1],dtype='<f8')
                    changed=min(np.linalg.norm(oldq-q),np.linalg.norm(oldq+q))>1e-5 or np.linalg.norm(oldt-t)>1e-5
                if changed:
                    db.execute('update two_view_geometries set qvec=?,tvec=?,E=? where pair_id=?',(q.tobytes(),t.tobytes(),np.asarray(pose['E'],dtype='<f8').tobytes(),int(pair)))
                    restored.append({'pairId':pair,'reason':pose['source'],'observations':pose['observations']})
            db.commit()
        _json(output/'summary/calibration.json',{'success':True,'restoredRelativePoses':restored,'absoluteCameraPositionsSupplied':False})
        sparse=sfm/'sparse';sparse.mkdir(exist_ok=True)
        _progress('global','执行一次全局定位、三角化和联合优化。')
        command=[request['colmap'],'global_mapper','--database_path',str(working),'--image_path',request['images'],'--output_path',str(sparse),
                 '--GlobalMapper.num_threads','12','--GlobalMapper.random_seed',str(config['seed']),'--GlobalMapper.min_num_matches',str(config['minSharedPoints']),
                 '--GlobalMapper.decompose_relative_pose','1' if local_review else '0','--log_color','0']
        _json(output/'summary/global-command.json',command);run(command,**options)
        gate_args=['--model-root',str(sparse),'--database',str(working),'--manifest',request['manifest'],'--out',str(output/'summary')]
        if run_gate(gate_args)!=0:raise RuntimeError('最终几何检查工具失败')
        gate=json.loads((output/'summary/gate.json').read_text(encoding='utf8'));result['gate']=gate
        final_request={**request,'constraints':{**request['constraints'],'landmarks':aligned['landmarks']}}
        bridges=None
        if gate['verdict']=='pass':
            _progress('verify','检查最终共享三维点和所有目标区域。')
            bridges=verify_final_bridges(sparse/gate['selectedModel'],final_request,config)
        if not local_review and (gate['verdict']!='pass' or not bridges['accepted']):
            # Keep the failed random initialization. Only measured geometry may
            # initialize this second native global solve; labels supply no pose.
            _json(output/'summary/random-global-gate.json',gate)
            if bridges is not None:_json(output/'summary/random-global-bridges.json',bridges)
            candidate,receipt=run_initialized_global(final_request,context,aligned,working,output,_progress)
            checked=output/'summary/initialized-global'
            if run_gate(['--model-root',str(candidate),'--database',str(working),'--manifest',request['manifest'],'--out',str(checked)])!=0:
                raise RuntimeError('几何初始化后的模型检查失败')
            candidate_gate=json.loads((checked/'gate.json').read_text(encoding='utf8'))
            candidate_bridges=verify_final_bridges(candidate/candidate_gate['selectedModel'],final_request,config) if candidate_gate['selectedModel'] is not None else None
            _json(checked/'final-bridges.json',candidate_bridges)
            receipt.update(gate=candidate_gate['verdict'],bridgesAccepted=bool(candidate_bridges and candidate_bridges['accepted']))
            _json(output/'summary/initialized-global.json',receipt);result['initializedGlobal']=receipt
            if candidate_gate['verdict']=='pass' and candidate_bridges and candidate_bridges['accepted']:
                sparse.rename(sfm/'random-global-sparse');candidate.rename(sparse)
                if run_gate(gate_args)!=0:raise RuntimeError('采用候选后的模型检查失败')
                gate=json.loads((output/'summary/gate.json').read_text(encoding='utf8'));result['gate']=gate;bridges=candidate_bridges
        if gate['verdict']!='pass':result.update(outcome='needs_input',missing=[{'code':'final_gate_failed','message':gate['message']}]);return result
        model=sparse/gate['selectedModel']
        _json(output/'summary/final-bridges.json',bridges);result['bridges']=bridges
        if not bridges['accepted']:result.update(outcome='needs_input',missing=bridges['missing']);return result
        if local_review:
            def residual(triangulated):
                errors=[v['maxReprojectionPx'] for p in triangulated.values() for v in p.values() if v.get('accepted')]
                return float(np.median(errors)) if errors else float('inf')
            before,after=residual(aligned['triangulated']),residual(bridges['triangulated'])
            result['localReview']={'beforePx':before,'afterPx':after,'improved':local_repair_improved(before,after,config)}
            if not result['localReview']['improved']:
                result.update(outcome='needs_input',missing=[{'code':'local_pose_uncertain','message':'局部复查尚无足够的姿态改善证据。请补充受影响位置两侧的共同观察，画面仍需检查。'}]);return result
        scale=calibrate_final_scale(model,request['constraints'].get('dimensions',[]),bridges['triangulated'],config)
        result['scale']=scale;_json(output/'summary/scale.json',scale)
        if not scale['accepted']:result.update(outcome='needs_input',missing=scale['missing']);return result
        if scale['scale']=='calibrated':
            if run_gate(gate_args)!=0:raise RuntimeError('尺度校准后的几何检查工具失败')
            gate=json.loads((output/'summary/gate.json').read_text(encoding='utf8'));result['gate']=gate
            bridges=verify_final_bridges(model,final_request,config);result['bridges']=bridges;_json(output/'summary/final-bridges.json',bridges)
            if gate['verdict']!='pass' or not bridges['accepted']:
                result.update(outcome='needs_input',missing=bridges['missing'] or [{'code':'scaled_gate_failed','message':gate['message']}]);return result
        result.update(outcome='verified',model={'name':gate['selectedModel'],'geometrySignature':geometry_signature(model)})
        return result
    except (OSError,ValueError,KeyError,sqlite3.Error,RuntimeError,subprocess.CalledProcessError,np.linalg.LinAlgError) as error:
        result['error']={'type':type(error).__name__,'message':str(error)};return result
    finally:_json(output/'summary/assistance-result.json',result)


def calibrate_final_scale(model,dimensions,triangulated,config):
    points={}
    for point_id,regions in triangulated.items():
        reliable=[p for p in regions.values() if p.get('accepted')]
        if reliable:points[point_id]=max(reliable,key=lambda p:p.get('views',0))
    result=check_dimensions(dimensions,points,config)
    if result['accepted'] and result['scale']=='calibrated':
        reconstruction=pc.Reconstruction(str(model))
        reconstruction.transform(pc.Sim3d(result['factor'],pc.Rotation3d(),np.zeros(3)))
        reconstruction.write(str(model))
    return result


def local_repair_improved(before,after,config):
    return bool(np.isfinite([before,after]).all() and before-after>=config['minLocalImprovementPx']
                and before>0 and (before-after)/before>=config['minLocalImprovementFraction'])


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--request',required=True,type=Path);parser.add_argument('--result',required=True,type=Path)
    args=parser.parse_args();request=json.loads(args.request.read_text(encoding='utf8'));result=solve_assisted(request);_json(args.result,result)
    return {'verified':0,'needs_input':2,'failed':1}[result['outcome']]


if __name__=='__main__':raise SystemExit(main())
