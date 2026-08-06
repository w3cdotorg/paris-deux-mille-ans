import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  SIGNATURES,
  WEATHER_MODES,
  NIGHT_EXPOSURE_FLOOR,
  OVERCAST_DESATURATION,
  LAMP_ERA_START,
  createSignatureTarget,
  blendSignatures,
  applyWeather,
  mixSignatures,
  stepWeatherWeights,
  snapWeatherWeights,
  windowLightProfile,
  eraMaxWindowHeight,
  lampEraFactor,
  fireFlicker,
  generateWindowSlots,
  generateLampSlots,
  rainStreakCount,
  hexToRgb,
  luminance,
  saturation,
  init,
  update,
  forceRescan,
  forceWeather,
  debugState,
  stats,
} from "../src/layers/weather.js";
import { MOMENTS } from "../src/timeline.js";
import { urbanYear, distanceToSeine } from "../src/geography.js";
import * as terrain from "../src/layers/terrain.js";

// ============================================================================
// Table des signatures — une par moment, dans le même ordre
// ============================================================================

test("signatures : 14 entrées, alignées année par année sur timeline.MOMENTS", () => {
  assert.equal(SIGNATURES.length, 14);
  assert.equal(SIGNATURES.length, MOMENTS.length);
  for (let i = 0; i < SIGNATURES.length; i++) {
    assert.equal(SIGNATURES[i].year, MOMENTS[i].year, `signature ${i + 1}`);
  }
});

test("signatures : le siège (885) est la seule nuit pleine de la frise", () => {
  const nights = SIGNATURES.filter((s) => s.nightness === 1);
  assert.equal(nights.length, 1);
  assert.equal(nights[0].year, 885);
  assert.equal(nights[0].fires, 1);
  // Nuit lisible, jamais noire : le ciel garde une luminance perceptible.
  const rgb = hexToRgb(nights[0].skyTop, { r: 0, g: 0, b: 0 });
  assert.ok(luminance(rgb) > 0.08, `luminance ciel = ${luminance(rgb)}`);
  // …et un ton brun-rouge : plus de rouge que de bleu.
  assert.ok(rgb.r > rgb.b);
});

test("signatures : chaque champ scalaire est renseigné et plausible", () => {
  for (const s of SIGNATURES) {
    assert.ok(s.ambientMood.length > 3, `mood manquant pour ${s.year}`);
    assert.ok(s.fogNear > 0 && s.fogNear < s.fogFar, `brouillard ${s.year}`);
    assert.ok(s.sunIntensity > 0 && s.sunIntensity <= 1.5, `soleil ${s.year}`);
    assert.ok(s.sunElevation > 0 && s.sunElevation <= 90, `élévation ${s.year}`);
    assert.ok(s.sunAzimuth >= 0 && s.sunAzimuth <= 360, `azimut ${s.year}`);
    assert.ok(s.exposure >= 0.8 && s.exposure <= 1.5, `exposition ${s.year}`);
    for (const key of ["nightness", "fires", "lamps", "windows"]) {
      assert.ok(s[key] >= 0 && s[key] <= 1, `${key} ${s.year}`);
    }
  }
});

test("signatures : les becs de gaz n'apparaissent pas avant l'ère du gaz", () => {
  for (const s of SIGNATURES) {
    if (s.year < LAMP_ERA_START) {
      assert.equal(s.lamps, 0, `lampadaires anachroniques en ${s.year}`);
    }
  }
});

// ============================================================================
// blendSignatures — interpolation continue de la signature d'époque
// ============================================================================

test("blendSignatures : l'année 885 pile donne exactement la signature 3", () => {
  const out = blendSignatures(885, createSignatureTarget());
  const expected = SIGNATURES[2];
  assert.equal(out.ambientMood, expected.ambientMood);
  assert.equal(out.nightness, 1);
  assert.equal(out.fires, 1);
  assert.equal(out.exposure, expected.exposure);
  assert.equal(out.sunIntensity, expected.sunIntensity);
  const rgb = hexToRgb(expected.skyTop, { r: 0, g: 0, b: 0 });
  assert.ok(Math.abs(out.skyTop.r - rgb.r) < 1e-12);
  assert.ok(Math.abs(out.skyTop.g - rgb.g) < 1e-12);
  assert.ok(Math.abs(out.skyTop.b - rgb.b) < 1e-12);
});

