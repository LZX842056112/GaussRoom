"""Find measured features; homographies and predictions only guide their search."""
from copy import deepcopy
from itertools import combinations
import cv2
import numpy as np


def detect_features(path, config):
    image=cv2.imdecode(np.fromfile(str(path),dtype=np.uint8),cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError(f'无法读取工作照片：{path}')
    detector=cv2.SIFT_create(nfeatures=int(config.get('maxSiftFeatures',16384)))
    keypoints,descriptors=detector.detectAndCompute(image,None)
    return {'xy':np.asarray([p.pt for p in keypoints],dtype=np.float64).reshape(-1,2),
            'descriptors':descriptors if descriptors is not None else np.empty((0,128),np.float32)}


def _inside(points, polygon):
    polygon=np.asarray(polygon,np.float32)
    return np.asarray([cv2.pointPolygonTest(polygon,tuple(map(float,xy)),False)>=0 for xy in points])


def _mutual_matches(a,b,ratio=0.8):
    if len(a)<2 or len(b)<2:return []
    matcher=cv2.BFMatcher(cv2.NORM_L2)
    forward=matcher.knnMatch(a,b,k=2); backward=matcher.knnMatch(b,a,k=2)
    reverse={pair[0].queryIdx:pair[0].trainIdx for pair in backward if len(pair)==2 and pair[0].distance<ratio*pair[1].distance}
    return [(pair[0].queryIdx,pair[0].trainIdx) for pair in forward
            if len(pair)==2 and pair[0].distance<ratio*pair[1].distance
            and reverse.get(pair[0].trainIdx)==pair[0].queryIdx]


def _planar_transform(first,second):
    a,b=np.asarray(first,np.float32),np.asarray(second,np.float32)
    if a.shape!=(4,2) or b.shape!=(4,2) or not cv2.isContourConvex(a) or not cv2.isContourConvex(b):
        raise ValueError('平面四角需要沿边界按相同方向排列，不能交叉或共线')
    h=cv2.getPerspectiveTransform(a,b)
    if not np.isfinite(h).all() or abs(np.linalg.det(h))<1e-12:
        raise ValueError('平面四角退化，无法引导搜索')
    return h


def rejected_pairs(constraints):
    denied={a['questionId'] for a in constraints.get('answers',[]) if a['value']=='no'}
    pairs=set()
    for question in constraints.get('questions',[]):
        if question['id'] in denied:
            pairs.update(frozenset(ids) for ids in combinations(question.get('photoIds',[]),2))
    return pairs


def conflicts_with_rejections(photo_ids,denied):
    return any(frozenset(ids) in denied for ids in combinations(set(photo_ids),2))


def collect_observations(catalog,models,constraints,config):
    cv2.setRNGSeed(int(config.get('seed',42)))
    by_id={photo['photoId']:photo for photo in catalog}
    cache={}
    def features(photo_id):
        if photo_id not in cache:cache[photo_id]=detect_features(by_id[photo_id]['path'],config)
        return cache[photo_id]
    result={'landmarks':[],'rejected':[],'missing':[]}
    denied=rejected_pairs(constraints)
    for point in deepcopy(constraints.get('landmarks',[])):
        if conflicts_with_rejections([o['photoId'] for o in point['observations']],denied):
            result['missing'].append({'code':'conflicting_observations','landmarkId':point['id'],'message':'对应点包含已否定的共同内容。请核对回答或修改这个点的观察。'})
        else:result['landmarks'].append(point)
    occupied={(o['photoId'],tuple(np.asarray(o['xy'],dtype=np.float32)))
              for point in result['landmarks'] for o in point['observations']}
    for obj in constraints.get('objects',[]):
        rois={r['photoId']:r['polygon'] for r in obj.get('rois',[])}
        corners={r['photoId']:r['xy'] for r in obj.get('corners',[])}
        polygons={**rois,**corners}
        selected={}
        for photo_id,polygon in polygons.items():
            if photo_id not in by_id:raise ValueError('共同物体引用不存在的照片')
            feature=features(photo_id)
            indices=np.flatnonzero(_inside(feature['xy'],polygon))
            selected[photo_id]=indices
        parent={}
        def find(key):
            parent.setdefault(key,key)
            if parent[key]!=key:parent[key]=find(parent[key])
            return parent[key]
        for a,b in combinations(selected,2):
            if frozenset((a,b)) in denied:
                result['rejected'].append({'code':'user_rejected','photoIds':[a,b],'objectId':obj['id']});continue
            fa,fb=features(a),features(b);ia,ib=selected[a],selected[b]
            pairs=[(int(ia[i]),int(ib[j])) for i,j in _mutual_matches(fa['descriptors'][ia],fb['descriptors'][ib])]
            if not pairs:continue
            points_a=np.asarray([fa['xy'][i] for i,j in pairs]);points_b=np.asarray([fb['xy'][j] for i,j in pairs])
            if obj['kind']=='planar' and a in corners and b in corners:
                h=_planar_transform(corners[a],corners[b])
                predicted=cv2.perspectiveTransform(points_a.reshape(-1,1,2),h).reshape(-1,2)
                keep=np.linalg.norm(predicted-points_b,axis=1)<=max(4,0.02*np.hypot(by_id[b]['width'],by_id[b]['height']))
            elif len(pairs)>=8:
                try:
                    _,mask=cv2.findFundamentalMat(points_a,points_b,cv2.USAC_MAGSAC,float(config['maxReprojectionPx']),0.999)
                except cv2.error:
                    # Native USAC can throw for degenerate candidate geometry.
                    # This pair supplies no evidence; retain the user's inputs
                    # and continue checking the other photo pairs.
                    result['rejected'].append({'code':'degenerate_feature_pair','photoIds':[a,b],'objectId':obj['id']})
                    continue
                keep=mask.ravel().astype(bool) if mask is not None and len(mask)==len(pairs) else np.zeros(len(pairs),bool)
            else:keep=np.zeros(len(pairs),bool)
            for (i,j),accepted in zip(pairs,keep):
                if accepted:
                    ra,rb=find((a,i)),find((b,j));parent[rb]=ra
        groups={}
        for key in parent:groups.setdefault(find(key),[]).append(key)
        for group in groups.values():
            if len(group)<2:continue
            if conflicts_with_rejections([p for p,index in group],denied):
                result['rejected'].append({'code':'user_rejected_track','objectId':obj['id']});continue
            if len({p for p,index in group})!=len(group):
                result['rejected'].append({'code':'ambiguous_track','objectId':obj['id']});continue
            observations=[{'photoId':p,'xy':features(p)['xy'][index].tolist(),'origin':'detected','featureIndex':index}
                          for p,index in sorted(group)]
            pixels={(o['photoId'],tuple(np.asarray(o['xy'],dtype=np.float32))) for o in observations}
            if pixels & occupied:
                result['rejected'].append({'code':'duplicate_feature_pixel','objectId':obj['id']})
                continue
            result['landmarks'].append({'id':f"detected-{obj['id']}-{len(result['landmarks'])}",'objectId':obj['id'],'observations':observations})
            occupied.update(pixels)
    if not result['landmarks']:
        result['missing'].append({'code':'no_real_features','message':'没有取得真实对应点。请选择其他共同内容，或标记多张照片中的同一位置。'})
    return result


def extend_observations(landmark,region,context):
    """Match descriptors into other views; never save a predicted pixel as evidence."""
    result=deepcopy(landmark)
    catalog=context['catalog'];features=context['features']
    present={o['photoId'] for o in result['observations']}
    anchors=[o for o in result['observations'] if o['photoId'] in region['photoIds']]
    if not anchors or len(anchors)>=context['config']['minViewsPerSide']:return result
    for photo_id in region['photoIds']:
        if photo_id in present:continue
        if conflicts_with_rejections([*present,photo_id],context.get('deniedPairs',set())):continue
        target=features(photo_id)
        for anchor in anchors:
            source=features(anchor['photoId'])
            if not len(source['xy']) or len(target['xy'])<2:continue
            index=int(np.argmin(np.linalg.norm(source['xy']-anchor['xy'],axis=1)))
            if np.linalg.norm(source['xy'][index]-anchor['xy'])>4:continue
            matcher=cv2.BFMatcher(cv2.NORM_L2)
            candidates=matcher.knnMatch(source['descriptors'][index:index+1],target['descriptors'],k=2)[0]
            if len(candidates)<2 or candidates[0].distance>=0.8*candidates[1].distance:continue
            match_index=candidates[0].trainIdx
            reverse=matcher.match(target['descriptors'][match_index:match_index+1],source['descriptors'])
            if not reverse or reverse[0].trainIdx!=index:continue
            xy=target['xy'][match_index].tolist()
            if context.get('epipolar_error') and context['epipolar_error'](anchor,photo_id,xy)>context['config']['maxReprojectionPx']:continue
            result['observations'].append({'photoId':photo_id,'xy':xy,'origin':'detected','featureIndex':match_index})
            present.add(photo_id)
            if len(present.intersection(region['photoIds']))>=context['config']['minViewsPerSide']:return result
            break
    return result
