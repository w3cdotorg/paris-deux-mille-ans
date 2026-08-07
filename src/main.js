import * as THREE from "three";
import { MOMENTS, YEAR_MIN, YEAR_MAX } from "./timeline.js";
import { sliderToYear } from "./timeEngine.js";
import * as weather from "./layers/weather.js";
import * as terrain from "./layers/terrain.js";
import * as buildings from "./layers/buildings.js";
import * as walls from "./layers/walls.js";
import * as monuments from "./layers/monuments.js";
import * as rails from "./layers/rails.js";
import * as life from "./layers/life.js";
import * as ghosts from "./layers/ghosts.js";
import { createControls } from "./controls.js";
import * as ui from "./ui.js";
import * as narration from "./narration.js";
import { createPlayback } from "./play.js";

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

/** @type {{year:number, weather:string, showLandmarks:boolean, voice:boolean, sound:boolean, qualityTier:string, reducedMotion:boolean, time:number, playing:boolean, playSpeed:number}} */
const state = {
  year: 2026,
  weather: "sun",
  showLandmarks: true,
  voice: false,
  sound: false,
  qualityTier: "haut",
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  time: 0,
  // Tâche 16 — ▶️ Lecture : "playing" et "playSpeed" ne sont mutés qu'ici
  // (voir advancePlayback et les écouteurs "playtoggle"/"speedchange"
  // ci-dessous) ; ui.js ne fait que les refléter sur le bouton et les
  // molettes de vitesse (même invariant que le reste de state — voir le
  // docstring de ui.js).
  playing: false,
  playSpeed: 1,
};

const quality = { crowds: 1, trees: 1, rain: 1, boats: 1, shadows: 1, windows: 1 };
const ctx = { scene, renderer, camera, quality };

// Layer registry: each module exports init(ctx) and update(dt, state).
// weather en premier : c'est lui qui possède tout l'éclairage (hémisphérique,
// soleil/lune, brouillard, dôme de ciel, exposition, pluie, feux, fenêtres
// allumées). L'ordre n'a pas d'importance pour three (les lumières sont
// collectées à chaque rendu), mais il rend l'intention lisible — et weather
// diffère ses nuages de points au sol à sa première frame, puisqu'ils
// échantillonnent le maillage de terrain construit juste après.
// buildings after terrain: it samples the *rendered* ground mesh
// (groundHeightAt) to sit buildings on the real surface, so terrain's
// init() (which builds that mesh) must have already run.
// monuments après walls : ils lisent groundHeightAt (terrain) et occupent des
// emplacements que buildings tient déjà libres (MONUMENT_FOOTPRINTS).
// rails après monuments : même dépendance au terrain (groundHeightAt), et
// leurs couloirs (geography.insideRailCorridor) sont déjà pris en compte par
// buildings.js à sa génération.
// life après rails : les bateaux flottent au niveau de l'eau du terrain et
// les foules/vignettes reposent sur groundHeightAt (terrain), déjà construit.
// ghosts en dernier : la Tour Eiffel fantôme et la balise « chez nous » sont
// en matériau additif sans écriture de profondeur — elles doivent se dessiner
// *après* tout le reste (bâtiments, monuments, rails, vie) pour ne pas
// produire d'artefacts de tri avec ce qui se trouve derrière elles.
const layers = [weather, terrain, buildings, walls, monuments, rails, life, ghosts];
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

// Tâche 16 — ▶️ Lecture : "regarder le film". `playback` (src/play.js) est
// une pure machine à état en u∈[0,1] (la même unité que la frise) ; ce
// fichier est le seul à la faire avancer (`advancePlayback`, appelée depuis
// la boucle animate() ci-dessous) et à reconvertir u en année via
// `sliderToYear` — exactement comme ui.js le fait déjà pour son propre
// tween de vol d'icône, mais ici piloté par le temps plutôt que par une
// destination fixe.
const YEAR_ANCHORS = MOMENTS.map((m) => m.year);
const playback = createPlayback({ totalSeconds: 105, pauseSeconds: 4 });

