import * as THREE from "three";
import { YEAR_MIN, YEAR_MAX } from "./timeline.js";
import * as terrain from "./layers/terrain.js";

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

// Fixed 3/4 aerial view (provisional — Task 6 adds orbit controls). Elevated,
// positioned south-east of the Paris core so the Seine's north-west run
// toward La Défense (and its attenuated off-map tail) recedes into the
// distance rather than sitting behind the camera.
const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  2,
  4000
);
camera.position.set(620, 480, 760);
camera.lookAt(-120, 10, -40);

/** @type {{year:number, weather:string, showLandmarks:boolean, reducedMotion:boolean, time:number}} */
const state = {
  year: 2026,
  weather: "sun",
  showLandmarks: true,
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  time: 0,
};

const quality = { crowds: 1, trees: 1, rain: 1, boats: 1, shadows: 1 };
const ctx = { scene, renderer, camera, quality };

// Layer registry: each module exports init(ctx) and update(dt, state).
const layers = [terrain];
for (const layer of layers) {
  layer.init(ctx);
}

function onResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", onResize);

// --- Provisional keyboard year control (Task 6 replaces with real UI) -----
const YEAR_STEP = 20;

const yearLabel = document.createElement("div");
yearLabel.id = "year-label";
Object.assign(yearLabel.style, {
  position: "fixed",
  top: "12px",
  left: "12px",
  padding: "6px 14px",
  background: "rgba(10, 14, 24, 0.55)",
  color: "#fdf6e3",
  font: "600 15px 'Fredoka', system-ui, sans-serif",
  borderRadius: "8px",
  zIndex: "10",
  pointerEvents: "none",
});
document.body.appendChild(yearLabel);

function updateYearLabel() {
  const y = Math.round(state.year);
  const label = y < 0 ? `${Math.abs(y)} av. J.-C.` : `${y}`;
  yearLabel.textContent = `Année : ${label}`;
}
updateYearLabel();

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") {
    state.year = Math.min(YEAR_MAX, state.year + YEAR_STEP);
    updateYearLabel();
  } else if (event.key === "ArrowLeft") {
    state.year = Math.max(YEAR_MIN, state.year - YEAR_STEP);
    updateYearLabel();
  }
});

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
