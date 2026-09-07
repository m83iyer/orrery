import { planetPositionAU, osculatingPositionAU, moonPositionKm, julianCenturiesSinceJ2000, daysSinceEpoch, dateToJD, AU_KM, eclipticPoleAndNode, wrapDeg, DEG2RAD } from "./orbits.js";

const THREE = window.THREE;
if (!THREE) {
  document.body.innerHTML = '<div style="padding:40px;color:#fff;font-family:sans-serif">Three.js failed to load (CDN blocked or offline). Nothing else can render.</div>';
  throw new Error("THREE.js missing");
}

// ---- constants -------------------------------------------------------

const KM_PER_UNIT = 1000; // 1 Three.js world unit = 1000 km
const MIN_ZOOM_SURFACE_FACTOR = 1.02;
const MAX_DIST_KM = 5000 * AU_KM;
const LABEL_HIDE_PX = 3; // below this apparent radius, show a marker dot instead of a filled sphere-derived label

// ---- renderer / scene / camera ---------------------------------------

const canvas = document.getElementById("gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 1e9);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// Sun light (real: only light source, so far sides are genuinely dark)
const sunLight = new THREE.PointLight(0xffffff, 1, 0, 0); // decay=0: no falloff (auto-exposure convention, per Fable)
scene.add(sunLight);
scene.add(new THREE.AmbientLight(0xffffff, 0.06));

// ---- universe: bodies built from data.json ----------------------------

const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();
function loadTexture(path) {
  if (!textureCache.has(path)) {
    const tex = textureLoader.load(path);
    tex.encoding = THREE.sRGBEncoding;
    textureCache.set(path, tex);
  }
  return textureCache.get(path);
}
function loadTextureLinear(path) {
  // For non-color data (alpha/height maps) — no sRGB decode.
  const key = path + "#linear";
  if (!textureCache.has(key)) {
    textureCache.set(key, textureLoader.load(path));
  }
  return textureCache.get(key);
}

const bodiesById = new Map();
const allBodies = [];
let metaEpochJd = 2451545.0;

class Body {
  constructor(def, kind, parent) {
    this.id = def.id;
    this.name = def.name;
    this.kind = kind; // "star" | "planet" | "moon" | "dwarf"
    this.radiusKm = def.radius_km || 1;
    this.parent = parent || null;
    this.def = def;
    this.children = [];

    const segs = this.kind === "star" ? [64, 32] : [48, 24];
    const geo = new THREE.SphereGeometry(this.radiusKm / KM_PER_UNIT, segs[0], segs[1]);
    const color = kind === "star" ? 0xfff2c8 : 0x9aa3b5;
    const tex = def.texture ? loadTexture(def.texture) : null;
    const mat = kind === "star"
      ? new THREE.MeshBasicMaterial({ color: tex ? 0xffffff : color, map: tex })
      : new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : color, map: tex, roughness: 0.95, metalness: 0.0 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.userData.body = this;
    scene.add(this.mesh);

    this.ringMesh = null;
    if (def.rings) {
      const inner = def.rings.inner_km / KM_PER_UNIT;
      const outer = def.rings.outer_km / KM_PER_UNIT;
      const ringGeo = new THREE.RingGeometry(inner, outer, 128, 1);
      // RingGeometry's default UVs run radially the wrong way for a
      // radial gradient texture; remap so u=0 at inner edge, u=1 at outer.
      const uv = ringGeo.attributes.uv;
      const pos = ringGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i));
        uv.setXY(i, (r - inner) / (outer - inner), 1);
      }
      const ringTex = def.rings.texture ? loadTextureLinear(def.rings.texture) : null;
      const ringMat = ringTex
        ? new THREE.MeshBasicMaterial({ color: 0xc9bfa3, map: ringTex, transparent: true, side: THREE.DoubleSide, depthWrite: false })
        : new THREE.MeshBasicMaterial({ color: 0xc9bfa3, side: THREE.DoubleSide, transparent: true, opacity: 0.75 });
      this.ringMesh = new THREE.Mesh(ringGeo, ringMat);
      this.ringMesh.rotateX(Math.PI / 2); // RingGeometry lies in XY; rotate into the body's equatorial (here: local XZ) plane
      scene.add(this.ringMesh);
    }

    if (parent) parent.children.push(this);

    this.orbitLine = this.buildOrbitLine();
    if (this.orbitLine) scene.add(this.orbitLine);

    this.labelEl = document.createElement("div");
    this.labelEl.className = "body-label" + (kind === "moon" || kind === "dwarf" ? " dim" : "");
    this.labelEl.textContent = this.name;
    this.labelEl.addEventListener("click", (e) => {
      e.stopPropagation();
      selectBody(this);
    });
    document.getElementById("labels").appendChild(this.labelEl);
  }

  // Orient the mesh (and rings, if any) so its rotation axis matches the
  // real pole direction, spun to the correct prime-meridian angle at jd.
  // Three.js SphereGeometry's own pole is local +Y; we map that to the
  // ecliptic-frame pole (converted to world space) and use the current
  // prime-meridian direction as a secondary axis. Getting the rotation
  // AXIS right (tested against Earth's 23.44 deg obliquity, see
  // orbits.js) matters far more than exact texture-seam alignment, which
  // this secondary axis gives a reasonable but not pixel-verified result for.
  applyRotation(jd) {
    if (!this.def.pole) return;
    const { poleEcl, nodeEcl } = eclipticPoleAndNode(this.def.pole);
    const poleW = eclipticDirToWorld(poleEcl);
    const nodeW = eclipticDirToWorld(nodeEcl);
    const poleWorld = new THREE.Vector3(poleW.x, poleW.y, poleW.z).normalize();
    const nodeWorld = new THREE.Vector3(nodeW.x, nodeW.y, nodeW.z).normalize();
    const pmDeg = this.def.pole.pm_deg + this.def.pole.pm_rate_per_day * (jd - 2451545.0);
    const primeMeridianDir = nodeWorld.clone().applyAxisAngle(poleWorld, wrapDeg(pmDeg) * DEG2RAD);
    const xAxis = new THREE.Vector3().crossVectors(poleWorld, primeMeridianDir).normalize();
    const zAxis = new THREE.Vector3().crossVectors(xAxis, poleWorld).normalize();
    const basis = new THREE.Matrix4().makeBasis(xAxis, poleWorld, zAxis);
    const q = new THREE.Quaternion().setFromRotationMatrix(basis);
    this.mesh.quaternion.copy(q);
    if (this.ringMesh) this.ringMesh.quaternion.copy(q);
  }

  // Position in km, in the parent's local frame (heliocentric for planets/dwarfs/star, parent-relative for moons).
  localPositionKm(jd) {
    if (this.kind === "star") return { x: 0, y: 0, z: 0 };
    if (this.kind === "moon") {
      return moonPositionKm(this.def.elements_relative_to_parent, daysSinceEpoch(jd, metaEpochJd), this.parent?.def?.pole);
    }
    if (this.def.osculating_epoch_jd) {
      const p = osculatingPositionAU(
        { a_au: this.def.elements.a_au[0], e: this.def.elements.e[0], i_deg: this.def.elements.i_deg[0], om_deg: this.def.elements.Omega_deg[0], w_deg: this.def.elements.varpi_deg[0] - this.def.elements.Omega_deg[0], ma_deg: this.def.elements.L_deg[0] - this.def.elements.varpi_deg[0] },
        jd - this.def.osculating_epoch_jd
      );
      return { x: p.x * AU_KM, y: p.y * AU_KM, z: p.z * AU_KM };
    }
    const T = julianCenturiesSinceJ2000(jd);
    const p = planetPositionAU(this.def.elements, T);
    return { x: p.x * AU_KM, y: p.y * AU_KM, z: p.z * AU_KM };
  }

  // Absolute heliocentric position in km at time jd.
  absolutePositionKm(jd) {
    const local = this.localPositionKm(jd);
    if (!this.parent) return local;
    const parentPos = this.parent.absolutePositionKm(jd);
    return { x: local.x + parentPos.x, y: local.y + parentPos.y, z: local.z + parentPos.z };
  }

  buildOrbitLine() {
    if (this.kind === "star") return null;
    const N = 180;
    const pts = [];
    const isMoon = this.kind === "moon";
    for (let i = 0; i <= N; i++) {
      const frac = i / N;
      let p;
      if (isMoon) {
        p = moonPositionKm(this.def.elements_relative_to_parent, frac * this.def.elements_relative_to_parent.period_days, this.parent?.def?.pole);
      } else if (this.def.osculating_epoch_jd) {
        const periodDays = 365.25 * Math.pow(this.def.elements.a_au[0], 1.5);
        const el = { a_au: this.def.elements.a_au[0], e: this.def.elements.e[0], i_deg: this.def.elements.i_deg[0], om_deg: this.def.elements.Omega_deg[0], w_deg: this.def.elements.varpi_deg[0] - this.def.elements.Omega_deg[0], ma_deg: this.def.elements.L_deg[0] - this.def.elements.varpi_deg[0] };
        const pAU = osculatingPositionAU(el, frac * periodDays);
        p = { x: pAU.x * AU_KM, y: pAU.y * AU_KM, z: pAU.z * AU_KM };
      } else {
        const a = this.def.elements.a_au[0];
        const periodDays = 365.25 * Math.pow(a, 1.5);
        const T = frac * periodDays / 36525;
        const pAU = planetPositionAU(this.def.elements, T);
        p = { x: pAU.x * AU_KM, y: pAU.y * AU_KM, z: pAU.z * AU_KM };
      }
      pts.push(new THREE.Vector3(p.x / KM_PER_UNIT, p.z / KM_PER_UNIT, -p.y / KM_PER_UNIT));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const color = isMoon ? 0x445066 : 0x33456b;
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: isMoon ? 0.25 : 0.45 });
    return new THREE.Line(geo, mat);
  }
}

