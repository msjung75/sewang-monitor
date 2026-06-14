#!/usr/bin/env python3
# Closures (폐업일자 기준) fetch — 17 시·도 × 4 type 분할
# 옛 인허가 매장의 최근 폐업까지 포착 (회전율 분석용)
import os, json, time, urllib.request, urllib.parse

KEY = os.environ['DATA_GO_KR_KEY']
SINCE = os.environ['SINCE']
UNTIL = os.environ.get('UNTIL', '')

SERVICES = {
    'ilban':   'general_restaurants',
    'hyuge':   'rest_cafes',
    'danran':  'singing_bars',
    'yuheung': 'entertainment_bars',
}
LABELS = {
    'ilban': '일반음식점', 'hyuge': '휴게음식점',
    'danran': '단란주점', 'yuheung': '유흥주점',
}
PREFIXES = [
    '서울특별시','경기도','부산광역시','대구광역시','인천광역시','광주광역시',
    '대전광역시','울산광역시','세종특별자치시','강원특별자치도','충청북도',
    '충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도',
]

def fetch(svc, prefix, max_pages=10):
    out = []
    for page in range(1, max_pages+1):
        qs = {
            'serviceKey': KEY, 'pageNo': str(page), 'numOfRows': '100',
            'returnType': 'json',
            'cond[CLSBIZ_YMD::GTE]': SINCE,
            'cond[ROAD_NM_ADDR::LIKE]': prefix,
        }
        if UNTIL:
            qs['cond[CLSBIZ_YMD::LT]'] = UNTIL
        url = f'https://apis.data.go.kr/1741000/{SERVICES[svc]}/info?' + urllib.parse.urlencode(qs)
        try:
            r = urllib.request.urlopen(url, timeout=30)
            data = json.loads(r.read())
        except Exception as e:
            print(f'  ! {svc}/{prefix} p{page}: {e}')
            break
        body = data.get('response', {}).get('body', {})
        if not body: break
        items = body.get('items', {})
        arr = items.get('item', []) if isinstance(items, dict) else items
        if not isinstance(arr, list): arr = [arr] if arr else []
        for it in arr:
            cd = ''.join(c for c in str(it.get('CLSBIZ_YMD',''))[:8] if c.isdigit())
            pd = ''.join(c for c in str(it.get('LCPMT_YMD',''))[:8] if c.isdigit())
            out.append({
                'id': it.get('MNG_NO') or (it.get('BPLC_NM','') + cd),
                'name': it.get('BPLC_NM',''),
                'type': svc,
                'typeLabel': LABELS[svc],
                'permitDate': pd,
                'closedDate': cd,
                'status': it.get('DTL_SALS_STTS_NM') or it.get('SALS_STTS_NM',''),
                'addr': it.get('ROAD_NM_ADDR') or it.get('LOTNO_ADDR',''),
            })
        total = int(body.get('totalCount', 0) or 0)
        if page * 100 >= total or len(arr) < 100: break
        time.sleep(0.05)
    return out

print(f'Window: CLSBIZ_YMD GTE {SINCE} / LT {UNTIL or "(open)"}')
all_items = []
seen = set()
for svc in SERVICES:
    for p in PREFIXES:
        items = fetch(svc, p)
        added = 0
        for it in items:
            if it['id'] and it['id'] not in seen:
                seen.add(it['id']); all_items.append(it); added += 1
        print(f'  {svc} {p}: +{added}')

# 폐업일 desc
all_items.sort(key=lambda x: x.get('closedDate',''), reverse=True)
out = {
    'since': SINCE, 'until': UNTIL,
    'count': len(all_items),
    'items': all_items,
}
os.makedirs('data', exist_ok=True)
with open('data/closures_recent.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',',':'))
print(f'\nTotal closures: {len(all_items)}')
print(f'Saved: data/closures_recent.json')
