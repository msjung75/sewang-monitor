#!/usr/bin/env python3
"""YTD 집계: data/ytd_2026/*.json → data/ytd_2026_summary.json
- 월별 카운트
- 카테고리(업종)별 카운트
- 시·도별 카운트
- 브랜드별 카운트 (간단 prefix 매칭)
- TOP N 리스트
"""
import json, glob, os, re, datetime
from collections import defaultdict, Counter

# EXCLUDE 키워드 (커피·빵·편의점·기타 — 클라이언트 isExcluded와 일관)
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

def brand_of(name):
    """매장명에서 브랜드 추출 — 첫 공백 전까지 or 알려진 split"""
    if not name: return None
    # 알려진 브랜드 alias
    n = name.strip()
    # "야화 혼술바 광안점" → "야화 혼술바"
    # "토핑 몬스터피자 강남점" → "토핑 몬스터피자"
    # 마지막 N글자 "점"으로 끝나면 그 부분 제거
    parts = re.split(r'\s+', n)
    if len(parts) >= 2:
        last = parts[-1]
        if last.endswith('점') and len(last) <= 5:
            return ' '.join(parts[:-1])
    return n

def sido_short(addr):
    """주소에서 시·도 추출"""
    if not addr: return '기타'
    a = addr.strip()
    SIDO_MAP = {
        '서울': '서울', '경기': '경기', '인천': '인천', '부산': '부산', '대구': '대구',
        '광주': '광주', '대전': '대전', '울산': '울산', '세종': '세종', '강원': '강원',
        '충북': '충북', '충남': '충남', '전북': '전북', '전남': '전남',
        '경북': '경북', '경남': '경남', '제주': '제주',
        '충청북도': '충북', '충청남도': '충남', '전라북도': '전북', '전라남도': '전남',
        '경상북도': '경북', '경상남도': '경남', '제주특별자치도': '제주',
        '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천',
        '광주광역시': '광주', '대전광역시': '대전', '울산광역시': '울산', '세종특별자치시': '세종',
        '경기도': '경기', '강원특별자치도': '강원', '강원도': '강원',
    }
    for k, v in SIDO_MAP.items():
        if a.startswith(k): return v
    return '기타'

# 모든 월별 raw 로드
months = {}
total_stores = []
for f in sorted(glob.glob('data/ytd_2026/*.json')):
    name = os.path.basename(f).replace('.json','')
    if not re.match(r'^\d{6}$', name): continue
    try:
        d = json.load(open(f))
        stores = d.get('stores', [])
        months[name] = stores
        total_stores.extend(stores)
    except Exception as e:
        print(f'{name} skip: {e}')

# 필터 (EXCLUDE 적용)
filtered_total = [s for s in total_stores if not is_excluded(s.get('name',''), s.get('upte',''))]
print(f'raw: {len(total_stores)} → filtered: {len(filtered_total)}')

# === 집계 ===
summary = {
    'at': datetime.datetime.utcnow().isoformat() + 'Z',
    'year': '2026',
    'total_raw': len(total_stores),
    'total_filtered': len(filtered_total),
    'months_loaded': sorted(months.keys()),
    'by_month': {},
    'by_sido': Counter(),
    'by_upte': Counter(),
    'by_brand_top': {},
    'monthly_top_brands': {},
    'monthly_top_upte': {},
    'monthly_by_sido': {},
}

# 월별
for month, stores in months.items():
    fs = [s for s in stores if not is_excluded(s.get('name',''), s.get('upte',''))]
    summary['by_month'][month] = {
        'total': len(fs),
        'by_sido': dict(Counter(sido_short(s.get('addr','')) for s in fs)),
        'by_upte': dict(Counter(s.get('upte','기타') or '기타' for s in fs).most_common(20)),
    }
    # 월별 TOP 브랜드
    brand_counter = Counter()
    for s in fs:
        b = brand_of(s.get('name',''))
        if b: brand_counter[b] += 1
    summary['monthly_top_brands'][month] = brand_counter.most_common(30)
    summary['monthly_top_upte'][month] = Counter(s.get('upte','기타') or '기타' for s in fs).most_common(15)
    summary['monthly_by_sido'][month] = dict(Counter(sido_short(s.get('addr','')) for s in fs))

# 전체
summary['by_sido'] = dict(Counter(sido_short(s.get('addr','')) for s in filtered_total).most_common())
summary['by_upte'] = dict(Counter(s.get('upte','기타') or '기타' for s in filtered_total).most_common(30))
total_brands = Counter()
for s in filtered_total:
    b = brand_of(s.get('name',''))
    if b: total_brands[b] += 1
summary['by_brand_top'] = total_brands.most_common(50)


# === 네이버 N등록 캐시 ===
nstat_cache = {}
if os.path.exists('data/naver_nstat_cache.json'):
    try: nstat_cache = json.load(open('data/naver_nstat_cache.json'))
    except: nstat_cache = {}
nstat_summary = Counter()
for s in filtered_total:
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

# 크기 보고
size = os.path.getsize('data/ytd_2026_summary.json')
print(f'summary saved: {size/1024:.1f}KB')
print(f'months: {summary["months_loaded"]}')
print(f'total filtered: {summary["total_filtered"]}')
