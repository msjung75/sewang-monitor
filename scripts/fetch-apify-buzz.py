#!/usr/bin/env python3
"""v17.13 Phase 2 — Apify Instagram Hashtag Scraper로 TOP brand 화제성 수집
사장님 정책: 코인 적게, 캐시 최대.
- Input: data/ytd_2026_summary.json (이미 brand별 신규 오픈 집계)
- 카테고리 가중 점수 TOP 10 brand 선정
- Apify actor: apify/instagram-hashtag-scraper, resultsType=reels, resultsLimit=8
- Output: data/sns_buzz.json {at, brands: {brand: {posts, totalLikes, avgLikes, totalComments, topHashtags, sampleUrls}}}
- 비용: 10 brand × 8 reels × $0.0026 = $0.21/day, ~$6/month
"""
import json, os, re, time, urllib.request, urllib.error
from collections import Counter

APIFY_TOKEN = os.environ.get('APIFY_TOKEN', '')
if not APIFY_TOKEN:
    print('⚠️ APIFY_TOKEN missing — skip')
    raise SystemExit(0)

# 카테고리 가중 (frontend와 일치)
FOCUS_WEIGHT = {'sool': 3.0, 'chicken': 2.5, 'meat': 2.5, 'korean': 1.5, 'japanese': 1.5,
                'western': 1.2, 'seafood': 1.2, 'food': 1.0, 'asian': 1.0, 'chinese': 1.0,
                'snack': 0.8, 'cafe': 0.5, 'other': 0.6}

def detail_category(name, upte, type_, type_label):
    n = (name or '').lower()
    u = (upte or '').lower()
    t = n + ' ' + u
    if type_ in ('yuheung', 'danran'): return 'sool'
    if type_ == 'hyuge':
        if re.search(r'카페|커피|cafe|coffee|빵|베이커리|디저트', t): return 'cafe'
        if re.search(r'떡볶이|김밥|분식|꽈배기|도넛|튀김', t): return 'snack'
        return 'cafe'
    if re.search(r'주점|호프|선술|이자카야|포차|혼술|와인바|칵테일|맥주|소주|샴페인|사케', t) or re.search(r'유흥|단란', u): return 'sool'
    if re.search(r'카페|커피|cafe|coffee|빵|베이커리|제과|디저트|도넛|꽈배기|와플|아이스크림|빙수|마카롱|크로플', t): return 'cafe'
    if re.search(r'치킨|chicken|닭볶|닭갈비|찜닭|닭한마리|닭발|닭강정|영양닭|통닭|비비큐|bbq|bhc|굽네|페리카나|가마치|호치킨', t): return 'chicken'
    if re.search(r'고기|삼겹|갈비|곱창|막창|불고기|구이|돼지|소고기|한우|등심|안심|차돌|항정살|숯불|연탄', t): return 'meat'
    if re.search(r'일식|이자카야|라멘|우동|초밥|돈까스|돈가스|소바|텐동|규동|스시|텐푸라|야키토리', t): return 'japanese'
    if re.search(r'중식|짜장|짬뽕|마라|훠궈|마라탕|양꼬치|중화|딤섬|만두|탕수육', t): return 'chinese'
    if re.search(r'베트남|쌀국수|반미|팟타이|태국|타이|인도|카레', t): return 'asian'
    if re.search(r'피자|pizza|버거|burger|타코|샌드위치|토스트|패스트|스테이크|파스타|이탈리|핫도그', t): return 'western'
    if re.search(r'횟집|회\s|물회|해산물|해물|조개|굴|새우|꽃게|문어|낙지|장어|아구|아귀|복어', t): return 'seafood'
    if re.search(r'떡볶이|볶이|튀김|순대|꼬치|어묵|붕어빵|핫바|김밥|분식', t): return 'snack'
    if re.search(r'한식|국밥|찌개|덮밥|비빔밥|족발|보쌈|국수|냉면|설렁탕|해장국|감자탕|갈비탕|곰탕|찜|뷔페|백반|한정식|쌈밥|순두부|삼계탕', t): return 'korean'
    if re.search(r'푸드|food|하우스|house|키친|kitchen|식당|레스토|restaurant|다이닝|dining|그릴|grill|펍|pub', t): return 'food'
    if type_ == 'ilban': return 'food'
    return 'other'

# 1. YTD summary 로드
try:
    with open('data/ytd_2026_summary.json') as f:
        ytd = json.load(f)
except Exception as e:
    print(f'❌ YTD load: {e}')
    raise SystemExit(0)

by_brand = ytd.get('by_brand', {})
if not by_brand:
    print('❌ by_brand empty')
    raise SystemExit(0)

