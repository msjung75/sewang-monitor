#!/usr/bin/env python3
"""trend30_all.json을 YTD 월별 파일(data/ytd_2026/*.json)에서 재구성.
2026-11-20: 행안부 API가 느려져 nightly-trend30의 별도 fetch가 25분 타임아웃으로 8일째 실패(11/12~).
YTD 수집(같은 API, 같은 30일 창, status=all)이 성공할 때마다 이 스크립트로 trend30을 갱신해
'신규 매장' 탭이 별도 fetch 없이도 최신을 유지하도록 한다. 기존 nightly-fetch.sh 출력 포맷과 동일.
규칙: status=='영업' + permitDate가 [FROM_DATE, TO_DATE) 안 (nightly-fetch.sh와 동일: to는 미만)."""
import json, os, glob, datetime, sys
FROM = os.environ.get('FROM_DATE') or (datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))) - datetime.timedelta(days=30)).strftime('%Y%m%d')
TO = os.environ.get('TO_DATE') or datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime('%Y%m%d')
OUT = os.environ.get('TREND_PATH', 'data/trend30_all.json')
REGIONS = 'seoul gyeonggi busan daegu incheon gwangju daejeon ulsan sejong gangwon chungbuk chungnam jeonbuk jeonnam gyeongbuk gyeongnam jeju'.split()
items = {}
for path in sorted(glob.glob('data/ytd_2026/*.json')):
    month = os.path.basename(path)[:6]
    if month < FROM[:6] or month > TO[:6]:
        continue
    try:
        stores = json.load(open(path, encoding='utf-8')).get('stores', [])
    except Exception as e:
        print(f'skip {path}: {e}'); continue
    for it in stores:
        pd = it.get('permitDate') or ''
        if it.get('status') != '영업' or not it.get('id') or not (FROM <= pd < TO):
            continue
        items[it['id']] = it
stores = list(items.values())
if len(stores) < 500:
    print(f'::warning::trend30-from-ytd: {len(stores)}건뿐 — 이전 trend30 유지'); sys.exit(0)
# 기존 파일보다 오래된 결과면 덮어쓰지 않음 (별도 fetch가 더 최신일 수 있음)
try:
    prev = json.load(open(OUT, encoding='utf-8'))
    prev_max = max(prev.get('byDay') or {'': ''}); new_max = max(it['permitDate'] for it in stores)
    if new_max < prev_max:
        print(f'skip: 기존 trend30({prev_max})이 더 최신 (ytd {new_max})'); sys.exit(0)
except Exception:
    pass
byDay = {}
for it in stores:
    byDay[it['permitDate']] = byDay.get(it['permitDate'], 0) + 1
out = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'stores': stores, 'byDay': byDay, 'count': len(stores), 'failures': [],
       'coverage': {'complete': True, 'regions': REGIONS, 'from': FROM, 'toExclusive': TO, 'source': 'ytd_2026'}}
tmp = OUT + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
os.replace(tmp, OUT)
print(f'trend30 from ytd: {len(stores)} stores, {len(byDay)} days, {FROM}~{TO} (max permitDate {max(byDay)})')
