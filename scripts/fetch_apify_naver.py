#!/usr/bin/env python3
"""Franchise v1 — Apify Naver Map Search 스크레이퍼.

- data/franchise_brands.json 로드 → 브랜드별 30건 조회
- Apify actor: delicious_zebu/naver-map-search-results-scraper
- 결과를 data/franchise_raw.json 에 저장
- APIFY_TOKEN 환경 변수 필요
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

APIFY_TOKEN = os.environ.get("APIFY_TOKEN", "").strip()
if not APIFY_TOKEN:
    print("[franchise] APIFY_TOKEN missing — skip")
    sys.exit(0)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRANDS_PATH = os.path.join(ROOT, "data", "franchise_brands.json")
OUT_PATH = os.path.join(ROOT, "data", "franchise_raw.json")

ACTOR_ID = "delicious_zebu~naver-map-search-results-scraper"
RESULTS_PER_BRAND = 30
BASE = "https://api.apify.com/v2"


def http(method: str, url: str, body=None, timeout: int = 90):
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def run_actor(query: str):
    url = f"{BASE}/acts/{ACTOR_ID}/run-sync-get-dataset-items?token={APIFY_TOKEN}&timeout=180"
    payload = {"queries": [query], "maxResults": RESULTS_PER_BRAND, "language": "ko"}
    try:
        return http("POST", url, payload, timeout=200)
    except urllib.error.HTTPError as e:
        print(f"[franchise] HTTP {e.code} for '{query}': {e.read()[:200]!r}")
        return []
    except Exception as e:  # noqa: BLE001
        print(f"[franchise] error for '{query}': {e}")
        return []


def main() -> int:
    with open(BRANDS_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    brands = cfg.get("brands", [])
    print(f"[franchise] {len(brands)} brands")

    out = {"at": time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.localtime()), "brands": {}}
    total_items = 0
    for b in brands:
        name = b["name"]
        query = b.get("query") or name
        items = run_actor(query)
        if not isinstance(items, list):
            items = []
        out["brands"][name] = {
            "query": query,
            "count": len(items),
            "items": items,
        }
        total_items += len(items)
        print(f"[franchise] {name}: {len(items)} items")
        time.sleep(1.0)

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    est_credits = total_items * 0.006  # rough est per docs
    print(f"[franchise] wrote {OUT_PATH}, total items={total_items}, est spend≈${est_credits:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
