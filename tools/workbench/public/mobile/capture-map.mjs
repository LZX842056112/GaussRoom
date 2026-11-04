import * as THREE from '../vendor/three/build/three.module.js';

const finiteVector=(value,n)=>Array.isArray(value)&&value.length===n&&value.every(Number.isFinite);
export function mapSnapshot(data){
 const cameras=[];
 for(const item of data.cameras||[]){
  const matrix=item.cameraToWorld||item.cameraToWorld16,intrinsics=item.intrinsics||item.intrinsics4;
  if(!finiteVector(matrix,16)||!finiteVector(intrinsics,4)||!item.fileId||!(item.width>0&&item.height>0&&intrinsics[0]>0&&intrinsics[1]>0))continue;
  const transform=(x,y,z)=>[matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12],matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13],matrix[2]*x+matrix[6]*y+matrix[10]*z+matrix[14]];
  const [fx,fy,cx,cy]=intrinsics;
  cameras.push({fileId:item.fileId,origin:transform(0,0,0),corners:[[0,0],[item.width,0],[item.width,item.height],[0,item.height]].map(([u,v])=>transform((u-cx)/fx,-(v-cy)/fy,-1))});
 }
 const points=[];for(const item of data.points||[]){if(finiteVector(item.position,3)&&finiteVector(item.color,3))points.push(item);if(points.length===10000)break;}
 return {revision:data.revision,cameras,points,unlocalized:[...(data.unlocalized||[])]};
}

// A camera outline is only a few pixels wide. Use a touch-sized screen target too.
export function cameraMarkerAt(cameras,camera,point,viewport){
 let selected=null,best=20*20;
 for(const item of cameras){const screen=new THREE.Vector3(...item.origin).project(camera);if(screen.z<-1||screen.z>1)continue;
  const distance=((screen.x-point.x)*viewport.width/2)**2+((screen.y-point.y)*viewport.height/2)**2;
  if(distance<=best){best=distance;selected=item.fileId;}
 }return selected;
}

export function createCaptureMap(container,onSelect){
 const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.setClearColor(0xeef3fa);container.replaceChildren(renderer.domElement);
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,1,.001,10000),target=new THREE.Vector3();let group=new THREE.Group(),radius=6,yaw=.7,pitch=.6,distance=8,drag=null,lastDrag=0,markers=[];
 scene.add(group);const raycaster=new THREE.Raycaster();raycaster.params.Points.threshold=.1;raycaster.params.Line.threshold=.1;
 function draw(){const width=container.clientWidth,height=container.clientHeight;if(!width||!height)return;renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();camera.position.set(target.x+distance*Math.cos(pitch)*Math.sin(yaw),target.y+distance*Math.sin(pitch),target.z+distance*Math.cos(pitch)*Math.cos(yaw));camera.lookAt(target);renderer.render(scene,camera);}
 function dispose(value){value.traverse(object=>{object.geometry?.dispose();if(Array.isArray(object.material))object.material.forEach(m=>m.dispose());else object.material?.dispose();});}
 function fit(){const box=new THREE.Box3().setFromObject(group);if(box.isEmpty()){target.set(0,0,0);radius=6;}else{box.getCenter(target);radius=Math.max(.01,box.getSize(new THREE.Vector3()).length());}distance=radius*1.35;camera.near=Math.max(.00001,radius/10000);camera.far=Math.max(100,radius*100);raycaster.params.Line.threshold=radius*.008;draw();}
 const resize=new ResizeObserver(draw);resize.observe(container);
 renderer.domElement.addEventListener('pointerdown',event=>{drag={x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY};renderer.domElement.setPointerCapture(event.pointerId);});
 renderer.domElement.addEventListener('pointermove',event=>{if(!drag)return;yaw-=(event.clientX-drag.x)*.008;pitch=Math.max(-1.45,Math.min(1.45,pitch+(event.clientY-drag.y)*.008));drag.x=event.clientX;drag.y=event.clientY;draw();});
 renderer.domElement.addEventListener('pointerup',event=>{if(!drag)return;lastDrag=Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY);drag=null;if(lastDrag>8)return;const rect=renderer.domElement.getBoundingClientRect(),point=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);raycaster.setFromCamera(point,camera);const id=cameraMarkerAt(markers,camera,point,rect),hit=id?null:raycaster.intersectObjects(group.children,false).find(item=>item.object.userData.fileId);if(id||hit)onSelect(id||hit.object.userData.fileId);});
 renderer.domElement.addEventListener('pointercancel',()=>{drag=null;});
 renderer.domElement.addEventListener('wheel',event=>{event.preventDefault();distance=Math.max(radius*.02,Math.min(radius*30,distance*Math.exp(event.deltaY*.001)));draw();},{passive:false});
 function replace(data){
  const snapshot=mapSnapshot(data),next=new THREE.Group();markers=snapshot.cameras;
  const positions=[],colors=[];for(const point of snapshot.points){positions.push(...point.position);colors.push(...point.color.map(c=>Math.max(0,Math.min(1,c/255))));}
  if(positions.length){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));next.add(new THREE.Points(geometry,new THREE.PointsMaterial({size:2,sizeAttenuation:false,vertexColors:true})));}
  // Camera frustums use the published camera-to-world matrix. No marker is made for unlocalized photos.
  const origins=new THREE.Box3();for(const item of snapshot.cameras)origins.expandByPoint(new THREE.Vector3(...item.origin));const frustumScale=Math.max(.02,origins.isEmpty()?1:origins.getSize(new THREE.Vector3()).length()*.05);
  for(const item of snapshot.cameras){const origin=new THREE.Vector3(...item.origin),corners=item.corners.map(v=>new THREE.Vector3(...v).sub(origin).multiplyScalar(frustumScale).add(origin)),vertices=[];for(let i=0;i<4;i++){vertices.push(...origin.toArray(),...corners[i].toArray(),...corners[i].toArray(),...corners[(i+1)%4].toArray());}const line=new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(vertices,3)),new THREE.LineBasicMaterial({color:0x2467e8}));line.userData.fileId=item.fileId;next.add(line);}
  const old=group;scene.add(next);scene.remove(old);group=next;dispose(old);fit();
 }
 function clear(){const old=group;markers=[];group=new THREE.Group();scene.remove(old);scene.add(group);dispose(old);fit();}
 return {replace,fit,clear};
}
