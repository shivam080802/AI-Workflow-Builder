import {createCipheriv,createDecipheriv,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {isIP} from 'node:net';

function key():Buffer {
  const encoded=process.env.SECRET_ENCRYPTION_KEY;
  if (!encoded) throw new Error('SECRET_ENCRYPTION_KEY must be set');
  const value=Buffer.from(encoded,'base64');
  if (value.length!==32) throw new Error('SECRET_ENCRYPTION_KEY must be 32 base64-encoded bytes');
  return value;
}
export function encrypt(value:string):string {
  const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key(),iv);
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
}
export function decrypt(value:string):string {
  const bytes=Buffer.from(value,'base64');const decipher=createDecipheriv('aes-256-gcm',key(),bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
}
export function signWebhook(secret:string,timestamp:string,body:Buffer):string {
  return createHmac('sha256',secret).update(timestamp).update('.').update(body).digest('hex');
}
export function validWebhookSignature(secret:string,timestamp:string,body:Buffer,signature:string):boolean {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const provided=Buffer.from(signature.slice(7),'hex');const expected=Buffer.from(signWebhook(secret,timestamp,body),'hex');
  return timingSafeEqual(provided,expected);
}
export function isPublicAddress(address:string):boolean {
  if (isIP(address)===4) {
    const [a=0,b=0,c=0]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&b>=18&&b<=19||a===192&&b===0&&c===0);
  }
  if (isIP(address)===6) {
    const first=parseInt(address.split(':')[0]||'0',16);
    return first>=0x2000&&first<=0x3fff;
  }
  return false;
}
export async function safeHttpRequest(input:{url:string;method:'GET'|'POST'|'PUT'|'PATCH';body?:string;bearer?:string}):Promise<string> {
  const url=new URL(input.url);
  if (url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443') throw new Error('Only standard HTTPS URLs are allowed');
  const answers=await lookup(url.hostname,{all:true,verbatim:true});
  if (!answers.length||answers.some(answer=>!isPublicAddress(answer.address))) throw new Error('Private or unsafe destinations are blocked');
  const chosen=answers[0]!;
  const body=input.body??'';
  if (Buffer.byteLength(body)>1_000_000) throw new Error('Request body too large');
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:input.method,timeout:10000,lookup:(_hostname,_options,callback)=>callback(null,chosen.address,chosen.family),headers:{'Content-Type':'application/json','User-Agent':'AI-Workflow-Builder/1.0',...(input.bearer?{Authorization:`Bearer ${input.bearer}`}:{})}},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1_000_000){req.destroy(new Error('Response too large'));return;}chunks.push(chunk);});
      res.on('end',()=>{
        const content=Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode??500)>=300) reject(new Error(`HTTP action returned ${res.statusCode}`));
        else resolve(content);
      });
    });
    req.on('timeout',()=>req.destroy(new Error('HTTP action timed out')));
    req.on('error',reject);
    if (body) req.write(body);
    req.end();
  });
}
