#!/usr/bin/env python3
"""
세왕-monitor: 프랜차이즈 업변(상호변경) detection - nightly cron.

행정안전부 「식품_일반음식점 조회서비스」 API (data.go.kr 1741000)의
/info + /history 엔드포인트를 활용해서 1월 1일(baseline) vs 현재(snapshot)
사이에 BPLC_NM(사업장명)이 바뀐 매장을 검출한다.

알고리즘:
  1. /info BPLC_NM LIKE = brand → 전국 현 매장 list
  2. 후보 필터: LCPMT_YMD < BASELINE AND DAT_UPDT_PNT >= BASELINE
  3. /history BASE_DATE=BASELINE + 자치단체 + 동일 인허가일 → 1월 1일 BPLC_NM
  4. old_name != new_name → 업변 확정

출력: data/upbyeon_2026.json
"""
import asyncio, aiohttp, json, time, sys, os, urllib.parse

KEY = os.environ.get("DATA_GO_KR_KEY", "")
BASELINE = os.environ.get("UPBYEON_BASELINE", "20260101")
OUTPUT = os.environ.get("OUTPUT", "data/upbyeon_2026.json")
CONCURRENCY = int(os.environ.get("CONCURRENCY", "6"))

# 모니터링 대상 브랜드: (이름, 서비스key)
# svc: ilban=일반음식점, hyuge=휴게음식점, danran=단란주점, yuheung=유흥주점
BRANDS = [
    # 업변 전문 (검증된)
    ("88포차","ilban"), ("빅대디","ilban"), ("한신포차","ilban"),
    ("포차중문","ilban"), ("생마차","ilban"), ("1988포차","ilban"),
    # 치킨
    ("BHC","ilban"), ("BBQ","ilban"), ("교촌치킨","ilban"),
    ("굽네치킨","ilban"), ("깐부치킨","ilban"), ("처갓집양념치킨","ilban"),
    ("노랑통닭","ilban"), ("페리카나","ilban"), ("네네치킨","ilban"),
    ("호식이두마리치킨","ilban"), ("보드람치킨","ilban"), ("자담치킨","ilban"),
    ("멕시카나","ilban"),
    # 호프/포차/이자카야
    ("투다리","ilban"), ("봉구비어","ilban"), ("79대포","ilban"),
    ("청담이상","ilban"), ("야화혼술바","ilban"), ("우이락","ilban"),
    # 한식 / 외식
    ("새마을식당","ilban"), ("홍콩반점","ilban"), ("신선설농탕","ilban"),
    ("명륜진사갈비","ilban"),
]

SERVICES = {
    "ilban":   "general_restaurants",
    "hyuge":   "rest_cafes",
    "danran":  "singing_bars",
    "yuheung": "entertainment_bars",
}

# 행안부 자치단체코드 (개방자치단체코드) → 시도·시군구명
REGION_NAMES = {
    "3000000":"서울특별시","3010000":"서울 종로구","3020000":"서울 중구","3030000":"서울 용산구",
    "3040000":"서울 성동구","3050000":"서울 광진구","3060000":"서울 동대문구","3070000":"서울 중랑구",
    "3080000":"서울 성북구","3090000":"서울 강북구","3100000":"서울 도봉구","3110000":"서울 노원구",
    "3120000":"서울 은평구","3130000":"서울 서대문구","3140000":"서울 마포구","3150000":"서울 양천구",
    "3160000":"서울 강서구","3170000":"서울 구로구","3180000":"서울 금천구","3190000":"서울 영등포구",
    "3200000":"서울 동작구","3210000":"서울 관악구","3220000":"서울 강남구","3230000":"서울 서초구",
    "3240000":"서울 송파구","3250000":"서울 강동구",
    "3260000":"부산광역시","3350000":"부산 금정구","3380000":"부산 수영구",
    "3500000":"대구 달성군","3510000":"인천광역시","3590000":"인천 서구",
    "3600000":"광주광역시","3620000":"광주 서구","3650000":"광주 광산구",
    "3680000":"대전 대덕구","3690000":"대전 유성구","3700000":"대전 중구",
    "3710000":"대전 서구","3720000":"울산광역시","3770000":"울산 울주군",
    "3800000":"경기도","3810000":"경기 수원시","3820000":"경기 성남시",
    "3830000":"경기 의정부시","3840000":"경기 안양시","3850000":"경기 부천시",
    "3860000":"경기 광명시","3870000":"경기 동두천시","3880000":"경기 평택시",
    "3890000":"경기 안산시","3900000":"경기 고양시","3910000":"경기 과천시",
    "3920000":"경기 구리시","3930000":"경기 시흥시","3940000":"경기 군포시",
    "3950000":"경기 의왕시","3960000":"경기 하남시","3970000":"경기 용인시",
    "3980000":"경기 파주시","3990000":"경기 남양주시","4000000":"경기 오산시",
    "4010000":"경기 안성시","4020000":"경기 김포시","4030000":"경기 화성시",
    "4040000":"경기 광주시","4050000":"경기 이천시","4060000":"경기 양주시",
    "4070000":"경기 포천시","4080000":"경기 여주시","4090000":"경기 연천군",
    "4100000":"경기 가평군","4110000":"경기 양평군",
}

