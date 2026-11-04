// One heavy task across reconstruction and diagnostic camera analysis.
let owner=null;
export const computeOwner=()=>owner;
export function acquireCompute(task){
 if(owner)return null;
 if(!['reconstruction','capture_analysis'].includes(task?.kind)||typeof task.id!=='string'||!task.id)throw new TypeError('Invalid compute owner');
 const lease=Object.freeze({kind:task.kind,id:task.id});owner=lease;
 return ()=>{if(owner===lease)owner=null;};
}
