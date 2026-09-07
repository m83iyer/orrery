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
  click, real Kepler orbital mechanics), `orbits.js` (the orbital math),
  `ui.js` (time control, navigator, sources panel), `data/data.json`
  (everything numeric — see below), `assets/textures/` (CC BY 4.0
  Solar System Scope textures)
- `scripts/` — the data pipeline, run in this order against a fresh
  `data.json`: `build_data_core.py` (Sun + 8 planets' orbital elements
  and physical parameters), `add_pole_data.py` (rotation axes, and the
  Sun's radius), `add_moon_data.py` (41 physically-characterized
  moons), `add_sun_mass.py` (the Sun's mass, from JPL's GM), `add_ring_data.py`
  (Saturn's ring bands), `add_texture_paths.py` (assigns each body's
  texture asset by a fixed, validated convention — every other step
  only adds numeric data, so this runs last). `oracle_positions.py` is
  separate: an independent Python re-derivation of the position formula
  in DATA_SCHEMA.md, checked against live JPL Horizons vectors for
  Earth/Jupiter/Saturn (currently within 0.005–0.27% of orbital radius,
  well inside its 0.5% tolerance); re-run it any time the propagation
  math changes.
- `DATA_SCHEMA.md` — the exact contract `data.json` follows, including
  the orbital-propagation formulas

## Data integrity

Every number in `data.json` traces to a fetched, hashed source recorded
in `app/data/sources.json` — visible in the app itself via the
"Sources" button. Nothing is estimated or invented. Moon orbits given
in a planet's equatorial or Laplace-plane frame (most major moons) are
rotated into the shared ecliptic frame using that planet's real pole
orientation — verified against Earth's own case, reproducing its known
23.4393° obliquity exactly, and the resulting heliocentric positions
are separately checked against live JPL Horizons vectors by
`scripts/oracle_positions.py` (see above). One disclosed exception: the
Moon's apsidal-precession rate is overridden from JPL's live table
value (an instantaneous rate at their reference epoch) to the
well-established ~8.85-year secular mean, since the app's rendering
model needs a steady rate — see the comment in `add_moon_data.py`.

## Hosting

Static site served from `app/` via GitHub Pages
(`.github/workflows/deploy-pages.yml`, deploys on push to `main`).

## Controls

Drag to look around, scroll to move forward/back (pinch to zoom on
touch), WASD to fly, Q/E for down/up, click or tap any label to fly to
that body.