def region_name(code):
    if code in REGION_NAMES: return REGION_NAMES[code]
    # 모르는 코드는 시도 prefix만 추정
    if code.startswith("3"): return "기타 시도"
    if code.startswith("4"): return "기타 도"
    if code.startswith("5"): return "기타 지역"
    return code

def log(msg):
    sys.stderr.write(f"[upbyeon] {msg}\n"); sys.stderr.flush()

def is_trivial_rename(old, new):
    """법인명/괄호/띄어쓰기만 다른 경우 trivial 처리."""
    if not old or not new: return True
    oa = "".join(c for c in old if c.isalnum())
    na = "".join(c for c in new if c.isalnum())
    if oa == na: return True
    if old in new or new in old: return True
    return False

async def fetch(sess, svc, ep, params, sem):
    qs = "&".join([f"{k}={urllib.parse.quote(str(v))}" for k,v in params.items()])
    url = f"https://apis.data.go.kr/1741000/{svc}/{ep}?serviceKey={KEY}&{qs}"
    async with sem:
        for attempt in range(4):
            try:
                async with sess.get(url, timeout=aiohttp.ClientTimeout(total=20),
                                     headers={"Accept":"application/json"}) as r:
                    text = await r.text()
                    return json.loads(text)
            except Exception:
                if attempt == 3: raise
                await asyncio.sleep((2**attempt) * 0.5)