// Coordinate convention: ecliptic (x,y,z) km -> Three.js (x, z, -y) world units,
// so ecliptic north (+z) maps to Three.js +Y (up).
function eclipticKmToWorld(km, originKm) {
  return new THREE.Vector3(
    (km.x - originKm.x) / KM_PER_UNIT,
    (km.z - originKm.z) / KM_PER_UNIT,
    -(km.y - originKm.y) / KM_PER_UNIT
  );
}

function buildUniverse(data) {
  metaEpochJd = data.meta.epoch_jd;

  const sun = new Body(data.sun, "star", null);
  sun.id = "sun"; sun.name = data.sun.name || "Sun";
  bodiesById.set(sun.id, sun);
  allBodies.push(sun);

  for (const p of data.planets || []) {
    const body = new Body(p, "planet", sun);
    bodiesById.set(body.id, body);
    allBodies.push(body);
    for (const m of p.moons || []) {
      const moon = new Body(m, "moon", body);
      bodiesById.set(moon.id, moon);
      allBodies.push(moon);
    }
  }
  for (const d of (data.dwarf_planets || [])) {
    const body = new Body(d, "dwarf", sun);
    bodiesById.set(body.id, body);
    allBodies.push(body);
    for (const m of d.moons || []) {
      const moon = new Body(m, "moon", body);
      bodiesById.set(moon.id, moon);
      allBodies.push(moon);
    }
  }
  return sun;
}