test("blendSignatures : le milieu de 885→1200 mélange nuit et aube", () => {
  const mid = (885 + 1200) / 2;
  const out = blendSignatures(mid, createSignatureTarget());
  // t = 0.5 exactement : nightness passe de 1 à 0, fires de 1 à 0.
  assert.ok(Math.abs(out.nightness - 0.5) < 1e-9, `nightness = ${out.nightness}`);
  assert.ok(Math.abs(out.fires - 0.5) < 1e-9);
  const night = blendSignatures(885, createSignatureTarget());
  const dawn = blendSignatures(1200, createSignatureTarget());
  assert.ok(luminance(out.skyTop) > luminance(night.skyTop));
  assert.ok(luminance(out.skyTop) < luminance(dawn.skyTop));
  // L'exposition (compensation du siège) redescend vers celle de l'aube.
  assert.ok(out.exposure < night.exposure && out.exposure > dawn.exposure);
  assert.ok(out.hemiIntensity < night.hemiIntensity && out.hemiIntensity > dawn.hemiIntensity);
});

test("blendSignatures : hors bornes, la frise reste accrochée à ses extrémités", () => {
  const before = blendSignatures(-9999, createSignatureTarget());
  const after = blendSignatures(9999, createSignatureTarget());
  assert.equal(before.ambientMood, SIGNATURES[0].ambientMood);
  assert.equal(after.ambientMood, SIGNATURES[13].ambientMood);
});

test("blendSignatures : continuité — aucune discontinuité sur toute la frise", () => {
  // Testé au dixième d'année, pas à l'année : deux ancres voisines peuvent
  // être séparées de 5 ans seulement (1860 matin clair → 1865 crépuscule au
  // gaz), donc un pas d'un an *doit* pouvoir changer la lumière franchement.
  // Ce qui doit être vrai, c'est qu'il n'existe aucun saut : la fonction est
  // continue, la pente est simplement raide dans les segments courts.
  const a = createSignatureTarget();
  const b = createSignatureTarget();
  let maxJump = 0;
  let jumpYear = null;
  for (let step = 0; step < 22760; step++) {
    const year = -250 + step * 0.1;
    blendSignatures(year, a);
    blendSignatures(year + 0.1, b);
    const jump = Math.abs(luminance(a.skyTop) - luminance(b.skyTop));
    if (jump > maxJump) {
      maxJump = jump;
      jumpYear = year;
    }
  }
  assert.ok(maxJump < 0.01, `saut max = ${maxJump} vers ${jumpYear}`);
});

test("blendSignatures : aucune allocation — écrit toujours dans la cible fournie", () => {
  const out = createSignatureTarget();
  const skyRef = out.skyTop;
  assert.equal(blendSignatures(1500, out), out);
  assert.equal(out.skyTop, skyRef);
});

// ============================================================================
// applyWeather — modulation météo
// ============================================================================

function sigAt(year) {
  return blendSignatures(year, createSignatureTarget());
}

test("applyWeather couvert : désature réellement et rapproche le brouillard", () => {
  const base = sigAt(1889); // grand beau, la signature la plus saturée
  const out = applyWeather(base, "overcast", createSignatureTarget());
  assert.ok(
    saturation(out.skyTop) < saturation(base.skyTop) * (1 - OVERCAST_DESATURATION * 0.5),
    `sat ${saturation(base.skyTop)} → ${saturation(out.skyTop)}`
  );
  assert.ok(saturation(out.sunColor) <= saturation(base.sunColor));
  assert.ok(out.fogNear < base.fogNear);
  assert.ok(out.fogFar < base.fogFar);
  assert.ok(out.sunIntensity < base.sunIntensity, "soleil adouci");
  assert.ok(out.hemiIntensity > base.hemiIntensity, "remplissage remonté");
});

