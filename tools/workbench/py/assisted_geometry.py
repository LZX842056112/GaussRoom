"""Multiview geometry and region graph validation in measured image coordinates."""
from itertools import combinations
import math
import numpy as np


def _failure(code,message,rejected=None):
    return {'accepted':False,'rejected':rejected or [],'missing':[{'code':code,'message':message}]}


def _dlt(observations,views):
    equations=[]
    for obs in observations:
        view=views[obs['photoId']]
        xy=view['camera'].cam_from_img(np.asarray(obs['xy'],float))
        if xy is None or not np.isfinite(xy).all():return None
        p=np.asarray(view['camFromWorld'],float)
        equations.extend([xy[0]*p[2]-p[0],xy[1]*p[2]-p[1]])
    _,_,vt=np.linalg.svd(np.asarray(equations))
    homogeneous=vt[-1]
    return homogeneous[:3]/homogeneous[3] if abs(homogeneous[3])>1e-12 else None


def _errors(xyz,observations,views):
    result=[]
    for obs in observations:
        view=views[obs['photoId']];pose=np.asarray(view['camFromWorld'],float)
        local=pose[:,:3]@xyz+pose[:,3]
        predicted=view['camera'].img_from_cam(local) if local[2]>1e-9 else None
        result.append(float(np.linalg.norm(predicted-obs['xy'])) if predicted is not None and np.isfinite(predicted).all() else float('inf'))
    return np.asarray(result)


def validate_observed_point(xyz,observations,views,config):
    valid=[o for o in observations if o['photoId'] in views]
    if len({o['photoId'] for o in valid})!=len(valid):return _failure('duplicate_observation','同一照片存在重复点观察，请修正标记。')
    if np.asarray(xyz).shape!=(3,) or not np.isfinite(xyz).all():return _failure('invalid_point','三维点坐标无效。')
    errors=_errors(np.asarray(xyz),valid,views);mask=errors<=config['maxReprojectionPx']
    kept=[o for o,ok in zip(valid,mask) if ok]
    if len(kept)<config['minViewsPerSide']:return _failure('positive_depth_or_reprojection','点深度或重投影不可靠，请核对标记。')
    rays=[];spread=[]
    for obs in kept:
        view=views[obs['photoId']];pose=np.asarray(view['camFromWorld'],float)
        center=-pose[:,:3].T@pose[:,3];ray=np.asarray(xyz)-center;rays.append(ray/np.linalg.norm(ray))
        spread.append({'photoId':obs['photoId'],'xy':obs['xy'],'diagonal':float(np.hypot(view['camera'].width,view['camera'].height))})
    parallax=max(math.degrees(math.acos(float(np.clip(a@b,-1,1)))) for a,b in combinations(rays,2))
    if parallax+1e-9<config['minParallaxDeg']:return _failure('insufficient_parallax','拍摄位置过近，无法稳定确定深度。请选择视角差更大的照片。')
    return {'accepted':True,'xyz':np.asarray(xyz).tolist(),'views':len(kept),'parallaxDeg':parallax,'maxReprojectionPx':float(max(errors[mask])),
            'observations':kept,'spread':spread,'rejected':[{'photoId':o['photoId'],'code':'reprojection_or_depth'} for o,ok in zip(valid,mask) if not ok],'missing':[]}


def triangulate_observations(observations,reconstruction,config):
    views=reconstruction
    valid=[o for o in observations if o['photoId'] in views]
    if len({o['photoId'] for o in valid})!=len(valid):return _failure('duplicate_observation','同一照片存在重复点观察，请修正标记。')
    if len(valid)<config['minViewsPerSide']:return _failure('insufficient_views','该点在本区域至少需要两张不同照片。')
    if any(np.asarray(o['xy']).shape!=(2,) or not np.isfinite(o['xy']).all() for o in valid):return _failure('invalid_pixel','点坐标无效。')
    pairs=list(combinations(range(len(valid)),2))
    if len(pairs)>512:
        rng=np.random.default_rng(config['seed']);pairs=[pairs[i] for i in rng.choice(len(pairs),512,replace=False)]
    best=None;best_mask=None;best_score=(-1,-float('inf'))
    for i,j in pairs:
        xyz=_dlt([valid[i],valid[j]],views)
        if xyz is None or not np.isfinite(xyz).all():continue
        errors=_errors(xyz,valid,views);mask=errors<=config['maxReprojectionPx']
        score=(int(mask.sum()),-float(np.median(errors[mask])) if mask.any() else -float('inf'))
        if score>best_score:best,best_mask,best_score=xyz,mask,score
    if best is None or best_mask.sum()<config['minViewsPerSide']:return _failure('positive_depth_or_reprojection','点深度或重投影不可靠。请核对标记并选择更清楚的照片。')
    for _ in range(2):
        kept=[o for o,ok in zip(valid,best_mask) if ok]
        candidate=_dlt(kept,views)
        if candidate is None:break
        best=candidate;errors=_errors(best,valid,views);best_mask=errors<=config['maxReprojectionPx']
        if best_mask.sum()<config['minViewsPerSide']:return _failure('reprojection_error','对应点优化后误差过大，请修正标记。')
    return validate_observed_point(best,valid,views,config)