# 2. brand별 카테고리 + 최근 3개월 신규
candidates = []
now = time.gmtime()
this_ym = now.tm_year * 100 + now.tm_mon
for brand, v in by_brand.items():
    if len(brand) < 2 or len(brand) > 20: continue
    if re.search(r'\d{4,}', brand): continue  # 연도 등 노이즈
    cats = Counter()
    late = 0
    for m, mv in v.get('monthly', {}).items():
        if len(m) < 6: continue
        my = int(m[:4]) * 100 + int(m[4:6])
        diff = (this_ym // 100 - my // 100) * 12 + (this_ym % 100 - my % 100)
        for s in mv.get('stores', []):
            if s.get('closed'): continue
            cat = detail_category(s.get('name'), s.get('upte'), s.get('type'), s.get('typeLabel'))
            cats[cat] += 1
            if diff <= 3: late += 1
    if late < 5: continue
    main_cat = cats.most_common(1)[0][0] if cats else 'food'
    weight = FOCUS_WEIGHT.get(main_cat, 0.6)
    score = late * weight
    candidates.append({'brand': brand, 'late': late, 'mainCat': main_cat, 'score': score})

candidates.sort(key=lambda x: -x['score'])
top10 = candidates[:10]
print(f'TOP 10 brand: {[c["brand"] for c in top10]}')

if not top10:
    print('no candidates')
    raise SystemExit(0)

# 3. Apify actor 호출 — hashtags = brand 명 (공백·특수문자 제거)
def clean_hashtag(b):
    # 한글·영문·숫자만, 공백 제거
    return re.sub(r'[^가-힣a-zA-Z0-9]', '', b)

hashtags = [clean_hashtag(c['brand']) for c in top10 if clean_hashtag(c['brand'])]
hashtags = [h for h in hashtags if len(h) >= 2]
print(f'hashtags: {hashtags}')

# Apify run-sync API (결과 즉시 받음)
ACTOR_ID = 'apify~instagram-hashtag-scraper'
url = f'https://api.apify.com/v2/acts/{ACTOR_ID}/run-sync-get-dataset-items?token={APIFY_TOKEN}'
payload = {
    'hashtags': hashtags,
    'resultsType': 'reels',  # 릴스가 화제성 더 잘 반영
    'resultsLimit': 8,  # 비용 절감
}
data = json.dumps(payload).encode()
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')
try:
    with urllib.request.urlopen(req, timeout=300) as r:
        items = json.loads(r.read())
        print(f'✅ Apify returned {len(items)} items')
except urllib.error.HTTPError as e:
    print(f'❌ Apify HTTP {e.code}: {e.read().decode()[:300]}')
    raise SystemExit(1)
except Exception as e:
    print(f'❌ Apify err: {e}')
    raise SystemExit(1)

# 4. brand별 집계
by_brand_buzz = {}
for c in top10:
    by_brand_buzz[c['brand']] = {
        'mainCat': c['mainCat'], 'newOpens3M': c['late'],
        'posts': 0, 'totalLikes': 0, 'totalViews': 0, 'totalComments': 0,
        'topHashtags': [], 'samplePosts': []
    }

# hashtag → brand 매핑
hash_to_brand = {clean_hashtag(c['brand']).lower(): c['brand'] for c in top10}
hashtag_counts = {c['brand']: Counter() for c in top10}

for item in items:
    # 어느 hashtag 결과인지 — input hashtag 또는 caption에 포함된 hashtag로 추정
    matched_brand = None
    # item.hashtag 또는 input hashtag 필드 확인
    item_hashtag = (item.get('input', {}).get('hashtag') or item.get('hashtag') or '').lower()
    if item_hashtag in hash_to_brand:
        matched_brand = hash_to_brand[item_hashtag]
    else:
        # caption에서 brand hashtag 찾기
        caption = (item.get('caption') or '').lower()
        for h, b in hash_to_brand.items():
            if '#' + h in caption or h in caption[:200]:
                matched_brand = b; break
    if not matched_brand:
        # 첫 hashtag만 match — 결과는 input 순서대로 올 가능성
        continue
    buzz = by_brand_buzz[matched_brand]
    buzz['posts'] += 1
    buzz['totalLikes'] += item.get('likesCount', 0) or 0
    buzz['totalViews'] += item.get('videoViewCount', 0) or item.get('videoPlayCount', 0) or 0
    buzz['totalComments'] += item.get('commentsCount', 0) or 0
    # hashtag 수집
    for h in (item.get('hashtags') or []):
        hashtag_counts[matched_brand][h] += 1
    # sample post URL
    if len(buzz['samplePosts']) < 3 and item.get('url'):
        buzz['samplePosts'].append({
            'url': item.get('url'),
            'likes': item.get('likesCount', 0) or 0,
            'views': item.get('videoViewCount', 0) or item.get('videoPlayCount', 0) or 0,
            'caption': (item.get('caption') or '')[:100]
        })

for b in by_brand_buzz:
    buzz = by_brand_buzz[b]
    if buzz['posts']:
        buzz['avgLikes'] = round(buzz['totalLikes'] / buzz['posts'])
        buzz['avgViews'] = round(buzz['totalViews'] / buzz['posts'])
    else:
        buzz['avgLikes'] = 0
        buzz['avgViews'] = 0
    buzz['topHashtags'] = [h for h, n in hashtag_counts[b].most_common(8)]

# 5. 저장
import datetime
out = {
    'at': datetime.datetime.utcnow().isoformat() + 'Z',
    'source': 'apify/instagram-hashtag-scraper',
    'resultsType': 'reels',
    'resultsLimit': 8,
    'brandCount': len(by_brand_buzz),
    'itemsTotal': len(items),
    'brands': by_brand_buzz,
}
os.makedirs('data', exist_ok=True)
with open('data/sns_buzz.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
size = os.path.getsize('data/sns_buzz.json')
print(f'✅ sns_buzz.json saved: {size/1024:.1f}KB, {len(by_brand_buzz)} brands')
for b, buzz in by_brand_buzz.items():
    print(f'  {b}: posts={buzz["posts"]} avgLikes={buzz["avgLikes"]} avgViews={buzz["avgViews"]}')
