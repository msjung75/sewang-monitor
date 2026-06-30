#!/usr/bin/env python3
"""
세왕 신규 모니터 — 프랜차이즈 자동 감지 + master 갱신
매일 nightly cron에서 실행. 행안부 신규 인허가 데이터에서:
1. 같은 정규화 상호가 14일 내 3+회, 또는 누적 5+개 매장 = 프차로 판단
2. franchise_master.json에 신규 추가 + 기존 매장 수 갱신
3. trend30_all.json 도 같이 갱신 (날짜별 신규 인허가 추이)

환경변수:
  BASE_URL: sewang-monitor API base
  MASTER_PATH: franchise_master.json 경로 (default: data/franchise_master.json)
  TREND_PATH: trend30_all.json 경로
  DAYS: 분석 기간 (default 14)
"""
import urllib.request, urllib.parse, json, sys, os, re, time, unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timedelta

BASE = os.environ.get("BASE_URL", "https://sewang-monitor.vercel.app")
MASTER_PATH = os.environ.get("MASTER_PATH", "data/franchise_master.json")
TREND_PATH = os.environ.get("TREND_PATH", "data/trend30_all.json")
DAYS = int(os.environ.get("DAYS", "14"))

# 12 regions covering all of Korea
REGIONS = ['metro','chungnam','chungbuk','gangwon','jeonnam','jeonbuk',
           'gyeongnam','gyeongbuk','jeju','daegu','busan','ulsan']

# Filters
EXCLUDED_SUFFIXES = ['유통','상사','컴퍼니','푸드시스템','에프엔비','에프앤비']
DEPT_PATTERNS = ['신세계백화점','롯데백화점','현대백화점','백화점 지하','아울렛','AK플라자',
                 '갤러리아','타임스퀘어','스타필드','롯데몰','이마트트레이더스','코엑스',
                 '더현대','의정부신세계','COEX','아이파크몰','면세점','터미널']

def is_dept_store(addr):
    return any(p in (addr or '') for p in DEPT_PATTERNS)

def is_operating_co(name):
    if not name: return True
    nm = re.sub(r'[\s\(\)주식회사]', '', name)
    return any(nm.endswith(s) for s in EXCLUDED_SUFFIXES) or \
           ('(주)' in name and len(name.replace('(주)','').strip()) < 6)

def normalize(name):
    """Aggressive brand-name normalization."""
    if not name: return ''
    name = unicodedata.normalize('NFC', name).strip()
    name = re.sub(r'\([^)]*\)\s*|\[[^\]]*\]\s*', '', name)
    name = re.sub(r'한시적|직영점|본점|분점|지점|FC점', '', name)
    name = re.sub(r'\(?주식?회사\)?', '', name)
    name = re.sub(r'(?:^|\s)\(?주\)?\s*', ' ', name)
    name = re.sub(r'\s+', ' ', name).strip()
    
    tokens = name.split()
    while tokens and tokens[-1].endswith('점') and len(tokens) > 1:
        tokens.pop()
    result = ' '.join(tokens).strip() if tokens else name
    
    if result.endswith('점') and len(result) > 4:
        for pat in [r'(천안|서울|인천|경기|부산|대구|광주|대전|울산|강원|충남|충북|전남|전북|경남|경북|제주|광안|강남|역삼|연남|판교|일산)',
                    r'(\d+호|\d+호점|\d+차)']:
            m = re.search(pat, result)
            if m and m.start() > 1:
                bp = result[:m.start()].strip()
                if len(bp) >= 2:
                    result = bp
                    break
    return result.strip()

def canonical(name):
    return re.sub(r'[\s\(\)주식회사한시적]', '', name or '').lower()

