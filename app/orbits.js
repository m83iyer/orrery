// Orbital mechanics core. Mirrors DATA_SCHEMA.md's propagation formulas
// exactly — this is the JS side of what scripts/oracle_positions.py
// verifies against JPL Horizons in Python. Keep the two in lockstep; if
// you change the math here, the oracle's Python reimplementation must
// change identically or the oracle stops meaning anything.

export const DEG2RAD = Math.PI / 180;
export const AU_KM = 149597870.7;

export function wrapDeg(x) {
  x = x % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
}

function solveKepler(mDeg, e) {
  const M = wrapDeg(mDeg) * DEG2RAD;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 50; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

// Perifocal (orbital-plane) coordinates -> reference-frame coordinates,
// via the standard R_z(Omega) R_x(i) R_z(omega) composition.
function perifocalToFrame(a, e, iDeg, omegaBigDeg, omegaSmallDeg, E) {
  const xOrb = a * (Math.cos(E) - e);
  const yOrb = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);

  const i = iDeg * DEG2RAD, Om = omegaBigDeg * DEG2RAD, w = omegaSmallDeg * DEG2RAD;
  const cosOm = Math.cos(Om), sinOm = Math.sin(Om);
  const cosw = Math.cos(w), sinw = Math.sin(w);
  const cosi = Math.cos(i), sini = Math.sin(i);

  const x = (cosOm * cosw - sinOm * sinw * cosi) * xOrb + (-cosOm * sinw - sinOm * cosw * cosi) * yOrb;
  const y = (sinOm * cosw + cosOm * sinw * cosi) * xOrb + (-sinOm * sinw + cosOm * cosw * cosi) * yOrb;
  const z = (sinw * sini) * xOrb + (cosw * sini) * yOrb;
  return { x, y, z };
}

// elements: {a_au:[v,r], e:[v,r], i_deg:[v,r], L_deg:[v,r], varpi_deg:[v,r], Omega_deg:[v,r]}
// T: Julian centuries since J2000 (2451545.0)
// Returns heliocentric ecliptic position in AU.
export function planetPositionAU(elements, T) {
  const at = (pair) => pair[0] + pair[1] * T;
  const a = at(elements.a_au);
  const e = at(elements.e);
  const i = at(elements.i_deg);
  const L = at(elements.L_deg);
  const varpi = at(elements.varpi_deg);
  const Omega = at(elements.Omega_deg);
  const M = wrapDeg(L - varpi);
  const E = solveKepler(M, e);
  const omega = varpi - Omega;
  return perifocalToFrame(a, e, i, Omega, omega, E);
}

// Osculating-elements form (dwarf planets from sbdb.api): elements are
// given directly (no rate), propagated from their own osculating epoch
// via mean motion n = 360/period_days, period from Kepler's third law
// using a_au (assumes heliocentric two-body; fine at this precision).
export function osculatingPositionAU(el, daysSinceOscEpoch) {
  const periodDays = 365.25 * Math.pow(el.a_au, 1.5);
  const n = 360 / periodDays;
  const M = wrapDeg(el.ma_deg + n * daysSinceOscEpoch);
  const E = solveKepler(M, el.e);
  const omega = el.w_deg;
  return perifocalToFrame(el.a_au, el.e, el.i_deg, el.om_deg, omega, E);
}

// Moon elements relative to parent, in km. daysSinceEpoch: days since
// meta.epoch_jd. Precession periods are optional (absent/null = static).
// parentPole: the parent body's {ra_deg, dec_deg} — required whenever
// el.frame is "equatorial" or "laplace" (anything other than
// "ecliptic"), to rotate into the ecliptic frame this app renders in.
export function moonPositionKm(el, daysSinceEpoch, parentPole) {
  const M = wrapDeg(el.mean_anomaly_deg_at_epoch + 360 * (daysSinceEpoch / el.period_days));
  const raan = el.node_precession_period_days
    ? wrapDeg(el.raan_deg + 360 * (daysSinceEpoch / el.node_precession_period_days))
    : el.raan_deg;
  const argPeri = el.peri_precession_period_days
    ? wrapDeg(el.arg_peri_deg + 360 * (daysSinceEpoch / el.peri_precession_period_days))
    : el.arg_peri_deg;
  const E = solveKepler(M, el.e);
  const local = perifocalToFrame(el.a_km, el.e, el.i_deg, raan, argPeri, E);
  if (el.frame && el.frame !== "ecliptic" && parentPole) {
    return parentFrameToEcliptic(local, parentPole);
  }
  return local;
}

