#!/usr/bin/env python3
"""
세왕-monitor: 신규 매장 「영업 추천 TOP」 daily cron.

수도권(서울/경기/인천) 최근 14일 신규 인허가 매장 중에서
세왕 거래처 패턴(상호 키워드·업태·위치) 기반 점수 ≥ 임계치 매장을 추천.

출력: data/recommend_metro.json
"""
import urllib.request, urllib.parse, json, sys, os, time

BASE = os.environ.get("BASE_URL", "https://sewang-monitor.vercel.app")
OUTPUT = os.environ.get("OUTPUT", "data/recommend_metro.json")
DAYS = int(os.environ.get("DAYS", "14"))
SCORE_THRESHOLD = float(os.environ.get("SCORE_THRESHOLD", "2.0"))

# 키워드 가중 (세왕 거래처 16,601건 패턴 분석 기반)
KW_WEIGHT = {
    # 술 판매 강력 시그널
    '포차':2.0, '이자카야':2.0, '이자까야':2.0, '호프':1.8,
    '바':1.5, 'BAR':1.5, 'PUB':1.5,
    '주점':1.8, '술집':1.8, '노포':1.5, '와인':1.3, '꼬치':1.5,
    '치킨':1.5, '통닭':1.5, '곱창':1.3, '족발':1.3,
    '회':1.2, '스시':1.2, '갈비':1.1, '삼겹':1.1,
    '오뎅':1.3, '룸':1.2, '코노':1.0, '노래':1.0,
    '샤브':1.0, '보쌈':1.0, '횟집':1.3, '참치':1.3, '클럽':1.5,
    '막걸리':1.5, '연탄':1.2, '대포':1.5,
    # 약한 시그널 (일식)
    '오마카세':1.0, '돈카츠':0.8,
    # 제외 키워드 (비-주류)
    '편의점':-3.0, '약국':-3.0, '학원':-3.0, '세탁':-3.0, '미용':-3.0, '이발':-3.0,
    '약품':-3.0, '병원':-3.0, '치과':-3.0, '의원':-3.0,
    '카페':-1.0, '커피':-1.5, '디저트':-1.5, '베이커리':-2.0, '빵':-1.5,
    '분식':-0.5, '김밥':-1.0, '떡볶이':-1.0,
    '도시락':-1.5,
}

UPJONG_WEIGHT = {
    'yuheung':2.5, 'danran':2.0, 'ilban':1.0, 'hyuge':0.3,
}

BZSTAT_WEIGHT = {
    '감성주점':2.0, '호프/통닭':2.0, '한식주점':1.5, '일식주점':1.5,
    '한식':1.0, '일식':1.2, '중식':0.8, '양식':1.0, '치킨/통닭':1.5,
    '뷔페식':0.5, '분식':0.3, '식육(숯불구이)':1.0, '단란주점':2.0,
    '유흥주점':2.5, '제과점':-1.5, '커피숍':-2.0, '아이스크림':-2.0,
    '패스트푸드':0.2, '편의식품 외 외식자판':-2.0, '키즈카페':-1.5,
    '복어취급':1.0, '횟집':1.5,
}

def score_store(s):
    name = s.get('name', '') or ''
    addr = s.get('addr', '') or ''
    type_key = s.get('type', '') or ''
    bzstat = s.get('upte', '') or ''

    score = 0.0
    reasons = []

    # 1) 위치 — 수도권만 처리 (이 스크립트는 metro 한정)
    score += 1.0
    reasons.append('수도권')

    # 2) 업태
    if type_key in UPJONG_WEIGHT:
        w = UPJONG_WEIGHT[type_key]
        score += w
        if w >= 1.0: reasons.append(f'{type_key}+{w}')

    # 3) 위생업태
    for key, w in BZSTAT_WEIGHT.items():
        if key in bzstat:
            score += w
            if w > 0: reasons.append(f'{key}+{w}')
            elif w < 0: reasons.append(f'⛔{key}{w}')
            break

    # 4) 상호 키워드
    matched_kw = []
    for kw, w in KW_WEIGHT.items():
        if kw in name:
            score += w
            if w > 0: matched_kw.append(f'+{kw}')
            elif w < 0: matched_kw.append(f'⛔{kw}')
    reasons.extend(matched_kw[:5])

    return score, reasons

def fetch_permits(region, days, max_pages=30):
    url = f"{BASE}/api/permits?region={region}&type=all&days={days}&maxPages={max_pages}"
    req = urllib.request.Request(url, headers={'Accept':'application/json'})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())

def main():
    sys.stderr.write(f"[recommend] fetching metro {DAYS}days\n")
    data = fetch_permits('metro', DAYS, max_pages=30)
    items = data.get('items', []) or []
    sys.stderr.write(f"[recommend] metro items: {len(items)}\n")

    scored = []
    excluded = 0
    for s in items:
        sc, reasons = score_store(s)
        if sc >= SCORE_THRESHOLD:
            scored.append({
                'score': round(sc, 2),
                'name': s.get('name', ''),
                'addr': (s.get('addr', '') or '')[:80],
                'type': s.get('typeLabel', ''),
                'type_key': s.get('type', ''),
                'bzstat': s.get('upte', ''),
                'permitDate': s.get('permitDate', ''),
                'mng_no': s.get('id', ''),
                'tel': s.get('tel', ''),
                'reasons': reasons[:6],
            })
        else:
            excluded += 1
    scored.sort(key=lambda x: -x['score'])

    out = {
        'updated': time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.localtime()),
        'baseline': data.get('since', ''),
        'days': DAYS,
        'region': 'metro',
        'score_threshold': SCORE_THRESHOLD,
        'total_input': len(items),
        'recommended_count': len(scored),
        'excluded_count': excluded,
        'items': scored[:200],
    }

    os.makedirs(os.path.dirname(OUTPUT) or '.', exist_ok=True)
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    sys.stderr.write(f"[recommend] DONE → {OUTPUT}, recommended {len(scored)} / total {len(items)}\n")

if __name__ == "__main__":
    main()
