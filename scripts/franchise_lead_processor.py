#!/usr/bin/env python3
"""Franchise v2 — Lead processor.

Key changes vs v1:
  - stable_id = Naver PlaceId when available; fallback f"{brand}_{sha1(name|addr)[:10]}"
  - Diff-based booth suspect: previous scan snapshotted to data/franchise_leads_prev.json;
    new items compared against it. booth_suspect only fires when a brand has
    >= BOOTH_THRESHOLD *newly-appeared* stores whose first_seen is within
    BOOTH_WINDOW_DAYS. Removes the v1 bug where every item got booth_suspect.
  - First-run mode: if prev has no leads, everything is saved as `baseline`
    (no `lead` and no `booth_suspect` flags emitted); acts as the baseline
    snapshot the next scan diffs against.
  - Per-brand and total counters printed for the workflow log.

I/O:
  Input  : data/franchise_raw.json, data/franchise_brands.json
  Prev   : data/franchise_leads_prev.json (previous scan snapshot)
  Output : data/franchise_leads.json

Env:
  BASE_URL           default https://sewang-monitor.vercel.app
  BOOTH_WINDOW_DAYS  default 7
  BOOTH_THRESHOLD    default 5
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import urllib.request
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_PATH = os.path.join(ROOT, "data", "franchise_raw.json")
BRANDS_PATH = os.path.join(ROOT, "data", "franchise_brands.json")
OUT_PATH = os.path.join(ROOT, "data", "franchise_leads.json")
PREV_PATH = os.path.join(ROOT, "data", "franchise_leads_prev.json")

BASE_URL = os.environ.get("BASE_URL", "https://sewang-monitor.vercel.app").rstrip("/")
MATCH_RADIUS_M = 50.0
BOOTH_WINDOW_DAYS = int(os.environ.get("BOOTH_WINDOW_DAYS", "7"))
BOOTH_THRESHOLD = int(os.environ.get("BOOTH_THRESHOLD", "5"))


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
    s = re.sub(r"\s*\d+층.*$", "", s)
    s = re.sub(r"\s*[가-힣]?\d+호.*$", "", s)
    return s


def haversine(lat1, lon1, lat2, lon2):
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


def match_brand(name, brands_cfg):
    n = normalize_name(name)
    if not n:
        return None
    for b in brands_cfg:
        for c in [b["name"], *b.get("aliases", [])]:
            cn = normalize_name(c)
            if cn and cn in n:
                return b
    return None


def is_excluded(item, brand_cfg):
    text = " ".join(
        str(item.get(k, ""))
        for k in ("name", "title", "category", "description", "Name", "Category", "Description")
    )
    for term in brand_cfg.get("exclude_terms", []):
        if term and term in text:
            return True
    return False


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def apify_coords(item):
    for lat_k, lon_k in (
        ("Latitude", "Longitude"),
        ("y", "x"),
        ("lat", "lng"),
        ("latitude", "longitude"),
        ("mapy", "mapx"),
    ):
        lat = _to_float(item.get(lat_k))
        lon = _to_float(item.get(lon_k))
        if lat is not None and lon is not None and abs(lat) < 90 and abs(lon) < 180:
            return lat, lon
    return None


def apify_name(item):
    for k in ("Name", "name", "title", "placeName"):
        v = item.get(k)
        if v:
            return str(v).strip()
    return ""


def apify_addr(item):
    for k in ("FullAddress", "Address", "address", "roadAddress", "addr"):
        v = item.get(k)
        if v:
            return str(v).strip()
    return ""


def apify_place_id(item):
    for k in ("PlaceId", "placeId", "place_id"):
        v = item.get(k)
        if v:
            return str(v).strip()
    return None


def apify_url(item):
    for k in ("NaverMapUrl", "link", "url"):
        v = item.get(k)
        if v:
            return v
    pid = apify_place_id(item)
    if pid:
        return f"https://map.naver.com/p/entry/place/{pid}"
    return None


def permit_coords(p):
    for lat_k, lon_k in (("lat", "lng"), ("y", "x"), ("latitude", "longitude")):
        lat = _to_float(p.get(lat_k))
        lon = _to_float(p.get(lon_k))
        if lat is not None and lon is not None and abs(lat) < 90 and abs(lon) < 180:
            return lat, lon
    return None


def stable_id_for(brand, name, addr, place_id):
    if place_id:
        return str(place_id)
    h = hashlib.sha1(f"{brand}|{name}|{addr}".encode("utf-8")).hexdigest()[:10]
    return f"{brand}_{h}"


def _parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


def main():
    if not os.path.exists(RAW_PATH):
        print(f"[franchise-proc] raw missing: {RAW_PATH}")
        return 0
    with open(BRANDS_PATH, "r", encoding="utf-8") as f:
        brands_cfg = json.load(f).get("brands", [])
    with open(RAW_PATH, "r", encoding="utf-8") as f:
        raw = json.load(f)

    # 1) Snapshot last scan's OUT -> PREV (before we overwrite OUT)
    if os.path.exists(OUT_PATH):
        try:
            shutil.copy(OUT_PATH, PREV_PATH)
        except Exception as e:
            print(f"[franchise-proc] snapshot prev failed: {e}")

    # 2) Load PREV as the diff reference
    prev_by_id = {}
    if os.path.exists(PREV_PATH):
        try:
            with open(PREV_PATH, "r", encoding="utf-8") as f:
                prev_data = json.load(f)
            for l in (prev_data or {}).get("leads", []) or []:
                sid = l.get("id")
                if sid:
                    prev_by_id[str(sid)] = l
        except Exception as e:
            print(f"[franchise-proc] prev load failed: {e}")

    first_run = len(prev_by_id) == 0
    if first_run:
        print("[franchise-proc] first-run mode — saving baseline; no lead/booth_suspect flags")

    permits = fetch_permits()
    print(f"[franchise-proc] permits loaded: {len(permits)}")

    now = datetime.now()
    now_iso = now.isoformat(timespec="seconds")
    window_cutoff = now - timedelta(days=BOOTH_WINDOW_DAYS)

    leads = []
    matched_permit_ids = set()
    brand_summary = []

    for brand_name, block in raw.get("brands", {}).items():
        brand_cfg = next((b for b in brands_cfg if b["name"] == brand_name), None)
        if not brand_cfg:
            print(f"[franchise-proc] no cfg for brand {brand_name}, skip")
            continue
        items = block.get("items", [])
        brand_entries = []
        b_new = 0
        b_existing = 0
        b_confirmed = 0
        b_lead = 0
        b_skipped_noname = 0
        b_skipped_excluded = 0

        for it in items:
            nm = apify_name(it)
            addr = apify_addr(it)
            if not nm:
                b_skipped_noname += 1
                continue
            if is_excluded(it, brand_cfg):
                b_skipped_excluded += 1
                continue
            pid = apify_place_id(it)
            coords = apify_coords(it)
            sid = stable_id_for(brand_name, nm, addr, pid)
            prev = prev_by_id.get(sid)
            first_seen = (prev or {}).get("first_seen") or now_iso

            status = None
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

            if status is None:
                if first_run:
                    status = "baseline"
                elif prev is None:
                    status = "lead"
                else:
                    # Was seen before; retain prior classification unless it was
                    # 'lead'/'booth_suspect'/'baseline' — those become 'existing' now.
                    prev_status = prev.get("status")
                    if prev_status in ("lead", "booth_suspect", "baseline", "existing"):
                        status = "existing"
                    else:
                        status = prev_status or "existing"

            entry = {
                "id": sid,
                "place_id": pid,
                "brand": brand_name,
                "priority": brand_cfg.get("priority", "normal"),
                "name": nm,
                "address": normalize_addr(addr),
                "lat": coords[0] if coords else None,
                "lng": coords[1] if coords else None,
                "status": status,
                "source": "apify_naver",
                "first_seen": first_seen,
                "detected_at": now_iso,
                "raw_url": apify_url(it),
            }
            if matched_permit:
                entry["permit"] = {
                    "mng_no": mng_no,
                    "opened_at": matched_permit.get("apv_perm_ymd") or matched_permit.get("opened_at"),
                }
            brand_entries.append(entry)
            if prev is None:
                b_new += 1
            else:
                b_existing += 1
            if status == "confirmed":
                b_confirmed += 1
            elif status == "lead":
                b_lead += 1

        # 3) Diff-based booth-suspect (per brand, per window). Skip on first_run.
        booth_flagged = 0
        if not first_run and b_lead >= BOOTH_THRESHOLD:
            recent_new = [
                e for e in brand_entries
                if e["status"] == "lead"
                and (_parse_iso(e["first_seen"]) or now) >= window_cutoff
            ]
            if len(recent_new) >= BOOTH_THRESHOLD:
                for e in recent_new:
                    e["status"] = "booth_suspect"
                booth_flagged = len(recent_new)
                b_lead -= booth_flagged

        leads.extend(brand_entries)
        brand_summary.append({
            "brand": brand_name, "items": len(items), "new": b_new, "existing": b_existing,
            "confirmed": b_confirmed, "lead": b_lead, "booth": booth_flagged,
            "skip_noname": b_skipped_noname, "skip_excluded": b_skipped_excluded,
        })
        print(
            f"[{brand_name}] Apify={len(items)} 신규={b_new} 기존={b_existing} "
            f"확정={b_confirmed} lead={b_lead} booth={booth_flagged}"
        )

    # 4) gov_only rows for permits not matched by any Apify item
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
            "place_id": None,
            "brand": brand["name"],
            "priority": brand.get("priority", "normal"),
            "name": pname,
            "address": normalize_addr(p.get("address") or p.get("site_addr") or ""),
            "lat": pc[0] if pc else None,
            "lng": pc[1] if pc else None,
            "status": "gov_only",
            "source": "gov_permits",
            "first_seen": now_iso,
            "detected_at": now_iso,
            "permit": {"mng_no": pid, "opened_at": p.get("apv_perm_ymd") or p.get("opened_at")},
        })

    # 5) Dedup by id (last-wins)
    dedup = {}
    for l in leads:
        dedup[l["id"]] = l
    deduped = len(leads) - len(dedup)
    leads = list(dedup.values())

    counts = {
        "total": len(leads),
        "confirmed": sum(1 for x in leads if x["status"] == "confirmed"),
        "lead": sum(1 for x in leads if x["status"] == "lead"),
        "gov_only": sum(1 for x in leads if x["status"] == "gov_only"),
        "booth_suspect": sum(1 for x in leads if x["status"] == "booth_suspect"),
        "existing": sum(1 for x in leads if x["status"] == "existing"),
        "baseline": sum(1 for x in leads if x["status"] == "baseline"),
    }
    out = {
        "updated": now_iso,
        "counts": counts,
        "meta": {
            "first_run": first_run,
            "booth_window_days": BOOTH_WINDOW_DAYS,
            "booth_threshold": BOOTH_THRESHOLD,
        },
        "brand_summary": brand_summary,
        "leads": leads,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(
        f"[franchise-proc] total: {counts['total']} "
        f"(confirmed {counts['confirmed']}, lead {counts['lead']}, "
        f"gov_only {counts['gov_only']}, booth {counts['booth_suspect']}, "
        f"existing {counts['existing']}, baseline {counts['baseline']}, deduplicated {deduped})"
    )
    print(f"[franchise-proc] wrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
