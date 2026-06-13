#!/usr/bin/env bash
# YTD 데이터 fetch — FROM_DATE / TO_DATE 환경변수 받음 (yyyymmdd)
# 결과를 data/ytd_2026/{yyyymm}.json에 append/upsert (id 기준 dedupe)
set -uo pipefail
BASE_URL="${BASE_URL:-https://sewang-monitor.vercel.app}"
FROM_DATE="${FROM_DATE:-$(date -u -d 'yesterday' +%Y%m%d)}"
TO_DATE="${TO_DATE:-$FROM_DATE}"
REGIONS=(seoul gyeonggi busan daegu incheon gwangju daejeon ulsan sejong gangwon chungbuk chungnam jeonbuk jeonnam gyeongbuk gyeongnam jeju)

echo "YTD fetch: $FROM_DATE -> $TO_DATE"
mkdir -p data/tmp data/ytd_2026
rm -f data/tmp/*.json

for r in "${REGIONS[@]}"; do
  echo "::group::region $r"
  curl -sS --max-time 120 "$BASE_URL/api/permits?from=$FROM_DATE&to=$TO_DATE&region=$r&type=all&maxPages=30" -o "data/tmp/$r.json" || echo "$r failed"
  ls -la "data/tmp/$r.json" 2>/dev/null || true
  echo "::endgroup::"
  sleep 2
done

python3 << PYEOF
import json, glob, datetime, os
from collections import defaultdict

# 새로 fetch된 매장 수집 (id 기준 dedupe)
new_items = {}
failures = []
for f in sorted(glob.glob('data/tmp/*.json')):
    region = os.path.basename(f).replace('.json','')
    try:
        d = json.load(open(f))
        items = d.get('items', [])
        for it in items:
            iid = it.get('id')
            if iid: new_items[iid] = it
    except Exception as e:
        print(f'{region} parse fail: {e}'); failures.append(region)

# 월별로 분류
by_month = defaultdict(dict)
for iid, it in new_items.items():
    pd = it.get('permitDate', '')
    if len(pd) >= 6:
        month = pd[:6]  # yyyymm
        by_month[month][iid] = it

# 각 월별 기존 파일에 upsert
for month, items_dict in by_month.items():
    path = f'data/ytd_2026/{month}.json'
    existing = {}
    if os.path.exists(path):
        try:
            existing = {x['id']: x for x in json.load(open(path)).get('stores', []) if x.get('id')}
        except Exception: existing = {}
    # 신규로 덮어쓰기 (사후 등록·수정 자동 반영)
    existing.update(items_dict)
    stores = list(existing.values())
    stores.sort(key=lambda x: (x.get('permitDate',''), x.get('id','')))
    out = {
        'month': month,
        'at': datetime.datetime.utcnow().isoformat() + 'Z',
        'count': len(stores),
        'stores': stores,
    }
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'  {month}: {len(items_dict)} new/updated → total {len(stores)} stores')

print(f'YTD fetch done. failures: {failures}')
PYEOF

rm -rf data/tmp