function hasSpeechSpeaking() {
  return typeof window !== "undefined" && !!window.speechSynthesis && window.speechSynthesis.speaking;
}

/**
 * Fait avancer la lecture automatique de `dt` secondes (sans effet si
 * `state.playing` est faux). Factorisée hors de `animate()` pour que
 * `window.__paris.playback.tick` (vérification Playwright — driver la
 * lecture plus vite que le temps réel sans dépendre d'un vrai
 * requestAnimationFrame) partage exactement le même chemin que la boucle
 * réelle.
 * @param {number} dt secondes
 * @returns {{u:number, phase:string, holdRemaining:number}|null}
 */
function advancePlayback(dt) {
  if (!state.playing) return null;
  const result = playback.tick(dt);
  state.year = Math.max(YEAR_MIN, Math.min(YEAR_MAX, sliderToYear(result.u, YEAR_ANCHORS)));
  // Pendant une pause à une ancre, si la voix (state.voice) est encore en
  // train de lire la carte, on prolonge la pause d'au moins 1s à chaque
  // frame tant qu'elle parle — extendHold plafonne lui-même à 12s au total
  // (voir play.js), donc cette relance ne peut jamais dépasser le plafond
  // même si la voix continue plus longtemps.
  if (result.phase === "holding" && state.voice && hasSpeechSpeaking()) {
    playback.extendHold(1);
  }
  if (result.phase === "done") {
    state.playing = false;
    controls.setDrift(false);
    // Petit bouquet de fin sur l'icône 2026 : voir ui.js, écouteur
    // "playfinished" (ui.js est seul à connaître dom.momentButtons).
    ui.bus.dispatchEvent(new CustomEvent("playfinished"));
  }
  return result;
}