def _umeyama(a,b):
    ma,mb=a.mean(axis=0),b.mean(axis=0);ac,bc=a-ma,b-mb
    if np.linalg.matrix_rank(ac,tol=1e-10)<2:raise ValueError('collinear')
    u,s,vt=np.linalg.svd(bc.T@ac/len(a))
    sign=np.ones(3);sign[-1]=1 if np.linalg.det(u@vt)>0 else -1
    rotation=(u*sign)@vt
    scale=float(s@sign/(np.sum(ac*ac)/len(a)))
    if scale<=0 or not np.isfinite(scale):raise ValueError('invalid scale')
    return scale,rotation,mb-scale*rotation@ma


def _noncollinear(points,config):
    singular=np.linalg.svd(points-points.mean(axis=0),compute_uv=False)
    return len(singular)>=2 and singular[0]>1e-9 and singular[1]/singular[0]>=config['minSecondSingularRatio']


def _image_spread(points,side,config):
    groups={}
    for point in points:
        for obs in point[side].get('spread',[]):groups.setdefault(obs['photoId'],[]).append(obs)
    good=0
    for observations in groups.values():
        xy=np.asarray([o['xy'] for o in observations]);diagonal=observations[0]['diagonal']
        if diagonal>0 and np.linalg.norm(np.ptp(xy,axis=0))/diagonal>=config['minImageSpanFraction']:good+=1
    return good>=config['minViewsPerSide']


def estimate_region_alignment(shared_points,config):
    def reliable(side):
        return side.get('accepted') is True and side.get('views',0)>=config['minViewsPerSide'] and side.get('parallaxDeg',0)+1e-9>=config['minParallaxDeg'] and side.get('maxReprojectionPx',float('inf'))<=config['maxReprojectionPx'] and np.asarray(side.get('xyz')).shape==(3,) and np.isfinite(side['xyz']).all()
    usable=[p for p in shared_points if reliable(p['a']) and reliable(p['b'])]
    rejected=[{'id':p['id'],'code':'unreliable_multiview_point'} for p in shared_points if p not in usable]
    if len(usable)<config['minSharedPoints']:return _failure('insufficient_shared_points',f"需要至少 {config['minSharedPoints']} 个两侧均可靠的共享点。",rejected)
    a=np.asarray([p['a']['xyz'] for p in usable]);b=np.asarray([p['b']['xyz'] for p in usable])
    span=float(np.median(np.linalg.norm(b-np.median(b,axis=0),axis=1)))
    threshold=max(span*config['maxAlignmentResidualFraction'],1e-8)
    rng=np.random.default_rng(config['seed']);best_mask=None;best_score=(-1,-float('inf'))
    for _ in range(512):
        sample=rng.choice(len(a),3,replace=False)
        try:scale,rotation,translation=_umeyama(a[sample],b[sample])
        except (ValueError,np.linalg.LinAlgError):continue
        errors=np.linalg.norm((scale*(rotation@a.T)).T+translation-b,axis=1);mask=errors<=threshold
        score=(int(mask.sum()),-float(errors[mask].sum()))
        if score>best_score:best_mask,best_score=mask,score
    if best_mask is None or best_mask.sum()<config['minSharedPoints']:return _failure('inconsistent_alignment','共享点不能得到一致的尺度和位置。请核对物体及对应点。',rejected)
    scale,rotation,translation=_umeyama(a[best_mask],b[best_mask])
    errors=np.linalg.norm((scale*(rotation@a.T)).T+translation-b,axis=1);best_mask=errors<=threshold
    inliers=[p for p,ok in zip(usable,best_mask) if ok]
    rejected.extend({'id':p['id'],'code':'alignment_outlier'} for p,ok in zip(usable,best_mask) if not ok)
    if len(inliers)<config['minSharedPoints']:return _failure('insufficient_shared_points','对齐后可靠共享点不足。',rejected)
    if not _noncollinear(a[best_mask],config) or not _noncollinear(b[best_mask],config):return _failure('collinear_points','对应点近似共线。请标记分布更广的点。',rejected)
    if not _image_spread(inliers,'a',config) or not _image_spread(inliers,'b',config):return _failure('clustered_points','对应点分布过小。请在共同物体的不同位置增加标记。',rejected)
    return {'accepted':True,'sim3':{'scale':scale,'rotation':rotation.tolist(),'translation':translation.tolist()},
            'sharedPointIds':[p['id'] for p in inliers],'supportSpan':span,'maxResidual':float(errors[best_mask].max()),'rejected':rejected,'missing':[]}


