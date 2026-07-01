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
    '주바른','팝업','popup',  # v15.19: 팝업 brand
]
# v15.19: 백화점·복합몰 주소 → 단기 임대 팝업 매장 (영업 대상 X)
EXCLUDE_ADDR_KEYWORDS = [
    '백화점','아울렛','outlet','프리미엄아울렛','복합쇼핑','스타필드','롯데몰','현대몰',
    '신세계백화점','롯데백화점','현대백화점','갤러리아','AK플라자','NC백화점',
    '더현대','코엑스몰','타임스퀘어','IFC몰','애비뉴엘','지하상가',
]
def is_excluded(name, upte, addr=''):
    if not name: return False
    n = name.lower()
    if any(k.lower() in n for k in EXCLUDE_KEYWORDS): return True
    u = (upte or '').lower()
    if any(k in u for k in ['커피','빵','편의점']): return True
    if addr:
        a = addr.lower()
        if any(k.lower() in a for k in EXCLUDE_ADDR_KEYWORDS): return True
    return False

# v17.14.1: 백화점·복합몰 = 「팝업 폐업」 분류 (제외 X, 분류만)
POPUP_ADDR_KEYWORDS = [k.lower() for k in EXCLUDE_ADDR_KEYWORDS] + [
    '면세점','면세', 'duty free',
    '하나로마트','이마트','홈플러스','롯데마트','코스트코',
    '롯데월드몰','세이백화점','신세계센텀','센텀시티','파미에스테이션',
]
def is_popup_addr(addr):
    if not addr: return False
    a = addr.lower()
    return any(k in a for k in POPUP_ADDR_KEYWORDS)

# v17.14.2: 지방 행사·축제·박람회 = 「행사 폐업」 분류
EVENT_ADDR_KEYWORDS = [
    '행사장','페스티벌','박람회','축제','야시장','이벤트홀','컨벤션','전시장',
    '체험관','체험존','체육관','운동장','종합관','문화의광장','시민회관',
    '박물관','임시','팝업스토어','관광페어','축제장','전시관','문화회관',
    '엑스포','expo','경기장','월드컵경기장','월드컵공원','컨벤션센터',
    '아트센터','문화센터','관광지','관광단지','축전','국제행사',
]
EVENT_NAME_KEYWORDS = [
    '행사','축제','야시장','임시','팝업','부스','체험존','관광페어','박람회',
    '엑스포','expo','축전','이벤트','월드컵','국제박람회','체험전','특별전',
]
def is_event_addr(addr):
    if not addr: return False
    a = addr.lower()
    return any(k.lower() in a for k in EVENT_ADDR_KEYWORDS)
def is_event_name(name):
    if not name: return False
    n = name.lower()
    return any(k.lower() in n for k in EVENT_NAME_KEYWORDS)
def closure_category(name, addr):
    """v17.14.2: 폐업 카테고리 — event > popup > regular (우선순위)"""
    if is_event_addr(addr) or is_event_name(name): return 'event'
    if is_popup_addr(addr): return 'popup'
    return 'regular'
def is_closed(status):
    return any(k in (status or '') for k in ['폐업','취소','말소','중지','휴업'])

# v17.16.2: 유명 프차 brand 통합 override
_BRAND_OVERRIDES = [
    ('야화혼술바', '야화 혼술바'),
    ('야화 혼술바', '야화 혼술바'),
    ('농가의식탁', '농가의 식탁'),
    ('농가의 식탁', '농가의 식탁'),
    ('명류당티에프', '명류당티에프'),
    ('명류당', '명류당티에프'),
]
def brand_of(name):
    """v17.16.2 강화 — override 규칙 + 띄어쓰기·붙여쓰기·괄호 suffix 다중 패턴 통합"""
    if not name: return None
    n = re.sub(r'\s+', ' ', name).strip()
    # 0) "(지역명)점" 또는 "(주소) 점" 괄호 suffix 제거
    n = re.sub(r'\s*\([^)]+\)\s*점?\s*$', '', n).strip()
    # 0-1) 강제 override — 유명 프차 변형 통합
    n_ns = n.replace(' ','')
    for prefix, canonical in _BRAND_OVERRIDES:
        if n_ns.startswith(prefix.replace(' ','')):
            return canonical
    # 1) 띄어쓰기 있는 "OO점" 형식 — 마지막 토큰이 ~점으로 끝나면 떼기
    parts = re.split(r'\s+', n)
    if len(parts) >= 2:
        last = parts[-1]
        if re.search(r'점$', last) and len(last) <= 12:
            base = ' '.join(parts[:-1]).strip()
            if len(base) >= 3: return base
    # 2) 붙여쓴 "OO점" 형식
    m = re.match(r'^([가-힣a-zA-Z0-9·\-]{4,})([가-힣a-zA-Z0-9]{1,10}점)\s*$', n)
    if m: return m.group(1)
    # 3) "OO 직영점/가맹점/본점/지점" suffix
    m2 = re.match(r'^(.+?)(직영점|가맹점|본점|지점|매장)\s*$', n)
    if m2 and len(m2.group(1)) >= 3:
        return m2.group(1).strip()
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

