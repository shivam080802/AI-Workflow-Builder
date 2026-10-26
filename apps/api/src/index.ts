import express from 'express';
import cors from 'cors';
import {Queue} from 'bullmq';
import IORedis from 'ioredis';
import {createHash,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {db,Prisma} from '@awb/db';
import {graphSchema,nodeDefinitions,validateGraph,type WorkflowGraph} from '@awb/contracts';
import {decrypt,encrypt,validWebhookSignature} from '@awb/security';
import {z,ZodError} from 'zod';

class HttpError extends Error {constructor(public status:number,message:string){super(message);}}
const app=express();
const origin=process.env.WEB_ORIGIN??'http://localhost:5173';
app.use(cors({origin,credentials:true}));
app.use((req,res,next)=>{if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin&&req.headers.origin!==origin)return void res.status(403).json({error:'Invalid origin'});next();});
const redis=new IORedis(process.env.REDIS_URL??'redis://localhost:16379',{maxRetriesPerRequest:null});
const queue=new Queue('workflow-runs',{connection:redis});
const asyncRoute=(handler:express.RequestHandler):express.RequestHandler=>(req,res,next)=>Promise.resolve(handler(req,res,next)).catch(next);
const json=(value:unknown):Prisma.InputJsonValue=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const id=(value:string|undefined)=>z.string().cuid().parse(value);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const cookie=(req:express.Request)=>req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith('awb_session='))?.slice(12);
const setCookie=(res:express.Response,token:string)=>res.cookie('awb_session',token,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/',maxAge:7*24*60*60*1000});
const passwordHash=(password:string,salt:string)=>scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex');
const strongPassword=z.string().min(12).max(128);
type AuthContext={userId:string;workspaceId:string;role:string};
const auth=(req:express.Request):AuthContext=>(req as express.Request & {auth:AuthContext}).auth;
const canEdit=(req:express.Request)=>{if(!['owner','editor'].includes(auth(req).role))throw new HttpError(403,'Editor access required');};
const isOwner=(req:express.Request)=>{if(auth(req).role!=='owner')throw new HttpError(403,'Owner access required');};
const audit=(req:express.Request,action:string,targetId:string)=>db.auditEvent.create({data:{workspaceId:auth(req).workspaceId,actorId:auth(req).userId,action,targetId}});
const scopedWorkflow=async(req:express.Request,workflowId:string)=>{
  const workflow=await db.workflow.findFirst({where:{id:workflowId,workspaceId:auth(req).workspaceId}});
  if(!workflow)throw new HttpError(404,'Workflow not found');
  return workflow;
};
async function enqueue(runId:string){
  try{await queue.add('execute',{runId},{jobId:runId,attempts:3,backoff:{type:'exponential',delay:1000},removeOnComplete:1000,removeOnFail:1000});}
  catch(error){await db.run.update({where:{id:runId},data:{status:'failed',error:'Could not enqueue run',finishedAt:new Date()}});throw error;}
}

app.get('/health',asyncRoute(async(_req,res)=>{await db.$queryRaw`SELECT 1`;await redis.ping();res.json({status:'ok'});}));
app.post('/hooks/:workflowId',express.raw({type:'application/json',limit:'1mb'}),asyncRoute(async(req,res)=>{
  const workflowId=id(req.params.workflowId);
  const body=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);
  const timestamp=String(req.header('x-awb-timestamp')??'');
  const signature=String(req.header('x-awb-signature')??'');
  const deliveryId=String(req.header('x-awb-delivery-id')??'');
  if(!/^\d+$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp))>300000||!deliveryId||deliveryId.length>128)throw new HttpError(401,'Invalid webhook headers');
  const endpoint=await db.webhookSecret.findUnique({where:{workflowId}});
  if(!endpoint||!validWebhookSignature(decrypt(endpoint.ciphertext),timestamp,body,signature))throw new HttpError(401,'Invalid webhook signature');
  let payload:unknown;try{payload=JSON.parse(body.toString('utf8'));}catch{throw new HttpError(400,'Invalid JSON body');}
  const version=await db.workflowVersion.findFirst({where:{workflowId},orderBy:{number:'desc'}});
  if(!version||validateGraph(version.graph).nodes.find(n=>n.kind==='webhook')===undefined)throw new HttpError(409,'No published webhook workflow');
  const existing=await db.run.findFirst({where:{workflowId,deliveryId}});
  if(existing)return void res.status(202).json(existing);
  let run;
  try{run=await db.run.create({data:{workflowId,versionId:version.id,input:JSON.stringify(payload),deliveryId}});}
  catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){const duplicate=await db.run.findFirstOrThrow({where:{workflowId,deliveryId}});return void res.status(202).json(duplicate);}throw error;}
  await enqueue(run.id);res.status(202).json(run);
}));
app.use(express.json({limit:'1mb'}));

