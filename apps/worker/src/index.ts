import {Worker,Queue} from 'bullmq';
import IORedis from 'ioredis';
import {db} from '@awb/db';
import {nextNode,registry,evaluateCondition,renderTemplate} from '@awb/engine';
import {validateGraph,type NodeKind} from '@awb/contracts';
import {decrypt,safeHttpRequest} from '@awb/security';
import {ChatOllama} from '@langchain/ollama';

const connection=new IORedis(process.env.REDIS_URL??'redis://localhost:16379',{maxRetriesPerRequest:null});
const queue=new Queue('workflow-runs',{connection});
const sideEffectKinds=new Set<NodeKind>(['http','slack','github']);
async function credential(workspaceId:string,credentialId:unknown,kind:string) {
  if(typeof credentialId!=='string')throw new Error('Select a credential');
  const found=await db.credential.findFirst({where:{id:credentialId,workspaceId,kind}});
  if(!found)throw new Error('Credential is unavailable for this workspace');
  return decrypt(found.ciphertext);
}
async function executeNode(kind:NodeKind,input:string,config:Record<string,unknown>,trigger:string,workspaceId:string):Promise<string>{
  if(kind==='llm'){
    const prompt=renderTemplate(String(config.prompt),input,trigger);
    if(config.provider==='mock')return `MOCK: ${prompt}`;
    const model=new ChatOllama({model:String(config.model),baseUrl:process.env.OLLAMA_BASE_URL??'http://127.0.0.1:11434',temperature:0,maxRetries:0});
    const response=await model.invoke(prompt,{signal:AbortSignal.timeout(30000)});
    return typeof response.content==='string'?response.content:JSON.stringify(response.content);
  }
  if(kind==='http'){
    const token=config.credentialId?await credential(workspaceId,config.credentialId,'httpBearer'):undefined;
    return safeHttpRequest({url:renderTemplate(String(config.url),input,trigger),method:config.method as 'GET'|'POST'|'PUT'|'PATCH',body:renderTemplate(String(config.body??''),input,trigger),bearer:token});
  }
  if(kind==='slack'){
    const token=await credential(workspaceId,config.credentialId,'slack');
    const response=await safeHttpRequest({url:'https://slack.com/api/chat.postMessage',method:'POST',body:JSON.stringify({channel:config.channel,text:renderTemplate(String(config.text),input,trigger)}),bearer:token});
    const result=JSON.parse(response) as {ok?:boolean,error?:string,ts?:string};
    if(!result.ok)throw new Error(`Slack action failed: ${result.error??'unknown error'}`);
    return JSON.stringify({ok:true,ts:result.ts});
  }
  if(kind==='github'){
    const token=await credential(workspaceId,config.credentialId,'github');
    const owner=String(config.owner),repo=String(config.repo);
    if(!/^[A-Za-z0-9_.-]+$/.test(owner)||!/^[A-Za-z0-9_.-]+$/.test(repo))throw new Error('Invalid GitHub repository');
    const response=await safeHttpRequest({url:`https://api.github.com/repos/${owner}/${repo}/issues`,method:'POST',body:JSON.stringify({title:renderTemplate(String(config.title),input,trigger),body:renderTemplate(String(config.body??''),input,trigger)}),bearer:token});
    const issue=JSON.parse(response) as {number:number,html_url:string};
    return JSON.stringify({number:issue.number,url:issue.html_url});
  }
  return registry.execute(kind,input,config);
}
const worker=new Worker('workflow-runs',async job=>{
  if(job.name==='approval-timeout'){
    const approval=await db.approval.findUnique({where:{id:job.data.approvalId as string}});
    if(!approval||approval.status!=='pending'||approval.expiresAt>new Date())return null;
    const changed=await db.$transaction(async tx=>{
      const result=await tx.approval.updateMany({where:{id:approval.id,status:'pending'},data:{status:'timed_out',decidedAt:new Date()}});
      if(!result.count)return false;
      await tx.runStep.update({where:{runId_nodeId:{runId:approval.runId,nodeId:approval.nodeId}},data:{status:'succeeded',route:'false',output:(await tx.runStep.findUniqueOrThrow({where:{runId_nodeId:{runId:approval.runId,nodeId:approval.nodeId}}})).input,finishedAt:new Date()}});
      await tx.run.update({where:{id:approval.runId},data:{status:'queued'}});
      return true;
    });
    if(changed)await queue.add('resume',{runId:approval.runId},{jobId:`resume-timeout-${approval.id}`,attempts:3,backoff:{type:'exponential',delay:1000},removeOnComplete:1000});
    return null;
  }
  if(job.name==='schedule'){
    const workflowId=job.data.workflowId as string;
    const version=await db.workflowVersion.findFirst({where:{workflowId},orderBy:{number:'desc'}});
    if(!version||!validateGraph(version.graph).nodes.some(n=>n.kind==='schedule'))return null;
    await db.run.upsert({where:{workflowId_deliveryId:{workflowId,deliveryId:job.id!}},create:{workflowId,versionId:version.id,input:JSON.stringify({scheduledAt:new Date().toISOString()}),deliveryId:job.id},update:{}});
  }
  const runId=job.name==='schedule'?(await db.run.findUniqueOrThrow({where:{workflowId_deliveryId:{workflowId:job.data.workflowId as string,deliveryId:job.id!}},select:{id:true}})).id:job.data.runId as string;
  const run=await db.run.findUniqueOrThrow({where:{id:runId},include:{version:true,steps:true,workflow:true}});
  if(run.status==='succeeded'||run.status==='needs_review')return run.output;
  const graph=validateGraph(run.version.graph);
  if(!run.workflow.workspaceId)throw new Error('Run has no workspace');
  await db.run.update({where:{id:run.id},data:{status:'running',startedAt:run.startedAt??new Date(),error:null}});
  let value=run.input;
  let nodeId:string|undefined=graph.nodes.find(n=>n.kind==='manual'||n.kind==='webhook'||n.kind==='schedule')?.id;
  const visited=new Set<string>();
  try{
    while(nodeId){
      const node=graph.nodes.find(n=>n.id===nodeId)!;
      visited.add(node.id);
      const prior=run.steps.find(step=>step.nodeId===node.id);
      if(prior?.status==='succeeded'&&prior.output!==null){value=prior.output;nodeId=nextNode(graph,node.id,node.kind==='router'||node.kind==='approval'?(prior.route as 'true'|'false'):undefined);continue;}
      if(node.kind==='approval'){
        if(prior?.status==='waiting'){
          const pending=await db.approval.findUnique({where:{runId_nodeId:{runId:run.id,nodeId:node.id}}});
          if(pending?.status==='pending')await queue.add('approval-timeout',{approvalId:pending.id},{jobId:`approval-timeout-${pending.id}`,delay:Math.max(0,pending.expiresAt.getTime()-Date.now()),removeOnComplete:1000});
          return null;
        }
        const input=value;
        const expiresAt=new Date(Date.now()+Number(node.config.timeoutMinutes)*60000);
        const approval=await db.$transaction(async tx=>{
          await tx.runStep.upsert({where:{runId_nodeId:{runId:run.id,nodeId:node.id}},create:{runId:run.id,nodeId:node.id,kind:node.kind,status:'waiting',input},update:{status:'waiting',input}});
          const record=await tx.approval.upsert({where:{runId_nodeId:{runId:run.id,nodeId:node.id}},create:{runId:run.id,nodeId:node.id,prompt:renderTemplate(String(node.config.prompt),input,run.input),expiresAt},update:{}});
          await tx.run.update({where:{id:run.id},data:{status:'waiting'}});
          return record;
        });
        await queue.add('approval-timeout',{approvalId:approval.id},{jobId:`approval-timeout-${approval.id}`,delay:Math.max(0,approval.expiresAt.getTime()-Date.now()),removeOnComplete:1000});
        return null;
      }
      if(prior?.status==='running'&&sideEffectKinds.has(node.kind)){
        await db.runStep.update({where:{runId_nodeId:{runId:run.id,nodeId:node.id}},data:{status:'needs_review',error:'Worker stopped during an external action; outcome may be ambiguous',finishedAt:new Date()}});
        await db.run.update({where:{id:run.id},data:{status:'needs_review',error:'External action needs review before rerun',finishedAt:new Date()}});
        await job.discard();return null;
      }
      const input=value;
      await db.runStep.upsert({where:{runId_nodeId:{runId:run.id,nodeId:node.id}},create:{runId:run.id,nodeId:node.id,kind:node.kind,status:'running',input},update:{status:'running',input,error:null,startedAt:new Date(),finishedAt:null}});
      value=await executeNode(node.kind,input,node.config,run.input,run.workflow.workspaceId);
      const route=node.kind==='router'?(evaluateCondition(value,node.config)?'true':'false'):null;
      await db.runStep.update({where:{runId_nodeId:{runId:run.id,nodeId:node.id}},data:{status:'succeeded',output:value,route,finishedAt:new Date()}});
      nodeId=nextNode(graph,node.id,route??undefined);
    }
    for(const node of graph.nodes.filter(item=>!visited.has(item.id))){
      await db.runStep.upsert({where:{runId_nodeId:{runId:run.id,nodeId:node.id}},create:{runId:run.id,nodeId:node.id,kind:node.kind,status:'skipped',input:'',finishedAt:new Date()},update:{status:'skipped',finishedAt:new Date()}});
    }
    await db.run.update({where:{id:run.id},data:{status:'succeeded',output:value,finishedAt:new Date()}});
    return value;
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    const active=graph.nodes.find(n=>n.id===nodeId);
    if(active)await db.runStep.updateMany({where:{runId:run.id,nodeId:active.id},data:{status:'failed',error:message,finishedAt:new Date()}});
    const final=!!active&&sideEffectKinds.has(active.kind)||job.attemptsMade+1>=(job.opts.attempts??1);
    if(active&&sideEffectKinds.has(active.kind))await job.discard();
    await db.run.update({where:{id:run.id},data:{status:final?'failed':'queued',error:message,finishedAt:final?new Date():null}});
    throw error;
  }
},{connection,concurrency:5});
worker.on('failed',(job,error)=>console.error(`Run ${job?.id} failed:`,error));
async function recoverExpiredApprovals(){
  const expired=await db.approval.findMany({where:{status:'pending',expiresAt:{lte:new Date()}},select:{id:true},take:100});
  for(const approval of expired)await queue.add('approval-timeout',{approvalId:approval.id},{jobId:`approval-recovery-${approval.id}-${Math.floor(Date.now()/30000)}`,attempts:3,backoff:{type:'exponential',delay:1000},removeOnComplete:1000});
}
void recoverExpiredApprovals().catch(error=>console.error('Approval recovery failed:',error));
setInterval(()=>void recoverExpiredApprovals().catch(error=>console.error('Approval recovery failed:',error)),30000).unref();
console.log('Workflow worker ready');
