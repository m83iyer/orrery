#!/usr/bin/env python3
"""Assign texture paths in data.json by a fixed, reproducible convention,
validating each file actually exists — closes a real gap where these paths
were previously hand-patched into data.json outside of any script, so a
full rebuild (any other step's fresh data.json) silently dropped them.

Convention: assets/textures/{id}.jpg for the sun and all 8 planets (Earth
is the one exception: earth_day.jpg, matching the asset file actually on
disk), plus assets/textures/moon.jpg for Earth's Moon specifically. No
other moon has a real per-body texture asset — leaving their `texture`
field absent is the accurate state, not a gap to paper over."""
import json
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
DATA_OUT = PROJECT / "app" / "data"
TEXTURES_DIR = PROJECT / "app" / "assets" / "textures"

EARTH_OVERRIDE = "earth_day.jpg"
MOON_TEXTURE = "moon.jpg"


def path_for(filename):
    full = TEXTURES_DIR / filename
    if not full.exists():
        raise SystemExit(f"ERROR: expected texture asset missing: {full}")
    return f"assets/textures/{filename}"


def main():
    data = json.loads((DATA_OUT / "data.json").read_text())

    data["sun"]["texture"] = path_for("sun.jpg")

    assigned = []
    for p in data["planets"]:
        filename = EARTH_OVERRIDE if p["id"] == "earth" else f"{p['id']}.jpg"
        p["texture"] = path_for(filename)
        assigned.append(p["id"])
        for m in p.get("moons", []):
            if m["id"] == "moon" and p["id"] == "earth":
                m["texture"] = path_for(MOON_TEXTURE)
                assigned.append("earth/moon")
            # else: no real per-moon texture asset exists; leave absent
            # (not fabricated as a copy of the planet's or a placeholder).

    (DATA_OUT / "data.json").write_text(json.dumps(data, indent=2))
    print(f"Assigned textures: sun, {', '.join(assigned)}")


if __name__ == "__main__":
    main()
