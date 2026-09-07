#!/usr/bin/env python3
"""Add moon orbital + physical data to data.json, joining JPL's satellite
elements table (460 rows, all known satellites) against its physical
parameters table (46 rows, only the well-characterized ones) — the join
itself is the inclusion boundary: a moon needs sourced physical data to
be rendered as a real sphere, not the ~400 irregular/uncharacterized
rocks that only have orbital elements."""
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

G = 6.674e-11


def fetch(url, filename):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (orrery-data-pipeline)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    SSD_RAW.mkdir(parents=True, exist_ok=True)
    path = SSD_RAW / filename
    path.write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    return raw.decode("utf-8", errors="replace"), {"url": url, "fetched_utc": datetime.now(timezone.utc).isoformat(), "sha256": sha, "local_file": str(path)}


def strip(s):
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def first_number(s):
    m = re.match(r"^-?[\d.]+", s.strip())
    return float(m.group(0)) if m else None


def parse_elements(html):
    tbody = html[html.find("<tbody>"): html.find("</tbody>")]
    rows = re.findall(r"<tr>(.*?)</tr>", tbody, re.S)
    out = {}
    for r in rows:
        cells = [strip(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)]
        if len(cells) < 16:
            continue
        planet, sat = cells[1], cells[2]
        try:
            el = {
                "frame": cells[5].lower(),
                "a_km": float(cells[7].rstrip(".")),
                "e": float(cells[8]),
                "arg_peri_deg": float(cells[9]),
                "mean_anomaly_deg_at_epoch": float(cells[10]),
                "i_deg": float(cells[11]),
                "raan_deg": float(cells[12]),
                "period_days": float(cells[13]),
            }
            p_apsis_yr = first_number(cells[14]) if cells[14] else None
            p_node_yr = first_number(cells[15]) if cells[15] else None
            el["peri_precession_period_days"] = p_apsis_yr * 365.25 if p_apsis_yr else None
            el["node_precession_period_days"] = p_node_yr * 365.25 if p_node_yr else None
        except (ValueError, IndexError):
            continue
        out[(planet, sat)] = el
    return out


def parse_phys(html):
    tbody = html[html.find("<tbody>"): html.find("</tbody>")]
    rows = re.findall(r"<tr>(.*?)</tr>", tbody, re.S)
    out = {}
    for r in rows:
        cells = [strip(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)]
        if len(cells) < 6:
            continue
        planet, sat = cells[0], cells[1]
        gm = first_number(cells[3])
        radius = first_number(cells[4])
        if gm is None or radius is None:
            continue
        mass_kg = (gm * 1e9) / G  # GM in km^3/s^2 -> m^3/s^2, / G -> kg
        out[(planet, sat)] = {"radius_km": radius, "mass_kg": mass_kg, "gm_km3s2": gm}
    return out


def main():
    el_html, el_src = fetch("https://ssd.jpl.nasa.gov/sats/elem/", "jpl_sats_elem_index.html")
    ph_html, ph_src = fetch("https://ssd.jpl.nasa.gov/sats/phys_par/", "jpl_sats_phys_par.html")
    el_src["supplies"] = ["moon orbital elements"]
    ph_src["supplies"] = ["moon radius/mass"]

    elements = parse_elements(el_html)
    phys = parse_phys(ph_html)
    print(f"elements table: {len(elements)} rows parsed; phys table: {len(phys)} rows parsed")

    data = json.loads((DATA_OUT / "data.json").read_text())
    sources = json.loads((DATA_OUT / "sources.json").read_text())
    sources.append(el_src)
    sources.append(ph_src)

    planet_name_map = {p["id"]: p["name"] for p in data["planets"]}
    counts = {}
    for p in data["planets"]:
        p["moons"] = []
        p_name = p["name"]
        p_moon_count = 0
        for (pl, sat), el in elements.items():
            if pl != p_name:
                continue
            p_moon_count += 1
            ph = phys.get((pl, sat))
            if not ph:
                continue  # not well-characterized enough to render as a real body
            moon_id = re.sub(r"[^a-z0-9]+", "-", sat.lower()).strip("-")
            p["moons"].append({
                "id": moon_id, "name": sat, "radius_km": ph["radius_km"], "mass_kg": ph["mass_kg"],
                "gm_km3s2": ph["gm_km3s2"], "elements_relative_to_parent": el,
            })
        p["known_moon_count"] = p_moon_count
        p["known_moon_count_source"] = f"JPL SSD satellite elements table, fetched {el_src['fetched_utc'][:10]}"
        counts[p_name] = (p_moon_count, len(p["moons"]))

    (DATA_OUT / "data.json").write_text(json.dumps(data, indent=2))
    (DATA_OUT / "sources.json").write_text(json.dumps(sources, indent=2))
    print("\nPer-planet: known (elements) / rendered (has physical data)")
    for name, (known, rendered) in counts.items():
        print(f"  {name:8s} {known:3d} known / {rendered:3d} rendered")
    total_rendered = sum(r for _, r in counts.values())
    print(f"\nTotal moons rendered: {total_rendered}")


if __name__ == "__main__":
    main()
