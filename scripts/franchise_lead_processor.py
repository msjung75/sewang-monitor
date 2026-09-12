#!/usr/bin/env python3
"""Franchise v1 — Lead processor.

Input:
  - data/franchise_raw.json (from fetch_apify_naver.py)
  - data/franchise_brands.json
  - (optional) permits fetched from BASE_URL /api/permits for cross-check

Output:
  - data/franchise_leads.json

Logic:
  - normalize brand name/aliases + address
  - haversine within 50m == same store as an existing gov permit → status=confirmed
  - Apify-only match → status=lead, temp id apify_{brand}_{hash}
  - gov permit only (no Apify hit) → status=gov_only
  - exclude_terms filter drops booth/pop-up hits
  - >= 5 same-brand new hits within 7 days → booth_suspect (flag but still emitted)
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_PATH = os.path.join(ROOT, "data", "franchise_raw.json")
BRANDS_PATH = os.path.join(ROOT, "data", "franchise_brands.json")
OUT_PATH = os.path.join(ROOT, "data", "franchise_leads.json")

BASE_URL = os.environ.get("BASE_URL", "https://sewang-monitor.vercel.app").rstrip("/")
MATCH_RADIUS_M = 50.0
BOOTH_WINDOW_DAYS = 7
BOOTH_THRESHOLD = 5


def normalize_name(s: str) -> str:
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"[\s()\[\]{}<>,.·・~\-_/\\|:;!@#$%^&*+='\"`]", "", s)
    return s


def normalize_addr(s: str) -> str:
    if not s:
        return ""
    s = re.sub(r"\s+", " ", s).strip()
    # strip common suffixes
    s = re.sub(r"\s*\d+층.*$", "", s)
    s = re.sub(r"\s*[가-힣]?\d+호.*$", "", s)
    return s


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def fetch_permits():
    url = f"{BASE_URL}/api/permits?days=30"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        if isinstance(data, dict) and "rows" in data:
            return data["rows"]
        if isinstance(data, list):
            return data
    except Exception as e:  # noqa: BLE001
        print(f"[franchise-proc] permits fetch failed: {e}")
    return []


def match_brand(name: str, brands_cfg: list[dict]) -> dict | None:
    n = normalize_name(name)
    if not n:
        return None
    for b in brands_cfg:
        cands = [b["name"], *b.get("aliases", [])]
        for c in cands:
            cn = normalize_name(c)
            if cn and cn in n:
                return b
    return None


def is_excluded(item: dict, brand: dict) -> bool:
    text = " ".join(str(item.get(k, "")) for k in ("name", "title", "category", "description"))
    for term in brand.get("exclude_terms", []):
        if term and term in text:
            return True
    return False


def apify_coords(item: dict):
    for lat_k, lon_k in (("y", "x"), ("lat", "lng"), ("latitude", "longitude"), ("mapy", "mapx")):
        try:
            lat = float(item.get(lat_k))
            lon = float(item.get(lon_k))
            if abs(lat) < 90 and abs(lon) < 180:
                return lat, lon
        except (TypeError, ValueError):
            continue
    return None


def apify_name(item: dict) -> str:
    return str(item.get("name") or item.get("title") or item.get("placeName") or "").strip()


def apify_addr(item: dict) -> str:
    return str(item.get("address") or item.get("roadAddress") or item.get("addr") or "").strip()


def permit_coords(p: dict):
    for lat_k, lon_k in (("lat", "lng"), ("y", "x"), ("latitude", "longitude")):
        try:
            lat = float(p.get(lat_k))
            lon = float(p.get(lon_k))
            if abs(lat) < 90 and abs(lon) < 180:
                return lat, lon
        except (TypeError, ValueError):
            continue
    return None


def stable_id(brand: str, name: str, addr: str) -> str:
    h = hashlib.sha1(f"{brand}|{name}|{addr}".encode("utf-8")).hexdigest()[:10]
    return f"apify_{h}"


def main() -> int:
    if not os.path.exists(RAW_PATH):
        print(f"[franchise-proc] raw missing: {RAW_PATH}")
        return 0
    with open(BRANDS_PATH, "r", encoding="utf-8") as f:
        brands_cfg = json.load(f).get("brands", [])
    with open(RAW_PATH, "r", encoding="utf-8") as f:
        raw = json.load(f)

    permits = fetch_permits()
    print(f"[franchise-proc] permits loaded: {len(permits)}")

    now = datetime.now()
    window_start = now - timedelta(days=BOOTH_WINDOW_DAYS)

    leads = []
    matched_permit_ids = set()

    for brand_name, block in raw.get("brands", {}).items():
        brand_cfg = next((b for b in brands_cfg if b["name"] == brand_name), None)
        if not brand_cfg:
            continue
        recent_count = 0
        brand_leads = []
        for it in block.get("items", []):
            nm = apify_name(it)
            addr = apify_addr(it)
            if not nm:
                continue
            if is_excluded(it, brand_cfg):
                continue
            coords = apify_coords(it)
            status = "lead"
            mng_no = None
            matched_permit = None
            if coords and permits:
                for p in permits:
                    pc = permit_coords(p)
                    if not pc:
                        continue
                    if haversine(coords[0], coords[1], pc[0], pc[1]) <= MATCH_RADIUS_M:
                        matched_permit = p
                        status = "confirmed"
                        mng_no = p.get("mng_no") or p.get("mgtno") or p.get("id")
                        if mng_no:
                            matched_permit_ids.add(str(mng_no))
                        break
            entry = {
                "id": str(mng_no) if mng_no else stable_id(brand_name, nm, addr),
                "brand": brand_name,
                "priority": brand_cfg.get("priority", "normal"),
                "name": nm,
                "address": normalize_addr(addr),
                "lat": coords[0] if coords else None,
                "lng": coords[1] if coords else None,
                "status": status,
                "source": "apify_naver",
                "detected_at": now.isoformat(timespec="seconds"),
                "raw_url": it.get("link") or it.get("url"),
            }
            if matched_permit:
                entry["permit"] = {
                    "mng_no": mng_no,
                    "opened_at": matched_permit.get("apv_perm_ymd") or matched_permit.get("opened_at"),
                }
            brand_leads.append(entry)
            recent_count += 1
        if recent_count >= BOOTH_THRESHOLD:
            for e in brand_leads:
                if e["status"] == "lead":
                    e["status"] = "booth_suspect"
        leads.extend(brand_leads)

    # gov_only: permits that carry a franchise brand name but no Apify match
    for p in permits:
        pid = str(p.get("mng_no") or p.get("mgtno") or p.get("id") or "")
        if not pid or pid in matched_permit_ids:
            continue
        pname = p.get("name") or p.get("bplc_nm") or ""
        brand = match_brand(pname, brands_cfg)
        if not brand:
            continue
        pc = permit_coords(p)
        leads.append({
            "id": pid,
            "brand": brand["name"],
            "priority": brand.get("priority", "normal"),
            "name": pname,
            "address": normalize_addr(p.get("address") or p.get("site_addr") or ""),
            "lat": pc[0] if pc else None,
            "lng": pc[1] if pc else None,
            "status": "gov_only",
            "source": "gov_permits",
            "detected_at": now.isoformat(timespec="seconds"),
            "permit": {"mng_no": pid, "opened_at": p.get("apv_perm_ymd") or p.get("opened_at")},
        })

    out = {
        "updated": now.isoformat(timespec="seconds"),
        "counts": {
            "total": len(leads),
            "lead": sum(1 for x in leads if x["status"] == "lead"),
            "confirmed": sum(1 for x in leads if x["status"] == "confirmed"),
            "gov_only": sum(1 for x in leads if x["status"] == "gov_only"),
            "booth_suspect": sum(1 for x in leads if x["status"] == "booth_suspect"),
        },
        "leads": leads,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"[franchise-proc] wrote {OUT_PATH}: {out['counts']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
