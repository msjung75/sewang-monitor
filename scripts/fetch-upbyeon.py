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

v3 (2026-11-22): 자동 브랜드 확장 — 고정 29개 + YTD 주점 브랜드(2건 이상) 순환 점검.
  · 검색어는 브랜드 앞 3글자(띄어쓰기 변형 흡수) → 결과를 상호 접두어로 로컬 필터
  · 1회 API 호출 예산(UPBYEON_BUDGET) 안에서 오래 안 본 브랜드부터 점검, 결과는 기존 파일에 병합
  · 에러 난 브랜드는 직전 결과 유지

출력: data/upbyeon_2026.json
"""
import asyncio, aiohttp, json, time, sys, os, re, urllib.parse

KEY = os.environ.get("DATA_GO_KR_KEY", "")
BASELINE = os.environ.get("UPBYEON_BASELINE", "20260101")
OUTPUT = os.environ.get("OUTPUT", "data/upbyeon_2026.json")
CONCURRENCY = int(os.environ.get("CONCURRENCY", "6"))
BUDGET = int(os.environ.get("UPBYEON_BUDGET", "3000"))   # 1회 실행 API 호출 상한
AUTO_MIN = int(os.environ.get("UPBYEON_AUTO_MIN", "2"))  # 자동 브랜드 최소 올해 건수
CALLS = 0
TERM_CACHE = {}

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
    global CALLS
    async with sem:
        CALLS += 1
        for attempt in range(4):
            try:
                async with sess.get(url, timeout=aiohttp.ClientTimeout(total=20),
                                     headers={"Accept":"application/json"}) as r:
                    text = await r.text()
                    return json.loads(text)
            except Exception as e:
                if attempt == 3: raise RuntimeError(f"{type(e).__name__}: {e}")
                await asyncio.sleep((2**attempt) * 0.5)

async def page_info(sess, svc_key, brand, sem, max_pages=15):
    """brand = 검색어 (BPLC_NM LIKE)."""
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


def compact(s):
    s = re.sub(r"\((주|유|합)\)|주\)|㈜|주식회사|농업회사법인|유한회사", "", s or "")
    return re.sub(r"[\s\(\)\[\]\-_.·:,'\"]", "", s).lower()

def search_term(brand):
    b = re.sub(r"\((주|유|합)\)|주\)|㈜|주식회사|농업회사법인|유한회사", " ", brand or "").strip()
    tok = b.split()[0] if b else ""
    if re.match(r"^[가-힣]", tok) and len(tok) > 3: return tok[:3]
    return tok

async def process_brand(sess, spec, sem):
    """spec: {brand, svc, term, prefixes(None=검색 결과 전부 인정), ytd_brand, source}"""
    brand, svc_key = spec["brand"], spec["svc"]
    t0 = time.time()
    ck = (svc_key, spec["term"])
    if ck not in TERM_CACHE:
        TERM_CACHE[ck] = await page_info(sess, svc_key, spec["term"], sem)
    items, total = TERM_CACHE[ck]
    items = list(items)
    if spec.get("prefixes"):
        pfx = spec["prefixes"]
        items = [it for it in items if any(compact(it.get("BPLC_NM","")).startswith(p) for p in pfx)]
        total = len(items)
    candidates, new_perm = [], 0
    for it in items:
        lcp = (it.get("LCPMT_YMD","") or "").replace("-","")[:8]
        upd = "".join(c for c in (it.get("DAT_UPDT_PNT","") or "") if c.isdigit())[:8]
        if not lcp: continue
        if lcp >= BASELINE: new_perm += 1
        elif upd >= BASELINE: candidates.append(it)

    cap = min(len(candidates), 20 if spec.get("source") == "auto" else 80)
    verify_tasks = [verify(sess, svc_key, c, sem) for c in candidates[:cap]]
    verified = await asyncio.gather(*verify_tasks, return_exceptions=True)

    own = [compact(brand)] + list(spec.get("prefixes") or [])
    upbyeon, upbyeon_real = [], []
    for cand, old in zip(candidates[:cap], verified):
        if isinstance(old, Exception) or old is None: continue
        old_name = old.get("BPLC_NM","")
        new_name = cand.get("BPLC_NM","")
        if old_name and old_name != new_name:
            code = cand.get("OPN_ATMY_GRP_CD") or cand.get("MNG_NO","").split("-")[0]
            baseline_state = old.get("TRDSTATE_NM","") or old.get("DTL_STATE_NM","") or old.get("DTL_SALS_STTS_NM","") or old.get("SALS_STTS_NM","")
            current_state = cand.get("TRDSTATE_NM","") or cand.get("DTL_STATE_NM","") or cand.get("DTL_SALS_STTS_NM","") or cand.get("SALS_STTS_NM","")
            reopen_type = "pure_rename"
            if baseline_state and any(x in baseline_state for x in ["폐업","말소","취소"]):
                reopen_type = "reopened"
            oc = compact(old_name)
            same_brand_before = any(p and oc.startswith(p) for p in own)  # 원래 같은 브랜드였던 지점명 변경
            entry = {
                "mng_no": cand.get("MNG_NO"),
                "old_name": old_name,
                "new_name": new_name,
                "addr": cand.get("ROAD_NM_ADDR") or cand.get("LOTNO_ADDR",""),
                "lcpmt": cand.get("LCPMT_YMD"),
                "dat_updt": cand.get("DAT_UPDT_PNT"),
                "region_code": code,
                "region_name": region_name(code),
                "trivial": is_trivial_rename(old_name, new_name) or same_brand_before,
                "baseline_state": baseline_state,
                "current_state": current_state,
                "reopen_type": reopen_type,
                "upte": cand.get("SNTTN_BZSTAT_NM",""),
            }
            if any(x in (current_state or "") for x in ["폐업","말소","취소"]):
                entry["trivial"] = True  # 지금 폐업 상태면 전환 출점으로 안 봄
            upbyeon.append(entry)
            if not entry["trivial"] and reopen_type == "pure_rename":
                upbyeon_real.append(entry)

    total_growth = new_perm + len(upbyeon_real)
    ratio = (len(upbyeon_real)/total_growth) if total_growth else 0
    log(f"{brand} [{spec['term']}]: 매장 {len(items)}/{total} | 신규 {new_perm} | 업변 {len(upbyeon)} (real {len(upbyeon_real)}) | {time.time()-t0:.1f}s | calls {CALLS}")
    return brand, {
        "service": svc_key,
        "source": spec.get("source","fixed"),
        "ytd_brand": spec.get("ytd_brand"),
        "search_term": spec["term"],
        "checked": time.strftime("%Y%m%d"),
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

def _js_regex(html, name):
    m = re.search(r"var " + name + r" = /(.*)/([a-z]*);", html)
    if not m: return None
    return re.compile(m.group(1), re.I if "i" in m.group(2) else 0)

def auto_brand_specs():
    """YTD 요약에서 주점 브랜드(올해 AUTO_MIN건 이상)를 뽑아 점검 대상으로."""
    try:
        y = json.load(open("data/ytd_2026_summary.json", encoding="utf-8")).get("by_brand", {})
        bo = json.load(open("data/brand_overrides.json", encoding="utf-8"))
        html = open("index.html", encoding="utf-8").read()
    except Exception as e:
        log(f"auto brand load fail: {e}"); return []
    sool = _js_regex(html, "SOOL_RE"); excl = _js_regex(html, "EXCLUDE_NAME"); corp = _js_regex(html, "EXCLUDE_CORP")
    corp_name = re.compile(r"주식회사|농업회사법인|유한회사|\(주\)|㈜|^주\)")
    excluded = {x.get("name") for x in bo.get("excluded", [])}
    aliases = {re.sub(r"\s", "", k).lower(): v for k, v in (bo.get("brand_aliases") or {}).items()}
    catov = bo.get("category_overrides") or {}
    groups = {}
    for k, v in y.items():
        if k in excluded or (excl and excl.search(k)): continue
        if corp_name.search(k) or (corp and corp.search(re.sub(r"\s", "", k))): continue  # 법인명 = 위탁·운영사, 브랜드 아님
        can = aliases.get(re.sub(r"\s", "", k).lower(), k)
        g = groups.setdefault(re.sub(r"\s", "", can).lower(), {"brand": can, "n": 0, "sool": False, "keys": []})
        g["n"] += (v.get("total_open", 0) or 0) + (v.get("total_closed", 0) or 0)
        g["keys"].append(k)
        if not g["sool"] and sool:
            for m in (v.get("monthly") or {}).values():
                for st in m.get("stores", []):
                    if sool.search(st.get("upte", "") or "") or sool.search(re.sub(r"\s", "", st.get("name", ""))):
                        g["sool"] = True; break
                if g["sool"]: break
    specs = []
    for g in groups.values():
        ov = catov.get(g["brand"])
        is_sool = (ov == "sool") if ov else g["sool"]
        if g["n"] < AUTO_MIN or not is_sool: continue
        cb = compact(g["brand"])
        if len(cb) < 3: continue
        # 접두어: 브랜드 + 묶인 YTD 키들에서 지점명 뗀 앞부분(3글자 이상)
        pfx = {cb}
        for k in g["keys"]:
            ck = compact(k)[:len(cb)]
            if len(ck) >= 4 and ck[:3] == cb[:3]: pfx.add(ck)
        term = search_term(g["brand"])
        if len(term) < 2: continue
        specs.append({"brand": g["brand"], "svc": "ilban", "term": term, "prefixes": sorted(pfx),
                      "ytd_brand": g["brand"], "source": "auto", "n": g["n"]})
    specs.sort(key=lambda s: -s["n"])
    return specs

async def main():
    if not KEY: raise RuntimeError("DATA_GO_KR_KEY 환경변수 미설정")
    sem = asyncio.Semaphore(CONCURRENCY)
    connector = aiohttp.TCPConnector(limit=CONCURRENCY)
    out_dir = os.path.dirname(OUTPUT) or "."
    os.makedirs(out_dir, exist_ok=True)
    prev = {}
    try:
        prev = json.load(open(OUTPUT, encoding="utf-8")).get("brands", {}) or {}
    except Exception:
        prev = {}
    results = dict(prev)

    fixed = [{"brand": b, "svc": s, "term": b, "prefixes": None, "ytd_brand": None, "source": "fixed"} for b, s in BRANDS]
    fixed_names = {compact(b) for b, _ in BRANDS}
    auto = [a for a in auto_brand_specs() if compact(a["brand"]) not in fixed_names]
    # 오래 안 본 순 (미점검=0) → 같은 날이면 건수 많은 순
    def last_checked(spec):
        p = prev.get(spec["brand"]) or {}
        return p.get("checked", "0") if not p.get("error") else "0"
    # 오래 안 본 순 → 같은 날짜면 작은 브랜드부터(호출 적음 → 한 번에 많이 커버)
    queue = sorted(fixed + auto, key=lambda s: (last_checked(s), s.get("n", 999)))
    log(f"대상: 고정 {len(fixed)} + 자동 {len(auto)} = {len(queue)} | 예산 {BUDGET} calls")

    done = 0
    async with aiohttp.ClientSession(connector=connector) as sess:
        for i, spec in enumerate(queue, 1):
            if CALLS >= BUDGET:
                log(f"예산 소진 — {done}개 점검 후 중단 (나머지는 다음 실행)"); break
            try:
                name, data = await process_brand(sess, spec, sem)
                results[name] = data
            except Exception as e:
                log(f"  ERROR {spec['brand']}: {e}")
                p = prev.get(spec["brand"])
                if p and not p.get("error"):
                    p = dict(p); p["last_error"] = str(e)[:200]; results[spec["brand"]] = p
                else:
                    results[spec["brand"]] = {"service": spec["svc"], "source": spec.get("source"), "error": str(e)[:200] or "unknown"}
            done += 1
            if done % 10 == 0 or i == len(queue):
                _save(results)
    _save(results)
    log(f"DONE → {OUTPUT} | 점검 {done} | calls {CALLS}")

def _save(results):
    out = {
        "updated": time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.localtime()),
        "baseline_date": BASELINE,
        "current_date": time.strftime("%Y%m%d"),
        "brands": results,
    }
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

if __name__ == "__main__":
    asyncio.run(main())
