#!/usr/bin/env python3
"""YTD 집계 v2 — 신규/폐업 통합, brand별 월별 분리 카운트
출력 data/ytd_2026_summary.json:
- by_month: {yyyymm: {open, closed, by_sido, by_upte}}
- by_brand: {brand: {total_open, total_closed, monthly: {yyyymm: {open, closed, stores: [최신 5건]}}}}
"""
import json, glob, os, re, datetime
from collections import defaultdict, Counter

EXCLUDE_KEYWORDS = [
    '커피','카페','coffee','cafe','스타벅스','이디야','투썸','커피빈','메가커피','컴포즈','폴바셋',
    '빵','베이커리','파리바게뜨','뚜레쥬르','롯데리아','맥도날드','버거킹','KFC','맘스터치',
    'CU','GS25','세븐일레븐','이마트24','미니스톱',
]
def is_excluded(name, upte):
    if not name: return False
    n = name.lower()
    if any(k.lower() in n for k in EXCLUDE_KEYWORDS): return True
    u = (upte or '').lower()
    if any(k in u for k in ['커피','빵','편의점']): return True
    return False
def is_closed(status):
    return any(k in (status or '') for k in ['폐업','취소','말소','중지','휴업'])
def brand_of(name):
    if not name: return None
    n = name.strip()
    parts = re.split(r'\s+', n)
    if len(parts) >= 2:
        last = parts[-1]
        if last.endswith('점') and len(last) <= 5:
            return ' '.join(parts[:-1])
    # 공백 없는 한 단어 매장: '인쌩맥주구미봉곡점' → '인쌩맥주' (정규식 시도)
    m = re.match(r'^([가-힣a-zA-Z0-9]+?)(구|시|동|읍|면|점|지점|매장)?(점)?$', n)
    if m and m.group(1) and len(m.group(1)) >= 3:
        return m.group(1)
    return n
def sido_short(addr):
    if not addr: return '기타'
    SIDO_MAP = {
        '서울':'서울','경기':'경기','인천':'인천','부산':'부산','대구':'대구','광주':'광주','대전':'대전',
        '울산':'울산','세종':'세종','강원':'강원','충북':'충북','충남':'충남','전북':'전북','전남':'전남',
        '경북':'경북','경남':'경남','제주':'제주',
        '충청북도':'충북','충청남도':'충남','전라북도':'전북','전라남도':'전남','경상북도':'경북','경상남도':'경남',
        '서울특별시':'서울','부산광역시':'부산','대구광역시':'대구','인천광역시':'인천','광주광역시':'광주',
        '대전광역시':'대전','울산광역시':'울산','세종특별자치시':'세종','경기도':'경기',
        '강원특별자치도':'강원','전북특별자치도':'전북','제주특별자치도':'제주',
    }
    a = addr.strip()
    for k, v in SIDO_MAP.items():
        if a.startswith(k): return v
    return '기타'

# 모든 월별 raw 로드
months = {}
all_stores = []
for f in sorted(glob.glob('data/ytd_2026/*.json')):
    name = os.path.basename(f).replace('.json','')
    if not re.match(r'^\d{6}$', name): continue
    try:
        d = json.load(open(f))
        stores = d.get('stores', [])
        months[name] = stores
        all_stores.extend(stores)
    except Exception: pass

filtered = [s for s in all_stores if not is_excluded(s.get('name',''), s.get('upte',''))]
print(f'raw: {len(all_stores)} → filtered: {len(filtered)}')

summary = {
    'at': datetime.datetime.utcnow().isoformat() + 'Z',
    'year': '2026',
    'total_raw': len(all_stores),
    'total_filtered': len(filtered),
    'months_loaded': sorted(months.keys()),
    'by_month': {},
    'by_sido': {},
    'by_upte': {},
    'by_brand': {},  # {brand: {total_open, total_closed, monthly: {yyyymm: {open, closed, stores: 매장 list}}}}
}

# 월별
for month, stores in months.items():
    fs = [s for s in stores if not is_excluded(s.get('name',''), s.get('upte',''))]
    open_n = sum(1 for s in fs if not is_closed(s.get('status','')))
    closed_n = len(fs) - open_n
    summary['by_month'][month] = {
        'open': open_n,
        'closed': closed_n,
        'total': len(fs),
        'by_sido': dict(Counter(sido_short(s.get('addr','')) for s in fs)),
    }

# brand별 월별 신규/폐업 + 매장 리스트
brand_data = defaultdict(lambda: {'total_open': 0, 'total_closed': 0, 'monthly': defaultdict(lambda: {'open': 0, 'closed': 0, 'stores': []})})
for s in filtered:
    b = brand_of(s.get('name',''))
    if not b: continue
    pd = s.get('permitDate','')[:6]
    if not pd: continue
    closed = is_closed(s.get('status',''))
    bd = brand_data[b]
    if closed:
        bd['total_closed'] += 1
        bd['monthly'][pd]['closed'] += 1
    else:
        bd['total_open'] += 1
        bd['monthly'][pd]['open'] += 1
    # 매장 list — 최대 30개
    if len(bd['monthly'][pd]['stores']) < 30:
        bd['monthly'][pd]['stores'].append({
            'id': s.get('id'),
            'name': s.get('name'),
            'addr': s.get('addr',''),
            'permitDate': s.get('permitDate'),
            'status': s.get('status',''),
            'closed': closed,
        })

# 2건 이상 출점 브랜드만 (노이즈 제거)
for brand, data in brand_data.items():
    if data['total_open'] + data['total_closed'] < 2: continue
    monthly = {}
    for m, v in data['monthly'].items():
        v['stores'].sort(key=lambda x: x.get('permitDate',''), reverse=True)
        monthly[m] = v
    summary['by_brand'][brand] = {
        'total_open': data['total_open'],
        'total_closed': data['total_closed'],
        'monthly': monthly,
    }

# 전체
summary['by_sido'] = dict(Counter(sido_short(s.get('addr','')) for s in filtered).most_common())
summary['by_upte'] = dict(Counter(s.get('upte','기타') or '기타' for s in filtered).most_common(50))

# Naver N-Check 캐시 통합
nstat_cache = {}
if os.path.exists('data/naver_nstat_cache.json'):
    try: nstat_cache = json.load(open('data/naver_nstat_cache.json'))
    except: nstat_cache = {}
nstat_summary = Counter()
for s in filtered:
    iid = s.get('id')
    c = nstat_cache.get(iid, {})
    nstat_summary[c.get('nstat', 'unknown')] += 1
summary['nstat'] = {
    'registered': nstat_summary.get('registered', 0),
    'unregistered': nstat_summary.get('unregistered', 0),
    'unknown': nstat_summary.get('unknown', 0),
    'cache_size': len(nstat_cache),
}

# 저장
os.makedirs('data', exist_ok=True)
with open('data/ytd_2026_summary.json', 'w', encoding='utf-8') as f:
    json.dump(summary, f, ensure_ascii=False, separators=(',',':'))

size = os.path.getsize('data/ytd_2026_summary.json')
print(f'summary saved: {size/1024:.1f}KB')
print(f'months: {summary["months_loaded"]}')
print(f'total filtered: {summary["total_filtered"]}')
print(f'brands tracked: {len(summary["by_brand"])}')