test("applyWeather pluie : couvert + sol assombri + exposition −15 %", () => {
  const base = sigAt(1973);
  const overcast = applyWeather(base, "overcast", createSignatureTarget());
  const rain = applyWeather(base, "rain", createSignatureTarget());
  assert.ok(rain.fogNear < overcast.fogNear, "brouillard encore plus près");
  assert.ok(luminance(rain.hemiGround) < luminance(overcast.hemiGround), "sol mouillé");
  assert.ok(Math.abs(rain.exposure - base.exposure * 0.85) < 1e-9);
});

test("applyWeather nuit : plancher d'exposition respecté même sur la signature la plus sombre", () => {
  for (const s of SIGNATURES) {
    const base = sigAt(s.year);
    const out = applyWeather(base, "night", createSignatureTarget());
    assert.ok(
      out.exposure >= NIGHT_EXPOSURE_FLOOR - 1e-12,
      `exposition ${out.exposure} < plancher en ${s.year}`
    );
    assert.equal(out.nightness, 1);
    // Jamais noir : la luminance du ciel reste dans une fenêtre lisible.
    const lum = luminance(out.skyTop);
    assert.ok(lum > 0.05, `ciel trop noir en ${s.year} (lum=${lum})`);
    assert.ok(lum < 0.45, `ciel pas assez nocturne en ${s.year} (lum=${lum})`);
    // Lune généreuse et haute — le relief doit se lire.
    assert.ok(out.sunIntensity >= 0.35, `lune trop faible en ${s.year}`);
    assert.ok(out.sunElevation >= 12, `lune trop rasante en ${s.year}`);
    // Fenêtres et éclairage public actifs à toute époque (l'ère les filtre
    // ensuite via windowLightProfile / lampEraFactor).
    assert.equal(out.windows, 1);
    assert.ok(out.lamps >= 0.95);
  }
});

test("applyWeather nuit : la nuit d'une époque claire est plus froide que le jour", () => {
  const base = sigAt(1889);
  const out = applyWeather(base, "night", createSignatureTarget());
  assert.ok(luminance(out.skyTop) < luminance(base.skyTop));
  assert.ok(out.skyTop.b > out.skyTop.r, "bleu profond, pas gris");
});

test("moment 3 + soleil : la signature gagne, le siège reste sa nuit orange", () => {
  const base = sigAt(885);
  const out = applyWeather(base, "sun", createSignatureTarget());
  assert.ok(luminance(out.skyTop) < 0.2, `ciel éclairci à tort (${luminance(out.skyTop)})`);
  assert.ok(out.skyTop.r > out.skyTop.b, "le brun-rouge doit rester");
  assert.equal(out.nightness, 1);
  assert.equal(out.fires, 1);
  // L'éclaircissement du mode soleil est pondéré par (1 - nightness) : nul ici.
  assert.equal(out.sunIntensity, base.sunIntensity);
  assert.equal(out.exposure, base.exposure);
});

test("moment 3 + nuit : reste orange (verrou) au lieu de basculer au bleu générique", () => {
  const siege = applyWeather(sigAt(885), "night", createSignatureTarget());
  const roman = applyWeather(sigAt(200), "night", createSignatureTarget());
  assert.ok(siege.skyTop.r > siege.skyTop.b, "le siège garde son ton chaud");
  assert.ok(roman.skyTop.b > roman.skyTop.r, "une nuit ordinaire est bleue");
  assert.equal(siege.fires, 1, "les feux brûlent toujours");
});

test("applyWeather : le soleil pousse une signature diurne, jamais une nocturne", () => {
  const day = sigAt(1889);
  const dayOut = applyWeather(day, "sun", createSignatureTarget());
  assert.ok(dayOut.sunIntensity > day.sunIntensity);
  assert.ok(dayOut.fogFar > day.fogFar);
  const night = sigAt(885);
  const nightOut = applyWeather(night, "sun", createSignatureTarget());
  assert.equal(nightOut.fogFar, night.fogFar);
});

test("applyWeather : les 4 modes sont tous gérés (aucun retour identité surprise)", () => {
  const base = sigAt(1865);
  for (const mode of WEATHER_MODES) {
    const out = applyWeather(base, mode, createSignatureTarget());
    assert.ok(out.exposure > 0, mode);
    assert.ok(out.fogFar > out.fogNear, mode);
  }
});

// ============================================================================
// Transition météo — poids amortis (~1,5 s)
// ============================================================================

