import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createWorkbenchServer} from './server.mjs';
import {TRAINING_PRESETS,FEATURE_PRESETS,GATE} from './lib/pipeline.mjs';
const require=createRequire(import.meta.url),cache=resolve(process.env.LOCALAPPDATA,'npm-cache/_npx');
const {chromium}=require(readdirSync(cache).map(n=>resolve(cache,n,'node_modules/playwright')).find(existsSync));
const browsers=resolve(process.env.LOCALAPPDATA,'ms-playwright'),version=readdirSync(browsers).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]))[0];
const server=createWorkbenchServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:resolve(browsers,version,'chrome-win64/chrome.exe')});
try{
 const page=await browser.newPage();let runCalls=0,reuseCalls=0,reviewCalls=0;
 const project={id:'assist-ui',name:'测试辅助',state:'needs_input',sourceDir:'fixture',progress:.6,mapper:'global',cameraModel:'SIMPLE_RADIAL',trainingPreset:'full',scene:null,activeAttemptId:null,
  steps:['prepare','features','match','sparse','gate','undistort','train'].map((id,i)=>({id,name:id,status:i<4?'success':i===4?'needs_input':'blocked',progress:i<4?1:0}))};
 const otherProject={...project,id:'other-ui',name:'链接目标'};let projectList=[project];
 const photos=Array.from({length:5},(_,i)=>({photoId:`p${i}`,name:`image-${i}.png`,width:100,height:80}));
 let record={version:1,revision:0,state:'needs_input',photos,regions:[{id:'0:0',photoIds:['p0','p1']},{id:'0:1',photoIds:['p2','p3','p4']}],reasons:[{code:'disconnected_regions',message:'发现两个未连接区域'}],
  questions:[{id:'q1',type:'same_object',text:'这两张照片是否包含同一固定物体？',reason:'需要跨区域共同内容',photoIds:['p0','p2'],options:['yes','no','unknown'],allowManualSelection:true},
  {id:'door',type:'door_relation',text:'照片拍摄的是门的哪一侧？',reason:'门两侧不能混用',photoIds:['p0'],options:['near_door','beyond_door','inside','outside','unknown']}],
  answers:[],regionLabels:[],objects:[],landmarks:[],dimensions:[],coverage:[],onlyExistingPhotos:false,missing:[{message:'需要共同点'}]};
 await page.addInitScript(()=>{window.EventSource=class{addEventListener(){}close(){}};});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method();let json;
  if(path==='/api/presets')json={trainingPresets:TRAINING_PRESETS,featurePresets:FEATURE_PRESETS,gate:GATE};
  else if(path==='/api/health')json={tools:{}};
  else if(path==='/api/projects')json=projectList;
  else if(path==='/api/projects/other-ui')json=otherProject;
  else if(path.endsWith('/summary'))json={gate:{selectedModel:'0',models:[{name:'0',geometrySignature:'sig',registered:5,registration_ratio:1,points:5000}]},assistance:record,quality:{geometry:'failed',coverage:'reviewed',appearance:'unreviewed',scale:'unmeasured'},attempts:[]};
  else if(path.endsWith('/assistance')&&method==='PUT'){const body=route.request().postDataJSON();assert.equal(body.expectedRevision,record.revision);record={...record,...body.patch,revision:record.revision+1};json={record};}
  else if(path.endsWith('/assistance/run')){runCalls++;json={project,attemptId:null};}
  else if(path.endsWith('/assistance/reuse')){if(method==='GET')json={photos:[],answers:[{id:'fact-1',kind:'answer',description:'已确认共同物体'}],conflicts:[]};else{reuseCalls++;record.revision++;json={record};}}
  else if(path.endsWith('/assistance/review')){reviewCalls++;const body=route.request().postDataJSON();assert.equal(body.expectedRevision,record.revision);assert.equal(body.review.appearance,'needs_improvement');record.revision++;json={record,quality:{geometry:'verified',coverage:'reviewed',appearance:'needs_improvement',scale:'unmeasured',complete:false}};}
  else if(path.endsWith('/evaluation'))json={photos:[{photoId:'p0',name:'image-0.png'}],steps:[1000,30000],available:[{step:1000,names:['image-0.png']},{step:30000,names:['image-0.png']}]};
  else if(path.endsWith('/evaluation/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"/>'});
  else if(path==='/api/dialog/folder')return route.fulfill({status:204,body:''});
  else if(path.endsWith('/assistance'))json={record,catalog:photos,attempts:[]};
  else if(path.endsWith('/log'))return route.fulfill({body:''});
  else if(path.endsWith('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="gray"/></svg>'});
  else json=project;
  await route.fulfill({json});
 });
 await page.goto(base);const panel=page.locator('#assistancePanel');
 await panel.getByText('等待用户补充',{exact:true}).waitFor();
 await panel.getByRole('button',{name:'不知道',exact:true}).first().click();
 await panel.getByRole('button',{name:'保存回答',exact:true}).click();
 await panel.getByText(/已保存/).waitFor();assert.equal(runCalls,0);assert.equal(record.answers[0].value,'unknown');
 await page.reload();await panel.locator('[data-value="unknown"][aria-pressed="true"]').first().waitFor();
 await panel.getByLabel('手动选择照片').selectOption('p4');
 await panel.getByRole('button',{name:'加入标记照片',exact:true}).click();
 assert.ok(await panel.locator('[data-selected-photo="p4"]').count());
 await panel.locator('[data-repair-role="p4"]').selectOption('repair');
 for(const id of ['p0','p1']){await panel.getByLabel('手动选择照片').selectOption(id);await panel.getByRole('button',{name:'加入标记照片',exact:true}).click();await panel.locator(`[data-repair-role="${id}"]`).selectOption('reference');}
 await panel.locator('[data-local-scope]').getByText('修正照片：1 张；固定参照：2 张',{exact:true}).waitFor();
 await panel.getByRole('button',{name:'保存回答',exact:true}).click();await panel.getByText(/已保存/).waitFor();
 assert.deepEqual(record.localRepair.photoIds,['p4']);assert.deepEqual(record.localRepair.referencePhotoIds,['p0','p1']);
 await page.reload();await panel.locator('[data-local-scope]').getByText('修正照片：1 张；固定参照：2 张',{exact:true}).waitFor();
 await panel.getByLabel('手动选择照片').selectOption('p4');await panel.getByRole('button',{name:'加入标记照片',exact:true}).click();
 assert.equal(await panel.locator('[data-repair-role="p4"]').inputValue(),'repair');
 await panel.locator('[data-remove-photo="p4"]').click();
 assert.ok(await panel.locator('[data-local-scope]').getByText('修正照片：1 张；固定参照：2 张',{exact:true}).count(),'removing an annotation view must preserve the repair scope');
 await panel.getByLabel('手动选择照片').selectOption('p4');await panel.getByRole('button',{name:'加入标记照片',exact:true}).click();
 await panel.locator('[data-repair-role="p4"]').selectOption('none');
 await panel.getByRole('button',{name:'取消局部修正',exact:true}).click();
 await panel.getByRole('button',{name:'保存回答',exact:true}).click();await panel.getByText(/已保存/).waitFor();assert.equal(record.localRepair,null);
 assert.ok(await panel.getByText('近处的门',{exact:true}).count());assert.ok(await panel.getByText('门外的门',{exact:true}).count());
 assert.equal(await page.locator('#stepList > li').count(),7);
 assert.equal(await panel.getByRole('button',{name:'继续求解',exact:true}).isDisabled(),true);
 await panel.getByText('增加照片或复用资料',{exact:true}).click();
 await panel.getByLabel('来源项目 ID').fill('other-project');await panel.getByRole('button',{name:'预览可复用资料',exact:true}).click();
 await panel.getByText('已确认共同物体',{exact:true}).waitFor();assert.equal(reuseCalls,0);
 await panel.getByLabel('已确认共同物体').check();await panel.getByRole('button',{name:'复用所选资料',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-save-state]')?.textContent.includes('已复用'));assert.equal(reuseCalls,1);
 const revisionBeforeCancel=record.revision;await panel.getByText('增加照片或复用资料',{exact:true}).click();await panel.getByRole('button',{name:'选择并导入照片',exact:true}).click();assert.equal(record.revision,revisionBeforeCancel);
 // Work pixels stay stable when the canvas is resized or zoomed.
 const editor=panel.locator('[data-annotation]');
 await editor.getByRole('button',{name:'新建对应点',exact:true}).click();
 await editor.locator('[data-annotation-surface]').waitFor();
 const surface=editor.locator('[data-annotation-surface]');let box=await surface.boundingBox();
 await surface.click({position:{x:box.width/2,y:box.height/2}});
  assert.ok((await editor.locator('[data-point] option:checked').textContent()).includes('1 张'));
 await panel.getByRole('button',{name:'保存回答',exact:true}).click();await panel.getByText(/已保存/).waitFor();
 assert.ok(Math.abs(record.landmarks[0].observations[0].xy[0]-50)<1);
 assert.ok(Math.abs(record.landmarks[0].observations[0].xy[1]-40)<1);
 await editor.getByLabel('编辑模式').selectOption('move');
 await editor.locator('[data-annotation-surface][data-ready="true"]').waitFor();
 const marker=editor.locator('[data-marker]').first();await marker.scrollIntoViewIfNeeded();const mb=await marker.boundingBox();
 await page.mouse.move(mb.x+mb.width/2,mb.y+mb.height/2);await page.mouse.down();await page.mouse.move(mb.x+mb.width/2+20,mb.y+mb.height/2+10);await page.mouse.up();
 await page.setViewportSize({width:850,height:900});
 await panel.getByRole('button',{name:'保存回答',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-save-state]')?.textContent.includes('已保存'));
 assert.ok(record.landmarks[0].observations[0].xy[0]>50);
 const saved=structuredClone(record.landmarks[0].observations[0].xy);
 await editor.getByLabel('缩放').fill('1.5');await editor.getByLabel('缩放').dispatchEvent('input');
 await panel.getByRole('button',{name:'保存回答',exact:true}).click();await panel.getByText(/已保存/).waitFor();assert.deepEqual(record.landmarks[0].observations[0].xy,saved);
 await editor.getByText('可选尺寸',{exact:true}).click();
 await editor.getByLabel('尺寸来源').selectOption('measured');await editor.getByLabel('尺寸值').fill('100');await editor.getByRole('button',{name:'添加尺寸',exact:true}).click();
 await editor.getByText('请输入正数，并选择两个不同的对应点作为尺寸端点。',{exact:true}).waitFor();
 await editor.getByLabel('尺寸来源').selectOption('unknown');await editor.getByRole('button',{name:'添加尺寸',exact:true}).click();
 await panel.getByRole('button',{name:'保存回答',exact:true}).click();await panel.getByText(/已保存/).waitFor();assert.equal(record.dimensions[0].source,'unknown');
 await page.screenshot({path:resolve('.superpowers/sdd/2026-10-20-assisted-reconstruction/annotation-ui.png'),fullPage:true});
 const savedPointCount=record.landmarks.length;
 await editor.getByRole('button',{name:'新建对应点',exact:true}).click();await surface.waitFor();box=await surface.boundingBox();await surface.click({position:{x:box.width*.6,y:box.height*.5}});
 await panel.getByText('画面检查',{exact:true}).click();await panel.getByLabel('墙面重影').selectOption('needs_improvement');
 await panel.getByRole('button',{name:'保存画面检查',exact:true}).click();await panel.getByText(/画面检查已保存/).waitFor();assert.equal(reviewCalls,1);
 await panel.getByRole('button',{name:'保存回答',exact:true}).click();await panel.locator('[data-save-state]').getByText(/已保存/).waitFor();assert.equal(record.landmarks.length,savedPointCount+1,'saving an appearance review must preserve unsaved measured points');
 const measuredBeforeScope=structuredClone(record.landmarks);
 await panel.locator('[data-repair-role="p4"]').selectOption('repair');
 await panel.getByRole('button',{name:'保存回答',exact:true}).click();await panel.locator('[data-save-state]').getByText(/已保存/).waitFor();
 assert.deepEqual(record.landmarks,measuredBeforeScope,'scope changes must preserve existing measured pixels');
 await panel.getByText('高级几何选项',{exact:true}).click();
 await panel.locator('[data-refine-corner]').first().check();
 await panel.getByRole('button',{name:'保存回答',exact:true}).click();await panel.locator('[data-save-state]').getByText(/已保存/).waitFor();
 assert.equal(record.localRepair.refineCornerIds[0],record.landmarks[0].id);assert.deepEqual(record.landmarks,measuredBeforeScope);
 await panel.getByRole('button',{name:'载入固定评估对比',exact:true}).click();
 await panel.locator('[data-eval-image]').first().waitFor();assert.equal(await panel.locator('[data-eval-image]').count(),2);
 for(const deviceScaleFactor of [1,2]){
  const context=await browser.newContext({deviceScaleFactor,viewport:{width:deviceScaleFactor===1?620:1280,height:900}}),view=await context.newPage();
  await view.route('**/annotation-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body></body></html>'}));await view.goto(base+'/annotation-fixture');
  await view.evaluate(async()=>{
   document.body.replaceChildren();const style=document.createElement('style');style.textContent='body{display:block;padding:12px}';document.head.append(style);
   const root=document.createElement('div');document.body.append(root);
   const {mountAnnotation}=await import('/annotation.js');
   const src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="gray"/></svg>');
   window.__annotationChanges=0;window.__editorRoot=root;window.__editor=mountAnnotation(root,{photos:[{photoId:'portrait',name:'竖图',width:300,height:600,src}],landmarks:[{id:'landmark',objectId:null,observations:[]}],onChange:data=>{window.__annotations=data;window.__annotationChanges++;}});
  });
  const surface=view.locator('[data-annotation-surface][data-ready="true"]');await surface.waitFor();const box=await surface.boundingBox();await surface.click({position:{x:box.width/2,y:box.height/2}});
  assert.equal(await view.locator('[data-mode]').count(),1,'the mode picker must remain distinct from canvas cursor state');
  const xy=await view.evaluate(()=>window.__annotations.landmarks[0].observations[0].xy);assert.ok(Math.abs(xy[0]-150)<1&&Math.abs(xy[1]-300)<1);
  await view.evaluate(()=>{window.__editorRoot.hidden=true;});await view.evaluate(()=>{window.__editorRoot.hidden=false;});
  await view.getByLabel('缩放').fill('1.5');await view.getByLabel('缩放').dispatchEvent('input');
  assert.deepEqual(await view.evaluate(()=>window.__annotations.landmarks[0].observations[0].xy),xy);
  // A correction must allow moving the photo without moving any measured point.
  await view.getByLabel('编辑模式').selectOption('move');await surface.scrollIntoViewIfNeeded();
  const changesBeforePan=await view.evaluate(()=>window.__annotationChanges);
  const dragView=async(dx,dy,button='left',onMarker=false)=>{
   const area=await surface.boundingBox(),imageBefore=await view.locator('[data-work-photo]').boundingBox();
   const markerBox=onMarker?await view.locator('[data-marker]').boundingBox():null;
   const x=markerBox?markerBox.x+markerBox.width/2:area.x+12,y=markerBox?markerBox.y+markerBox.height/2:area.y+15;
   await view.mouse.move(x,y);await view.mouse.down({button});await view.mouse.move(x+dx,y+dy,{steps:4});await view.mouse.up({button});
   const imageAfter=await view.locator('[data-work-photo]').boundingBox();
   assert.ok(Math.abs(imageAfter.x-imageBefore.x-dx)<1,'dragging the correction background must pan the photo');
   assert.ok(Math.abs(imageAfter.y-imageBefore.y-dy)<1,'photo pan must follow the vertical drag');
   assert.deepEqual(await view.evaluate(()=>window.__annotations.landmarks[0].observations[0].xy),xy);
   assert.equal(await view.evaluate(()=>window.__annotationChanges),changesBeforePan,'panning cannot create an annotation edit');
  };
  await dragView(40,25);
  await view.getByRole('button',{name:'平移图片',exact:true}).click();assert.equal(await view.getByLabel('编辑模式').inputValue(),'pan');
  await dragView(-20,-15,'left',true);
  await view.getByLabel('编辑模式').selectOption('point');await dragView(25,15,'middle',true);
  await view.getByLabel('编辑模式').selectOption('move');
  const correctedMarker=await view.locator('[data-marker]').boundingBox(),pannedImage=await view.locator('[data-work-photo]').boundingBox();
  await view.mouse.move(correctedMarker.x+correctedMarker.width/2,correctedMarker.y+correctedMarker.height/2);await view.mouse.down();await view.mouse.move(correctedMarker.x+correctedMarker.width/2+12,correctedMarker.y+correctedMarker.height/2+8);await view.mouse.up();
  const corrected=await view.evaluate(()=>window.__annotations.landmarks[0].observations[0].xy);
  assert.ok(Math.abs(corrected[0]-xy[0]-12*300/pannedImage.width)<1&&Math.abs(corrected[1]-xy[1]-8*600/pannedImage.height)<1,'a marker drag after pan must still save work-image pixels');
  await view.getByLabel('编辑模式').selectOption('point');
  await view.getByRole('button',{name:'复位视图',exact:true}).click();await view.evaluate(()=>{document.body.style.zoom='1.5';});
  await view.waitForTimeout(50);const imageBox=await view.locator('[data-work-photo]').boundingBox(),zoomBox=await surface.boundingBox();
  await surface.scrollIntoViewIfNeeded();const visibleImage=await view.locator('[data-work-photo]').boundingBox();
  await view.mouse.click(visibleImage.x+visibleImage.width*.3,visibleImage.y+visibleImage.height*.4);
  const zoomed=await view.evaluate(()=>window.__annotations.landmarks[0].observations[0].xy);assert.ok(Math.abs(zoomed[0]-90)<1&&Math.abs(zoomed[1]-240)<1,'150% layout zoom must use the displayed image coordinates');
  const layoutPanBefore=await view.locator('[data-work-photo]').boundingBox(),layoutSurface=await surface.boundingBox(),layoutChanges=await view.evaluate(()=>window.__annotationChanges);
  await view.mouse.move(layoutSurface.x+15,layoutSurface.y+15);await view.mouse.down({button:'middle'});await view.mouse.move(layoutSurface.x+55,layoutSurface.y+35);await view.mouse.up({button:'middle'});
  const layoutPanAfter=await view.locator('[data-work-photo]').boundingBox();
  assert.ok(Math.abs(layoutPanAfter.x-layoutPanBefore.x-40)<1&&Math.abs(layoutPanAfter.y-layoutPanBefore.y-20)<1,'150% layout zoom must preserve the pointer pan distance');
  assert.deepEqual(await view.evaluate(()=>window.__annotations.landmarks[0].observations[0].xy),zoomed);assert.equal(await view.evaluate(()=>window.__annotationChanges),layoutChanges);
  await view.mouse.move(layoutSurface.x+70,layoutSurface.y+45);assert.deepEqual(await view.locator('[data-work-photo]').boundingBox(),layoutPanAfter,'releasing the pointer must finish panning');
  await view.screenshot({path:resolve(`.superpowers/sdd/2026-10-20-assisted-reconstruction/annotation-dpr-${deviceScaleFactor}.png`),fullPage:true});await context.close();
 }
 const isolated=await browser.newPage();await isolated.route('**/annotation-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><main id="fixture"></main></body></html>'}));await isolated.goto(base+'/annotation-fixture');
 await isolated.evaluate(async()=>{
  const {mountAssistance}=await import('/assistance.js');
  const record=text=>({version:1,revision:0,state:'needs_input',photos:[],regions:[],reasons:[],questions:[{id:'q',text,type:'same_object',photoIds:[],options:['yes','no','unknown']}],answers:[],objects:[],landmarks:[],dimensions:[],coverage:[],regionLabels:[],missing:[],onlyExistingPhotos:false});
  window.__oldRecord=record('旧项目问题');window.__newRecord=record('新项目问题');
  window.__controller=mountAssistance(document.querySelector('#fixture'),{api:()=>new Promise(resolve=>window.__resolveOldRequest=resolve)});
  window.__controller.update({id:'old'},{assistance:window.__oldRecord});
 });
 await isolated.getByRole('button',{name:'检查位置',exact:true}).click();await isolated.waitForFunction(()=>typeof window.__resolveOldRequest==='function');
 await isolated.evaluate(()=>{window.__controller.update({id:'new'},{assistance:window.__newRecord});window.__resolveOldRequest({record:window.__oldRecord});});
 await isolated.waitForTimeout(50);assert.equal(await isolated.getByText('新项目问题',{exact:true}).count(),1,'a late response must not replace the current project');
 await isolated.evaluate(async()=>{
  window.__controller.destroy();const {mountAssistance}=await import('/assistance.js');
  window.__controller=mountAssistance(document.querySelector('#fixture'),{api:()=>new Promise(resolve=>window.__resolveReview=resolve)});
  window.__controller.update({id:'old'},{assistance:window.__oldRecord,gate:{selectedModel:'0',models:[{name:'0',geometrySignature:'old'}]}});
 });
 await isolated.getByText('画面检查',{exact:true}).click();await isolated.getByLabel('墙面重影').selectOption('needs_improvement');await isolated.getByRole('button',{name:'保存画面检查',exact:true}).click();await isolated.waitForFunction(()=>typeof window.__resolveReview==='function');
 await isolated.evaluate(()=>{window.__controller.update({id:'new'},{assistance:window.__newRecord});window.__resolveReview({record:window.__oldRecord,quality:{}});});
 await isolated.waitForTimeout(50);assert.equal(await isolated.getByText('新项目问题',{exact:true}).count(),1,'a late review response must not replace the current project');
 await isolated.evaluate(()=>window.__controller.update({id:'new'},{assistance:{...window.__newRecord,revision:1,state:'verified',reasons:[{message:'检测到 2 个独立区域'}],answers:[{questionId:'q',value:'yes'}]}}));
 assert.equal(await isolated.locator('.assist-reason').count(),0,'legacy reasons cannot contradict a verified result');
 assert.equal(await isolated.getByText('新项目问题',{exact:true}).isVisible(),false,'resolved questions remain as collapsed saved information');
 await isolated.getByText('已保存的辅助资料',{exact:true}).click();assert.equal(await isolated.getByText('新项目问题',{exact:true}).isVisible(),true);
 assert.equal(await isolated.locator('[data-question="q"][data-value="yes"]').getAttribute('aria-pressed'),'true');await isolated.close();
 const historyPage=await browser.newPage();await historyPage.route('**/history-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><main id="fixture"></main>'}));await historyPage.goto(base+'/history-fixture');
 await historyPage.evaluate(async()=>{
  const {mountQualityReview}=await import('/quality-review.js');window.__scene=null;
  window.__quality=mountQualityReview(document.querySelector('#fixture'),{api:async()=>({plyUrl:'/old-model.ply'}),onSceneChange:scene=>window.__scene=scene});
  window.__data={gate:{models:[{geometrySignature:'old'}]},assistance:{revision:0},attempts:[]};
  window.__quality.update({id:'same-project',activeAttemptId:'old'},window.__data);
 });
 await historyPage.locator('[data-history]').selectOption('legacy');await historyPage.waitForFunction(()=>window.__scene?.plyUrl==='/old-model.ply');
 await historyPage.evaluate(()=>window.__quality.update({id:'same-project',activeAttemptId:'new'},{...window.__data,gate:{models:[{geometrySignature:'new'}]}}));
 assert.equal(await historyPage.evaluate(()=>window.__scene),null,'adopting a new model must clear the old viewer scene before enabling current-model review');
 await historyPage.close();
 record={...record,state:'verified',missing:[]};Object.assign(project.steps.find(s=>s.id==='gate'),{status:'success',note:'需要真实共享点。请选择其他照片。'});
 await page.reload();await page.locator('#stepList').waitFor();
 assert.equal(await page.locator('#stepList').getByText(/需要真实共享点/).count(),0,'a legacy waiting note cannot contradict the successful gate status');
 projectList=[project,otherProject];await page.goto(base+'/?project=other-ui');await page.locator('li[data-id="other-ui"]').waitFor();await page.waitForTimeout(100);
 assert.equal(await page.locator('#projectName').textContent(),'链接目标');
 await page.locator('li[data-id="assist-ui"]').click();await page.waitForTimeout(100);assert.equal(new URL(page.url()).searchParams.get('project'),'assist-ui');
 console.log('PASS: assistance answers survive reload; manual photo selection; separate save and run; seven steps; project links');
}finally{await browser.close();await new Promise(r=>server.close(r));}
