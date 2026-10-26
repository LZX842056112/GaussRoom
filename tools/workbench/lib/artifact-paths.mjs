import { resolve, sep,dirname } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { PROJECTS_DIR } from './paths.mjs';

export function artifactDirs(project,{attemptId=project.activeAttemptId??null}={}) {
  const root=resolve(project.root??resolve(PROJECTS_DIR,project.id));
  if(attemptId!==null && (typeof attemptId!=='string'||!/^a-[a-f0-9]{24}$/.test(attemptId)))throw Object.assign(new Error('重建尝试 ID 无效'),{code:400});
  const workspace=attemptId?resolve(root,'attempts',attemptId):root;
  if(existsSync(root)){
    let ancestor=workspace;
    while(!existsSync(ancestor)&&ancestor!==dirname(ancestor))ancestor=dirname(ancestor);
    const target=realpathSync(ancestor),base=realpathSync(root);
    if(target!==base&&!target.startsWith(base+sep))throw Object.assign(new Error('重建尝试目录越界'),{code:400});
  }
  return {root,workspace,manifest:resolve(workspace,'manifest.json'),
    images:attemptId?resolve(workspace,'inputs/images'):resolve(root,'images'),
    sfm:resolve(workspace,'sfm'),sparse:resolve(workspace,'sfm/sparse'),summary:resolve(workspace,'summary'),
    undistorted:resolve(workspace,'undistorted'),train:resolve(workspace,'train'),logs:resolve(workspace,'logs')};
}
