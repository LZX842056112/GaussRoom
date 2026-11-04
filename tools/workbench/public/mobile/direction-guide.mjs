// Direction sampling is local to one manually selected station, not surface coverage.
const rad=Math.PI/180,deg=180/Math.PI;
const wrap=value=>((value+180)%360+360)%360-180;
const dot=(a,b)=>a.reduce((sum,value,i)=>sum+value*b[i],0);
const ray=(yaw,pitch)=>[Math.sin(yaw*rad)*Math.cos(pitch*rad),Math.cos(yaw*rad)*Math.cos(pitch*rad),Math.sin(pitch*rad)];
export const DIRECTION_TARGETS=Object.freeze([0,35,-35].flatMap((pitch,row)=>Array.from({length:24},(_,sector)=>Object.freeze({id:`${row}:${sector}`,row,sector,yaw:sector*15,pitch}))));

export function orientationPose({alpha,beta,gamma,screenAngle=0}){
 if(![alpha,beta,gamma,screenAngle].every(value=>typeof value==='number'&&Number.isFinite(value)))return null;
 const a=alpha*rad,b=beta*rad,g=gamma*rad,s=screenAngle*rad,ca=Math.cos(a),sa=Math.sin(a),cb=Math.cos(b),sb=Math.sin(b),cg=Math.cos(g),sg=Math.sin(g);
 // W3C Z-X-Y device rotation. Rear camera looks along device -Z.
 const x=[ca*cg-sa*sb*sg,sa*cg+ca*sb*sg,-cb*sg],y=[-sa*cb,ca*cb,sb];
 const forward=[-ca*sg-sa*sb*cg,-sa*sg+ca*sb*cg,-cb*cg];
 const right=x.map((value,i)=>value*Math.cos(s)-y[i]*Math.sin(s)),up=x.map((value,i)=>value*Math.sin(s)+y[i]*Math.cos(s));
 return {right,up,forward,yaw:wrap(Math.atan2(forward[0],forward[1])*deg),pitch:Math.asin(Math.max(-1,Math.min(1,forward[2])))*deg};
}

export function projectDirection(yaw,pitch,pose,width,height){
 if(!pose||!(width>0&&height>0))return null;
 const target=ray(yaw,pitch),z=dot(target,pose.forward);if(z<=0)return null;
 // Camera intrinsics are unavailable in the web preview; this is a direction diagram.
 const longest=Math.tan(65*rad/2),aspect=width/height,tx=aspect>=1?longest:longest*aspect,ty=aspect>=1?longest/aspect:longest;
 const x=dot(target,pose.right)/z/tx,y=-dot(target,pose.up)/z/ty;
 return Math.abs(x)<=.96&&Math.abs(y)<=.96?{x:(x+1)/2,y:(y+1)/2}:null;
}

export function containedVideoRect(width,height,videoWidth,videoHeight){
 if(![width,height,videoWidth,videoHeight].every(value=>Number.isFinite(value)&&value>0))return {left:0,top:0,width:0,height:0};
 const scale=Math.min(width/videoWidth,height/videoHeight),w=videoWidth*scale,h=videoHeight*scale;
 return {left:(width-w)/2,top:(height-h)/2,width:w,height:h};
}

export class DirectionGuide {
 constructor({clock=Date.now}={}){this.clock=clock;this.epoch=0;this.records=new Map();this.newStation();}
 newStation(){this.epoch++;this.origin=null;this.pose=null;this.speed=0;this.records.clear();}
 suspend(){this.newStation();}
 update(sample){
  const pose=orientationPose(sample),now=this.clock();if(!pose){this.pose=null;return;}
  const previous=this.pose,dt=previous?now-previous.at:0;
  const angle=previous?Math.acos(Math.max(-1,Math.min(1,dot(pose.forward,previous.forward))))*deg:0;
  this.speed=previous?(dt>0?angle/(dt/1000):angle>.1?Infinity:0):0;
  this.pose={...pose,at:now};if(this.origin===null&&Math.abs(pose.pitch)<=60)this.origin=pose.yaw;
 }
 reason(){if(this.origin===null||!this.pose)return 'waiting';if(this.clock()-this.pose.at>800||this.clock()<this.pose.at)return 'stale';if(this.speed>45)return 'fast';if(Math.abs(this.pose.pitch)>75)return 'vertical';return null;}
 snapshot(){
  if(this.reason())return null;
  const yaw=wrap(this.pose.yaw-this.origin),sector=((Math.round(yaw/15)%24)+24)%24;
  const target=DIRECTION_TARGETS.filter(item=>item.sector===sector).sort((a,b)=>Math.abs(a.pitch-this.pose.pitch)-Math.abs(b.pitch-this.pose.pitch))[0];
  if(Math.abs(wrap(yaw-target.yaw))>8||Math.abs(this.pose.pitch-target.pitch)>10)return null;
  return {epoch:this.epoch,cell:target.id};
 }
 saved(snapshot,captureId){if(!snapshot||snapshot.epoch!==this.epoch||!DIRECTION_TARGETS.some(item=>item.id===snapshot.cell)||typeof captureId!=='string')return false;this.records.set(captureId,snapshot.cell);return true;}
 reconcile(ids){for(const id of this.records.keys())if(!ids.has(id))this.records.delete(id);}
 view(mode='auto'){
  const done=new Set(this.records.values()),reason=this.reason(),summary={ready:!reason,reason,recorded:done.size,total:72,done,pose:this.pose,origin:this.origin,target:null};
  if(reason)return summary;
  const requested={wall:0,upper:1,lower:2,doorway:0}[mode];
  const row=requested??[0,1,2].find(index=>DIRECTION_TARGETS.some(item=>item.row===index&&!done.has(item.id)));
  const targets=DIRECTION_TARGETS.filter(item=>item.row===row&&!done.has(item.id));
  targets.sort((a,b)=>dot(ray(b.yaw+this.origin,b.pitch),this.pose.forward)-dot(ray(a.yaw+this.origin,a.pitch),this.pose.forward));
  summary.target=targets[0]??null;return summary;
 }
}