# v17.14: EXCLUDE 룰은 「신규 매장 분석」에만 적용
# 폐업 분석은 모든 매장 포함 (백화점·팝업 한시적 운영도 위기 신호 → 포함)
filtered = [s for s in all_stores if not is_excluded(s.get('name',''), s.get('upte',''), s.get('addr',''))]
print(f'raw: {len(all_stores)} → filtered (신규 분석용): {len(filtered)}')

# v17.14: 폐업 분석은 전체 stores 대상 (EXCLUDE 미적용)
all_closed = [s for s in all_stores if is_closed(s.get('status',''))]
print(f'closed (전체, EXCLUDE 미적용): {len(all_closed)}')

# v17.14: 운영기간 (closedDate - permitDate) 계산
def operating_days(s):
    pd_s = (s.get('permitDate') or '').strip()
    cd_s = (s.get('closedDate') or '').strip()
    if not pd_s or not cd_s or len(pd_s) < 8 or len(cd_s) < 8: return None
    try:
        pd = datetime.datetime.strptime(pd_s[:8], '%Y%m%d')
        cd = datetime.datetime.strptime(cd_s[:8], '%Y%m%d')
        d = (cd - pd).days
        return d if d >= 0 else None
    except: return None

summary = {
    'at': datetime.datetime.utcnow().isoformat() + 'Z',
    'year': '2026',
    'total_raw': len(all_stores),
    'total_filtered': len(filtered),
    'total_closed_all': len(all_closed),  # v17.14
    'months_loaded': sorted(months.keys()),
    'by_month': {},
    'by_sido': {},
    'by_upte': {},
    'by_brand': {},  # {brand: {total_open, total_closed, monthly: {yyyymm: {open, closed, stores: 매장 list}}}}
    'closure_analysis': {},  # v17.14: 폐업 세부 분석
}

# 월별 (신규는 EXCLUDE 적용 / 폐업은 EXCLUDE 미적용, v17.14.2 카테고리 분리)
for month, stores in months.items():
    fs = [s for s in stores if not is_excluded(s.get('name',''), s.get('upte',''), s.get('addr',''))]
    open_n = sum(1 for s in fs if not is_closed(s.get('status','')))
    closed_all = [s for s in stores if is_closed(s.get('status',''))]
    closed_n = len(closed_all)
    short_term_n = 0
    closed_cat_cnt = Counter()
    for cs in closed_all:
        d = operating_days(cs)
        if d is not None and d <= 90: short_term_n += 1
        closed_cat_cnt[closure_category(cs.get('name',''), cs.get('addr',''))] += 1
    summary['by_month'][month] = {
        'open': open_n,
        'closed': closed_n,
        'closed_short_term': short_term_n,
        'closed_regular': closed_cat_cnt.get('regular', 0),  # v17.14.2
        'closed_popup': closed_cat_cnt.get('popup', 0),
        'closed_event': closed_cat_cnt.get('event', 0),
        'total': len(fs),
        'by_sido': dict(Counter(sido_short(s.get('addr','')) for s in fs)),
    }

