import { privateResponse, mutationAllowed, readSession, ROLES } from '../lib/security.mjs';
import { revokeDevice } from '../lib/credential-store.mjs';
import { ready, challengeFor, maskEmail, beginSetup, startPasswordLogin, completeChallenge, accountInfo, freshKakao } from '../lib/password-auth.mjs';

async function bodyOf(req) {
  if(req.body) {
    if(Buffer.byteLength(typeof req.body==='string'?req.body:JSON.stringify(req.body))>8192)throw Error('invalid_request');
    return typeof req.body==='string'?JSON.parse(req.body):req.body;
  }
  let raw='';
  for await(const part of req) {raw+=part;if(Buffer.byteLength(raw)>8192)throw Error('invalid_request');}
  return JSON.parse(raw || '{}');
}
export default async function handler(req,res) {
  privateResponse(res);
  try {
    const action=req.query?.action || 'account';
    const userFor = async () => {
      if(req.headers?.['sec-fetch-site']==='cross-site' || (req.headers?.origin && req.headers.origin!=='https://sewang-monitor.vercel.app'))throw Error('permission_required');
      const user=await readSession(req);
      if(!user)throw Error('login_required');
      if(!ROLES.includes(user.r))throw Error('permission_required');
      return user;
    };
    if(req.method==='GET') {
      if(action==='status')return res.status(200).json({ready:ready()});
      if(action==='challenge') {
        const {challenge:c}=await challengeFor(req);
        return res.status(200).json({ok:true,email:maskEmail(c.email),mode:c.mode,verified:!!c.verified});
      }
      if(action==='account')return res.status(200).json(await accountInfo(req,await userFor()));
      return res.status(404).json({error:'not_found'});
    }
    if(!mutationAllowed(req,res))return;
    const body=await bodyOf(req);
    if(!body || typeof body!=='object' || Array.isArray(body))throw Error('invalid_request');
    if(action==='setup' || action==='change')return res.status(200).json(await beginSetup(req,res,await userFor(),body,action==='change'));
    if(action==='login')return res.status(200).json(await startPasswordLogin(req,res,body));
    if(action==='verify' || action==='replace') {
      const result=await completeChallenge(req,res,body,async()=>{const user=await userFor();freshKakao(user);return user;});
      return res.status(result.ok?200:409).json(result);
    }
    if(action==='revoke') {
      const user=await userFor();
      if(!/^[a-f0-9]{64}$/.test(body.deviceId || ''))throw Error('device_not_found');
      await revokeDevice(user.id,body.deviceId);
      return res.status(200).json({ok:true,current:body.deviceId===user.did});
    }
    return res.status(404).json({error:'not_found'});
  } catch(error) {
    const known=['invalid_username','invalid_email','invalid_password','invalid_login','login_required','permission_required','reauthentication_required','too_many_attempts','verification_expired','invalid_code','device_not_found','account_already_configured','account_not_configured','username_unavailable','email_unavailable','email_delivery_failed','auth_storage_unavailable','invalid_request'];
    const message=known.includes(error.message)?error.message:'service_unavailable';
    const status=message==='login_required'||message==='invalid_login'?401:message==='permission_required'?403:message==='too_many_attempts'?429:message.endsWith('unavailable')||message==='email_delivery_failed'?503:400;
    return res.status(status).json({error:message});
  }
}
