import { scrypt, randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT } from 'jose';
import { privateCommand, privateAccessConfigured } from './access-store.mjs';
import { sessionKey, cookies, allowlist, currentRole, ROLES, SESSION_OPTIONS } from './security.mjs';
import { digest, credentialKey, devicesKey, loginKey, challengeKey, storedJson, readCredential, readDevices, rateLimit, evalStore, COMPLETE_LOGIN, VERIFY_CODE, TRUSTED_LOGIN } from './credential-store.mjs';

const derive = promisify(scrypt);
const SCRYPT = {N:131072,r:8,p:1,maxmem:192*1024*1024};
export const nowSeconds = () => Math.floor(Date.now()/1000);
export const randomToken = () => randomBytes(32).toString('hex');
const TOKEN = /^[a-f0-9]{64}$/;
export function username(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._-]{3,39}$/.test(v)) throw Error('invalid_username');
  return v;
}
export function email(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (v.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v)) throw Error('invalid_email');
  return v;
}
export function passwordPolicy(value) {
  if (typeof value !== 'string' || [...value].length < 15 || [...value].length > 128 || Buffer.byteLength(value) > 1024 || /^(.)\1+$/.test(value) || ['passwordpassword','123456789012345','qwertyuiopasdfgh'].includes(value.toLowerCase())) throw Error('invalid_password');
}
export async function hashPassword(value) {
  passwordPolicy(value);
  const salt = randomBytes(16).toString('hex');
  const key = await derive(value, salt, 32, SCRYPT);
  return `scrypt$131072$8$1$${salt}$${key.toString('hex')}`;
}
export async function checkPassword(value, hash) {
  if (typeof value !== 'string' || Buffer.byteLength(value)>1024) return false;
  const parts = String(hash).split('$');
  if (parts.length!==6 || parts.slice(0,4).join('$')!=='scrypt$131072$8$1' || !/^[a-f0-9]{32}$/.test(parts[4]) || !TOKEN.test(parts[5])) throw Error('auth_storage_unavailable');
  const actual = await derive(value,parts[4],32,SCRYPT);
  return timingSafeEqual(actual,Buffer.from(parts[5],'hex'));
}
const hmac = value => createHmac('sha256',sessionKey()).update(value).digest('hex');
export const maskEmail = value => value.replace(/^(.)([^@]*)(@.*)$/, '$1***$3');
export function secureCookie(name,value,age) {return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;}
export function deviceToken(req) {
  const token = cookies(req.headers?.cookie).sewang_device;
  return TOKEN.test(token || '') ? token : randomToken();
}
export function deviceName(value, req) {
  if(typeof value==='string' && value.trim())return value.trim().replace(/[\x00-\x1f]/g,'').slice(0,50);
  const agent = String(req.headers?.['user-agent'] || '');
  return /Android/.test(agent)?'Android 휴대폰':/iPhone|iPad/.test(agent)?'iPhone / iPad':/Mac/.test(agent)?'Mac 브라우저':/Windows/.test(agent)?'Windows 브라우저':'웹 브라우저';
}
export const ready = () => privateAccessConfigured() && !!process.env.RESEND_API_KEY;
async function sendCode(address, code) {
  if (!process.env.RESEND_API_KEY) throw Error('email_unavailable');
  const response = await fetch('https://api.resend.com/emails', {
    method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({from:process.env.AUTH_EMAIL_FROM || 'sewang-monitor <onboarding@resend.dev>',to:[address],subject:'[세왕] 로그인 인증번호',text:`세왕 앱 인증번호는 ${code} 입니다.\n10분 안에 앱에서 입력해 주세요. 다른 사람에게 알려주지 마세요.\n본인이 요청하지 않았다면 이 메일을 무시하세요.`}),
    signal:AbortSignal.timeout(10000)
  });
  if(!response.ok)throw Error('email_delivery_failed');
}
export async function beginChallenge(req,res,details) {
  if(!ready())throw Error('email_unavailable');
  await rateLimit('email:'+details.id,3,600);
  const token=randomToken(),code=String(randomInt(1000000)).padStart(6,'0'),device=deviceToken(req);
  const challenge={...details,deviceId:digest(device),deviceName:deviceName(details.deviceName,req),codeHash:hmac(token+':'+code),attempts:0,verified:false};
  await privateCommand(['SET',challengeKey(token),JSON.stringify(challenge),'EX',600]);
  try {await sendCode(details.email,code);} catch(e){await privateCommand(['DEL',challengeKey(token)]);throw e;}
  res.setHeader('Set-Cookie',[secureCookie('sewang_challenge',token,600),secureCookie('sewang_device',device,2592000)]);
  return {ok:true,verification_required:true,email:maskEmail(details.email),mode:details.mode};
}
export async function challengeFor(req) {
  const token=cookies(req.headers?.cookie).sewang_challenge;
  if(!TOKEN.test(token || ''))throw Error('verification_expired');
  const challenge=await storedJson(challengeKey(token));
  if(!challenge)throw Error('verification_expired');
  // The proof is bound to the same browser device cookie, never an arbitrary request ID.
  const device=cookies(req.headers?.cookie).sewang_device;
  if(!TOKEN.test(device || '') || digest(device)!==challenge.deviceId)throw Error('verification_expired');
  return {token,challenge,device};
}
export async function liveUser(id, nickname='', profile='') {
  const list=await allowlist(),role=currentRole(id,list);
  if(!ROLES.includes(role))throw Error('permission_required');
  const entry=list.users.find(u=>String(u.id)===String(id));
  return {id,n:nickname || entry?.nickname || '사용자',p:profile || entry?.profile || '',r:role};
}
export async function issueManagedSession(res,user,version,sid,device) {
  const jwt=await new SignJWT({...user,cv:version,sid,did:digest(device),auth_method:user.auth_method==='kakao'?'kakao':'password'})
    .setProtectedHeader({alg:'HS256'}).setIssuer(SESSION_OPTIONS.issuer).setAudience(SESSION_OPTIONS.audience)
    .setIssuedAt().setExpirationTime('24h').sign(sessionKey());
  res.setHeader('Set-Cookie',[secureCookie('sewang_session',jwt,86400),secureCookie('sewang_device',device,2592000),secureCookie('sewang_challenge','',0)]);
}
export async function trustedLogin(req,res,account,user) {
  const device=cookies(req.headers?.cookie).sewang_device;
  if(!TOKEN.test(device || ''))return false;
  const sid=randomToken();
  const result=await evalStore(TRUSTED_LOGIN,[credentialKey(account.id),devicesKey(account.id)],[account.version,digest(device),nowSeconds(),sid]);
  if(!result.ok)return false;
  await issueManagedSession(res,user,account.version,sid,device);
  return true;
}
let dummyHash;
export async function startPasswordLogin(req,res,body) {
  const name=username(body.username);
  await rateLimit('login-user:'+name,8,900);
  const ip=String(req.headers?.['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown');
  await rateLimit('login-ip:'+hmac(ip),30,900);
  const id=await privateCommand(['GET',loginKey(name)]);
  const account=/^\d+$/.test(String(id || ''))?await readCredential(id):null;
  if(!dummyHash)dummyHash=await hashPassword('fixture-unusable-password-'+randomToken());
  const correct=await checkPassword(body.password,account?.passwordHash || dummyHash);
  if(!account || !correct)throw Error('invalid_login');
  const user=await liveUser(account.id);
  if(await trustedLogin(req,res,account,user))return {ok:true};
  return beginChallenge(req,res,{mode:'login',id:account.id,username:account.username,email:account.email,expectedVersion:account.version,n:user.n,p:user.p,deviceName:body.deviceName});
}
export async function completeChallenge(req,res,body,authenticateSetup) {
  const {token,challenge:c,device}=await challengeFor(req);
  if(c.mode!=='login') {
    const user=await authenticateSetup();
    if(!user || String(user.id)!==String(c.id))throw Error('permission_required');
  }
  const user=await liveUser(c.id,c.n || '',c.p || '');
  user.auth_method=c.authMethod;
  if(!c.verified) {
    if(!/^\d{6}$/.test(String(body.code || '')))throw Error('invalid_code');
    const checked=await evalStore(VERIFY_CODE,[challengeKey(token)],[hmac(token+':'+body.code)]);
    if(!checked.ok)throw Error(checked.error);
  }
  const sid=randomToken();
  const replace=body.replaceDeviceId || '';
  if(replace && !TOKEN.test(replace))throw Error('device_not_found');
  const result=await evalStore(COMPLETE_LOGIN,[challengeKey(token),credentialKey(c.id),loginKey(c.username),devicesKey(c.id)],[nowSeconds(),sid,'',replace]);
  if(!result.ok)return result;
  await issueManagedSession(res,user,result.version,sid,device);
  return {ok:true};
}
export function freshKakao(user) {
  if(user.auth_method==='password' || nowSeconds() - Number(user.iat || 0) > 600)throw Error('reauthentication_required');
}
export async function beginSetup(req,res,user,body,change=false) {
  freshKakao(user);
  await rateLimit('setup:'+user.id,3,600);
  const current=await readCredential(user.id);
  if(current && !change)throw Error('account_already_configured');
  if(!current && change)throw Error('account_not_configured');
  const name=current?current.username:username(body.username);
  const address=current?current.email:email(body.email);
  const existing=await privateCommand(['GET',loginKey(name)]);
  if(existing && String(existing)!==String(user.id))throw Error('username_unavailable');
  const passwordHash=await hashPassword(body.password);
  return beginChallenge(req,res,{mode:change?'change':'setup',id:String(user.id),username:name,email:address,passwordHash,version:randomToken(),expectedVersion:current?.version,n:user.n,p:user.p,deviceName:body.deviceName});
}
export async function managedKakaoLogin(req,res,user) {
  const account=await readCredential(user.id);
  if(!account)return false;
  if(await trustedLogin(req,res,account,{...user,auth_method:'kakao'}))return 'complete';
  await beginChallenge(req,res,{mode:'login',authMethod:'kakao',id:String(user.id),username:account.username,email:account.email,expectedVersion:account.version,n:user.n,p:user.p});
  return 'verify';
}
export async function accountInfo(req,user) {
  const account=await readCredential(user.id);
  const device=cookies(req.headers?.cookie).sewang_device;
  const current=user.did || (TOKEN.test(device || '')?digest(device):'');
  const devices=Object.entries(await readDevices(user.id)).filter(([,d])=>d.trustedUntil>nowSeconds()).map(([id,d])=>({id,name:d.name,lastLogin:d.lastLogin,current:id===current}));
  return {ok:true,configured:!!account,ready:ready(),username:account?.username,email:account?.email,devices,recentKakao:user.auth_method!=='password' && nowSeconds()-Number(user.iat || 0)<=600};
}
