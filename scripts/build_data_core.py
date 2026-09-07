#!/usr/bin/env python3
"""Core data pipeline: Sun + 8 planets, elements + physical params.
Every value traces to a fetched, hashed, saved raw response — see
sources.json. Run via the RAM admission wrapper.
"""
import hashlib
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")
SSD_RAW = Path(f"/Volumes/Media/AutomationStore/project-artifacts/space-exploration/{TODAY}/raw-fetches")
DATA_OUT = PROJECT / "app" / "data"

PLANET_NAMES = ["Mercury", "Venus", "EM Bary", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"]
PLANET_IDS = ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"]

sources = []


def fetch(url, filename):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (orrery-data-pipeline)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    SSD_RAW.mkdir(parents=True, exist_ok=True)
    path = SSD_RAW / filename
    path.write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    sources.append({"url": url, "fetched_utc": datetime.now(timezone.utc).isoformat(), "sha256": sha, "local_file": str(path)})
    return raw.decode("utf-8", errors="replace")


def parse_elements_table1(html):
    """Parse JPL Table 1 (1800-2050 AD) pre-block. Returns {name: {a,e,i,L,varpi,Omega each [val,rate]}}."""
    idx = html.find("Table 1")
    block = html[idx: idx + 3000]
    pre_start = block.find("<pre>")
    pre_end = block.find("</pre>")
    pre = block[pre_start + 5: pre_end]
    lines = [l for l in pre.split("\n") if l.strip()]
    # skip header lines until we hit the first planet name line
    data_lines = []
    for l in lines:
        matched_name = next((name for name in PLANET_NAMES if l.strip().startswith(name)), None)
        if matched_name and re.match(r"^-?[\d.]", l.strip()[len(matched_name):].strip()):
            data_lines.append(("name", l))
        elif data_lines and data_lines[-1][0] == "name" and re.match(r"^\s+-?\d", l):
            data_lines.append(("rate", l))
    out = {}
    i = 0
    while i < len(data_lines):
        tag, line = data_lines[i]
        assert tag == "name"
        name = next(n for n in PLANET_NAMES if line.strip().startswith(n))
        rest = line.strip()[len(name):].split()
        vals = [float(x) for x in rest]
        rate_line = data_lines[i + 1][1]
        rates = [float(x) for x in rate_line.split()]
        out[name] = {
            "a_au": [vals[0], rates[0]],
            "e": [vals[1], rates[1]],
            "i_deg": [vals[2], rates[2]],
            "L_deg": [vals[3], rates[3]],
            "varpi_deg": [vals[4], rates[4]],
            "Omega_deg": [vals[5], rates[5]],
        }
        i += 2
    assert len(out) == 8, f"expected 8 planets, got {len(out)}: {list(out.keys())}"
    return out


def strip_tags(s):
    return re.sub(r"<[^>]+>", "", s).strip()


def parse_phys_par(html):
    """Parse the physical-parameters HTML table. Returns {name: {radius_km(mean), mass_kg, rotation_period_hr, albedo}}."""
    tbody_start = html.find("<tbody>")
    tbody_end = html.find("</tbody>")
    tbody = html[tbody_start:tbody_end]
    rows = re.findall(r"<tr>(.*?)</tr>", tbody, re.S)
    out = {}
    for row in rows:
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        if not cells:
            continue
        name = strip_tags(cells[0])
        if name not in PLANET_NAMES and name != "Earth":
            continue
        def numval(cell):
            # first line of the cell, strip footnote refs and uncertainty
            text = strip_tags(cell)
            first = text.split("\n")[0].strip()
            m = re.match(r"^-?[\d.]+", first)
            return float(m.group(0)) if m else None
        mean_radius_km = numval(cells[2])
        mass_1e24 = numval(cells[3])
        rotation_period_d = numval(cells[5])
        albedo = numval(cells[8])
        key = "EM Bary" if name == "Earth" else name
        out[key] = {
            "radius_km": mean_radius_km,
            "mass_kg": mass_1e24 * 1e24 if mass_1e24 is not None else None,
            "rotation_period_hr": abs(rotation_period_d) * 24 if rotation_period_d is not None else None,
            "retrograde": rotation_period_d is not None and rotation_period_d < 0,
            "albedo": albedo,
        }
    return out


def main():
    print("Fetching JPL Table 1 (orbital elements)...")
    elements_html = fetch("https://ssd.jpl.nasa.gov/planets/approx_pos.html", "jpl_approx_pos.html")
    elements = parse_elements_table1(elements_html)
    print(f"  parsed {len(elements)} planets: {list(elements.keys())}")

    print("Fetching JPL physical parameters...")
    phys_html = fetch("https://ssd.jpl.nasa.gov/planets/phys_par.html", "jpl_phys_par.html")
    phys = parse_phys_par(phys_html)
    print(f"  parsed {len(phys)} planets: {list(phys.keys())}")

    planets = []
    for name, pid in zip(PLANET_NAMES, PLANET_IDS):
        el = elements[name]
        ph = phys.get(name, {})
        display_name = "Earth" if name == "EM Bary" else name
        planets.append({
            "id": pid,
            "name": display_name,
            "radius_km": ph.get("radius_km"),
            "mass_kg": ph.get("mass_kg"),
            "rotation_period_hr": ph.get("rotation_period_hr"),
            "retrograde_rotation": ph.get("retrograde", False),
            "albedo": ph.get("albedo"),
            "elements": el,
            "moons": [],
        })

    sun = {
        "name": "Sun",
        # radius_km filled by add_pole_data.py (from the same pck00011.tpc it
        # already fetches for pole data) and mass_kg by add_sun_mass.py (from
        # JPL's astro_par.html GM_sun, converted via mass = GM/G) — both real
        # fetched sources, not hardcoded here. Left null until those run so a
        # stale/wrong placeholder can never ship if either script is skipped.
        "radius_km": None,
        "mass_kg": None,
    }

    data = {
        "meta": {
            "epoch_jd": 2451545.0,
            "generated_utc": datetime.now(timezone.utc).isoformat(),
            "obliquity_j2000_deg": 23.4392911,
        },
        "sun": sun,
        "planets": planets,
        "dwarf_planets": [],
        "small_bodies": {"asteroids": [], "tnos": []},
        "stars": [],
    }

    DATA_OUT.mkdir(parents=True, exist_ok=True)
    (DATA_OUT / "data.json").write_text(json.dumps(data, indent=2))
    (DATA_OUT / "sources.json").write_text(json.dumps(sources, indent=2))
    print(f"\nWrote {DATA_OUT / 'data.json'}")
    print(f"Wrote {DATA_OUT / 'sources.json'}")
    print(f"Raw fetches saved to {SSD_RAW}")

    # sanity print
    for p in planets:
        print(f"  {p['name']:8s} r={p['radius_km']:>9} km  mass={p['mass_kg']:.3e} kg  a={p['elements']['a_au'][0]:.4f} AU")


if __name__ == "__main__":
    main()
