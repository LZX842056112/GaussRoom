import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {PY_DIR,TOOLS} from './paths.mjs';

const execute=promisify(execFile);
let capabilityCache=null;
async function run(args) {
  try {
    const {stdout}=await execute(TOOLS.python,['-X','utf8','-B',resolve(PY_DIR,'validate_photo.py'),...args,
      ...(TOOLS.ffmpeg?['--ffmpeg',TOOLS.ffmpeg]:[])],{windowsHide:true,encoding:'utf8',maxBuffer:65536,timeout:45000});
    return JSON.parse(stdout);
  } catch(error) {
    const message=error.killed?'照片校验超时，请重试。':error.code==='ENOENT'?'照片校验器不可用，请检查电脑环境。':'照片无法解码，或格式、尺寸不符合要求。';
    throw Object.assign(new Error(message),{code:error.code==='ENOENT'?503:400});
  }
}
export function validatePhotoFile(path,extension) {
  return run(['--image',path,'--extension',extension,'--min-long-edge','1000']);
}
export async function getPhotoFormats() {
  if(!capabilityCache || Date.now()-capabilityCache.at>=60000) {
    const entry={at:Date.now(),promise:run(['--capabilities'])};capabilityCache=entry;
    entry.promise.catch(()=>{if(capabilityCache===entry)capabilityCache=null;});
  }
  return capabilityCache.promise;
}
