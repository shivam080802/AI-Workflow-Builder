import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
const api=process.env.API_URL??'http://localhost:4000';
let cookie='';
async function call(path,options={},expected){
  const response=await fetch(`${api}${path}`,{...options,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...options.headers}});
  const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
  const value=response.status===204?null:await response.json();
  if(expected){assert.equal(response.status,expected,JSON.stringify(value));return value;}
  if(!response.ok)throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value;
}
async function waitRun(id){
  for(let attempt=0;attempt<40;attempt++){
    await new Promise(resolve=>setTimeout(resolve,250));
    const run=await call(`/api/runs/${id}`);
    if(['succeeded','failed','needs_review'].includes(run.status))return run;
  }
  throw new Error('Run did not finish');
}
const suffix=randomUUID().slice(0,8);
await call('/api/auth/register',{method:'POST',body:JSON.stringify({name:'Smoke Owner',email:`smoke-${suffix}@example.test`,password:'correct horse battery staple',workspaceName:'Smoke Workspace'})},201);
const me=await call('/api/me');assert.equal(me.memberships[0].role,'owner');
const firstWorkspaceId=me.memberships[0].workspace.id;
const credential=await call('/api/credentials',{method:'POST',body:JSON.stringify({name:'Test token',kind:'httpBearer',secret:'very-secret-value'})},201);
assert.equal(credential.secret,undefined);
const listed=await call('/api/credentials');assert.equal(listed[0].secret,undefined);
const workflow=await call('/api/workflows',{method:'POST',body:JSON.stringify({name:'Routing smoke test'})},201);
const graph={
  nodes:[
    {id:'start',kind:'manual',position:{x:0,y:0},config:{}},
    {id:'route',kind:'router',position:{x:200,y:0},config:{field:'kind',operator:'equals',value:'urgent'}},
    {id:'urgent',kind:'text',position:{x:400,y:-100},config:{prefix:'URGENT ',suffix:''}},
    {id:'normal',kind:'text',position:{x:400,y:100},config:{prefix:'NORMAL ',suffix:''}}
  ],
  edges:[
    {id:'a',source:'start',target:'route'},
    {id:'b',source:'route',target:'urgent',sourceHandle:'true'},
    {id:'c',source:'route',target:'normal',sourceHandle:'false'}
  ]
};
await call(`/api/workflows/${workflow.id}/draft`,{method:'PUT',body:JSON.stringify({name:'Routing smoke test',graph})});
await call(`/api/workflows/${workflow.id}/publish`,{method:'POST'},201);
const urgent=await call(`/api/workflows/${workflow.id}/runs`,{method:'POST',body:JSON.stringify({input:JSON.stringify({kind:'urgent',message:'hello'})})},202);
const urgentRun=await waitRun(urgent.id);
assert.equal(urgentRun.status,'succeeded');assert.match(urgentRun.output,/^URGENT /);
assert.equal(urgentRun.steps.find(step=>step.nodeId==='normal')?.status,'skipped');
assert.equal(urgentRun.steps.find(step=>step.nodeId==='route')?.route,'true');
const normal=await call(`/api/workflows/${workflow.id}/runs`,{method:'POST',body:JSON.stringify({input:JSON.stringify({kind:'routine'})})},202);
const normalRun=await waitRun(normal.id);
assert.match(normalRun.output,/^NORMAL /);
assert.equal(normalRun.steps.find(step=>step.nodeId==='urgent')?.status,'skipped');
graph.nodes[0].kind='webhook';
await call(`/api/workflows/${workflow.id}/draft`,{method:'PUT',body:JSON.stringify({name:'Routing smoke test',graph})});
await call(`/api/workflows/${workflow.id}/publish`,{method:'POST'},201);
const hook=await call(`/api/workflows/${workflow.id}/webhook`);
const body=JSON.stringify({kind:'urgent',message:'from webhook'});
const timestamp=String(Date.now()),deliveryId=randomUUID();
const signature='sha256='+createHmac('sha256',hook.secret).update(timestamp).update('.').update(body).digest('hex');
const webhookHeaders={'Content-Type':'application/json','x-awb-timestamp':timestamp,'x-awb-delivery-id':deliveryId,'x-awb-signature':signature};
const received=await call(`/hooks/${workflow.id}`,{method:'POST',headers:webhookHeaders,body},202);
const duplicate=await call(`/hooks/${workflow.id}`,{method:'POST',headers:webhookHeaders,body},202);
assert.equal(duplicate.id,received.id);
const webhookRun=await waitRun(received.id);assert.equal(webhookRun.status,'succeeded');
const scheduled=await call('/api/workflows',{method:'POST',body:JSON.stringify({name:'Schedule smoke test'})},201);
const scheduleGraph={nodes:[{id:'start',kind:'schedule',position:{x:0,y:0},config:{everyMinutes:1}}],edges:[]};
await call(`/api/workflows/${scheduled.id}/draft`,{method:'PUT',body:JSON.stringify({name:'Schedule smoke test',graph:scheduleGraph})});
await call(`/api/workflows/${scheduled.id}/publish`,{method:'POST'},201);
assert.equal((await call(`/api/workflows/${scheduled.id}/schedule`)).active,true);
scheduleGraph.nodes[0].kind='manual';scheduleGraph.nodes[0].config={};
await call(`/api/workflows/${scheduled.id}/draft`,{method:'PUT',body:JSON.stringify({name:'Schedule smoke test',graph:scheduleGraph})});
await call(`/api/workflows/${scheduled.id}/publish`,{method:'POST'},201);
assert.equal((await call(`/api/workflows/${scheduled.id}/schedule`)).active,false);
const ai=await call('/api/workflows',{method:'POST',body:JSON.stringify({name:'Local AI smoke test'})},201);
const aiGraph={nodes:[{id:'start',kind:'manual',position:{x:0,y:0},config:{}},{id:'ai',kind:'llm',position:{x:200,y:0},config:{provider:'mock',model:'',prompt:'Classify {{input}}'}}],edges:[{id:'a',source:'start',target:'ai'}]};
await call(`/api/workflows/${ai.id}/draft`,{method:'PUT',body:JSON.stringify({name:'Local AI smoke test',graph:aiGraph})});
await call(`/api/workflows/${ai.id}/publish`,{method:'POST'},201);
const aiRun=await call(`/api/workflows/${ai.id}/runs`,{method:'POST',body:JSON.stringify({input:'message'})},202);
assert.equal((await waitRun(aiRun.id)).output,'MOCK: Classify message');
const reviewed=await call('/api/workflows',{method:'POST',body:JSON.stringify({name:'Approval smoke test'})},201);
const approvalGraph={nodes:[
  {id:'start',kind:'manual',position:{x:0,y:0},config:{}},
  {id:'review',kind:'approval',position:{x:200,y:0},config:{prompt:'Review {{input}}',timeoutMinutes:1}},
  {id:'yes',kind:'text',position:{x:400,y:-100},config:{prefix:'APPROVED ',suffix:''}},
  {id:'no',kind:'text',position:{x:400,y:100},config:{prefix:'REJECTED ',suffix:''}}
],edges:[{id:'a',source:'start',target:'review'},{id:'b',source:'review',target:'yes',sourceHandle:'true'},{id:'c',source:'review',target:'no',sourceHandle:'false'}]};
await call(`/api/workflows/${reviewed.id}/draft`,{method:'PUT',body:JSON.stringify({name:'Approval smoke test',graph:approvalGraph})});
await call(`/api/workflows/${reviewed.id}/publish`,{method:'POST'},201);
let lastApprovalId;
for(const decision of ['approved','rejected']){
  const pendingRun=await call(`/api/workflows/${reviewed.id}/runs`,{method:'POST',body:JSON.stringify({input:decision})},202);
  let pendingApproval;
  for(let attempt=0;attempt<40;attempt++){
    await new Promise(resolve=>setTimeout(resolve,250));
    pendingApproval=(await call('/api/approvals')).find(item=>item.run.id===pendingRun.id);
    if(pendingApproval)break;
  }
  assert.equal(pendingApproval?.status,'pending');
  lastApprovalId=pendingApproval.id;
  assert.equal((await call(`/api/runs/${pendingRun.id}`)).status,'waiting');
  await call(`/api/approvals/${pendingApproval.id}/decision`,{method:'POST',body:JSON.stringify({decision})});
  const finished=await waitRun(pendingRun.id);
  assert.equal(finished.status,'succeeded');
  assert.match(finished.output,decision==='approved'?/^APPROVED /:/^REJECTED /);
  assert.equal(finished.steps.find(step=>step.nodeId===(decision==='approved'?'no':'yes'))?.status,'skipped');
}
await call('/api/auth/register',{method:'POST',body:JSON.stringify({name:'Other Owner',email:`other-${suffix}@example.test`,password:'correct horse battery staple',workspaceName:'Other Workspace'})},201);
await call(`/api/workflows/${workflow.id}`,{},404);
await call(`/api/runs/${urgent.id}`,{},404);
assert.equal((await call('/api/approvals')).length,0);
await call(`/api/approvals/${lastApprovalId}/decision`,{method:'POST',body:JSON.stringify({decision:'approved'})},404);
await call('/api/workflows',{headers:{'x-workspace-id':firstWorkspaceId}},403);
console.log(`Smoke test passed: auth, workspace isolation, credentials, router paths, signed webhook, dedupe, schedules, local AI mock, approvals; workflow ${workflow.id}`);
