// Absolute paths for every external tool the workbench drives. Any of them can be
// overridden in the repo-root .env (template: .env.example); a relative value there
// is resolved against REPO, so the file stays portable.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from 'node:child_process';

export const REPO = resolve(import.meta.dirname, "..", "..", "..");
export const WORKBENCH = resolve(import.meta.dirname, "..");
export const PUBLIC_DIR = resolve(WORKBENCH, "public");
export const PY_DIR = resolve(WORKBENCH, "py");
export const PROJECTS_DIR = resolve(REPO, "projects");

// A missing .env is fine, and a real environment variable wins over the file.
try {
  process.loadEnvFile(resolve(REPO, ".env"));
} catch { /* no .env yet */ }

const configured = (key, fallback) => {
  const value = process.env[key];
  return value ? resolve(REPO, value) : fallback;
};

export const TOOLS = {
  python: configured("WORKBENCH_PYTHON", resolve(REPO, ".venv/Scripts/python.exe")),
  colmapGpu: configured("COLMAP_GPU", resolve(REPO, "tools/colmap-4.2.1-cuda/bin/colmap.exe")),
  colmapCpu: configured("COLMAP_CPU", resolve(REPO, "tools/colmap-4.2.1/bin/colmap.exe")),
  brush: configured("BRUSH", resolve(REPO, "tools/brush-0.3.0/brush_app.exe")),
  // Only needed to decode HEIC originals; leave unset when every source is JPEG.
  ffmpeg: configured("FFMPEG", ""),
};

export function toolStatus() {
  const status = {};
  for (const [name, path] of Object.entries(TOOLS)) status[name] = existsSync(path);
  for (const [name, value] of Object.entries(dependencyStatus())) status[name] = value.ok;
  return status;
}

let dependencyCache=null;
const dependencyProbe = `import importlib,json
result={}
for key,module in [('pycolmap','pycolmap'),('opencv','cv2')]:
 try:
  imported=importlib.import_module(module)
  result[key]={'ok':True,'version':getattr(imported,'__version__','unknown')}
 except Exception as error:
  result[key]={'ok':False,'error':str(error)}
print(json.dumps(result))`;
export function dependencyStatus({force=false,probe=execFileSync}={}) {
  if(!force&&probe===execFileSync&&dependencyCache&&Date.now()-dependencyCache.at<60000)return dependencyCache.value;
  let raw;
  try {raw=JSON.parse(String(probe(TOOLS.python,['-c',dependencyProbe],{encoding:'utf8',timeout:8000,windowsHide:true,stdio:['ignore','pipe','pipe']})));}
  catch(error){raw=Object.fromEntries(['pycolmap','opencv'].map(name=>[name,{ok:false,error:error.message}]));}
  const value={};
  for(const [key,module] of [['pycolmap','pycolmap'],['opencv','cv2']]){
    const entry=raw[key]??{ok:false,error:'依赖检查没有返回结果'};
    value[key]={...entry,ok:entry.ok===true,message:entry.ok?`${module} ${entry.version} 就绪`:`${module} 无法加载：${entry.error}`,repair:'uv sync --locked'};
  }
  if(probe===execFileSync)dependencyCache={at:Date.now(),value};
  return value;
}