app.post('/api/auth/register',asyncRoute(async(req,res)=>{
  const body=z.object({name:z.string().trim().min(1).max(80),email:z.string().email().max(255).transform(v=>v.toLowerCase()),password:strongPassword,workspaceName:z.string().trim().min(1).max(80)}).parse(req.body);
  const salt=randomBytes(16).toString('hex');
  let user;
  try{user=await db.$transaction(async tx=>{const created=await tx.user.create({data:{name:body.name,email:body.email,passwordSalt:salt,passwordHash:passwordHash(body.password,salt)}});const workspace=await tx.workspace.create({data:{name:body.workspaceName,memberships:{create:{userId:created.id,role:'owner'}}}});await tx.auditEvent.create({data:{workspaceId:workspace.id,actorId:created.id,action:'workspace.created',targetId:workspace.id}});return created;});}
  catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')throw new HttpError(409,'Email already registered');throw error;}
  const token=randomBytes(32).toString('base64url');await db.session.create({data:{userId:user.id,tokenHash:sha(token),expiresAt:new Date(Date.now()+7*86400000)}});setCookie(res,token);res.status(201).json({id:user.id,name:user.name,email:user.email});
}));
app.post('/api/auth/login',asyncRoute(async(req,res)=>{
  const body=z.object({email:z.string().email().transform(v=>v.toLowerCase()),password:z.string()}).parse(req.body);
  const throttleKey=`login:${sha(`${req.ip}:${body.email}`)}`;const failures=Number(await redis.get(throttleKey)??0);
  if(failures>=10)throw new HttpError(429,'Too many sign-in attempts');
  const user=await db.user.findUnique({where:{email:body.email}});
  const actual=Buffer.from(user?.passwordHash??'','hex');const expected=Buffer.from(passwordHash(body.password,user?.passwordSalt??'00000000000000000000000000000000'),'hex');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){
    const count=await redis.incr(throttleKey);if(count===1)await redis.expire(throttleKey,900);throw new HttpError(401,'Invalid email or password');
  }
  await redis.del(throttleKey);
  const token=randomBytes(32).toString('base64url');await db.session.create({data:{userId:user!.id,tokenHash:sha(token),expiresAt:new Date(Date.now()+7*86400000)}});setCookie(res,token);res.json({id:user!.id,name:user!.name,email:user!.email});
}));
app.post('/api/auth/logout',asyncRoute(async(req,res)=>{const token=cookie(req);if(token)await db.session.deleteMany({where:{tokenHash:sha(token)}});res.clearCookie('awb_session',{path:'/'});res.status(204).end();}));

