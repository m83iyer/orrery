#!/usr/bin/env python3
"""Merge IAU pole/rotation data (from the already-fetched pck00011.tpc) into
data.json's sun/planets. Source already saved+hashed by build_data_core.py's
sibling fetch below; this script re-parses the local copy (already recorded
in sources.json by its own fetch call here)."""
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
import urllib.request

PROJECT = Path(__file__).resolve().parent.parent
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")
SSD_RAW = Path(f"/Volumes/Media/AutomationStore/project-artifacts/space-exploration/{TODAY}/raw-fetches")
DATA_OUT = PROJECT / "app" / "data"

NAIF_ID = {"sun": "10", "mercury": "199", "venus": "299", "earth": "399", "mars": "499",
           "jupiter": "599", "saturn": "699", "uranus": "799", "neptune": "899"}


def fetch_pck():
    url = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (orrery-data-pipeline)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    SSD_RAW.mkdir(parents=True, exist_ok=True)
    path = SSD_RAW / "pck00011.tpc"
    path.write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    return raw.decode("utf-8", errors="replace"), {"url": url, "fetched_utc": datetime.now(timezone.utc).isoformat(), "sha256": sha, "local_file": str(path), "supplies": ["pole (all bodies)"]}


def parse_triplet(text, naif_id, key):
    m = re.search(rf"BODY{naif_id}_{key}\s*=\s*\(([^)]+)\)", text)
    if not m:
        return None
    nums = [float(x) for x in m.group(1).split()]
    while len(nums) < 3:
        nums.append(0.0)
    return nums


def sun_radius_km(text):
    # Same kernel; a triplet like other bodies' *_RADII, all three equal for
    # a sphere. This file's own commentary flags the 696000 figure still
    # seen in older sources as the outdated 2009 IAU value — 695700 is what
    # this kernel actually loads (\begindata) as current.
    r = parse_triplet(text, "10", "RADII")
    return r[0] if r else None


def main():
    text, source = fetch_pck()
    data = json.loads((DATA_OUT / "data.json").read_text())
    sources = json.loads((DATA_OUT / "sources.json").read_text())
    sources.append(source)

    def pole_for(naif_id):
        ra = parse_triplet(text, naif_id, "POLE_RA")
        dec = parse_triplet(text, naif_id, "POLE_DEC")
        pm = parse_triplet(text, naif_id, "PM")
        if not (ra and dec and pm):
            return None
        return {
            "ra_deg": ra[0], "ra_rate_per_century": ra[1],
            "dec_deg": dec[0], "dec_rate_per_century": dec[1],
            "pm_deg": pm[0], "pm_rate_per_day": pm[1],
        }

    data["sun"]["pole"] = pole_for(NAIF_ID["sun"])
    radius = sun_radius_km(text)
    if radius:
        data["sun"]["radius_km"] = radius
    else:
        print("WARNING: no Sun radius found in pck00011.tpc")
    filled = 0
    for p in data["planets"]:
        pole = pole_for(NAIF_ID[p["id"]])
        if pole:
            p["pole"] = pole
            filled += 1
        else:
            print(f"WARNING: no pole data found for {p['id']}")

    (DATA_OUT / "data.json").write_text(json.dumps(data, indent=2))
    (DATA_OUT / "sources.json").write_text(json.dumps(sources, indent=2))
    print(f"Filled pole data for {filled}/8 planets + sun")


if __name__ == "__main__":
    main()
