#!/usr/bin/env python3
"""oracle_positions.py -- independent JPL Horizons position oracle.

Purpose
-------
Orrery's whole premise is "nothing is estimated or invented." This script
is the actual, re-runnable check backing that claim for the orbital math:
it re-implements the heliocentric-ecliptic-XYZ Keplerian position formula
in Python, written directly from the prose description in DATA_SCHEMA.md
(mean longitude -> mean anomaly -> Kepler's equation via Newton's method ->
true anomaly -> perifocal position -> rotate into the ecliptic frame by
inclination / ascending node / argument of periapsis). It is a fresh
derivation, not a port of app/orbits.js: the rotation here is built from
three sequential single-axis rotation matrices and the perifocal position
is built from true anomaly + radius, rather than orbits.js's hand-expanded
closed-form trig identity and (cos E - e) formulation. Two structurally
different implementations of the same documented physics are far less
likely to share a bug than one implementation checked against itself.

For Earth, Jupiter, and Saturn, this Python position (evaluated at T=0,
i.e. exactly at data.meta.epoch_jd, so the elements' secular rate terms
drop out entirely) is compared against a REAL vector ephemeris fetched
live from JPL Horizons (DE441 integration) for that same Julian day.
Nothing about the Horizons comparison is fabricated: if the API is
unreachable, this script raises/reports that plainly rather than
inventing a plausible-looking number.

Tolerance: 0.5% of each body's own semi-major axis (a_au at T=0). The
Standish (1800-2050) mean elements this app uses are a 6-constant-rate
fit to the true (numerically integrated) orbit, not the integration
itself, so some residual versus Horizons' DE441 is expected even
exactly at the fit's own reference epoch; the fit is documented as
accurate to a small fraction of a degree / percent over its interval,
and the residual right at epoch should be far smaller than that. 0.5%
of a_au (roughly 750,000 km at Earth's distance, ~4-7 million km at
Jupiter/Saturn's) is generous enough to absorb that known, disclosed
approximation while still catching an actual implementation bug: a
sign error, a degrees/radians mixup, or a wrong rotation order would
throw the result off by many percent, not a fraction of one.

Usage
-----
    python3 scripts/oracle_positions.py

Exit code 0 iff every tested body passes; non-zero otherwise (including
on a hard failure such as unreadable data.json or an unreachable
network -- this script never fabricates a result to force a green exit).

Run through the Mac mini RAM admission controller, per standing policy:
    python3 ~/.local/libexec/macmini_ram_admission.py run \\
        --job orrery_oracle_build --kind heavy -- \\
        python3 scripts/oracle_positions.py
"""

import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_JSON = REPO_ROOT / "app" / "data" / "data.json"

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
HORIZONS_CENTER = "500@10"  # Sun, body center (heliocentric)
HORIZONS_TARGET = {
    "earth": "399",
    "jupiter": "599",
    "saturn": "699",
}
TESTED_BODIES = ["earth", "jupiter", "saturn"]

TOLERANCE_FRACTION = 0.005  # 0.5% of the body's own semi-major axis
AU_KM = 149597870.7  # IAU 2012 Resolution B2 exact definition


# ---------------------------------------------------------------------------
# Independent Kepler-orbit math, derived fresh from DATA_SCHEMA.md's prose
# description (not ported from app/orbits.js).
# ---------------------------------------------------------------------------

def wrap_deg(x):
    """Wrap an angle in degrees to (-180, 180]."""
    x = math.fmod(x, 360.0)
    if x > 180.0:
        x -= 360.0
    if x <= -180.0:
        x += 360.0
    return x


def solve_kepler(m_deg, e, tol_rad=1e-8, max_iter=100):
    """Solve M = E - e*sin(E) for eccentric anomaly E (radians) by Newton's
    method, starting from E0 = M + e*sin(M) (per DATA_SCHEMA.md)."""
    m = math.radians(wrap_deg(m_deg))
    e_anom = m + e * math.sin(m)
    for _ in range(max_iter):
        f = e_anom - e * math.sin(e_anom) - m
        fprime = 1.0 - e * math.cos(e_anom)
        delta = f / fprime
        e_anom -= delta
        if abs(delta) < tol_rad:
            return e_anom
    raise RuntimeError(f"Kepler solve did not converge for M={m_deg} e={e}")