// ---- time engine -------------------------------------------------------

const clock = { jd: dateToJD(new Date()), speedDaysPerSec: 0, playing: false };

// ---- free-flight camera rig --------------------------------------------

const rig = {
  posKm: { x: 0, y: 0, z: 8 * AU_KM }, // ecliptic north, looking straight down at the whole system
  yaw: 0,
  pitch: -Math.PI / 2 + 0.001,
  keys: new Set(),
  dragging: false,
  lastX: 0, lastY: 0,
};

function rigForwardVec() {
  const cp = Math.cos(rig.pitch), sp = Math.sin(rig.pitch);
  const cy = Math.cos(rig.yaw), sy = Math.sin(rig.yaw);
  return new THREE.Vector3(cp * cy, sp, cp * sy).normalize();
}
function rigRightVec(fwd) {
  return new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
}

// rigForwardVec/rigRightVec return directions in Three.js WORLD space
// (Y-up), because that's what camera.lookAt needs directly. rig.posKm is
// in ECLIPTIC space (Z-up, per eclipticKmToWorld's convention: world.x =
// eclip.x, world.y = eclip.z, world.z = -eclip.y). Moving the camera by a
// world-space direction therefore requires the inverse axis remap before
// touching rig.posKm — this is a *direction*, not a position, so no
// origin subtraction, just the axis swap.
function worldDirToEclipticKm(dir) {
  return { x: dir.x, y: -dir.z, z: dir.y };
}
// Inverse of the above: ecliptic-space direction -> Three.js world-space direction.
function eclipticDirToWorld(dir) {
  return { x: dir.x, y: dir.z, z: -dir.y };
}
function yawPitchFromWorldDir(dir) {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const y = dir.y / len;
  return { yaw: Math.atan2(dir.z, dir.x), pitch: Math.asin(Math.max(-1, Math.min(1, y))) };
}

