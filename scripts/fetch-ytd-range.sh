#!/usr/bin/env bash
# YTD 데이터 fetch — status=all (영업+폐업+휴업 모두)
# FROM_DATE / TO_DATE 환경변수 받음 (yyyymmdd)
set -uo pipefail
BASE_URL="${BASE_URL:-https://sewang-monitor.vercel.app}"
FROM_DATE="${FROM_DATE:-$(date -u -d 'yesterday' +%Y%m%d)}"
TO_DATE="${TO_DATE:-$FROM_DATE}"
REGIONS=(seoul gyeonggi busan daegu incheon gwangju daejeon ulsan sejong gangwon chungbuk chungnam jeonbuk jeonnam gyeongbuk gyeongnam jeju)

echo "YTD fetch (영업+폐업 통합): $FROM_DATE -> $TO_DATE"
mkdir -p data/tmp data/ytd_2026
rm -f data/tmp/*.json

for r in "${REGIONS[@]}"; do
  echo "::group::region $r"
  curl -sS --max-time 120 "$BASE_URL/api/permits?from=$FROM_DATE&to=$TO_DATE&region=$r&type=all&status=all&maxPages=30" -o "data/tmp/$r.json" || echo "$r failed"
  ls -la "data/tmp/$r.json" 2>/dev/null || true
  echo "::endgroup::"
  sleep 2
done

python3 << PYEOF
import json, glob, datetime, os
from collections import defaultdict

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
        month = pd[:6]
        by_month[month][iid] = it

for month, items_dict in by_month.items():
    path = f'data/ytd_2026/{month}.json'
    existing = {}
    if os.path.exists(path):
        try:
            existing = {x['id']: x for x in json.load(open(path)).get('stores', []) if x.get('id')}
        except Exception: existing = {}
    existing.update(items_dict)
    stores = list(existing.values())
    stores.sort(key=lambda x: (x.get('permitDate',''), x.get('id','')))
    open_n = sum(1 for s in stores if not any(k in (s.get('status','') or '') for k in ['폐업','취소','말소','중지','휴업']))
    closed_n = len(stores) - open_n
    out = {
        'month': month,
        'at': datetime.datetime.utcnow().isoformat() + 'Z',
        'count': len(stores),
        'open_count': open_n,
        'closed_count': closed_n,
        'stores': stores,
    }
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'  {month}: {len(items_dict)} new → total {len(stores)} (영업 {open_n} / 폐업·휴업 {closed_n})')

print(f'YTD fetch done. failures: {failures}')
PYEOF

rm -rf data/tmp