app.use('/api',asyncRoute(async(req,_res,next)=>{
  const token=cookie(req);if(!token)throw new HttpError(401,'Sign in required');
  const session=await db.session.findUnique({where:{tokenHash:sha(token)},include:{user:{include:{memberships:true}}}});
  if(!session||session.expiresAt<=new Date())throw new HttpError(401,'Session expired');
  const requested=req.header('x-workspace-id');
  const membership=session.user.memberships.find(m=>m.workspaceId===(requested??session.user.memberships[0]?.workspaceId));
  if(!membership)throw new HttpError(403,'Workspace access denied');
  (req as express.Request&{auth:AuthContext}).auth={userId:session.userId,workspaceId:membership.workspaceId,role:membership.role};
  next();
}));
app.get('/api/me',asyncRoute(async(req,res)=>{const user=await db.user.findUniqueOrThrow({where:{id:auth(req).userId},select:{id:true,name:true,email:true,memberships:{include:{workspace:true}}}});res.json(user);}));
app.post('/api/workspaces/:id/members',asyncRoute(async(req,res)=>{
  isOwner(req);if(id(req.params.id)!==auth(req).workspaceId)throw new HttpError(404,'Workspace not found');
  const body=z.object({email:z.string().email().transform(v=>v.toLowerCase()),role:z.enum(['editor','viewer'])}).parse(req.body);
  const user=await db.user.findUnique({where:{email:body.email}});if(!user)throw new HttpError(404,'User must register first');
  if(user.id===auth(req).userId)throw new HttpError(400,'You cannot change your own role here');
  const member=await db.membership.upsert({where:{userId_workspaceId:{userId:user.id,workspaceId:auth(req).workspaceId}},create:{userId:user.id,workspaceId:auth(req).workspaceId,role:body.role},update:{role:body.role}});
  await audit(req,'membership.upserted',user.id);res.status(201).json(member);
}));
app.get('/api/workspaces/:id/members',asyncRoute(async(req,res)=>{if(id(req.params.id)!==auth(req).workspaceId)throw new HttpError(404,'Workspace not found');res.json(await db.membership.findMany({where:{workspaceId:auth(req).workspaceId},select:{role:true,user:{select:{id:true,name:true,email:true}}}}));}));
app.get('/api/credentials',asyncRoute(async(req,res)=>{res.json(await db.credential.findMany({where:{workspaceId:auth(req).workspaceId},select:{id:true,name:true,kind:true,createdAt:true},orderBy:{createdAt:'desc'}}));}));
app.post('/api/credentials',asyncRoute(async(req,res)=>{
  canEdit(req);const body=z.object({name:z.string().trim().min(1).max(80),kind:z.enum(['httpBearer','slack','github']),secret:z.string().min(1).max(10000)}).parse(req.body);
  const credential=await db.credential.create({data:{workspaceId:auth(req).workspaceId,name:body.name,kind:body.kind,ciphertext:encrypt(body.secret)}});
  await audit(req,'credential.created',credential.id);res.status(201).json({id:credential.id,name:credential.name,kind:credential.kind,createdAt:credential.createdAt});
}));
app.delete('/api/credentials/:id',asyncRoute(async(req,res)=>{isOwner(req);const credential=await db.credential.findFirst({where:{id:id(req.params.id),workspaceId:auth(req).workspaceId}});if(!credential)throw new HttpError(404,'Credential not found');await db.credential.delete({where:{id:credential.id}});await audit(req,'credential.deleted',credential.id);res.status(204).end();}));
app.get('/api/nodes',(_req,res)=>res.json(Object.values(nodeDefinitions).map(({kind,label,description,version})=>({kind,label,description,version}))));
app.get('/api/models',asyncRoute(async(_req,res)=>{
  try{
    const response=await fetch(`${process.env.OLLAMA_BASE_URL??'http://127.0.0.1:11434'}/api/tags`,{signal:AbortSignal.timeout(2000)});
    if(!response.ok)throw new Error('Ollama unavailable');
    const data=await response.json() as {models?:{name:string}[]};
    res.json({provider:'ollama',available:true,models:(data.models??[]).map(model=>model.name)});
  }catch{res.json({provider:'ollama',available:false,models:[]});}
}));
app.get('/api/workflows',asyncRoute(async(req,res)=>{res.json(await db.workflow.findMany({where:{workspaceId:auth(req).workspaceId},orderBy:{updatedAt:'desc'},select:{id:true,name:true,version:true,updatedAt:true}}));}));
app.post('/api/workflows',asyncRoute(async(req,res)=>{
  canEdit(req);const body=z.object({name:z.string().trim().min(1).max(100)}).parse(req.body);
  const draft={nodes:[{id:'start',kind:'manual',position:{x:80,y:160},config:{}}],edges:[]};
  const workflow=await db.workflow.create({data:{workspaceId:auth(req).workspaceId,name:body.name,draft}});
  await audit(req,'workflow.created',workflow.id);res.status(201).json(workflow);
}));
app.get('/api/workflows/:id',asyncRoute(async(req,res)=>{
  const workflow=await db.workflow.findFirst({where:{id:id(req.params.id),workspaceId:auth(req).workspaceId},include:{versions:{orderBy:{number:'desc'},take:10}}});
  if(!workflow)throw new HttpError(404,'Workflow not found');res.json(workflow);
}));
app.put('/api/workflows/:id/draft',asyncRoute(async(req,res)=>{
  canEdit(req);const workflowId=id(req.params.id);await scopedWorkflow(req,workflowId);
  const body=z.object({name:z.string().trim().min(1).max(100),graph:graphSchema}).parse(req.body);
  const workflow=await db.workflow.update({where:{id:workflowId},data:{name:body.name,draft:json(body.graph)}});
  await audit(req,'workflow.draft.updated',workflowId);res.json(workflow);
}));
app.post('/api/workflows/:id/publish',asyncRoute(async(req,res)=>{
  canEdit(req);const workflowId=id(req.params.id);const workflow=await scopedWorkflow(req,workflowId);const graph:WorkflowGraph=validateGraph(workflow.draft);
  const credentialIds=graph.nodes.map(n=>n.config.credentialId).filter((v):v is string=>typeof v==='string');
  if(credentialIds.length){const found=await db.credential.findMany({where:{id:{in:credentialIds},workspaceId:auth(req).workspaceId},select:{id:true}});if(found.length!==new Set(credentialIds).size)throw new HttpError(400,'A node references an unavailable credential');}
  const version=await db.$transaction(async tx=>{
    const updated=await tx.workflow.update({where:{id:workflowId},data:{version:{increment:1}}});
    const result=await tx.workflowVersion.create({data:{workflowId,number:updated.version,graph:json(graph)}});
    if(graph.nodes.some(n=>n.kind==='webhook')){
      const existing=await tx.webhookSecret.findUnique({where:{workflowId}});
      if(!existing)await tx.webhookSecret.create({data:{workflowId,ciphertext:encrypt(randomBytes(32).toString('base64url'))}});
    }
    return result;
  });
  const trigger=graph.nodes.find(n=>n.kind==='schedule');
  if(trigger)await queue.upsertJobScheduler(workflowId,{every:Number(trigger.config.everyMinutes)*60000},{name:'schedule',data:{workflowId},opts:{attempts:3,backoff:{type:'exponential',delay:1000},removeOnComplete:1000,removeOnFail:1000}});
  else await queue.removeJobScheduler(workflowId);
  await audit(req,'workflow.published',version.id);res.status(201).json(version);
}));
app.get('/api/workflows/:id/webhook',asyncRoute(async(req,res)=>{
  canEdit(req);const workflowId=id(req.params.id);await scopedWorkflow(req,workflowId);
  const endpoint=await db.webhookSecret.findUnique({where:{workflowId}});if(!endpoint)throw new HttpError(404,'Publish a webhook workflow first');
  res.setHeader('Cache-Control','no-store');await audit(req,'webhook.secret.viewed',workflowId);
  res.json({url:`${process.env.PUBLIC_API_URL??'http://localhost:4000'}/hooks/${workflowId}`,secret:decrypt(endpoint.ciphertext),signature:'sha256=HMAC_SHA256(secret, timestamp + \".\" + rawBody)'});
}));
app.get('/api/workflows/:id/schedule',asyncRoute(async(req,res)=>{const workflowId=id(req.params.id);await scopedWorkflow(req,workflowId);const scheduler=await queue.getJobScheduler(workflowId);res.json({active:!!scheduler,nextRunAt:scheduler?.next??null});}));
app.post('/api/workflows/:id/runs',asyncRoute(async(req,res)=>{
  canEdit(req);const workflowId=id(req.params.id);await scopedWorkflow(req,workflowId);
  const body=z.object({input:z.string().max(10000)}).parse(req.body);
  const version=await db.workflowVersion.findFirst({where:{workflowId},orderBy:{number:'desc'}});if(!version)throw new HttpError(409,'Publish the workflow before running it');
  const run=await db.run.create({data:{workflowId,versionId:version.id,input:body.input}});await enqueue(run.id);await audit(req,'run.created',run.id);res.status(202).json(run);
}));
app.get('/api/workflows/:id/runs',asyncRoute(async(req,res)=>{const workflowId=id(req.params.id);await scopedWorkflow(req,workflowId);res.json(await db.run.findMany({where:{workflowId},orderBy:{createdAt:'desc'},take:30,include:{version:{select:{number:true}}}}));}));
app.get('/api/runs',asyncRoute(async(req,res)=>{res.json(await db.run.findMany({where:{workflow:{workspaceId:auth(req).workspaceId}},orderBy:{createdAt:'desc'},take:50,include:{workflow:{select:{id:true,name:true}},version:{select:{number:true}}}}));}));
app.get('/api/approvals',asyncRoute(async(req,res)=>{
  res.json(await db.approval.findMany({where:{run:{workflow:{workspaceId:auth(req).workspaceId}}},orderBy:{createdAt:'desc'},take:100,include:{run:{select:{id:true,input:true,status:true,workflow:{select:{id:true,name:true}}}}}}));
}));
app.post('/api/approvals/:id/decision',asyncRoute(async(req,res)=>{
  canEdit(req);
  const approvalId=id(req.params.id);
  const {decision}=z.object({decision:z.enum(['approved','rejected'])}).parse(req.body);
  const approval=await db.approval.findFirst({where:{id:approvalId,run:{workflow:{workspaceId:auth(req).workspaceId}}}});
  if(!approval)throw new HttpError(404,'Approval not found');
  if(approval.status!=='pending')throw new HttpError(409,'Approval has already been decided');
  const updated=await db.$transaction(async tx=>{
    const changed=await tx.approval.updateMany({where:{id:approvalId,status:'pending'},data:{status:decision,decidedBy:auth(req).userId,decidedAt:new Date()}});
    if(!changed.count)return false;
    const step=await tx.runStep.findUniqueOrThrow({where:{runId_nodeId:{runId:approval.runId,nodeId:approval.nodeId}}});
    await tx.runStep.update({where:{id:step.id},data:{status:'succeeded',output:step.input,route:decision==='approved'?'true':'false',finishedAt:new Date()}});
    await tx.run.update({where:{id:approval.runId},data:{status:'queued'}});
    return true;
  });
  if(!updated)throw new HttpError(409,'Approval has already been decided');
  await queue.add('resume',{runId:approval.runId},{jobId:`resume-${approval.id}`,attempts:3,backoff:{type:'exponential',delay:1000},removeOnComplete:1000});
  await audit(req,`approval.${decision}`,approval.id);
  res.json({id:approval.id,status:decision});
}));
app.get('/api/runs/:id',asyncRoute(async(req,res)=>{
  const run=await db.run.findFirst({where:{id:id(req.params.id),workflow:{workspaceId:auth(req).workspaceId}},include:{steps:{orderBy:{startedAt:'asc'}},version:{select:{number:true}}}});
  if(!run)throw new HttpError(404,'Run not found');res.json(run);
}));
app.get('/api/runs/:id/events',asyncRoute(async(req,res)=>{
  const runId=id(req.params.id);const allowed=await db.run.findFirst({where:{id:runId,workflow:{workspaceId:auth(req).workspaceId}},select:{id:true}});if(!allowed)throw new HttpError(404,'Run not found');
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.flushHeaders();
  const send=async()=>{const run=await db.run.findUnique({where:{id:runId},include:{steps:true}});res.write(`data: ${JSON.stringify(run)}\n\n`);if(['succeeded','failed','needs_review'].includes(run?.status??'')){clearInterval(timer);res.end();}};
  const timer=setInterval(()=>{void send().catch(()=>{clearInterval(timer);res.end();});},1000);req.on('close',()=>clearInterval(timer));await send();
}));
app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(error instanceof HttpError)return void res.status(error.status).json({error:error.message});
  if(error instanceof ZodError)return void res.status(400).json({error:'Invalid request',issues:error.issues});
  if(error instanceof Error&&error.name==='GraphValidationError')return void res.status(400).json({error:error.message});
  console.error(error);res.status(500).json({error:'Internal server error'});
});
const port=Number(process.env.PORT??4000);app.listen(port,()=>console.log(`API listening on ${port}`));
