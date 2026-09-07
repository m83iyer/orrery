#!/usr/bin/env python3
"""Fill data.json's sun.mass_kg from JPL's own DE440 astrodynamic-constants
page. GM (the heliocentric gravitational constant) is what's actually
measured to high precision (spacecraft tracking); "mass in kg" is always a
downstream conversion via G, since G itself is only known to ~1 part in
10,000 (the least-precisely-known fundamental constant) — this is standard
practice, not a shortcut, and mirrors how AU_KM is already a defined
constant hardcoded in orbits.js with no separate fetch: G is a universal
physical constant, not solar-system data, so it's cited here rather than
given its own sources.json fetch entry."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import re
import urllib.request

PROJECT = Path(__file__).resolve().parent.parent
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")
SSD_RAW = Path(f"/Volumes/Media/AutomationStore/project-artifacts/space-exploration/{TODAY}/raw-fetches")
DATA_OUT = PROJECT / "app" / "data"

# CODATA 2018 recommended value, m^3 kg^-1 s^-2 (same constant, same
# precision convention as add_moon_data.py's G = 6.674e-11).
G = 6.674e-11


def fetch_astro_par():
    url = "https://ssd.jpl.nasa.gov/astro_par.html"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (orrery-data-pipeline)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    SSD_RAW.mkdir(parents=True, exist_ok=True)
    path = SSD_RAW / "jpl_astro_par.html"
    path.write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    return raw.decode("utf-8", errors="replace"), {
        "url": url,
        "fetched_utc": datetime.now(timezone.utc).isoformat(),
        "sha256": sha,
        "local_file": str(path),
        "supplies": ["sun.mass_kg (via GM_sun / G)"],
    }


def parse_gm_sun(html):
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&#\d+;", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    m = re.search(r"GM sun\s+([\d.]+)\s*x\s*10\s*(\d+)\s*m", text)
    if not m:
        return None
    mantissa, exponent = float(m.group(1)), int(m.group(2))
    return mantissa * (10 ** exponent)  # m^3 s^-2


def main():
    html, source = fetch_astro_par()
    gm_sun = parse_gm_sun(html)
    if gm_sun is None:
        raise SystemExit("ERROR: could not find 'GM sun ... x 10^N m^3 s^-2' on astro_par.html — page format may have changed")

    mass_kg = gm_sun / G
    print(f"GM_sun = {gm_sun:.6e} m^3/s^2  (JPL DE440, ssd.jpl.nasa.gov/astro_par.html)")
    print(f"mass_kg = GM_sun / G = {mass_kg:.6e} kg  (G = {G} m^3 kg^-1 s^-2, CODATA 2018)")

    data = json.loads((DATA_OUT / "data.json").read_text())
    sources = json.loads((DATA_OUT / "sources.json").read_text())
    sources.append(source)

    data["sun"]["mass_kg"] = mass_kg
    data["sun"]["gm_m3s2"] = gm_sun

    (DATA_OUT / "data.json").write_text(json.dumps(data, indent=2))
    (DATA_OUT / "sources.json").write_text(json.dumps(sources, indent=2))
    print("Wrote sun.mass_kg and sun.gm_m3s2 to data.json")


if __name__ == "__main__":
    main()
