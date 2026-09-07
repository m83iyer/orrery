# Orrery

A real-scale, navigable 3D solar system — first item in the "Space
Exploration" collection. Fly freely through real space: the Sun, all 8
planets with their major moons, and Saturn's rings, all at true relative
size and distance, with real orbital motion driven by JPL orbital
elements.

The Milky Way galaxy itself is out of scope here — at any linear scale
where the galaxy's structure is visible, the entire solar system is
far below one pixel. That's item 2 in this collection.

## Structure

- `app/` — the static site: `index.html`, `styles.css`, `scene.js` (the
  3D engine — floating origin, free-flight camera, picking via label
  click, real Kepler orbital mechanics), `orbits.js` (the orbital math,
  independently verified against known values and JPL Horizons),
  `ui.js` (time control, navigator, sources panel), `data/data.json`
  (everything numeric — see below), `assets/textures/` (CC BY 4.0
  Solar System Scope textures)
- `scripts/` — the data pipeline: `build_data_core.py` (Sun + 8
  planets), `add_pole_data.py` (rotation axes), `add_moon_data.py` (41
  physically-characterized moons)
- `DATA_SCHEMA.md` — the exact contract `data.json` follows, including
  the orbital-propagation formulas

## Data integrity

Every number in `data.json` traces to a fetched, hashed source recorded
in `app/data/sources.json` — visible in the app itself via the
"Sources" button. Nothing is estimated or invented. Moon orbits given
in a planet's equatorial or Laplace-plane frame (most major moons) are
rotated into the shared ecliptic frame using that planet's real pole
orientation — verified against Earth's own case, reproducing its known
23.4393° obliquity exactly.

## Hosting

Static site served from `app/` via GitHub Pages
(`.github/workflows/deploy-pages.yml`, deploys on push to `main`).

## Controls

Drag to look around, scroll to move forward/back, WASD to fly, Q/E for
down/up, click any label to fly to that body.
