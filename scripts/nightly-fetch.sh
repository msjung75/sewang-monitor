#!/usr/bin/env bash
set -uo pipefail
BASE_URL="${BASE_URL:-https://sewang-monitor.vercel.app}"
FROM_DATE=$(date -u -d "30 days ago" +%Y%m%d)
TO_DATE=$(date -u +%Y%m%d)
REGIONS=(seoul gyeonggi busan daegu incheon gwangju daejeon ulsan sejong gangwon chungbuk chungnam jeonbuk jeonnam gyeongbuk gyeongnam jeju)
mkdir -p data/tmp
rm -f data/tmp/*.json
for r in "${REGIONS[@]}"; do
  echo "::group::region $r"
  curl -sS --max-time 90 "$BASE_URL/api/permits?from=$FROM_DATE&to=$TO_DATE&region=$r&type=all&maxPages=10" -o "data/tmp/$r.json" || echo "$r failed"
  ls -la "data/tmp/$r.json" 2>/dev/null || true
  echo "::endgroup::"
  sleep 2
done
python3 << 'PYEOF'
import json, glob, datetime, os
all_items=[]; seen=set(); byDay={}; failures=[]
for f in sorted(glob.glob('data/tmp/*.json')):
    region=os.path.basename(f).replace('.json','')
    try:
        d=json.load(open(f))
        items=d.get('items',[])
        if not items and not d.get('count'):
            failures.append(region); continue
        for it in items:
            iid=it.get('id')
            if iid and iid not in seen:
                seen.add(iid); all_items.append(it)
                pd=it.get('permitDate')
                if pd: byDay[pd]=byDay.get(pd,0)+1
    except Exception as e:
        print(f'{region} parse fail: {e}'); failures.append(region)
out={'at':datetime.datetime.utcnow().isoformat()+'Z','stores':all_items,'byDay':byDay,'count':len(all_items),'failures':failures}
os.makedirs('data',exist_ok=True)
with open('data/trend30_all.json','w',encoding='utf-8') as f:
    json.dump(out,f,ensure_ascii=False,separators=(',',':'))
print(f'merged: {len(all_items)} stores, {len(byDay)} days, failures: {failures}')
PYEOF
rm -rf data/tmp
ls -la data/trend30_all.json