# brand별 월별 신규/폐업 — v17.14: 폐업도 brand 그룹화하기 위해 all_stores 대상
# v17.14.1: 폐업을 「정규」 vs 「팝업」 분리 (주소 기반)
brand_data = defaultdict(lambda: {
    'total_open': 0, 'total_closed': 0,
    'total_closed_regular': 0, 'total_closed_popup': 0, 'total_closed_event': 0,
    'total_short_closed': 0,
    'operating_days_list': [],
    'closed_by_sido': Counter(), 'closed_regular_by_sido': Counter(),
    'monthly': defaultdict(lambda: {'open': 0, 'closed': 0, 'closed_regular': 0, 'closed_popup': 0, 'closed_event': 0, 'stores': []})
})
for s in all_stores:
    b = brand_of(s.get('name',''))
    if not b: continue
    pd = s.get('permitDate','')[:6]
    if not pd: continue
    closed = is_closed(s.get('status',''))
    excluded = is_excluded(s.get('name',''), s.get('upte',''), s.get('addr',''))
    cat = closure_category(s.get('name',''), s.get('addr','')) if closed else None
    bd = brand_data[b]
    if closed:
        bd['total_closed'] += 1
        bd['monthly'][pd]['closed'] += 1
        bd['closed_by_sido'][sido_short(s.get('addr',''))] += 1
        bd['total_closed_' + cat] += 1
        bd['monthly'][pd]['closed_' + cat] += 1
        if cat == 'regular':
            bd['closed_regular_by_sido'][sido_short(s.get('addr',''))] += 1
        d = operating_days(s)
        if d is not None:
            bd['operating_days_list'].append(d)
            if d <= 90: bd['total_short_closed'] += 1
    else:
        if excluded: continue
        bd['total_open'] += 1
        bd['monthly'][pd]['open'] += 1
    if len(bd['monthly'][pd]['stores']) < 30:
        bd['monthly'][pd]['stores'].append({
            'id': s.get('id'), 'name': s.get('name'), 'addr': s.get('addr',''),
            'permitDate': s.get('permitDate'), 'closedDate': s.get('closedDate',''),
            'status': s.get('status',''), 'closed': closed,
            'closureCat': cat,  # v17.14.2: regular/popup/event
            'opDays': operating_days(s) if closed else None,
            'type': s.get('type',''), 'typeLabel': s.get('typeLabel',''),
            'upte': s.get('upte',''),
        })