test("stepWeatherWeights : atteint la cible en ~1,5 s, sans jamais dépasser", () => {
  const w = snapWeatherWeights([0, 0, 0, 0], 0);
  const dt = 1 / 60;
  for (let i = 0; i < 90; i++) stepWeatherWeights(w, 3, dt); // 1,5 s vers 'night'
  assert.ok(w[3] > 0.95, `night = ${w[3]} après 1,5 s`);
  assert.ok(w[0] < 0.05);
  for (const v of w) assert.ok(v >= 0 && v <= 1);
});

test("stepWeatherWeights : les poids restent normalisés à chaque pas", () => {
  const w = snapWeatherWeights([0, 0, 0, 0], 0);
  for (let i = 0; i < 40; i++) {
    stepWeatherWeights(w, 2, 1 / 60);
    const total = w.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `somme = ${total}`);
  }
});

test("snapWeatherWeights : transition instantanée (mode reducedMotion)", () => {
  const w = snapWeatherWeights([0.3, 0.3, 0.2, 0.2], 1);
  assert.deepEqual(w, [0, 1, 0, 0]);
});

test("mixSignatures : à mi-transition, on est entre les deux modes", () => {
  const base = sigAt(2026);
  const sun = applyWeather(base, "sun", createSignatureTarget());
  const night = applyWeather(base, "night", createSignatureTarget());
  const mid = mixSignatures([sun, night], [0.5, 0.5], createSignatureTarget());
  assert.ok(mid.exposure > sun.exposure && mid.exposure < night.exposure);
  assert.ok(mid.nightness > sun.nightness && mid.nightness <= night.nightness);
});

// ============================================================================
// Fenêtres allumées — bougies → gaz → électrique
// ============================================================================

test("windowLightProfile : 1600 plafonne autour de 10 % de fenêtres allumées", () => {
  const p = windowLightProfile(1600);
  assert.ok(p.litFraction <= 0.12 && p.litFraction >= 0.08, `lit = ${p.litFraction}`);
});

// Les lumières de fenêtre saturent toutes le canal rouge (r = 1), donc la
// saturation HSL y vaut mécaniquement 1 : c'est la *chroma* (max − min) qui
// distingue l'ambre du gaz du blanc électrique.
const chroma = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);

test("windowLightProfile : 1880 est un ambre franc de bec de gaz", () => {
  const p = windowLightProfile(1880);
  const c = p.color;
  assert.ok(c.r > c.g && c.g > c.b, "dégradé chaud r>g>b");
  assert.ok(c.b / c.r < 0.55, `trop blanc pour du gaz (b/r = ${c.b / c.r})`);
  assert.ok(chroma(c) > 0.5, `pas assez ambré (chroma = ${chroma(c)})`);
});

test("windowLightProfile : 1950 est un blanc électrique", () => {
  const gas = windowLightProfile(1880);
  const electric = windowLightProfile(1950);
  assert.ok(electric.color.b / electric.color.r > 0.72, `b/r = ${electric.color.b / electric.color.r}`);
  assert.ok(chroma(electric.color) < chroma(gas.color) * 0.6, "bien moins coloré que le gaz");
  assert.ok(electric.litFraction > gas.litFraction, "et bien plus de fenêtres allumées");
});

test("windowLightProfile : la fraction allumée est monotone croissante", () => {
  let previous = -1;
  for (let year = -250; year <= 2026; year += 10) {
    const lit = windowLightProfile(year).litFraction;
    assert.ok(lit >= previous - 1e-12, `recul en ${year}`);
    previous = lit;
  }
  assert.ok(windowLightProfile(-250).litFraction < 0.1);
  assert.ok(windowLightProfile(2026).litFraction > 0.85);
});

test("windowLightProfile : hors bornes, aucune extrapolation", () => {
  assert.deepEqual(windowLightProfile(-5000).litFraction, windowLightProfile(-250).litFraction);
  assert.deepEqual(windowLightProfile(5000).litFraction, windowLightProfile(2026).litFraction);
});

