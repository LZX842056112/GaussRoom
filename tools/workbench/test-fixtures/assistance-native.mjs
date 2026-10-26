// Short child processes for HTTP lifecycle tests. This is not reconstruction evidence.
import {mkdirSync,writeFileSync,cpSync} from 'node:fs';
import {resolve} from 'node:path';
import {geometrySignature} from '../lib/pipeline.mjs';
export function graph(folder,connected,lastName='p4.png'){
 mkdirSync(folder,{recursive:true});let chunks=[];
 const n=(type,value)=>{const b=Buffer.alloc(type==='i'?4:8);if(type==='i')b.writeInt32LE(value);else if(type==='d')b.writeDoubleLE(value);else b.writeBigUInt64LE(BigInt(value));chunks.push(b);};
 n('q',1);n('i',1);n('i',2);n('q',1000);n('q',800);for(const x of [800,500,400,0])n('d',x);writeFileSync(resolve(folder,'cameras.bin'),Buffer.concat(chunks));chunks=[];
 const count=6000,xyz=i=>[(i%100-50)*.02,(Math.floor(i/100)-30)*.02,4+(i%3)*.1];
 n('q',4);
 for(let view=1;view<=4;view++){
  const cx=(view%2)*.4+(connected||view<3?0:10);n('i',view);for(const v of [1,0,0,0,-cx,0,0])n('d',v);n('i',1);chunks.push(Buffer.from(`${view===4?lastName:`p${view}.png`}\0`));
  const begin=connected||view<3?0:3000,end=connected?count:begin+3000;n('q',end-begin);
  for(let i=begin;i<end;i++){const [x,y,z]=xyz(i),offset=connected||view<3?0:10;n('d',800*(x+offset-cx)/z+500);n('d',800*y/z+400);n('q',i+1);}
 }
 writeFileSync(resolve(folder,'images.bin'),Buffer.concat(chunks));chunks=[];n('q',count);
 for(let i=0;i<count;i++){
  n('q',i+1);const values=xyz(i);if(!connected&&i>=3000)values[0]+=10;for(const v of values)n('d',v);chunks.push(Buffer.from([120,160,200]));n('d',.2);
  const views=connected?[1,2,3,4]:i<3000?[1,2]:[3,4];n('q',views.length);for(const view of views){n('i',view);n('i',connected?i:i%3000);}
 }
 writeFileSync(resolve(folder,'points3D.bin'),Buffer.concat(chunks));
}
if(process.argv[2]==='solve'){
 const [source,workspace,resultPath,fail]=process.argv.slice(3);await new Promise(r=>setTimeout(r,350));
 if(fail){writeFileSync(resultPath,JSON.stringify({outcome:'failed',error:{message:'native fixture tool failure'}}));process.exitCode=1;}
 else{const output=resolve(workspace,'sfm/sparse/0');cpSync(source,output,{recursive:true});writeFileSync(resultPath,JSON.stringify({outcome:'verified',geometrySignature:geometrySignature(output),bridges:{accepted:true,strongPoints:8},scale:{scale:'unmeasured'}}));}
}
if(process.argv[2]==='undistort'){
 const [input,images,output]=process.argv.slice(3);cpSync(input,resolve(output,'sparse'),{recursive:true});cpSync(images,resolve(output,'images'),{recursive:true});
}
if(process.argv[2]==='train'){
 const [output]=process.argv.slice(3);mkdirSync(output,{recursive:true});writeFileSync(resolve(output,'export_30000.ply'),'ply\nformat ascii 1.0\nelement vertex 0\nend_header\n');console.log('Refine iter 30000, fixture splats.');
}