# brand 데이터 정리 + 회전율 계산 (정규 기준)
for brand, data in brand_data.items():
    if data['total_open'] + data['total_closed'] < 1: continue
    monthly = {}
    for m, v in data['monthly'].items():
        v['stores'].sort(key=lambda x: x.get('permitDate',''), reverse=True)
        monthly[m] = v
    total = data['total_open'] + data['total_closed']
    total_reg = data['total_open'] + data['total_closed_regular']
    op_days = data['operating_days_list']
    transient = data['total_closed_popup'] + data['total_closed_event']  # v17.14.2: 한시 매장
    summary['by_brand'][brand] = {
        'total_open': data['total_open'],
        'total_closed': data['total_closed'],
        'total_closed_regular': data['total_closed_regular'],
        'total_closed_popup': data['total_closed_popup'],
        'total_closed_event': data['total_closed_event'],  # v17.14.2
        'total_closed_transient': transient,  # v17.14.2: 팝업+행사 합계
        'total_short_closed': data['total_short_closed'],
        'churn_rate': round(data['total_closed'] / total * 100, 1) if total else 0,
        'churn_rate_regular': round(data['total_closed_regular'] / total_reg * 100, 1) if total_reg else 0,
        'popup_ratio': round(data['total_closed_popup'] / data['total_closed'] * 100, 1) if data['total_closed'] else 0,
        'event_ratio': round(data['total_closed_event'] / data['total_closed'] * 100, 1) if data['total_closed'] else 0,
        'transient_ratio': round(transient / data['total_closed'] * 100, 1) if data['total_closed'] else 0,
        'avg_op_days': round(sum(op_days)/len(op_days)) if op_days else None,
        'median_op_days': sorted(op_days)[len(op_days)//2] if op_days else None,
        'closed_by_sido': dict(data['closed_by_sido'].most_common(8)),
        'closed_regular_by_sido': dict(data['closed_regular_by_sido'].most_common(8)),
        'monthly': monthly,
    }

# v17.14.1: 프랜차이즈 폐점 TOP — 정규/팝업 분리 + 두 가지 list 제공
franchise_closures = []
for b, v in summary['by_brand'].items():
    if len(b) < 2 or len(b) > 30: continue
    if re.search(r'\d{4,}', b): continue
    closed = v.get('total_closed', 0)
    if closed < 3: continue
    franchise_closures.append({
        'brand': b,
        'total_open': v.get('total_open', 0),
        'total_closed': closed,
        'total_closed_regular': v.get('total_closed_regular', 0),
        'total_closed_popup': v.get('total_closed_popup', 0),
        'total_closed_event': v.get('total_closed_event', 0),       # v17.14.2
        'total_closed_transient': v.get('total_closed_transient', 0),  # v17.14.2
        'churn_rate': v.get('churn_rate', 0),
        'churn_rate_regular': v.get('churn_rate_regular', 0),
        'popup_ratio': v.get('popup_ratio', 0),
        'event_ratio': v.get('event_ratio', 0),
        'transient_ratio': v.get('transient_ratio', 0),
        'total_short_closed': v.get('total_short_closed', 0),
        'avg_op_days': v.get('avg_op_days'),
        'top_sido': list(v.get('closed_by_sido', {}).items())[:3],
        'top_sido_regular': list(v.get('closed_regular_by_sido', {}).items())[:3],
    })
# v17.14.1: 「정규 기준」 = 사장님 핵심 의도 (brand 위기 신호)
top_regular = [c for c in franchise_closures if c['total_closed_regular'] >= 3]
top_regular.sort(key=lambda x: (-x['total_closed_regular'], -x['churn_rate_regular']))
summary['closure_analysis']['top_franchise_closures'] = top_regular[:30]  # 정규 기준 (default)
# 「전체 폐점」 별도 list
top_all = sorted(franchise_closures, key=lambda x: (-x['total_closed'], -x['churn_rate']))
summary['closure_analysis']['top_franchise_closures_all'] = top_all[:30]
# 「팝업 폐점」 별도 list (백화점 한시 운영)
top_popup = [c for c in franchise_closures if c['total_closed_popup'] >= 3]
top_popup.sort(key=lambda x: -x['total_closed_popup'])
summary['closure_analysis']['top_franchise_closures_popup'] = top_popup[:30]
# v17.14.2: 「행사 폐점」 별도 list (지방 행사·축제·박람회)
top_event = [c for c in franchise_closures if c['total_closed_event'] >= 3]
top_event.sort(key=lambda x: -x['total_closed_event'])
summary['closure_analysis']['top_franchise_closures_event'] = top_event[:30]
# 요약 통계
summary['closure_analysis']['total_closed_regular'] = sum(v.get('total_closed_regular', 0) for v in summary['by_brand'].values())
summary['closure_analysis']['total_closed_popup'] = sum(v.get('total_closed_popup', 0) for v in summary['by_brand'].values())
summary['closure_analysis']['total_closed_event'] = sum(v.get('total_closed_event', 0) for v in summary['by_brand'].values())

# v17.14: 단기 폐업 (≤90일) 통계
short_term_closures = []
for cs in all_closed:
    d = operating_days(cs)
    if d is None or d > 90: continue
    short_term_closures.append({
        'name': cs.get('name',''),
        'addr': cs.get('addr',''),
        'permitDate': cs.get('permitDate',''),
        'closedDate': cs.get('closedDate',''),
        'opDays': d,
        'sido': sido_short(cs.get('addr','')),
        'upte': cs.get('upte',''),
        'typeLabel': cs.get('typeLabel',''),
        'brand': brand_of(cs.get('name','') or ''),
    })
# brand별 단기 폐업 집계
short_brand_cnt = Counter(s['brand'] for s in short_term_closures if s.get('brand'))
summary['closure_analysis']['short_term_total'] = len(short_term_closures)
summary['closure_analysis']['short_term_by_brand'] = dict(short_brand_cnt.most_common(20))
summary['closure_analysis']['short_term_by_sido'] = dict(Counter(s['sido'] for s in short_term_closures).most_common())
# 최근 단기 폐업 매장 100건 (sample)
short_term_closures.sort(key=lambda x: x['closedDate'], reverse=True)
summary['closure_analysis']['short_term_recent'] = short_term_closures[:100]

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
print(f'total filtered (신규): {summary["total_filtered"]}')
print(f'total closed (전체): {summary["total_closed_all"]}')
print(f'brands tracked: {len(summary["by_brand"])}')
print(f'top franchise closures: {len(summary["closure_analysis"]["top_franchise_closures"])}')
print(f'short-term closures (≤90일): {summary["closure_analysis"]["short_term_total"]}')
