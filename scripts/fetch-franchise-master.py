#!/usr/bin/env python3
"""공정거래위원회 가맹본부 brand 마스터 전체 수집
data/franchise_master.json: { generated_at, total, brands: [...], lookup: {compact: canonical} }
"""
import os, json, urllib.request, urllib.parse, time

KEY = os.environ['DATA_GO_KR_KEY']
YEAR = os.environ.get('YEAR', '2024')

def fetch_page(page_no, num_rows=1000):
    qs = {
        'serviceKey': KEY, 'pageNo': str(page_no), 'numOfRows': str(num_rows),
        'resultType': 'json', 'jngBizCrtraYr': YEAR,
    }
    url = 'https://apis.data.go.kr/1130000/FftcBrandRlsInfo2_Service/getBrandinfo?' + urllib.parse.urlencode(qs)
    r = urllib.request.urlopen(url, timeout=30)
    return json.loads(r.read())

# 1페이지로 totalCount 확인
print(f'Fetching page 1 of year {YEAR}...')
first = fetch_page(1, 1000)
total = int(first.get('totalCount', 0))
print(f'Total brands: {total}')

# 모든 페이지 수집
all_brands = list(first.get('items', []))
pages = (total + 999) // 1000
for p in range(2, pages + 1):
    print(f'  page {p}/{pages}...')
    d = fetch_page(p, 1000)
    all_brands.extend(d.get('items', []))
    time.sleep(0.15)

print(f'Collected {len(all_brands)} brands')

# 매칭 lookup table — compact key (공백 제거, lowercase) → 정규 brandNm
lookup = {}
duplicates = 0
for b in all_brands:
    name = (b.get('brandNm') or '').strip()
    if not name: continue
    compact = name.replace(' ', '').lower()
    if compact in lookup and lookup[compact] != name:
        duplicates += 1
    lookup[compact] = name

print(f'Unique brand compact keys: {len(lookup)} (duplicates: {duplicates})')

# 출력 — index.html이 로드할 수 있게 간결한 구조
import datetime
out = {
    'generated_at': datetime.datetime.utcnow().isoformat() + 'Z',
    'year': YEAR,
    'total': len(all_brands),
    'brands': all_brands,  # 풀 데이터 (영업표지·법인·업종 등)
    'lookup': lookup,       # 빠른 매칭용
}
os.makedirs('data', exist_ok=True)
with open('data/franchise_master.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',',':'))
print(f'Saved: data/franchise_master.json')