function nearestSurfaceDistKm() {
  let min = Infinity;
  const originKm = focusOriginKm();
  const camWorld = eclipticKmToWorld(rig.posKm, { x: 0, y: 0, z: 0 });
  for (const b of allBodies) {
    const abs = b.absolutePositionKm(clock.jd);
    const world = eclipticKmToWorld(abs, { x: 0, y: 0, z: 0 });
    const distUnits = camWorld.distanceTo(world);
    const distKm = distUnits * KM_PER_UNIT - b.radiusKm;
    if (distKm < min) min = distKm;
  }
  return Math.max(min, 1);
}

let selected = null;
let flyTo = null; // {fromKm, toKm, fromYaw, toYaw, fromPitch, toPitch, t0, dur}

function selectBody(body) {
  selected = body;
  document.querySelectorAll(".body-label.selected").forEach((el) => el.classList.remove("selected"));
  body.labelEl.classList.add("selected");
  const target = body.absolutePositionKm(clock.jd);
  const viewDist = Math.max(body.radiusKm * 6, body.radiusKm + 2000);
  // Offset direction chosen in ecliptic space (a fixed "above and to the
  // side" vantage), then converted to world space to derive yaw/pitch —
  // everything here must go through the same ecliptic<->world convention
  // as the render loop, or the fly-to lands facing the wrong way.
  const dirEcl = { x: 0.5, y: -0.3, z: 0.8 };
  const len = Math.hypot(dirEcl.x, dirEcl.y, dirEcl.z);
  const offsetEcl = { x: (dirEcl.x / len) * viewDist, y: (dirEcl.y / len) * viewDist, z: (dirEcl.z / len) * viewDist };
  const toKm = { x: target.x + offsetEcl.x, y: target.y + offsetEcl.y, z: target.z + offsetEcl.z };
  const lookDirWorld = eclipticDirToWorld({ x: -offsetEcl.x, y: -offsetEcl.y, z: -offsetEcl.z });
  const { yaw: toYaw, pitch: toPitch } = yawPitchFromWorldDir(lookDirWorld);
  flyTo = { fromKm: { ...rig.posKm }, toKm, fromYaw: rig.yaw, toYaw, fromPitch: rig.pitch, toPitch, t0: performance.now(), dur: 2200 };
  updateInfoPanel(body);
}
window.selectBody = selectBody;
window.__orrery = { bodiesById, allBodies, rig, clock };

function focusOriginKm() {
  return rig.posKm;
}

// ---- input --------------------------------------------------------------

addEventListener("keydown", (e) => { rig.keys.add(e.code); });
addEventListener("keyup", (e) => { rig.keys.delete(e.code); });