async def page_info(sess, svc_key, brand, sem, max_pages=15):
    svc = SERVICES[svc_key]
    j = await fetch(sess, svc, "info",
        {"pageNo":"1","numOfRows":"100","returnType":"json",
         "cond[BPLC_NM::LIKE]": brand}, sem)
    b = (j.get("response") or {}).get("body") or {}
    total = b.get("totalCount", 0) or 0
    items = (b.get("items") or {}).get("item") or []
    pages = min(max_pages, (total + 99) // 100)
    if pages > 1:
        tasks = [fetch(sess, svc, "info",
            {"pageNo":str(p),"numOfRows":"100","returnType":"json",
             "cond[BPLC_NM::LIKE]": brand}, sem) for p in range(2, pages+1)]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for r in results:
            if isinstance(r, Exception): continue
            arr = (((r.get("response") or {}).get("body") or {}).get("items") or {}).get("item") or []
            items.extend(arr)
    return items, total

async def verify(sess, svc_key, cand, sem):
    svc = SERVICES[svc_key]
    mng = cand.get("MNG_NO","")
    if "-" not in mng: return None
    code = mng.split("-")[0]
    lcpmt = (cand.get("LCPMT_YMD","") or "").replace("-","")[:8]
    if not lcpmt: return None
    p = {"pageNo":"1","numOfRows":"100","returnType":"json",
         "cond[BASE_DATE::EQ]": BASELINE,
         "cond[OPN_ATMY_GRP_CD::EQ]": code,
         "cond[LCPMT_YMD::GTE]": lcpmt,
         "cond[LCPMT_YMD::LT]": str(int(lcpmt)+1).zfill(8)}
    try:
        j = await fetch(sess, svc, "history", p, sem)
    except Exception:
        return None
    arr = (((j.get("response") or {}).get("body") or {}).get("items") or {}).get("item") or []
    for it in arr:
        if it.get("MNG_NO") == mng: return it
    return None

async def process_brand(sess, brand, svc_key, sem):
    t0 = time.time()
    items, total = await page_info(sess, svc_key, brand, sem)
    candidates, new_perm = [], 0
    for it in items:
        lcp = (it.get("LCPMT_YMD","") or "").replace("-","")[:8]
        upd = "".join(c for c in (it.get("DAT_UPDT_PNT","") or "") if c.isdigit())[:8]
        if not lcp: continue
        if lcp >= BASELINE: new_perm += 1
        elif upd >= BASELINE: candidates.append(it)

    cap = min(len(candidates), 80)
    verify_tasks = [verify(sess, svc_key, c, sem) for c in candidates[:cap]]
    verified = await asyncio.gather(*verify_tasks, return_exceptions=True)

    upbyeon, upbyeon_real = [], []
    for cand, old in zip(candidates[:cap], verified):
        if isinstance(old, Exception) or old is None: continue
        old_name = old.get("BPLC_NM","")
        new_name = cand.get("BPLC_NM","")
        if old_name and old_name != new_name:
            code = cand.get("OPN_ATMY_GRP_CD") or cand.get("MNG_NO","").split("-")[0]
            entry = {
                "mng_no": cand.get("MNG_NO"),
                "old_name": old_name,
                "new_name": new_name,
                "addr": cand.get("ROAD_NM_ADDR") or cand.get("LOTNO_ADDR",""),
                "lcpmt": cand.get("LCPMT_YMD"),
                "dat_updt": cand.get("DAT_UPDT_PNT"),
                "region_code": code,
                "region_name": region_name(code),
                "trivial": is_trivial_rename(old_name, new_name),
            }
            upbyeon.append(entry)
            if not entry["trivial"]:
                upbyeon_real.append(entry)

    total_growth = new_perm + len(upbyeon_real)
    ratio = (len(upbyeon_real)/total_growth) if total_growth else 0
    log(f"{brand}: 매장 {len(items)}/{total} | 신규 {new_perm} | 업변 {len(upbyeon)} (real {len(upbyeon_real)}) | 비율 {ratio*100:.0f}% | {time.time()-t0:.1f}s")
    return brand, {
        "service": svc_key,
        "current_count": len(items),
        "current_count_reported": total,
        "new_permits_count": new_perm,
        "candidate_count": len(candidates),
        "verified_count": cap,
        "upbyeon_count": len(upbyeon),
        "upbyeon_count_real": len(upbyeon_real),
        "total_growth": total_growth,
        "upbyeon_ratio": round(ratio, 3),
        "is_upbyeon_specialist": ratio >= 0.50 and len(items) >= 20 and len(upbyeon_real) >= 3,
        "upbyeon": upbyeon,
    }

async def main():
    if not KEY: raise RuntimeError("DATA_GO_KR_KEY 환경변수 미설정")
    sem = asyncio.Semaphore(CONCURRENCY)
    connector = aiohttp.TCPConnector(limit=CONCURRENCY)
    results = {}
    out_dir = os.path.dirname(OUTPUT) or "."
    os.makedirs(out_dir, exist_ok=True)

    async with aiohttp.ClientSession(connector=connector) as sess:
        for i, (brand, svc) in enumerate(BRANDS, 1):
            log(f"[{i}/{len(BRANDS)}] {brand}")
            try:
                name, data = await process_brand(sess, brand, svc, sem)
                results[name] = data
            except Exception as e:
                log(f"  ERROR: {e}")
                results[brand] = {"service": svc, "error": str(e)}
            # 증분 저장 (실패해도 부분 결과는 남김)
            out = {
                "updated": time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.localtime()),
                "baseline_date": BASELINE,
                "current_date": time.strftime("%Y%m%d"),
                "brands": results,
            }
            with open(OUTPUT, "w", encoding="utf-8") as f:
                json.dump(out, f, ensure_ascii=False, indent=2)
    log(f"DONE → {OUTPUT}")

if __name__ == "__main__":
    asyncio.run(main())