test("eraMaxWindowHeight : monte avec les époques, jamais au-delà du plausible", () => {
  const heights = [1200, 1700, 1870, 1930, 2026].map(eraMaxWindowHeight);
  for (let i = 1; i < heights.length; i++) {
    assert.ok(heights[i] >= heights[i - 1], `recul à l'indice ${i}`);
  }
  assert.ok(heights[0] <= 8, "le médiéval reste bas");
  assert.ok(heights[heights.length - 1] <= 30, "1 unité = 10 m : pas de gratte-ciel");
});

test("lampEraFactor : rien avant les réverbères, plein après le gaz", () => {
  assert.equal(lampEraFactor(1600), 0);
  assert.equal(lampEraFactor(LAMP_ERA_START), 0);
  assert.ok(lampEraFactor(1815) > 0 && lampEraFactor(1815) < 1);
  assert.equal(lampEraFactor(1865), 1);
  assert.equal(lampEraFactor(2026), 1);
});

// ============================================================================
// Semis déterministes
// ============================================================================

test("generateWindowSlots : déterministe — deux appels identiques, même semis", () => {
  const a = generateWindowSlots(1900, -140, -80, 500, 300, 0);
  const b = generateWindowSlots(1900, -140, -80, 500, 300, 0);
  assert.equal(a.length, b.length);
  assert.ok(a.length > 0);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].x, b[i].x);
    assert.equal(a[i].z, b[i].z);
    assert.equal(a[i].rank, b[i].rank);
  }
});

test("generateWindowSlots : toute fenêtre est sur du bâti de son époque, hors de l'eau", () => {
  for (const year of [1400, 1700, 1900, 2026]) {
    const slots = generateWindowSlots(year, -140, -80, 500, 200, 7);
    assert.ok(slots.length > 0, `aucun emplacement en ${year}`);
    for (const s of slots) {
      assert.ok(urbanYear(s.x, s.z) <= year, `cellule non urbanisée en ${year}`);
      assert.ok(distanceToSeine(s.x, s.z) >= 9, "fenêtre posée sur la Seine");
      assert.ok(s.rank >= 0 && s.rank < 1);
    }
  }
});

test("generateWindowSlots : le semis grossit avec l'urbanisation", () => {
  // Lutèce romaine (un disque de rayon 90 sur la rive gauche + l'île) contre
  // le Paris de 2026 (tout l'intérieur du périphérique) : le semis n'arrive
  // même pas à remplir son quota au IIe siècle.
  const roman = generateWindowSlots(200, -140, -80, 500, 400, 3).length;
  const modern = generateWindowSlots(2026, -140, -80, 500, 400, 3).length;
  assert.ok(roman > 0, "aucune fenêtre à Lutèce");
  assert.ok(modern > roman * 2, `${roman} → ${modern}`);
  assert.equal(modern, 400, "le Paris moderne remplit le quota");
});

test("generateWindowSlots : ne dépasse jamais le nombre demandé", () => {
  assert.ok(generateWindowSlots(2026, 0, 0, 500, 50, 0).length <= 50);
});

test("generateWindowSlots : la ville s'allume fenêtre par fenêtre (rangs stables)", () => {
  // Le même emplacement garde son rang : quand la fraction allumée monte,
  // les fenêtres déjà allumées le restent — aucune ne s'éteint.
  const slots = generateWindowSlots(1900, -140, -80, 500, 300, 0);
  const lit1830 = slots.filter((s) => s.rank < windowLightProfile(1830).litFraction);
  const lit1900 = slots.filter((s) => s.rank < windowLightProfile(1900).litFraction);
  assert.ok(lit1900.length > lit1830.length);
  const keys1900 = new Set(lit1900.map((s) => `${s.x}:${s.z}`));
  for (const s of lit1830) {
    assert.ok(keys1900.has(`${s.x}:${s.z}`), "une fenêtre s'est éteinte en avançant");
  }
});

test("generateLampSlots : déterministe, complet, dans l'enceinte de Paris", () => {
  const a = generateLampSlots(320, 0);
  const b = generateLampSlots(320, 0);
  assert.equal(a.length, 320);
  assert.deepEqual(a.map((s) => s.x), b.map((s) => s.x));
  for (const s of a) {
    // Périphérique : ellipse (cx -140, cz -80, rx 575, rz 430), avec marge.
    const dx = (s.x + 140) / 575;
    const dz = (s.z + 80) / 430;
    assert.ok(dx * dx + dz * dz <= 1, `lampadaire hors du périph : ${s.x},${s.z}`);
  }
});

