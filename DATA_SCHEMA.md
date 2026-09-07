# data.json schema — Orrery (Solar System v1)

Contract between `scripts/build_data.py` (produces this) and `app/scene.js`
(consumes this). Do not change field names without updating both sides.

```jsonc
{
  "meta": {
    "epoch_jd": 2451545.0,          // J2000.0 — origin for all mean-anomaly propagation
    "generated_utc": "2026-09-07T...Z",
    "obliquity_j2000_deg": 23.4392911
  },
  "sun": {
    "radius_km": 695700,
    "mass_kg": 1.988499e30,
    "texture": "textures/sun.jpg"
  },
  "planets": [
    {
      "id": "earth", "name": "Earth", "kind": "planet",
      "radius_km": 6371.0, "mass_kg": 5.972e24,
      "obliquity_deg": 23.44, "rotation_period_hr": 23.9345,
      "albedo": 0.306,
      // Standish (1800-2050) Table 1 form: value + rate-per-century
      "elements": {
        "a_au": [1.00000261, 0.00000562],
        "e":     [0.01671123, -0.00004392],
        "i_deg": [-0.00001531, -0.01294668],
        "L_deg": [100.46457166, 35999.37244981],
        "varpi_deg": [102.93768193, 0.32327364],
        "Omega_deg": [0.0, 0.0]
      },
      "pole": { "ra_deg": 0.0, "dec_deg": 90.0, "ra_rate_per_century": 0, "dec_rate_per_century": 0,
                "pm_deg": 190.147, "pm_rate_per_day": 360.9856235 },
      "rings": null,
      "texture": "textures/earth_day.jpg",
      "night_texture": "textures/earth_night.jpg",
      "clouds_texture": "textures/earth_clouds.jpg",
      "moons": [
        {
          "id": "moon", "name": "Moon", "kind": "moon",
          "radius_km": 1737.4, "gm_km3s2": 4902.800,
          "elements_relative_to_parent": { "a_km": 384399, "e": 0.0549, "i_deg": 5.145,
            "raan_deg": 125.08, "arg_peri_deg": 318.15, "mean_anomaly_deg_at_epoch": 135.27,
            "period_days": 27.321661, "node_precession_period_days": -6798.38, "peri_precession_period_days": 3231.5,
            "frame": "ecliptic" },
          "texture": "textures/moon.jpg"
        }
      ],
      "known_moon_count": 1,
      "known_moon_count_source": "JPL SSD, fetched <date>"
    }
  ],
  "dwarf_planets": [
    {
      "id": "pluto", "name": "Pluto", "kind": "dwarf",
      "radius_km": 1188.3, "mass_kg": 1.303e22,
      "elements": { "a_au": [...], "e": [...], "i_deg": [...], "L_deg": [...], "varpi_deg": [...], "Omega_deg": [...] },
      "moons": [ { "id": "charon", ... } ]
    }
  ],
  "small_bodies": {
    "asteroids": [ { "id": "1_ceres", "name": "Ceres", "diameter_km": 939.4, "elements": {...} } ],
    "tnos": [ { "id": "eris", "name": "Eris", "diameter_km": 2326, "elements": {...} } ]
  },
  "stars": [
    { "ra_deg": 101.287, "dec_deg": -16.716, "vmag": -1.46, "bv": 0.00, "name": "Sirius" }
  ]
}
```

Angle propagation (planets/dwarfs, Standish form): at Julian day `JD`,
`T = (JD - 2451545.0) / 36525` (centuries since J2000). For each element
`[value, rate]`: `x(T) = value + rate * T`. Mean anomaly
`M = L - varpi` (both propagated first, then subtract, then wrap to
±180°). Solve Kepler's equation `M = E - e*sin(E)` for E by Newton's
method to 1e-8 rad from `E0 = M + e*sin(M)`. Heliocentric ecliptic
position from `(E, a, e, i, Omega, varpi)` via the standard two-body
transform (argument of periapsis `omega = varpi - Omega`).

Moon angle propagation (relative-to-parent form): mean anomaly at time
`t` (days since epoch_jd) is `mean_anomaly_deg_at_epoch + 360*(t/period_days)`,
wrapped. `raan_deg` and `arg_peri_deg` precess linearly using their
listed precession periods (`raan(t) = raan_deg + 360*(t/node_precession_period_days)`,
same pattern for `arg_peri_deg`); a `null`/absent precession period
means no precession (use the constant value). Same Kepler solve as
above, using `a_km` directly (no AU conversion), producing a position
relative to the parent body's center, in the parent's local equatorial
or the solar-system ecliptic frame — **use ecliptic** for every moon in
this dataset (note in `sources.json` if any moon's source table is in a
different reference plane; do not silently mix frames).

`frame` on a moon's elements is one of `"ecliptic"`, `"equatorial"`, or
`"laplace"`, taken verbatim from the JPL satellite-elements table's own
"Frame" column for that row. Only `"ecliptic"` elements are usable
directly against the ecliptic-frame Kepler solver; `"equatorial"` and
`"laplace"` elements are relative to the parent planet's own equator (or
its Laplace plane, which the app treats as equivalent to the equator —
a disclosed approximation, exact for the orbit's shape/period, off by up
to a few degrees in plane orientation for the outer/irregular
satellites where Laplace and equatorial planes genuinely diverge) and
must be rotated into the ecliptic using the parent's pole (RA, Dec) via
`orbits.js`'s `parentFrameToEcliptic`. Never render `equatorial`/`laplace`
elements as if they were already ecliptic — for a heavily tilted parent
(Uranus) this produces an orbit plane wrong by up to ~98°, not a minor
error.

Every numeric leaf in this file must trace to a fetched source recorded
in `sources.json` (url, fetched_utc, sha256 of the raw response, and
which field(s) it supplies). No value may be typed from memory.
