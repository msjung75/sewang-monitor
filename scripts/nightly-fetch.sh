#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${BASE_URL:-https://sewang-monitor.vercel.app}"
FROM_DATE=$(date -u -d "30 days ago" +%Y%m%d)
TO_DATE=$(date -u +%Y%m%d)
REGIONS=(seoul gyeonggi busan daegu incheon gwangju daejeon ulsan sejong gangwon chungbuk chungnam jeonbuk jeonnam gyeongbuk gyeongnam jeju)
mkdir -p data/tmp
rm -f data/tmp/*.json
for r in "${REGIONS[@]}"; do
  echo "::group::region $r"
  node scripts/collect-permits.mjs "from=$FROM_DATE&to=$TO_DATE&region=$r&type=all&maxPages=50" > "data/tmp/$r.json" || echo "$r failed"
  ls -la "data/tmp/$r.json" 2>/dev/null || true
  echo "::endgroup::"
  sleep 2
done
python3 << 'PYEOF'
import json, datetime, os, sys
sys.path.insert(0, 'scripts')
from permit_client import read_complete_regions
regions='seoul gyeonggi busan daegu incheon gwangju daejeon ulsan sejong gangwon chungbuk chungnam jeonbuk jeonnam gyeongbuk gyeongnam jeju'.split()
all_items=read_complete_regions('data/tmp', regions)
if not all_items:
    raise SystemExit('No nationwide records; preserving the previous snapshot')
byDay={}; failures=[]
for it in all_items:
    pd=it.get('permitDate')
    if pd: byDay[pd]=byDay.get(pd,0)+1
out={'at':datetime.datetime.utcnow().isoformat()+'Z','stores':all_items,'byDay':byDay,'count':len(all_items),'failures':failures}
os.makedirs('data',exist_ok=True)
with open('data/trend30_all.json.tmp','w',encoding='utf-8') as f:
    json.dump(out,f,ensure_ascii=False,separators=(',',':'))
os.replace('data/trend30_all.json.tmp','data/trend30_all.json')
print(f'merged: {len(all_items)} stores, {len(byDay)} days, failures: {failures}')
PYEOF
rm -rf data/tmp
ls -la data/trend30_all.json