// ============================================================================
// Pluie / feux
// ============================================================================

test("rainStreakCount : la qualité multiplie le nombre de streaks, sous plafond", () => {
  assert.equal(rainStreakCount(1, 6000), 6000);
  assert.equal(rainStreakCount(0.5, 6000), 3000);
  assert.equal(rainStreakCount(0, 6000), 0);
  assert.equal(rainStreakCount(5, 6000), 6000, "plafonné");
});

test("fireFlicker : borné, non constant, et figé sous reducedMotion", () => {
  let min = Infinity;
  let max = -Infinity;
  const seen = new Set();
  for (let t = 0; t < 20; t += 0.05) {
    const v = fireFlicker(t, 0.37);
    min = Math.min(min, v);
    max = Math.max(max, v);
    seen.add(v.toFixed(3));
  }
  assert.ok(min > 0.5, `min = ${min}`);
  assert.ok(max < 1.3, `max = ${max}`);
  assert.ok(seen.size > 100, "le feu doit vraiment vaciller");
  assert.equal(fireFlicker(null, 0.37), 1);
});

// ============================================================================
// Rendu réel (three.js sans WebGL) — la couche s'initialise et suit l'état
// ============================================================================

function fakeCtx() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1.6, 2, 4000);
  camera.position.set(400, 620, 500);
  camera.lookAt(-140, 0, -80);
  camera.updateMatrixWorld(true);
  return {
    scene,
    camera,
    renderer: { toneMappingExposure: 1 },
    quality: { rain: 1, windows: 1 },
  };
}

function makeState(year, weatherMode, extra = {}) {
  return {
    year,
    weather: weatherMode,
    reducedMotion: false,
    time: 12.5,
    ...extra,
  };
}

test("init : pose le rig complet dans la scène (ciel, lumières, brouillard)", () => {
  const ctx = fakeCtx();
  init(ctx);
  assert.ok(ctx.scene.fog, "brouillard absent");
  assert.ok(ctx.scene.background && ctx.scene.background.isColor, "fond absent");
  const lights = ctx.scene.children.filter((c) => c.isLight);
  assert.ok(lights.some((l) => l.isHemisphereLight), "hémisphérique absente");
  assert.ok(lights.some((l) => l.isDirectionalLight), "soleil/lune absent");
  const budget = stats();
  assert.equal(budget.signatures, 14);
  assert.equal(budget.rainStreaks, 6000);
  assert.ok(budget.windowCap <= 1500, `plafond fenêtres = ${budget.windowCap}`);
  assert.equal(budget.stars, 400);
});

test("update : traverse toute la frise × les 4 météos sans exception", () => {
  const ctx = fakeCtx();
  terrain.init(ctx); // les nuages au sol échantillonnent le maillage rendu
  init(ctx);
  for (const mode of WEATHER_MODES) {
    for (let year = -250; year <= 2026; year += 97) {
      const state = makeState(year, mode);
      forceWeather(state);
      update(1 / 60, state);
    }
  }
  for (const mode of WEATHER_MODES) {
    const state = makeState(1865, mode, { reducedMotion: true });
    forceWeather(state);
    update(1 / 60, state);
  }
  const d = debugState();
  assert.ok(d.mood.length > 3);
  assert.ok(d.exposure > 0);
});

test("update : à 885, les feux du siège brûlent et scintillent", () => {
  const ctx = fakeCtx();
  terrain.init(ctx);
  init(ctx);
  const state = makeState(885, "sun");
  forceWeather(state);
  update(1 / 60, state);
  const lights = ctx.scene.children.filter((c) => c.isPointLight && c.visible);
  assert.equal(lights.length, 6, "6 brasiers attendus sur les berges");
  for (const l of lights) {
    assert.ok(l.intensity > 0, "brasier éteint");
    assert.ok(Math.abs(l.position.y) < 6, "brasier hors sol");
  }
  const before = lights.map((l) => l.intensity);
  state.time += 0.3;
  update(1 / 60, state);
  assert.ok(
    lights.some((l, i) => Math.abs(l.intensity - before[i]) > 1e-6),
    "le feu ne vacille pas"
  );
  assert.equal(debugState().fires, 1);
});