def true_anomaly_and_radius(e_anom, a, e):
    """Perifocal true anomaly (rad) and radius from eccentric anomaly."""
    nu = 2.0 * math.atan2(
        math.sqrt(1.0 + e) * math.sin(e_anom / 2.0),
        math.sqrt(1.0 - e) * math.cos(e_anom / 2.0),
    )
    r = a * (1.0 - e * math.cos(e_anom))
    return nu, r


def _rotate_z(vec, angle_rad):
    c, s = math.cos(angle_rad), math.sin(angle_rad)
    x, y, z = vec
    return (c * x - s * y, s * x + c * y, z)


def _rotate_x(vec, angle_rad):
    c, s = math.cos(angle_rad), math.sin(angle_rad)
    x, y, z = vec
    return (x, c * y - s * z, s * y + c * z)


def perifocal_to_ecliptic(x_orb, y_orb, omega_deg, i_deg, bigomega_deg):
    """Rotate a perifocal-plane position into the ecliptic frame via three
    sequential single-axis rotations: R_z(Omega) . R_x(i) . R_z(omega),
    applied right-to-left as rotate_z(omega) -> rotate_x(i) -> rotate_z(Omega)."""
    v = (x_orb, y_orb, 0.0)
    v = _rotate_z(v, math.radians(omega_deg))
    v = _rotate_x(v, math.radians(i_deg))
    v = _rotate_z(v, math.radians(bigomega_deg))
    return v


def planet_position_au(elements, t_centuries):
    """Heliocentric ecliptic (x, y, z) in AU for a Standish-form element set
    {a_au, e, i_deg, L_deg, varpi_deg, Omega_deg}, each [value, rate_per_century],
    at T Julian centuries since J2000."""

    def at(pair):
        return pair[0] + pair[1] * t_centuries

    a = at(elements["a_au"])
    e = at(elements["e"])
    i_deg = at(elements["i_deg"])
    l_deg = at(elements["L_deg"])
    varpi_deg = at(elements["varpi_deg"])
    bigomega_deg = at(elements["Omega_deg"])

    m_deg = wrap_deg(l_deg - varpi_deg)
    e_anom = solve_kepler(m_deg, e)
    nu, r = true_anomaly_and_radius(e_anom, a, e)

    x_orb = r * math.cos(nu)
    y_orb = r * math.sin(nu)

    omega_deg = varpi_deg - bigomega_deg  # argument of periapsis
    return perifocal_to_ecliptic(x_orb, y_orb, omega_deg, i_deg, bigomega_deg)


# ---------------------------------------------------------------------------
# JPL Horizons live fetch (real network call -- never fabricated)
# ---------------------------------------------------------------------------

