#!/usr/bin/env python3
"""v17.12 Phase 2 — 4종 알림 송신 (cron 새벽 1회)
- 신규 매장: 어제 YTD 신규 ≥ 임계치 → 알림
- 폐점: 어제 YTD 폐점 ≥ 임계치 → 알림
- 화제성: 썸트렌드 growth ≥ +200% → 알림 (brand 단위)
- 가입자: pending_users.json에 ≥1 → 알림 (admin 전용 type)
- /api/auth/kakao?action=send_push 호출 (CRON_SECRET 인증)
"""
import json, os, re, time, datetime, urllib.request, urllib.error, glob

VERCEL_URL = os.environ.get('VERCEL_URL', 'https://sewang-monitor.vercel.app')
CRON_SECRET = os.environ.get('CRON_SECRET', '')
if not CRON_SECRET:
    print('⚠️ CRON_SECRET missing — skip'); raise SystemExit(0)

def post_push(payload):
    url = f'{VERCEL_URL}/api/auth/kakao?action=send_push'
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method='POST',
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {CRON_SECRET}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            result = json.loads(r.read())
            print(f"  📤 {payload['type']}: sent={result.get('sent',0)}/{result.get('total',0)}")
            return result
    except urllib.error.HTTPError as e:
        print(f"  ❌ {payload['type']} HTTP {e.code}: {e.read().decode()[:200]}")
        return None
    except Exception as e:
        print(f"  ❌ {payload['type']}: {e}"); return None

EXCLUDE_KEYWORDS = ['커피','카페','coffee','cafe','스타벅스','이디야','투썸','커피빈','메가커피','컴포즈','폴바셋','빵','베이커리','파리바게뜨','뚜레쥬르','롯데리아','맥도날드','버거킹','KFC','맘스터치','CU','GS25','세븐일레븐','이마트24','미니스톱','주바른','팝업','popup']
EXCLUDE_ADDR = ['백화점','아울렛','outlet','프리미엄아울렛','복합쇼핑','스타필드','롯데몰','현대몰','신세계백화점','롯데백화점','현대백화점','갤러리아','AK플라자','NC백화점','더현대','코엑스몰','타임스퀘어','IFC몰','애비뉴엘','지하상가','면세점','면세','하나로마트','이마트','홈플러스','롯데마트','코스트코']
# v17.14.2: 행사·축제·박람회 키워드
EVENT_ADDR_KW = ['행사장','페스티벌','박람회','축제','야시장','이벤트홀','컨벤션','전시장','체험관','체험존','체육관','운동장','종합관','문화의광장','시민회관','박물관','임시','팝업스토어','관광페어','축제장','전시관','문화회관','엑스포','expo','경기장','월드컵공원','컨벤션센터','문화센터','관광단지','축전']
EVENT_NAME_KW = ['행사','축제','야시장','임시','팝업','부스','체험존','관광페어','박람회','엑스포','expo','축전','이벤트','체험전','특별전']
def is_popup_addr(addr):
    a = (addr or '').lower()
    return any(k.lower() in a for k in EXCLUDE_ADDR)
def is_event_store(name, addr):
    a = (addr or '').lower(); n = (name or '').lower()
    if any(k.lower() in a for k in EVENT_ADDR_KW): return True
    if any(k.lower() in n for k in EVENT_NAME_KW): return True
    return False
def is_transient(name, addr):
    return is_popup_addr(addr) or is_event_store(name, addr)
def is_excluded(s):
    n = (s.get('name') or '').lower(); u = (s.get('upte') or '').lower(); a = (s.get('addr') or '').lower()
    if any(k.lower() in n for k in EXCLUDE_KEYWORDS): return True
    if any(k in u for k in ['커피','빵','편의점']): return True
    if any(k.lower() in a for k in EXCLUDE_ADDR): return True
    return False
def is_closed(s):
    return any(k in (s.get('status') or '') for k in ['폐업','취소','말소','중지','휴업'])

# 어제 YTD daily 파일
yesterday = (datetime.datetime.utcnow() + datetime.timedelta(hours=9) - datetime.timedelta(days=1)).strftime('%Y%m%d')
day_path = f'data/ytd_2026/{yesterday}.json'
if not os.path.exists(day_path):
    print(f'❌ {day_path} not found — skip diff alerts')
    new_count = 0; closed_count = 0; top_sido = ''
