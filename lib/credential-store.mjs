import { createHash } from 'node:crypto';
import { privateCommand } from './access-store.mjs';

const PREFIX = 'sewang:auth:password:v1:{auth}:';
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const credentialKey = id => PREFIX + 'user:' + id;
export const devicesKey = id => PREFIX + 'devices:' + id;
export const loginKey = username => PREFIX + 'login:' + digest(username);
export const challengeKey = token => PREFIX + 'challenge:' + digest(token);
export async function storedJson(key, options) {
  const value = await privateCommand(['GET', key], options);
  if (value == null) return null;
  try { return JSON.parse(value); } catch { throw Error('auth_storage_unavailable'); }
}
export const readCredential = (id, options) => storedJson(credentialKey(id), options);
export const readDevices = async (id, options) => await storedJson(devicesKey(id), options) || {};
export const evalStore = async (script, keys, args = [], options) => {
  const value = await privateCommand(['EVAL', script, keys.length, ...keys, ...args.map(String)], options);
  return typeof value === 'string' ? JSON.parse(value) : value;
};

export async function rateLimit(name, limit, seconds, options) {
  const count = await privateCommand(['EVAL', `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`, 1, PREFIX+'rate:'+digest(name), seconds], options);
  if (Number(count) > limit) throw Error('too_many_attempts');
}

export const VERIFY_CODE = `
local raw=redis.call('GET',KEYS[1]); if not raw then return cjson.encode({error='verification_expired'}) end
local c=cjson.decode(raw); if c.verified then return cjson.encode({ok=true}) end
c.attempts=(c.attempts or 0)+1
if c.attempts>5 then redis.call('DEL',KEYS[1]); return cjson.encode({error='verification_expired'}) end
if c.codeHash~=ARGV[1] then
 if c.attempts>=5 then redis.call('DEL',KEYS[1]) else redis.call('SET',KEYS[1],cjson.encode(c),'KEEPTTL') end
 return cjson.encode({error='invalid_code'})
end
c.verified=true; c.codeHash=nil; redis.call('SET',KEYS[1],cjson.encode(c),'KEEPTTL'); return cjson.encode({ok=true})`;

// One transaction consumes the proof, claims the username and reserves one of two device slots.
export const COMPLETE_LOGIN = `
local raw=redis.call('GET',KEYS[1]); if not raw then return cjson.encode({error='verification_expired'}) end
local c=cjson.decode(raw); if not c.verified then return cjson.encode({error='verification_required'}) end
local current=redis.call('GET',KEYS[2]); local account=current and cjson.decode(current) or nil
if c.mode=='setup' then
 if account then return cjson.encode({error='account_already_configured'}) end
 local owner=redis.call('GET',KEYS[3]); if owner and owner~=c.id then return cjson.encode({error='username_unavailable'}) end
else
 if not account or account.version~=c.expectedVersion then return cjson.encode({error='verification_expired'}) end
end
local now=tonumber(ARGV[1]); local devices={}; local dRaw=redis.call('GET',KEYS[4]);
if dRaw and c.mode~='change' then
 for k,v in pairs(cjson.decode(dRaw)) do if v.trustedUntil>now then devices[k]=v end end
end
local device=c.deviceId; local replace=ARGV[4]
if replace~='' then
 if not devices[replace] or replace==device then return cjson.encode({error='device_not_found'}) end
 devices[replace]=nil
end
local count=0; for k,v in pairs(devices) do count=count+1 end
if not devices[device] and count>=2 then
 local rows={}; for k,v in pairs(devices) do table.insert(rows,{id=k,name=v.name,lastLogin=v.lastLogin}) end
 return cjson.encode({error='device_limit',devices=rows})
end
local previous=devices[device]
devices[device]={name=c.deviceName,createdAt=previous and previous.createdAt or now,lastLogin=now,trustedUntil=now+2592000,sid=ARGV[2],sessionExpires=now+86400}
if c.mode=='setup' or c.mode=='change' then
 account={id=c.id,username=c.username,email=c.email,passwordHash=c.passwordHash,version=c.version}
 redis.call('SET',KEYS[2],cjson.encode(account)); redis.call('SET',KEYS[3],c.id)
end
redis.call('SET',KEYS[4],cjson.encode(devices),'EX',2592000)
redis.call('DEL',KEYS[1]); return cjson.encode({ok=true,version=account.version})`;

export const TRUSTED_LOGIN = `
local raw=redis.call('GET',KEYS[1]); local dRaw=redis.call('GET',KEYS[2]);
if not raw or not dRaw then return cjson.encode({error='verification_required'}) end
local c=cjson.decode(raw); if c.version~=ARGV[1] then return cjson.encode({error='verification_required'}) end
local devices=cjson.decode(dRaw); local d=devices[ARGV[2]]; local now=tonumber(ARGV[3])
if not d or d.trustedUntil<=now then return cjson.encode({error='verification_required'}) end
d.sid=ARGV[4]; d.sessionExpires=now+86400; d.lastLogin=now
redis.call('SET',KEYS[2],cjson.encode(devices),'EX',2592000); return cjson.encode({ok=true,version=c.version})`;

export async function managedSessionValid(payload, options) {
  const account = await readCredential(payload.id, options);
  if (!account) return !payload.sid;
  if (payload.cv !== account.version || !/^[a-f0-9]{64}$/.test(payload.sid || '') || !/^[a-f0-9]{64}$/.test(payload.did || '')) return false;
  const device = (await readDevices(payload.id, options))[payload.did];
  const now = Math.floor(Date.now()/1000);
  return !!device && device.sid === payload.sid && device.sessionExpires > now && device.trustedUntil > now;
}
export async function revokeDevice(id, deviceId, options) {
  return evalStore(`local raw=redis.call('GET',KEYS[1]); if not raw then return cjson.encode({ok=true}) end
local d=cjson.decode(raw); d[ARGV[1]]=nil; redis.call('SET',KEYS[1],cjson.encode(d),'KEEPTTL'); return cjson.encode({ok=true})`, [devicesKey(id)], [deviceId], options);
}
