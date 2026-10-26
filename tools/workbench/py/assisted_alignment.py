"""Joint image-space refinement for uncertain independently triangulated depth."""
import cv2
import numpy as np
from assisted_geometry import _umeyama,_failure,_noncollinear,_image_spread,validate_observed_point

def refine_pixel_alignment(shared,a_views,b_views,config):
    points=[p for p in shared if p['a'].get('accepted') and p['b'].get('accepted')]
    minimum=config['minSharedPoints']
    if len(points)<minimum:return _failure('insufficient_shared_points','可靠共同点不足，无法进行联合像素优化。')
    a=np.asarray([p['a']['xyz'] for p in points]);b=np.asarray([p['b']['xyz'] for p in points])
    prepared=[]
    for p in points:
        observations=[]
        for side,views in [('a',a_views),('b',b_views)]:
            for obs in p[side]['observations']:
                view=views[obs['photoId']];normal=view['camera'].cam_from_img(np.asarray(obs['xy'],float))
                observations.append((side,obs,view,np.asarray(normal)))
        prepared.append(observations)

    def unpack(theta):
        scale=float(np.exp(np.clip(theta[0],-15,15)));rotation=cv2.Rodrigues(theta[1:4])[0]
        return scale,rotation,theta[4:7]

    def project(theta,indices):
        scale,rotation,translation=unpack(theta);residuals=[];xyzs=[];lengths=[]
        for index in indices:
            equations=[];poses=[]
            for side,obs,view,normal in prepared[index]:
                pose=np.asarray(view['camFromWorld'],float)
                if side=='b':pose=np.column_stack([pose[:,:3]@rotation,(pose[:,:3]@translation+pose[:,3])/scale])
                poses.append(pose);equations.extend([normal[0]*pose[2]-pose[0],normal[1]*pose[2]-pose[1]])
            _,_,vt=np.linalg.svd(np.asarray(equations));h=vt[-1]
            xyz=h[:3]/h[3] if abs(h[3])>1e-12 else np.array([0.,0.,-1.]);xyzs.append(xyz)
            start=len(residuals)
            for (_,obs,view,_),pose in zip(prepared[index],poses):
                local=pose[:,:3]@xyz+pose[:,3]
                pixel=view['camera'].img_from_cam(local) if local[2]>1e-9 else None
                error=np.asarray(pixel)-obs['xy'] if pixel is not None and np.isfinite(pixel).all() else np.array([500.,500.])
                residuals.extend(np.clip(error,-500,500))
            lengths.append(len(residuals)-start)
        return np.asarray(residuals),xyzs,lengths

    def cost(residual):
        absolute=np.abs(residual);limit=config['maxReprojectionPx']
        return float(np.sum(np.where(absolute<=limit,.5*residual**2,limit*(absolute-.5*limit))))

    def optimize(theta,indices):
        theta=theta.copy();damping=1e-3
        for _ in range(config.get('alignmentPixelRefinementIterations',25)):
            residual,_,_=project(theta,indices);current=cost(residual)
            weights=1/np.sqrt(np.maximum(1,np.abs(residual)/config['maxReprojectionPx']))
            jacobian=[]
            for j in range(7):
                step=1e-5*(1+abs(theta[j]));shifted=theta.copy();shifted[j]+=step
                jacobian.append((project(shifted,indices)[0]-residual)/step)
            jacobian=np.asarray(jacobian).T*weights[:,None];weighted=residual*weights
            normal=jacobian.T@jacobian;diagonal=np.maximum(np.diag(normal),1e-8)
            try:update=-np.linalg.solve(normal+damping*np.diag(diagonal),jacobian.T@weighted)
            except np.linalg.LinAlgError:break
            candidate=theta+update
            if np.isfinite(candidate).all() and cost(project(candidate,indices)[0])<current:
                theta=candidate;damping=max(damping*.3,1e-8)
                if np.linalg.norm(update)<1e-7:break
            else:
                damping*=10
                if damping>1e8:break
        return theta

    proposals=[];rng=np.random.default_rng(config['seed'])
    for _ in range(512):
        sample=rng.choice(len(points),3,replace=False)
        try:scale,rotation,translation=_umeyama(a[sample],b[sample])
        except (ValueError,np.linalg.LinAlgError):continue
        errors=np.linalg.norm((scale*(rotation@a.T)).T+translation-b,axis=1)
        theta=np.r_[np.log(scale),cv2.Rodrigues(rotation)[0].ravel(),translation]
        proposals.append((float(np.sort(errors)[minimum-1]),theta,np.argsort(errors)[:minimum]))
    if not proposals:return _failure('inconsistent_alignment','共同点不足以初始化联合像素优化。')
    proposals.sort(key=lambda p:p[0]);proposals=proposals[:config.get('alignmentPixelHypotheses',12)]
    best=None
    for _,seed,indices in proposals:
        theta=optimize(seed,indices)
        for _ in range(2):
            residual,xyzs,lengths=project(theta,range(len(points)));offset=0;accepted=[]
            for i,length in enumerate(lengths):
                errors=np.linalg.norm(residual[offset:offset+length].reshape(-1,2),axis=1);offset+=length
                if np.max(errors)<=config['maxReprojectionPx']:accepted.append(i)
            if len(accepted)<minimum:break
            refined=optimize(theta,accepted)
            if cost(project(refined,accepted)[0])<=cost(project(theta,accepted)[0]):theta=refined
        _,xyzs,_=project(theta,range(len(points)));scale,rotation,translation=unpack(theta)
        inliers=[];joint={};max_error=0.
        for p,xyz in zip(points,xyzs):
            first=validate_observed_point(xyz,p['a']['observations'],a_views,config)
            second=validate_observed_point(scale*rotation@xyz+translation,p['b']['observations'],b_views,config)
            if not first.get('accepted') or not second.get('accepted'):continue
            inliers.append({'id':p['id'],'a':first,'b':second});joint[p['id']]={'a':first,'b':second}
            max_error=max(max_error,first['maxReprojectionPx'],second['maxReprojectionPx'])
        if len(inliers)<minimum:continue
        if not _noncollinear(np.asarray([p['a']['xyz'] for p in inliers]),config) or not _noncollinear(np.asarray([p['b']['xyz'] for p in inliers]),config):continue
        if not _image_spread(inliers,'a',config) or not _image_spread(inliers,'b',config):continue
        score=(len(inliers),-max_error)
        if best is None or score>best[0]:best=(score,theta,inliers,joint,max_error)
    if best is None:return _failure('inconsistent_joint_pixels','联合优化后仍没有足够共同点满足两侧像素、深度和视差检查。')
    _,theta,inliers,joint,max_error=best;scale,rotation,translation=unpack(theta)
    errors=np.linalg.norm((scale*(rotation@a.T)).T+translation-b,axis=1)
    return {'accepted':True,'criterion':'joint_reprojection','sim3':{'scale':scale,'rotation':rotation.tolist(),'translation':translation.tolist()},
            'sharedPointIds':[p['id'] for p in inliers],'jointTriangulated':joint,'maxJointReprojectionPx':max_error,'maxResidual':float(max(errors)),
            'rejected':[{'id':p['id'],'code':'joint_reprojection_or_parallax'} for p in points if p['id'] not in joint],'missing':[]}