export function julianCenturiesSinceJ2000(jd) {
  return (jd - 2451545.0) / 36525;
}

export function daysSinceEpoch(jd, epochJd) {
  return jd - epochJd;
}

// Convenience: JS Date -> Julian Day (UTC).
export function dateToJD(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

// ---- reference-frame rotation for moons given in their parent's
// equatorial (or Laplace) frame rather than the ecliptic --------------
//
// JPL's satellite mean-element tables give each moon's elements in one
// of three frames: "ecliptic" (usable directly), "equatorial" (relative
// to the parent planet's own equator), or "Laplace" (a precession-
// invariant plane close to, but not identical to, the equatorial plane
// for regular close-in satellites). We rotate equatorial- and Laplace-
// frame elements alike using the parent's actual pole (RA, Dec) — an
// approximation for Laplace-frame moons (their true reference plane can
// differ from the equatorial plane by up to a few degrees), disclosed
// in the app's Sources & Method panel rather than silently assumed.
//
// Construction: the parent's body-fixed frame has +Z along its pole,
// and +X along the ascending node of its equator on the ICRF equator
// (the standard IAU convention for a body-fixed inertial frame) —
// verified against Earth's own case (obliquity = pole at RA=0,Dec=90):
// reproduces 23.4393 deg exactly.

function poleToICRF(raDeg, decDeg) {
  const ra = raDeg * DEG2RAD, dec = decDeg * DEG2RAD;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function icrfToEcliptic(v) {
  const eps = 23.4392911 * DEG2RAD;
  return [v[0], v[1] * Math.cos(eps) + v[2] * Math.sin(eps), -v[1] * Math.sin(eps) + v[2] * Math.cos(eps)];
}

// Ecliptic-frame pole direction and its body-equator node direction (the
// same two basis vectors parentFrameToEcliptic builds internally),
// exposed so the renderer can orient a body's mesh (pole tilt + spin)
// without duplicating this construction.
export function eclipticPoleAndNode(pole) {
  const poleVec = poleToICRF(pole.ra_deg, pole.dec_deg);
  let node = cross3([0, 0, 1], poleVec);
  const nlen = Math.hypot(node[0], node[1], node[2]);
  node = nlen < 1e-9 ? [1, 0, 0] : norm3(node);
  const poleEclArr = icrfToEcliptic(poleVec);
  const nodeEclArr = icrfToEcliptic(node);
  return {
    poleEcl: { x: poleEclArr[0], y: poleEclArr[1], z: poleEclArr[2] },
    nodeEcl: { x: nodeEclArr[0], y: nodeEclArr[1], z: nodeEclArr[2] },
  };
}

// pos: {x,y,z} in the parent's body-fixed equatorial frame (as produced
// by perifocalToFrame using the moon's own i/node/argperi, which are
// defined relative to that frame). pole: {ra_deg, dec_deg, ...} (the
// parent's pole record from data.json, J2000 term only — precession of
// the pole itself over the app's practical time range is negligible for
// this purpose). Returns the position in ecliptic coordinates.
export function parentFrameToEcliptic(pos, pole) {
  const poleVec = poleToICRF(pole.ra_deg, pole.dec_deg);
  let node = cross3([0, 0, 1], poleVec);
  const nlen = Math.hypot(node[0], node[1], node[2]);
  node = nlen < 1e-9 ? [1, 0, 0] : norm3(node);
  const yAxis = cross3(poleVec, node);
  const icrf = [
    pos.x * node[0] + pos.y * yAxis[0] + pos.z * poleVec[0],
    pos.x * node[1] + pos.y * yAxis[1] + pos.z * poleVec[1],
    pos.x * node[2] + pos.y * yAxis[2] + pos.z * poleVec[2],
  ];
  const ec = icrfToEcliptic(icrf);
  return { x: ec[0], y: ec[1], z: ec[2] };
}

// Perifocal Kepler solve, exposed standalone (no frame assumption) so
// callers can choose whether to treat the result as already-ecliptic
// (moonPositionKm below) or pass it through parentFrameToEcliptic first.
export function keplerPositionRaw(a, e, iDeg, omegaBigDeg, omegaSmallDeg, mDeg) {
  const E = solveKepler(mDeg, e);
  return perifocalToFrame(a, e, iDeg, omegaBigDeg, omegaSmallDeg, E);
}
