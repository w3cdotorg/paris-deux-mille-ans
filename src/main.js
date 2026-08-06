import * as THREE from "three";
import { YEAR_MIN, YEAR_MAX } from "./timeline.js";
import * as terrain from "./layers/terrain.js";
import * as buildings from "./layers/buildings.js";
import * as walls from "./layers/walls.js";
import { createControls } from "./controls.js";
import * as ui from "./ui.js";

const canvas = document.querySelector("#scene");

// preserveDrawingBuffer: screenshot tooling (Playwright/CDP) can otherwise
// capture a blank frame right after a buffer swap; negligible cost here.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// Filmic rolloff instead of hard clipping to white on sunlit slopes.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  2,
  4000
);

/** @type {{year:number, weather:string, showLandmarks:boolean, voice:boolean, sound:boolean, qualityTier:string, reducedMotion:boolean, time:number}} */
const state = {
  year: 2026,
  weather: "sun",
  showLandmarks: true,
  voice: false,
  sound: false,
  qualityTier: "haut",
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  time: 0,
};

const quality = { crowds: 1, trees: 1, rain: 1, boats: 1, shadows: 1 };
const ctx = { scene, renderer, camera, quality };

// Layer registry: each module exports init(ctx) and update(dt, state).
// buildings after terrain: it samples the *rendered* ground mesh
// (groundHeightAt) to sit buildings on the real surface, so terrain's
// init() (which builds that mesh) must have already run.
const layers = [terrain, buildings, walls];
for (const layer of layers) {
  layer.init(ctx);
}

// Custom orbit/pan/zoom controls (see controls.js) — sets the camera's
// initial position to the `ensemble` preset, which exactly reproduces the
// project's original fixed establishing shot.
const controls = createControls(camera, canvas, () => state);

// UI shell (frise, boutons ronds, story-card slot) — follows the same
// init/update contract as the scene layers above, but drives the DOM.
ui.init(state);

// ui.js never mutates `state` directly; it only emits bus events. This is
// the one place that translates them into state mutations (or, for
// 'preset', a camera flight).
ui.bus.addEventListener("yearchange", (event) => {
  // Deliberately just an assignment — no forced rescan here. Both a
  // handle-drag and an icon's flyToYear tween call this many times per
  // second; terrain.js's own maybeRescan() (called every frame from the
  // layer update loop below) already debounces to at most one rescan per
  // ~60ms, so this path can never trigger an unthrottled full rescan per
  // pointermove. window.__paris.setYear (below) is the separate, deliberately
  // un-throttled path for single automated calls.
  state.year = Math.max(YEAR_MIN, Math.min(YEAR_MAX, event.detail.year));
});
ui.bus.addEventListener("weatherchange", (event) => {
  state.weather = event.detail.weather;
});
ui.bus.addEventListener("preset", (event) => {
  controls.flyTo(event.detail.name);
});
ui.bus.addEventListener("voicechange", (event) => {
  state.voice = event.detail.enabled;
});
ui.bus.addEventListener("soundchange", (event) => {
  state.sound = event.detail.enabled;
});
ui.bus.addEventListener("landmarkschange", (event) => {
  state.showLandmarks = event.detail.show;
});
ui.bus.addEventListener("qualitychange", (event) => {
  state.qualityTier = event.detail.tier;
});

function onResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", onResize);

// --- Keyboard: accessibility fallback for orbit/timeline/presets ----------
const YEAR_STEP = 20;
const PRESET_KEYS = { 1: "ensemble", 2: "cite", 3: "chezNous", 4: "eiffel" };

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") {
    // Same throttled path as a handle drag: a plain assignment, picked up
    // by terrain's per-frame debounced rescan — never an immediate forced
    // rescan on every keypress.
    state.year = Math.max(YEAR_MIN, Math.min(YEAR_MAX, state.year + YEAR_STEP));
  } else if (event.key === "ArrowLeft") {
    state.year = Math.max(YEAR_MIN, Math.min(YEAR_MAX, state.year - YEAR_STEP));
  } else if (PRESET_KEYS[event.key]) {
    controls.flyTo(PRESET_KEYS[event.key]);
  }
});

/**
 * Canonical year setter: clamps, updates state, then forces an immediate
 * full terrain rescan and render — bypassing the normal per-frame debounce
 * so the change is visible the instant this returns, regardless of
 * requestAnimationFrame timing. Exposed on window.__paris for
 * automation/verification (single calls only — driving this rapidly would
 * defeat the point of the throttled path above, which is what real drag/
 * keyboard/flight input goes through instead).
 * @param {number} year
 */
function setYear(year) {
  state.year = Math.max(YEAR_MIN, Math.min(YEAR_MAX, year));
  terrain.forceRescan(state.year);
  buildings.rebuildForYear(state.year);
  walls.forceRescan(state.year);
  ui.update(0, state);
  renderer.render(scene, camera);
}

// Debug/verification hook (permanent — load-bearing for automated checks in
// this task and later ones, e.g. Task 19's full-timeline traversal).
window.__paris = {
  get state() {
    return state;
  },
  setYear,
  flyTo: (name, duration) => controls.flyTo(name, duration),
  camera,
  buildingStats: () => buildings.stats(),
  debugCounts: (year) => buildings.debugCounts(year ?? state.year),
  wallCounts: (year) => walls.debugCounts(year ?? state.year),
  renderer,
  scene,
};

// --- Main loop --------------------------------------------------------------
const clock = new THREE.Clock();
let fpsFrameCount = 0;
let fpsLogAt = 0;

function animate() {
  const dt = Math.min(clock.getDelta(), 0.1);
  state.time += dt;

  for (const layer of layers) {
    layer.update(dt, state);
  }
  controls.update(dt);
  ui.update(dt, state);

  renderer.render(scene, camera);

  fpsFrameCount++;
  if (state.time - fpsLogAt >= 5) {
    const fps = Math.round(fpsFrameCount / (state.time - fpsLogAt));
    console.log(`FPS ~ ${fps}`);
    fpsFrameCount = 0;
    fpsLogAt = state.time;
  }

  requestAnimationFrame(animate);
}

animate();