test("update : loin de 885, aucun brasier n'est visible (ni lumière parasite)", () => {
  const ctx = fakeCtx();
  terrain.init(ctx);
  init(ctx);
  const state = makeState(1889, "sun");
  forceWeather(state);
  update(1 / 60, state);
  const lights = ctx.scene.children.filter((c) => c.isPointLight && c.visible);
  assert.equal(lights.length, 0);
});

test("update : la nuit contemporaine allume les fenêtres, la nuit gauloise non", () => {
  const ctx = fakeCtx();
  terrain.init(ctx);
  init(ctx);

  const modern = makeState(2026, "night");
  forceWeather(modern);
  update(1 / 60, modern);
  forceRescan(2026);
  update(1 / 60, modern);
  const modernLit = stats().windowsLit;
  assert.ok(modernLit > 200, `seulement ${modernLit} fenêtres allumées en 2026`);

  const ancient = makeState(-250, "night");
  forceWeather(ancient);
  ancient.time = 30;
  forceRescan(-250);
  update(1 / 60, ancient);
  const ancientLit = stats().windowsLit;
  assert.ok(ancientLit < modernLit / 10, `${ancientLit} fenêtres à l'âge du fer`);
  // La nuit gauloise doit rester lisible malgré l'absence de fenêtres.
  assert.ok(debugState().exposure >= NIGHT_EXPOSURE_FLOOR - 1e-9);
  assert.ok(ctx.renderer.toneMappingExposure >= NIGHT_EXPOSURE_FLOOR - 1e-9);
});

test("update : la pluie n'est visible qu'en mode pluie", () => {
  const ctx = fakeCtx();
  terrain.init(ctx);
  init(ctx);
  const findRain = () =>
    ctx.scene.children.find((c) => c.isMesh && c.material.uniforms && c.material.uniforms.uFall);

  const sunny = makeState(1973, "sun");
  forceWeather(sunny);
  update(1 / 60, sunny);
  assert.equal(findRain().visible, false);

  const wet = makeState(1973, "rain");
  forceWeather(wet);
  update(1 / 60, wet);
  const mesh = findRain();
  assert.equal(mesh.visible, true);
  assert.ok(mesh.material.uniforms.uOpacity.value > 0.1);
  assert.ok(mesh.geometry.drawRange.count === 6000 * 6);

  // Sous reducedMotion, l'averse est figée et discrète.
  const still = makeState(1973, "rain", { reducedMotion: true });
  forceWeather(still);
  update(1 / 60, still);
  assert.equal(mesh.material.uniforms.uTime.value, 0);
  assert.ok(mesh.material.uniforms.uOpacity.value < 0.3);
});

test("update : la qualité réduite réduit vraiment la pluie et les fenêtres", () => {
  const ctx = fakeCtx();
  ctx.quality = { rain: 0.35, windows: 0.4 };
  terrain.init(ctx);
  init(ctx);
  const budget = stats();
  assert.equal(budget.rainStreaks, 2100);
  assert.ok(budget.windowCap < 600, `plafond = ${budget.windowCap}`);
});

test("forceWeather : saute le fondu — le mode est effectif dès la frame suivante", () => {
  const ctx = fakeCtx();
  terrain.init(ctx);
  init(ctx);
  const state = makeState(2026, "night");
  forceWeather(state);
  update(0, state);
  assert.equal(debugState().weights.night, 1);
  assert.ok(debugState().nightness >= 0.99);
});

test("update sans forceWeather : le fondu météo est progressif (~1,5 s)", () => {
  const ctx = fakeCtx();
  terrain.init(ctx);
  init(ctx);
  const start = makeState(1889, "sun");
  forceWeather(start);
  update(0, start);
  const state = makeState(1889, "night");
  update(1 / 60, state);
  const partial = debugState().weights.night;
  assert.ok(partial > 0 && partial < 0.2, `poids nuit après 1 frame = ${partial}`);
  for (let i = 0; i < 90; i++) update(1 / 60, state);
  assert.ok(debugState().weights.night > 0.95);
});