canvas.addEventListener("pointerdown", (e) => { rig.dragging = true; rig.lastX = e.clientX; rig.lastY = e.clientY; flyTo = null; });
addEventListener("pointerup", () => { rig.dragging = false; });
addEventListener("pointermove", (e) => {
  if (!rig.dragging) return;
  const dx = e.clientX - rig.lastX, dy = e.clientY - rig.lastY;
  rig.lastX = e.clientX; rig.lastY = e.clientY;
  rig.yaw -= dx * 0.0035;
  rig.pitch = Math.max(-1.5, Math.min(1.5, rig.pitch - dy * 0.0035));
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  flyTo = null;
  const dist = nearestSurfaceDistKm();
  const moveMag = Math.min(Math.max(dist, 1) * 0.2, MAX_DIST_KM);
  const move = (e.deltaY > 0 ? -1 : 1) * moveMag;
  const fwdEcl = worldDirToEclipticKm(rigForwardVec());
  rig.posKm.x += fwdEcl.x * move;
  rig.posKm.y += fwdEcl.y * move;
  rig.posKm.z += fwdEcl.z * move;
}, { passive: false });

// ---- labels & picking ----------------------------------------------------

const labelsEl = document.getElementById("labels");
const _v = new THREE.Vector3();

function updateLabels() {
  const placed = [];
  const camWorld = camera.position;
  const w = innerWidth, h = innerHeight;

  const sorted = [...allBodies].sort((a, b) => {
    const order = { star: 0, planet: 1, dwarf: 2, moon: 3 };
    return order[a.kind] - order[b.kind];
  });

  for (const b of sorted) {
    const absKm = b.absolutePositionKm(clock.jd);
    const world = eclipticKmToWorld(absKm, focusOriginKm());
    _v.copy(world).project(camera);
    const behind = _v.z > 1 || _v.z < -1;
    const distUnits = camWorld.distanceTo(world);
    const apparentPx = behind || distUnits < 1e-6 ? 0 : (b.radiusKm / KM_PER_UNIT) / (distUnits * Math.tan((camera.fov * Math.PI / 180) / 2)) * (h / 2);

    if (behind) { b.labelEl.style.display = "none"; continue; }

    const sx = (_v.x * 0.5 + 0.5) * w;
    const sy = (-_v.y * 0.5 + 0.5) * h;
    if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) { b.labelEl.style.display = "none"; continue; }

    let overlap = false;
    for (const p of placed) {
      if (Math.abs(p.x - sx) < 46 && Math.abs(p.y - sy) < 16) { overlap = true; break; }
    }
    if (overlap && b.kind === "moon") { b.labelEl.style.display = "none"; continue; }
    placed.push({ x: sx, y: sy });

    b.labelEl.style.display = "block";
    b.labelEl.style.left = sx + "px";
    b.labelEl.style.top = (sy + (apparentPx > LABEL_HIDE_PX ? apparentPx + 12 : 10)) + "px";
    b.labelEl.classList.toggle("marker", apparentPx <= LABEL_HIDE_PX);
    b.mesh.visible = apparentPx > 0.4;
  }
}

// ---- info panel -----------------------------------------------------------

function updateInfoPanel(body) {
  const hud = document.getElementById("hud");
  let panel = document.getElementById("info-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "info-panel";
    panel.className = "panel";
    hud.appendChild(panel);
  }
  const km = body.absolutePositionKm(clock.jd);
  const distFromSunAu = (Math.hypot(km.x, km.y, km.z) / AU_KM).toFixed(3);
  panel.innerHTML = `
    <div class="info-name">${body.name}</div>
    <div class="info-row"><span>Radius</span><span>${body.radiusKm.toLocaleString()} km</span></div>
    <div class="info-row"><span>Distance from Sun</span><span>${distFromSunAu} AU</span></div>
    ${body.parent && body.kind === "moon" ? `<div class="info-row"><span>Orbits</span><span>${body.parent.name}</span></div>` : ""}
  `;
}