def fetch_region(region, days, max_pages=30, retries=2):
    url = f"{BASE}/api/permits?region={region}&type=all&days={days}&maxPages={max_pages}"
    for i in range(retries+1):
        try:
            req = urllib.request.Request(url, headers={'Accept':'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode()).get('items', [])
        except Exception as e:
            sys.stderr.write(f'[{region}] retry {i+1}/{retries+1}: {e}\n')
            time.sleep(3)
    return []

def main():
    sys.stderr.write(f"[franchise] fetching {DAYS}d nationwide\n")
    all_items = []
    for r in REGIONS:
        items = fetch_region(r, DAYS)
        sys.stderr.write(f"  {r}: {len(items)}\n")
        all_items.extend(items)
    sys.stderr.write(f"[franchise] total: {len(all_items)}\n")
    
    # Build brand → stores map
    brand_counter = Counter()
    brand_stores = defaultdict(list)
    brand_name_display = {}
    seen = set()
    
    for x in all_items:
        mng = x.get('id','') or x.get('name','')+x.get('addr','')
        if mng in seen: continue
        seen.add(mng)
        
        name = x.get('name','')
        addr = x.get('addr','')
        
        if is_dept_store(addr) or is_operating_co(name): continue
        
        norm = normalize(name)
        if not norm or len(norm) < 2: continue
        
        key = canonical(norm)
        if not key: continue
        
        brand_counter[key] += 1
        brand_stores[key].append({
            'name': name, 'addr': addr[:80],
            'permitDate': x.get('permitDate',''), 'id': x.get('id','')
        })
        if key not in brand_name_display or len(norm) < len(brand_name_display[key]):
            brand_name_display[key] = norm
    
    # Load existing master
    try:
        with open(MASTER_PATH,'r',encoding='utf-8') as f:
            master = json.load(f)
    except Exception:
        master = {'updated':'', 'source':'', 'total':0, 'compact_lookup':{}, 'brands':[]}
    
    existing_brands = master.get('brands', [])
    existing_keys = set()
    for b in existing_brands:
        nm = b.get('name','') if isinstance(b, dict) else b
        k = canonical(normalize(nm))
        if k: existing_keys.add(k)
    
    # Detect new franchises (3+ in window, not in master)
    threshold = 3
    new_franchises = []
    updated_brands = []
    
    for key, cnt in brand_counter.items():
        display = brand_name_display[key]
        if cnt >= threshold and key not in existing_keys:
            # Fuzzy check (avoid false positive)
            is_in = False
            for ek in existing_keys:
                if len(ek) >= 3 and len(key) >= 3:
                    if (key in ek or ek in key) and abs(len(key)-len(ek)) <= 4:
                        is_in = True; break
            if not is_in:
                new_franchises.append({
                    'name': display, 'key': key, 'stores_added': cnt,
                    'detected_at': time.strftime("%Y-%m-%d"),
                    'sample_stores': brand_stores[key][:3]
                })
                existing_brands.append({'name': display, 'stores': cnt})
        elif key in existing_keys:
            # Update existing brand's store count (add new permits)
            for b in existing_brands:
                bk = canonical(normalize(b.get('name','') if isinstance(b, dict) else b))
                if bk == key:
                    if isinstance(b, dict):
                        b['stores'] = b.get('stores', 0) + cnt
                        b['last_updated'] = time.strftime("%Y-%m-%d")
                    updated_brands.append({'name': display, 'added': cnt})
                    break
    
    # Save master
    master['updated'] = time.strftime("%Y-%m-%dT%H:%M:%S+09:00")
    master['source'] = f'sewang-monitor API nationwide {DAYS}d auto-detect'
    master['total'] = len(existing_brands)
    master['brands'] = existing_brands
    master.setdefault('audit', []).append({
        'run_at': master['updated'], 'new_franchises_added': len(new_franchises),
        'existing_updated': len(updated_brands), 'window_days': DAYS
    })
    # Keep last 30 audit entries
    master['audit'] = master['audit'][-30:]
    
    os.makedirs(os.path.dirname(MASTER_PATH) or '.', exist_ok=True)
    with open(MASTER_PATH,'w',encoding='utf-8') as f:
        json.dump(master, f, ensure_ascii=False, indent=2)
    sys.stderr.write(f"[franchise] master updated: +{len(new_franchises)} new, {len(updated_brands)} updated\n")
    
    # Update trend30 (날짜별 카테고리별 신규 인허가 count)
    try:
        with open(TREND_PATH,'r',encoding='utf-8') as f:
            trend = json.load(f)
    except Exception:
        trend = {'updated':'', 'days': {}}
    
    # Bucket by date
    by_date = defaultdict(lambda: defaultdict(int))
    for x in all_items:
        d = x.get('permitDate','')
        if not d or len(d) != 8: continue
        date = f'{d[:4]}-{d[4:6]}-{d[6:8]}'
        upte = (x.get('upte','') or '').strip()
        type_ = x.get('type','')
        by_date[date][type_] += 1
        # Categorize for trend chart
        cat = 'other'
        if any(k in upte for k in ['커피','제과','아이스크림','다방']) or any(k in x.get('name','') for k in ['카페','베이커리','베이글']):
            cat = 'cafe'
        elif any(k in upte for k in ['호프','통닭','감성주점','단란','유흥','정종','대포']):
            cat = 'bar'
        elif any(k in upte for k in ['한식','일식','중식','양식','횟집','분식','식육','경양식','뷔페','패스트푸드']):
            cat = 'restaurant'
        by_date[date]['cat:'+cat] += 1
    
    # Merge into trend30
    days_obj = trend.get('days', {})
    for d, counts in by_date.items():
        days_obj[d] = dict(counts)
    # Keep last 30 days
    cutoff = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    days_obj = {k: v for k, v in days_obj.items() if k >= cutoff}
    trend['days'] = days_obj
    trend['updated'] = time.strftime("%Y-%m-%dT%H:%M:%S+09:00")
    
    os.makedirs(os.path.dirname(TREND_PATH) or '.', exist_ok=True)
    with open(TREND_PATH,'w',encoding='utf-8') as f:
        json.dump(trend, f, ensure_ascii=False, indent=2)
    sys.stderr.write(f"[trend30] {len(days_obj)} days\n")
    
    # Output summary for workflow log
    print(json.dumps({
        'ok': True, 'new_franchises_added': len(new_franchises),
        'existing_updated': len(updated_brands),
        'new_franchise_names': [f['name'] for f in new_franchises][:50],
        'trend_days_updated': len(by_date),
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
