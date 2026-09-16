import { requireReadUser } from '../lib/security.mjs';
import { collectPermits } from '../lib/permit-source.mjs';

export default async function handler(req,res){
  if(!await requireReadUser(req,res))return;
  try{
    const data=await collectPermits(req.query,process.env.DATA_GO_KR_KEY);
    return res.status(200).json(data);
  }catch(e){
    return res.status(e.status||502).json({error:e.status===400?e.message:'upstream_request_failed'});
  }
}
