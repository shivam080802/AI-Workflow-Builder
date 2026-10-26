export const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
export const activeWorkspaceId=()=>localStorage.getItem('awb_workspace_id');
export const setActiveWorkspaceId=(id:string|null)=>id?localStorage.setItem('awb_workspace_id',id):localStorage.removeItem('awb_workspace_id');
export async function request<T>(path:string,options?:RequestInit):Promise<T>{
  const workspaceId=activeWorkspaceId();
  const response=await fetch(`${API}${path}`,{...options,credentials:'include',headers:{'Content-Type':'application/json',...(workspaceId&&path.startsWith('/api/')&&!path.startsWith('/api/auth/')&&path!=='/api/me'?{'x-workspace-id':workspaceId}:{}),...options?.headers}});
  if(response.status===204)return undefined as T;
  const body=await response.json().catch(()=>({error:'Request failed'}));
  if(!response.ok)throw new Error(body.error??'Request failed');
  return body as T;
}
export type Member={role:'owner'|'editor'|'viewer';user:{id:string;name:string;email:string}};
export type Me={id:string;name:string;email:string;memberships:{role:'owner'|'editor'|'viewer';workspace:{id:string;name:string}}[]};
export type WorkflowItem={id:string;name:string;version:number;updatedAt:string};
export type Workflow=WorkflowItem&{draft:import('@awb/contracts').WorkflowGraph;versions:{id:string;number:number;createdAt:string}[]};
export type Credential={id:string;name:string;kind:'httpBearer'|'slack'|'github';createdAt:string};
export type RunStep={nodeId:string;kind:string;status:string;input:string;output:string|null;route:string|null;error:string|null;startedAt:string;finishedAt:string|null};
export type Run={id:string;workflowId:string;status:string;input:string;output:string|null;error:string|null;createdAt:string;version:{number:number};steps?:RunStep[];workflow?:{id:string;name:string}};