def sim3_matrix(sim3):
    matrix=np.eye(4);matrix[:3,:3]=sim3['scale']*np.asarray(sim3['rotation']);matrix[:3,3]=sim3['translation'];return matrix


def connect_regions(regions,edges,config):
    ids=[r['id'] for r in regions]
    if not ids:return _failure('no_regions','尚无可用区域，请先完成自动定位。')
    transforms={ids[0]:np.eye(4)}
    accepted=[e for e in edges if e.get('accepted') and e['first'] in ids and e['second'] in ids]
    for _ in ids:
        for edge in accepted:
            a,b=edge['first'],edge['second'];m=sim3_matrix(edge['sim3'])
            if a in transforms and b not in transforms:transforms[b]=transforms[a]@np.linalg.inv(m)
            elif b in transforms and a not in transforms:transforms[a]=transforms[b]@m
    missing=[{'code':'unconnected_region','regionId':r,'message':'该区域尚未连接。请选择与其他区域共同可见的物体。'} for r in ids if r not in transforms]
    for edge in accepted:
        a,b=edge['first'],edge['second']
        if a not in transforms or b not in transforms:continue
        delta=np.linalg.inv(transforms[a])@transforms[b]@sim3_matrix(edge['sim3'])
        span=max(edge.get('supportSpan',1),1e-9)
        if np.linalg.norm(delta[:3,:3]-np.eye(3))>config['maxAlignmentResidualFraction']*math.sqrt(3) or np.linalg.norm(delta[:3,3])/span>config['maxAlignmentResidualFraction']:
            missing.append({'code':'inconsistent_cycle','regions':[a,b],'message':'区域关系互相冲突。请核对这条连接的物体和对应点。'})
    return {'accepted':not missing,'transforms':{k:v.tolist() for k,v in transforms.items()},'rejected':[],'missing':missing}


def check_dimensions(dimensions,points,config):
    measurements=[];hints=[]
    for dimension in dimensions:
        ends=dimension.get('endpoints')
        if dimension['source']!='measured' or not ends or any(e['landmarkId'] not in points or not points[e['landmarkId']].get('accepted') for e in ends):
            hints.append(dimension['id']);continue
        a,b=[np.asarray(points[e['landmarkId']]['xyz']) for e in ends];distance=float(np.linalg.norm(a-b))
        if distance>1e-9:
            meters=dimension['value']*{'mm':0.001,'cm':0.01,'m':1}[dimension['unit']]
            measurements.append((dimension['id'],distance,meters))
    if not measurements:return {'accepted':True,'scale':'unmeasured','factor':None,'residuals':[],'hints':hints,'rejected':[],'missing':[]}
    factor=sum(d*m for _,d,m in measurements)/sum(d*d for _,d,_ in measurements)
    residuals=[{'id':i,'measuredMeters':m,'estimatedMeters':d*factor,'residualMeters':d*factor-m} for i,d,m in measurements]
    conflicts=[r for r in residuals if abs(r['residualMeters'])/r['measuredMeters']>config['maxAlignmentResidualFraction']]
    return {'accepted':not conflicts,'scale':'unmeasured' if conflicts else 'calibrated','factor':None if conflicts else factor,'residuals':residuals,'hints':hints,'rejected':[],
            'missing':[{'code':'conflicting_dimensions','message':'实测尺寸互相冲突，请核对端点、单位和数值。'}] if conflicts else []}
