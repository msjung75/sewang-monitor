#!/usr/bin/env python3
"""네이버 N등록 확인 — 우선순위 큐 + registered 영구 SKIP
정책:
1. registered → 영원히 SKIP (재확인 X)
2. nstat 없음 (unknown) → 모두 1순위
3. 신규 30일 안 unregistered → 매일 모두
4. 30일+ unregistered, 마지막 확인 7일+ 전 → 일 5k 한도
5. 90일+ unregistered, 마지막 확인 30일+ 전 → 일 500 한도

캐시: data/naver_nstat_cache.json
- {매장id: {nstat, checked_at}}
- registered는 절대 다시 안 채움 (영구)
"""
import json, os, glob, sys, datetime, time
from urllib.parse import quote
import urllib.request, urllib.error

CACHE_PATH = 'data/naver_nstat_cache.json'
NAVER_CLIENT_ID = os.environ.get('NAVER_CLIENT_ID', '')
NAVER_CLIENT_SECRET = os.environ.get('NAVER_CLIENT_SECRET', '')

# 일별 한도 (네이버 25k/일 → 안전하게 5k 한도)
DAILY_LIMIT = int(os.environ.get('NAVER_DAILY_LIMIT', '5000'))
REQUEST_INTERVAL_SEC = 0.12  # 초당 ~8 호출

if not NAVER_CLIENT_ID or not NAVER_CLIENT_SECRET:
    print('NAVER 키 없음 — skip')
    sys.exit(0)

def now_iso():
    return datetime.datetime.utcnow().isoformat() + 'Z'

def days_ago(iso_str):
    """ISO 시각 문자열이 며칠 전인지"""
    if not iso_str: return 9999
    try:
        dt = datetime.datetime.fromisoformat(iso_str.replace('Z',''))
        return (datetime.datetime.utcnow() - dt).days
    except: return 9999

def permit_days_ago(permit_date):
    """permitDate (yyyymmdd) 가 며칠 전인지"""
    if not permit_date or len(permit_date) < 8: return 9999
    try:
        dt = datetime.datetime.strptime(permit_date[:8], '%Y%m%d')
        return (datetime.datetime.utcnow() - dt).days
    except: return 9999

def search_naver_local(name, addr):
    """네이버 search_local — 이름+주소 매칭 시도"""
    query = f'{name} {addr[:20]}' if addr else name
    url = f'https://openapi.naver.com/v1/search/local.json?query={quote(query)}&display=3&start=1'
    req = urllib.request.Request(url, headers={
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.loads(r.read())
        items = d.get('items', [])
        if not items: return 'unregistered'
        # 매장명 fuzzy match
        n_norm = name.replace(' ', '').lower()
        for it in items:
            title = it.get('title', '').replace('<b>','').replace('</b>','').replace(' ','').lower()
            # 이름 일부 포함되면 registered
            if n_norm[:6] in title or title[:6] in n_norm:
                return 'registered'
        # 검색 결과 있지만 매장명 안 맞음 → 일단 unregistered
        return 'unregistered'
    except urllib.error.HTTPError as e:
        if e.code == 429: return None  # rate limit
        return 'error'
    except Exception:
        return 'error'

# 캐시 로드
cache = {}
if os.path.exists(CACHE_PATH):
    try: cache = json.load(open(CACHE_PATH))
    except: cache = {}

# 모든 매장 로드 (YTD 월별 파일)
all_stores = {}
for f in sorted(glob.glob('data/ytd_2026/*.json')):
    try:
        d = json.load(open(f))
        for s in d.get('stores', []):
            iid = s.get('id')
            if iid: all_stores[iid] = s
    except Exception: pass

# trend30도 포함
if os.path.exists('data/trend30_all.json'):
    try:
        d = json.load(open('data/trend30_all.json'))
        for s in d.get('stores', []):
            iid = s.get('id')
            if iid and iid not in all_stores: all_stores[iid] = s
    except Exception: pass

print(f'총 매장: {len(all_stores)}, 캐시 보유: {len(cache)}')

# 우선순위 큐 구성
queue_p1 = []  # unknown (없음) — 모두
queue_p2 = []  # 신규 30일 안 unregistered
queue_p3 = []  # 30일+ unregistered, 7일+ 전 확인
queue_p4 = []  # 90일+ unregistered, 30일+ 전 확인

skipped_registered = 0
skipped_recent = 0

for iid, s in all_stores.items():
    cached = cache.get(iid, {})
    nstat = cached.get('nstat')
    checked_days = days_ago(cached.get('checked_at',''))
    perm_days = permit_days_ago(s.get('permitDate',''))
    
    if nstat == 'registered':
        skipped_registered += 1
        continue
    if not nstat:
        queue_p1.append(iid)
    elif nstat == 'unregistered':
        if perm_days <= 30:
            if checked_days >= 1: queue_p2.append(iid)
            else: skipped_recent += 1
        elif perm_days <= 90:
            if checked_days >= 7: queue_p3.append(iid)
            else: skipped_recent += 1
        else:
            if checked_days >= 30: queue_p4.append(iid)
            else: skipped_recent += 1

print(f'P1 (unknown): {len(queue_p1)}')
print(f'P2 (신규 미등록): {len(queue_p2)}')
print(f'P3 (30일+ 미등록 주1): {len(queue_p3)}')
print(f'P4 (90일+ 미등록 월1): {len(queue_p4)}')
print(f'SKIP registered: {skipped_registered}, recent: {skipped_recent}')

# P3·P4는 한도 적용
queue_p3 = queue_p3[:5000]
queue_p4 = queue_p4[:500]

# 전체 큐
queue = queue_p1 + queue_p2 + queue_p3 + queue_p4
queue = queue[:DAILY_LIMIT]
print(f'오늘 처리: {len(queue)}건')

processed = 0
new_registered = 0
new_unregistered = 0
errors = 0

for iid in queue:
    s = all_stores[iid]
    name = s.get('name','')
    addr = s.get('addr','')
    if not name: continue
    result = search_naver_local(name, addr)
    if result is None:
        print('Rate limit — stop')
        break
    if result == 'error':
        errors += 1
        time.sleep(REQUEST_INTERVAL_SEC); continue
    cache[iid] = {'nstat': result, 'checked_at': now_iso(), 'name': name[:30]}
    if result == 'registered': new_registered += 1
    else: new_unregistered += 1
    processed += 1
    time.sleep(REQUEST_INTERVAL_SEC)
    if processed % 100 == 0:
        print(f'  진행: {processed}/{len(queue)} (R={new_registered} U={new_unregistered})')

# 캐시 저장
with open(CACHE_PATH, 'w', encoding='utf-8') as f:
    json.dump(cache, f, ensure_ascii=False, separators=(',',':'))

print(f'\n완료: 처리 {processed}, 신규 R={new_registered} U={new_unregistered}, errors={errors}')
print(f'캐시 총: {len(cache)} 매장')
