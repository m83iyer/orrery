#!/usr/bin/env python3
"""Fill Saturn's ring geometry in data.json from the PDS Ring-Moon Systems
Node's own "Vital Statistics for Saturn's Rings" table — the app's six
rendered bands (D, C, B, Cassini Division, A, F) are these exact named
features' Inner/Outer Boundary columns, not an arbitrary cutoff: the table
also lists ~30 finer sub-features (gaps, ringlets, regions) that the app
does not render at this level of detail."""
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

BANDS_WANTED = ["D Ring", "C Ring", "B Ring", "Cassini Division", "A Ring", "F Ring"]


def fetch():
    url = "https://pds-rings.seti.org/saturn/saturn_rings_table.html"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (orrery-data-pipeline)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    SSD_RAW.mkdir(parents=True, exist_ok=True)
    path = SSD_RAW / "pds_saturn_rings.html"
    path.write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    return raw.decode("utf-8", errors="replace"), {
        "url": url,
        "fetched_utc": datetime.now(timezone.utc).isoformat(),
        "sha256": sha,
        "local_file": str(path),
        "supplies": ["saturn.rings"],
    }


def strip(s):
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("\xa0", " ")
    return re.sub(r"\s+", " ", s).strip()


def parse_bands(html):
    # The page is a flat sequence of <table><tr><td> rows (Feature, Inner
    # Boundary, Outer Boundary, Optical Depth, Type, Associated Moons,
    # Footnotes, Comments) with no <tbody> wrapper, so split on <tr> directly.
    rows = re.findall(r"<tr>(.*?)</tr>", html, re.S)
    found = {}
    for r in rows:
        cells = [strip(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)]
        if len(cells) < 3:
            continue
        name = cells[0]
        if name not in BANDS_WANTED:
            continue
        inner = re.sub(r"[^\d.]", "", cells[1])
        outer = re.sub(r"[^\d.]", "", cells[2])
        if not inner or not outer:
            continue
        found[name] = {"name": name, "inner_km": float(inner), "outer_km": float(outer)}
    return found


def main():
    html, source = fetch()
    found = parse_bands(html)
    missing = [b for b in BANDS_WANTED if b not in found]
    if missing:
        raise SystemExit(f"ERROR: could not find these ring features on the page (format may have changed): {missing}")

    bands = [found[name] for name in BANDS_WANTED]
    rings = {
        "inner_km": bands[0]["inner_km"],
        "outer_km": bands[-1]["outer_km"],
        "bands": bands,
        "source": f"PDS Ring-Moon Systems Node, Vital Statistics for Saturn's Rings, fetched {source['fetched_utc'][:10]}",
        "texture": "assets/textures/saturn_ring_alpha.png",
    }

    data = json.loads((DATA_OUT / "data.json").read_text())
    sources = json.loads((DATA_OUT / "sources.json").read_text())
    # Replace any prior (hand-typed / malformed) entry for this same URL
    # rather than appending a duplicate.
    sources = [s for s in sources if s.get("url") != source["url"]]
    sources.append(source)

    saturn = next(p for p in data["planets"] if p["name"] == "Saturn")
    saturn["rings"] = rings

    (DATA_OUT / "data.json").write_text(json.dumps(data, indent=2))
    (DATA_OUT / "sources.json").write_text(json.dumps(sources, indent=2))
    print("Saturn rings:")
    for b in bands:
        print(f"  {b['name']:20s} {b['inner_km']:>10,.0f} -> {b['outer_km']:>10,.0f} km")


if __name__ == "__main__":
    main()
