// Chrome around the 3D scene: navigator, time control, sources panel,
// help. Talks to scene.js only through window.__orrery (bodiesById,
// allBodies, rig, clock) and window.selectBody — no tighter coupling.

const SPEEDS = [
  { label: "Real time", daysPerSec: 1 / 86400 },
  { label: "1 min/s", daysPerSec: 1 / 1440 },
  { label: "1 hour/s", daysPerSec: 1 / 24 },
  { label: "1 day/s", daysPerSec: 1 },
  { label: "30 days/s", daysPerSec: 30 },
  { label: "1 year/s", daysPerSec: 365.25 },
];

function waitForOrrery() {
  return new Promise((resolve) => {
    (function check() {
      if (window.__orrery && window.__orrery.allBodies.length) resolve(window.__orrery);
      else setTimeout(check, 50);
    })();
  });
}

function jdToDate(jd) {
  return new Date((jd - 2440587.5) * 86400000);
}

async function boot() {
  const orrery = await waitForOrrery();
  const { allBodies, clock } = orrery;

  // ---- navigator ----
  const navSelect = document.getElementById("nav-select");
  const order = { star: 0, planet: 1, dwarf: 2, moon: 3 };
  const sorted = [...allBodies].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  const group = { star: null, planet: null, dwarf: null, moon: null };
  navSelect.innerHTML = '<option value="">Jump to…</option>';
  const groupLabel = { star: "Star", planet: "Planets", dwarf: "Dwarf planets", moon: "Moons" };
  for (const b of sorted) {
    if (!group[b.kind]) {
      group[b.kind] = document.createElement("optgroup");
      group[b.kind].label = groupLabel[b.kind];
      navSelect.appendChild(group[b.kind]);
    }
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.kind === "moon" ? `${b.name} (${b.parent.name})` : b.name;
    group[b.kind].appendChild(opt);
  }
  navSelect.addEventListener("change", () => {
    const id = navSelect.value;
    if (id) window.selectBody(orrery.bodiesById.get(id));
    navSelect.value = "";
  });

  // ---- time control ----
  const speedSelect = document.getElementById("speed-select");
  SPEEDS.forEach((s, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = s.label;
    speedSelect.appendChild(opt);
  });
  speedSelect.value = 2; // 1 hour/s default
  clock.speedDaysPerSec = SPEEDS[2].daysPerSec;
  speedSelect.addEventListener("change", () => {
    clock.speedDaysPerSec = SPEEDS[Number(speedSelect.value)].daysPerSec;
  });

  const playBtn = document.getElementById("play-btn");
  playBtn.addEventListener("click", () => {
    clock.playing = !clock.playing;
    playBtn.innerHTML = clock.playing ? "&#10073;&#10073;" : "&#9658;";
  });

  document.getElementById("now-btn").addEventListener("click", () => {
    clock.jd = Date.now() / 86400000 + 2440587.5;
  });

  const dateReadout = document.getElementById("date-readout");
  function tickReadout() {
    const d = jdToDate(clock.jd);
    dateReadout.textContent = d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    requestAnimationFrame(tickReadout);
  }
  tickReadout();

  // ---- sources & method ----
  const sourcesBtn = document.getElementById("sources-btn");
  const sourcesPanel = document.getElementById("sources-panel");
  let sourcesLoaded = false;
  sourcesBtn.addEventListener("click", async () => {
    if (sourcesPanel.hidden && !sourcesLoaded) {
      try {
        const res = await fetch("data/sources.json");
        const sources = await res.json();
        const rows = sources.map((s) =>
          `<div class="source-row"><a href="${s.url}" target="_blank" rel="noopener">${s.url}</a><span class="source-meta">fetched ${(s.fetched_utc || "").slice(0, 10)} · ${(s.supplies || []).join(", ")}</span></div>`
        ).join("");
        sourcesPanel.innerHTML = `<h3>Sources &amp; Method</h3>
          <p>Every position, size, and orbit here traces to a fetched, hashed source below — nothing is estimated or invented. Moon orbits given in a planet's equatorial or Laplace-plane frame are rotated into the shared ecliptic frame using that planet's real pole orientation; for Laplace-frame moons this is a disclosed approximation (exact orbit shape/period, plane orientation can differ by up to a few degrees for the outer/irregular satellites). Saturn's rings, textures, and star sky are separately credited below.</p>
          <div class="source-list">${rows}</div>
          <p class="credit">Surface textures &amp; sky: Solar System Scope (solarsystemscope.com), CC BY 4.0.</p>`;
        sourcesLoaded = true;
      } catch (e) {
        sourcesPanel.innerHTML = `<h3>Sources &amp; Method</h3><p>Could not load sources.json.</p>`;
      }
    }
    sourcesPanel.hidden = !sourcesPanel.hidden;
  });

  // ---- help ----
  const helpBtn = document.getElementById("help-btn");
  const helpPanel = document.getElementById("help-panel");
  helpBtn.addEventListener("click", () => { helpPanel.hidden = !helpPanel.hidden; });
  document.getElementById("help-close").addEventListener("click", () => { helpPanel.hidden = true; });
}

boot();