// Narration (Task 15) — cartes-récits, voix, monuments cliquables, compteur.
// Not part of the `layers` array above: unlike the scene layers, it needs the
// DOM (canvas for tap/raycast, #pdma-ui for the card/counter/label) and the
// ui.js bus, not just `ctx`/`state`.
narration.init({ scene, camera, canvas }, state);

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
  // Tâche 16 : ce bus event ne vient jamais de la lecture automatique
  // elle-même (advancePlayback écrit state.year directement, sans passer
  // par le bus) — il ne peut venir que d'un drag de la frise, d'un tap sur
  // une icône (flyToYear) ou des flèches clavier : dans les trois cas,
  // "l'utilisateur reprend la main", donc on met en pause (pause()/false
  // sont sans effet si la lecture ne tournait déjà pas — voir play.js).
  state.playing = false;
  playback.pause();
  controls.setDrift(false);
});
ui.bus.addEventListener("weatherchange", (event) => {
  state.weather = event.detail.weather;
});
ui.bus.addEventListener("preset", (event) => {
  controls.flyTo(event.detail.name);
});
ui.bus.addEventListener("playtoggle", () => {
  if (state.playing) {
    state.playing = false;
    playback.pause();
    controls.setDrift(false);
    return;
  }
  // Annule un éventuel vol d'icône en cours (voir stopTween's docstring) :
  // sans lien avec la lecture automatique elle-même, juste un garde-fou
  // pour ne jamais avoir deux mécanismes qui écrivent state.year le même
  // instant.
  ui.stopTween();
  playback.setSpeed(state.playSpeed);
  playback.play();
  state.playing = true;
  controls.setDrift(true);
});
ui.bus.addEventListener("speedchange", (event) => {
  state.playSpeed = event.detail.speed;
  playback.setSpeed(state.playSpeed);
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
    // Tâche 16 : cette voie ne passe pas par le bus (contrairement au drag
    // de la frise) — même intention "l'utilisateur reprend la main", donc
    // même mise en pause explicite ici.
    state.playing = false;
    playback.pause();
    controls.setDrift(false);
  } else if (event.key === "ArrowLeft") {
    state.year = Math.max(YEAR_MIN, Math.min(YEAR_MAX, state.year - YEAR_STEP));
    state.playing = false;
    playback.pause();
    controls.setDrift(false);
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
  monuments.forceRescan(state.year);
  rails.forceRescan(state.year);
  life.forceRescan(state.year);
  // life.forceRescan ne réécrit que les foules (InstancedMesh) — bateaux,
  // oiseaux et vignettes suivent l'année via `update()` normal (leur
  // présence/échelle dépend de state.year à chaque frame, pas d'un
  // InstancedMesh à reconstruire) : un appel synchrone les recale ici aussi.
  life.update(0, state);
  // weather : la signature d'époque suit l'année à chaque frame, mais le semis
  // de fenêtres allumées est débouncé (WINDOW_REPOSITION_*) — forceRescan le
  // repositionne tout de suite pour que la capture montre la bonne époque
  // d'éclairage (bougies / gaz / électrique) dès ce rendu synchrone.
  weather.forceRescan(state.year);
  weather.update(0, state);
  // ghosts n'a pas de rescan coûteux à forcer (pas d'InstancedMesh à réécrire) :
  // un simple update(0, state) suffit à recaler son opacité/visibilité sur la
  // nouvelle année avant le rendu synchrone ci-dessous, sans attendre la
  // prochaine frame de la boucle animate().
  ghosts.update(0, state);
  ui.update(0, state);
  narration.update(0, state);
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
  monumentCounts: (year) => monuments.debugCounts(year ?? state.year),
  monumentStats: () => monuments.stats(),
  railCounts: (year) => rails.debugCounts(year ?? state.year),
  railStats: () => rails.stats(),
  lifeCounts: (year) => life.debugCounts(year ?? state.year),
  lifeStats: () => life.stats(),
  lifeBoats: () => life.debugBoats(),
  lifeBirds: () => life.debugBirds(),
  ghostState: () => ghosts.debugState(state),
  ghostStats: () => ghosts.stats(),
  // Même rôle que le bouton météo de l'UI, en un appel — mais la transition
  // de 1,5 s est court-circuitée (`forceWeather`) pour qu'une capture prise
  // juste après montre bien le mode demandé, pas le milieu du fondu.
  setWeather: (mode) => {
    state.weather = mode;
    weather.forceWeather(state);
    weather.update(0, state);
    monuments.update(0, state);
    rails.update(0, state);
    ui.update(0, state);
    renderer.render(scene, camera);
  },
  weatherState: () => weather.debugState(),
  weatherStats: () => weather.stats(),
  renderer,
  scene,
  // Tâche 15 — carte-récit, voix, monuments cliquables, compteur.
  narration: {
    state: () => narration.debugState(),
    voices: () => narration.debugVoices(),
  },
  // Tâche 16 — ▶️ Lecture : le voyage automatique. `tick(dt)` appelle le
  // même chemin que la boucle animate() (`advancePlayback`), ce qui permet
  // à Playwright de driver tout le voyage avec des `dt` programmatiques
  // (ex. 2s à la fois, à ×2) plutôt que d'attendre ~80s de temps réel.
  playback: {
    state: () => ({
      playing: state.playing,
      speed: state.playSpeed,
      u: playback.u,
      phase: playback.phase,
      holdRemaining: playback.holdRemaining,
      holdCount: playback.holdCount,
    }),
    toggle: () => ui.bus.dispatchEvent(new CustomEvent("playtoggle")),
    setSpeed: (speed) => ui.bus.dispatchEvent(new CustomEvent("speedchange", { detail: { speed } })),
    tick: (dt) => advancePlayback(dt),
  },
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
  // Tâche 16 : après controls.update (le drift cinématique, s'il est armé,
  // a déjà tourné pour cette frame) et avant ui.update (qui doit refléter
  // l'année *déjà* avancée par la lecture, pas celle d'il y a une frame).
  advancePlayback(dt);
  ui.update(dt, state);
  narration.update(dt, state);

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