def fetch_horizons_vector(target_id, center, jd, retries=3, timeout=30):
    """Fetch a real heliocentric ecliptic-of-J2000 position vector (km) from
    JPL Horizons for `target_id` at Julian day `jd`. Returns (x, y, z) km.
    Raises on any failure -- this function never invents a result."""
    params = {
        "format": "json",
        "COMMAND": target_id,
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "VECTORS",
        "CENTER": center,
        "TLIST": repr(float(jd)),
        "OUT_UNITS": "KM-S",
        "VEC_TABLE": "1",
        "REF_PLANE": "ECLIPTIC",
        "REF_SYSTEM": "J2000",
        "CSV_FORMAT": "YES",
    }
    url = HORIZONS_URL + "?" + urllib.parse.urlencode(params)

    last_err = None
    payload = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                raw = resp.read()
            payload = json.loads(raw)
            last_err = None
            break
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            last_err = exc
            if attempt < retries:
                time.sleep(2 * attempt)
    if last_err is not None or payload is None:
        raise RuntimeError(
            f"JPL Horizons unreachable for target {target_id!r} after {retries} attempts: {last_err}"
        )

    if "error" in payload:
        raise RuntimeError(f"JPL Horizons returned an error for target {target_id!r}: {payload['error']}")

    result_text = payload.get("result", "")
    if "$$SOE" not in result_text or "$$EOE" not in result_text:
        raise RuntimeError(
            f"JPL Horizons response for target {target_id!r} missing $$SOE/$$EOE data block: {result_text[:500]!r}"
        )

    block = result_text.split("$$SOE", 1)[1].split("$$EOE", 1)[0].strip()
    lines = [ln for ln in block.splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError(f"JPL Horizons response for target {target_id!r} had an empty $$SOE/$$EOE block")
    fields = [f.strip() for f in lines[0].split(",") if f.strip() != ""]
    # CSV_FORMAT=YES, VEC_TABLE=1 -> JDTDB, Calendar Date, X, Y, Z
    if len(fields) < 5:
        raise RuntimeError(f"Unexpected Horizons VECTORS row format for target {target_id!r}: {lines[0]!r}")
    x_km, y_km, z_km = (float(fields[2]), float(fields[3]), float(fields[4]))
    return x_km, y_km, z_km


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not DATA_JSON.exists():
        print(f"FATAL: cannot find {DATA_JSON}", file=sys.stderr)
        return 2

    with DATA_JSON.open() as f:
        data = json.load(f)

    epoch_jd = data["meta"]["epoch_jd"]
    planets_by_id = {p["id"]: p for p in data["planets"]}

    print("Orrery oracle: independent Python Keplerian model vs live JPL Horizons (DE441)")
    print(f"data.json: {DATA_JSON}")
    print(f"Epoch JD (T=0): {epoch_jd!r}  (data.meta.epoch_jd)")
    print(f"Tolerance: {TOLERANCE_FRACTION * 100:.2f}% of each body's semi-major axis (a_au at T=0)")
    print()

    results = []
    for body_id in TESTED_BODIES:
        planet = planets_by_id.get(body_id)
        if planet is None:
            print(f"{body_id.upper():8s}  FAIL  no elements found for {body_id!r} in data.json")
            results.append((body_id, False))
            continue

        elements = planet["elements"]
        a_au = elements["a_au"][0]  # value at T=0

        x_au, y_au, z_au = planet_position_au(elements, 0.0)
        x_km, y_km, z_km = x_au * AU_KM, y_au * AU_KM, z_au * AU_KM

        try:
            hx, hy, hz = fetch_horizons_vector(HORIZONS_TARGET[body_id], HORIZONS_CENTER, epoch_jd)
        except Exception as exc:
            print(f"{body_id.upper():8s}  FAIL  Horizons fetch error: {exc}")
            results.append((body_id, False))
            continue

        diff_km = math.sqrt((x_km - hx) ** 2 + (y_km - hy) ** 2 + (z_km - hz) ** 2)
        a_km = a_au * AU_KM
        diff_pct = 100.0 * diff_km / a_km
        tol_pct = TOLERANCE_FRACTION * 100.0
        passed = diff_pct <= tol_pct

        print(f"{body_id.upper():8s}  {'PASS' if passed else 'FAIL'}")
        print(f"          python   (AU): x={x_au: .9f} y={y_au: .9f} z={z_au: .9f}")
        print(f"          python   (km): x={x_km: .3f} y={y_km: .3f} z={z_km: .3f}")
        print(f"          horizons (km): x={hx: .3f} y={hy: .3f} z={hz: .3f}")
        print(f"          |diff|       : {diff_km:.3f} km  ({diff_pct:.6f}% of a={a_km:,.0f} km)")
        print(f"          tolerance    : {tol_pct:.3f}%")
        print()

        results.append((body_id, passed))

    print("=" * 60)
    for body_id, passed in results:
        print(f"  {body_id.upper():8s} {'PASS' if passed else 'FAIL'}")
    all_pass = len(results) == len(TESTED_BODIES) and all(p for _, p in results)
    print("=" * 60)
    print("OVERALL:", "PASS" if all_pass else "FAIL")

    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