// ---- render loop ------------------------------------------------------------

function applyFlyTo() {
  if (!flyTo) return;
  const t = Math.min(1, (performance.now() - flyTo.t0) / flyTo.dur);
  const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  rig.posKm.x = flyTo.fromKm.x + (flyTo.toKm.x - flyTo.fromKm.x) * ease;
  rig.posKm.y = flyTo.fromKm.y + (flyTo.toKm.y - flyTo.fromKm.y) * ease;
  rig.posKm.z = flyTo.fromKm.z + (flyTo.toKm.z - flyTo.fromKm.z) * ease;
  let dYaw = flyTo.toYaw - flyTo.fromYaw;
  while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
  while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
  rig.yaw = flyTo.fromYaw + dYaw * ease;
  rig.pitch = flyTo.fromPitch + (flyTo.toPitch - flyTo.fromPitch) * ease;
  if (t >= 1) flyTo = null;
}

let lastT = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  if (clock.playing) clock.jd += clock.speedDaysPerSec * dt;

  applyFlyTo();

  if (!flyTo) {
    const fwd = rigForwardVec();
    const right = rigRightVec(fwd);
    const speed = nearestSurfaceDistKm() * 0.6 * dt;
    // Accumulate in Three.js world space (where fwd/right live), THEN
    // convert the resulting direction to ecliptic space once — converting
    // per-axis before summing would be equally correct here since the
    // remap is linear, but doing it once after summing is clearer.
    let mx = 0, my = 0, mz = 0;
    if (rig.keys.has("KeyW")) { mx += fwd.x; my += fwd.y; mz += fwd.z; }
    if (rig.keys.has("KeyS")) { mx -= fwd.x; my -= fwd.y; mz -= fwd.z; }
    if (rig.keys.has("KeyD")) { mx += right.x; mz += right.z; }
    if (rig.keys.has("KeyA")) { mx -= right.x; mz -= right.z; }
    if (rig.keys.has("KeyE")) { my += 1; }
    if (rig.keys.has("KeyQ")) { my -= 1; }
    const len = Math.hypot(mx, my, mz);
    if (len > 0) {
      const dirEcl = worldDirToEclipticKm({ x: mx / len, y: my / len, z: mz / len });
      rig.posKm.x += dirEcl.x * speed;
      rig.posKm.y += dirEcl.y * speed;
      rig.posKm.z += dirEcl.z * speed;
    }
  }

  // Place camera at floating-origin-relative position (rig.posKm IS the focus origin).
  camera.position.set(0, 0, 0);
  const fwd = rigForwardVec();
  camera.lookAt(fwd.x, fwd.y, fwd.z);

  // Position all bodies relative to the camera's km position (floating origin).
  for (const b of allBodies) {
    const abs = b.absolutePositionKm(clock.jd);
    const world = eclipticKmToWorld(abs, rig.posKm);
    b.mesh.position.copy(world);
    b.applyRotation(clock.jd);
    if (b.ringMesh) b.ringMesh.position.copy(world);
    if (b.orbitLine) {
      const parentAbs = b.parent ? b.parent.absolutePositionKm(clock.jd) : { x: 0, y: 0, z: 0 };
      const parentWorld = eclipticKmToWorld(parentAbs, rig.posKm);
      b.orbitLine.position.copy(parentWorld);
    }
  }
  sunLight.position.copy(eclipticKmToWorld({ x: 0, y: 0, z: 0 }, rig.posKm));

  updateLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ---- boot -----------------------------------------------------------------

async function boot() {
  const res = await fetch("data/data.json");
  if (!res.ok) throw new Error("data.json missing — run scripts/build_data.py first");
  const data = await res.json();
  buildUniverse(data);
  requestAnimationFrame(tick);
}
boot().catch((err) => {
  console.error(err);
  document.getElementById("hud").innerHTML = `<div class="panel" style="color:#f88">Failed to load: ${err.message}</div>`;
});