else:
    with open(day_path) as f: d = json.load(f)
    stores = d.get('stores', [])
    filtered = [s for s in stores if not is_excluded(s)]
    new_stores = [s for s in filtered if not is_closed(s)]
    # v17.14.2: 폐업 = 정규(EXCLUDE+팝업+행사 제외) / 팝업 / 행사 3분리, 정규만 알림
    all_closed_stores = [s for s in stores if is_closed(s)]
    closed_stores = [s for s in all_closed_stores if not is_transient(s.get('name',''), s.get('addr',''))]
    closed_popup_stores = [s for s in all_closed_stores if is_popup_addr(s.get('addr','')) and not is_event_store(s.get('name',''), s.get('addr',''))]
    closed_event_stores = [s for s in all_closed_stores if is_event_store(s.get('name',''), s.get('addr',''))]
    new_count = len(new_stores)
    closed_count = len(closed_stores)
    closed_popup_count = len(closed_popup_stores)
    closed_event_count = len(closed_event_stores)
    # 신규 매장 TOP 시·도
    from collections import Counter
    sido_cnt = Counter()
    for s in new_stores:
        a = (s.get('addr') or '').strip()
        for k in ['서울','경기','인천','부산','대구','광주','대전','울산','강원','충북','충남','전북','전남','경북','경남','제주','세종']:
            if a.startswith(k): sido_cnt[k] += 1; break
    top_sido = sido_cnt.most_common(1)[0][0] if sido_cnt else ''

print(f'[diff] yesterday={yesterday} new={new_count} closed={closed_count}')

# 1. 신규 매장 알림 (≥ 10건)
if new_count >= 10:
    post_push({
        'type': 'new_store',
        'title': f'🆕 신규 매장 {new_count}건',
        'body': f'{yesterday[:4]}.{yesterday[4:6]}.{yesterday[6:8]} {top_sido + " 중심 " if top_sido else ""}신규 영업 시작',
        'url': '/?tab=new'
    })

# 2. 폐점 알림 (정규 ≥ 5건 — 팝업은 노이즈로 제외)
if closed_count >= 5:
    post_push({
        'type': 'closed',
        'title': f'⚠️ 정규 폐점 {closed_count}건',
        'body': f'{yesterday[:4]}.{yesterday[4:6]}.{yesterday[6:8]} 폐업 (🏬팝업 {closed_popup_count}건 + 🎪행사 {closed_event_count}건 제외)',
        'url': '/?tab=trend'
    })

# 3. 화제성 알림 (썸트렌드 growth ≥ +200%)
if os.path.exists('data/sumtrend_buzz.json'):
    with open('data/sumtrend_buzz.json') as f: st = json.load(f)
    hot_brands = []
    for b, v in (st.get('brands') or {}).items():
        g = v.get('growth_3m_pct')
        if isinstance(g, (int, float)) and g >= 200:
            hot_brands.append((b, g))
    hot_brands.sort(key=lambda x: -x[1])
    if hot_brands:
        top_brand, top_g = hot_brands[0]
        post_push({
            'type': 'buzz',
            'title': f'🔥 화제성 급상승: {top_brand}',
            'body': f'인스타 3개월 성장률 +{int(top_g)}%' + (f' 외 {len(hot_brands)-1}개' if len(hot_brands) > 1 else ''),
            'url': '/?tab=dashboard'
        })

# 4. 가입자 승인 대기 알림 (admin 대상)
if os.path.exists('data/pending_users.json'):
    try:
        with open('data/pending_users.json') as f: pu = json.load(f)
        pending = pu.get('pending') or pu.get('users') or []
        if isinstance(pending, list) and len(pending) > 0:
            post_push({
                'type': 'user',
                'title': f'👤 가입자 승인 대기 {len(pending)}명',
                'body': '관리 탭에서 승인 처리하세요',
                'url': '/?tab=admin'
            })
    except Exception as e:
        print(f'pending_users err: {e}')

print('✅ push 송신 완료')
