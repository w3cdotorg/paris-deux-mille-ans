import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  EIFFEL_GHOST,
  GHOST_BASE_OPACITY,
  CELEBRATION_1889_THRESHOLD,
  CELEBRATION_1860_THRESHOLD,
  CELEBRATION_COOLDOWN,
  eiffelGhostBaseOpacity,
  eiffelGhostOpacity,
  beaconPresence,
  didCross,
  shouldCelebrate,
  init as initGhosts,
  update as updateGhosts,
  debugState,
  stats,
} from "../src/layers/ghosts.js";
import { lifecycle } from "../src/timeEngine.js";
import { LANDMARKS } from "../src/geography.js";

// ============================================================================
// Configuration : le fantôme s'accorde avec la vraie tour de monuments.js
// ============================================================================

test("configuration : le fantôme mime le cycle de vie réel de la tour (monuments.js)", () => {
  assert.equal(EIFFEL_GHOST.born, 1887);
  assert.equal(EIFFEL_GHOST.buildYears, 2.3);
  assert.ok(Math.abs(CELEBRATION_1889_THRESHOLD - 1889.3) < 1e-9);
  assert.equal(CELEBRATION_1860_THRESHOLD, 1860);
});

// ============================================================================
// Opacité du fantôme — la promesse dorée
// ============================================================================

test("fantôme : à -100, silhouette pleine (avant toute construction)", () => {
  assert.equal(eiffelGhostBaseOpacity(-100), GHOST_BASE_OPACITY);
});

test("fantôme : à -250 (l'aube de la simulation), toujours pleine", () => {
  assert.equal(eiffelGhostBaseOpacity(-250), GHOST_BASE_OPACITY);
});

test("fantôme : à 1887 pile (naissance de la vraie tour), présence de construction nulle => encore pleine", () => {
  assert.equal(eiffelGhostBaseOpacity(1887), GHOST_BASE_OPACITY);
});

test("fantôme : à 1888,2 (en plein chantier), partiellement éteint — exactement 1-présence", () => {
  const presence = lifecycle(1888.2, EIFFEL_GHOST).presence;
  assert.ok(presence > 0 && presence < 1, "1888,2 doit tomber en pleine construction");
  const expected = GHOST_BASE_OPACITY * (1 - presence);
  assert.ok(Math.abs(eiffelGhostBaseOpacity(1888.2) - expected) < 1e-9);
  assert.ok(eiffelGhostBaseOpacity(1888.2) < GHOST_BASE_OPACITY);
  assert.ok(eiffelGhostBaseOpacity(1888.2) > 0);
});

test("fantôme : à 1890 (chantier fini), complètement éteint", () => {
  assert.equal(eiffelGhostBaseOpacity(1890), 0);
});

test("fantôme : à 2026, toujours éteint (la vraie tour est là)", () => {
  assert.equal(eiffelGhostBaseOpacity(2026), 0);
});

test("fantôme : reducedMotion figé, sans scintillement — l'opacité affichée == la base", () => {
  assert.equal(eiffelGhostOpacity(-100, 0, true), GHOST_BASE_OPACITY);
  assert.equal(eiffelGhostOpacity(-100, 12.7, true), GHOST_BASE_OPACITY);
  assert.equal(eiffelGhostOpacity(1890, 12.7, true), 0);
});

test("fantôme : scintillement — oscille autour de la base sans jamais sortir de [0,1]", () => {
  const base = eiffelGhostOpacity(-100, 0, false);
  assert.equal(base, GHOST_BASE_OPACITY, "sin(0) = 0, donc pas de décalage à t=0");
  let sawHigher = false;
  let sawLower = false;
  for (let t = 0; t < 20; t += 0.25) {
    const o = eiffelGhostOpacity(-100, t, false);
    assert.ok(o >= 0 && o <= 1);
    assert.ok(Math.abs(o - GHOST_BASE_OPACITY) <= 0.05 + 1e-9);
    if (o > GHOST_BASE_OPACITY) sawHigher = true;
    if (o < GHOST_BASE_OPACITY) sawLower = true;
  }
  assert.ok(sawHigher && sawLower, "le scintillement doit monter et descendre autour de la base");
});

test("fantôme : une fois éteint (opacité de base nulle), le scintillement ne le ranime pas", () => {
  for (let t = 0; t < 10; t += 1) {
    assert.equal(eiffelGhostOpacity(1900, t, false), 0);
  }
});

// ============================================================================
// La balise « chez nous » — toujours là
// ============================================================================

test("balise : présence constante à 1, quelle que soit l'année", () => {
  for (const year of [-250, -100, 0, 1000, 1860, 1887, 2026]) {
    assert.equal(beaconPresence(year), 1);
  }
});

// ============================================================================
// Détecteur de franchissement — les deux sens, une fois par franchissement
// ============================================================================

test("didCross : franchissement montant détecté", () => {
  assert.equal(didCross(1888, 1890, 1889.3), true);
});

test("didCross : franchissement descendant détecté (l'autre sens du scrub)", () => {
  assert.equal(didCross(1890, 1888, 1889.3), true);
});

test("didCross : pile sur le seuil compte comme un franchissement", () => {
  assert.equal(didCross(1888, 1889.3, 1889.3), true);
});

test("didCross : aucun mouvement => pas de franchissement", () => {
  assert.equal(didCross(1888, 1888, 1889.3), false);
});

test("didCross : mouvement qui ne traverse pas le seuil => rien", () => {
  assert.equal(didCross(1700, 1750, 1889.3), false);
  assert.equal(didCross(1950, 2000, 1889.3), false);
});

// ============================================================================
// shouldCelebrate — franchissement + bouton 📍/reducedMotion + throttle
// ============================================================================

test("shouldCelebrate : déclenche sur un franchissement simple, activé", () => {
  assert.equal(
    shouldCelebrate({
      prevYear: 1888,
      year: 1890,
      threshold: 1889.3,
      lastTriggerTime: -Infinity,
      now: 10,
      cooldown: CELEBRATION_COOLDOWN,
      enabled: true,
    }),
    true
  );
});

test("shouldCelebrate : déclenche aussi dans l'autre sens du scrub", () => {
  assert.equal(
    shouldCelebrate({
      prevYear: 1890,
      year: 1888,
      threshold: 1889.3,
      lastTriggerTime: -Infinity,
      now: 10,
      cooldown: CELEBRATION_COOLDOWN,
      enabled: true,
    }),
    true
  );
});

test("shouldCelebrate : jamais si désactivé (📍 éteint ou reducedMotion) — même en cas de franchissement", () => {
  assert.equal(
    shouldCelebrate({
      prevYear: 1888,
      year: 1890,
      threshold: 1889.3,
      lastTriggerTime: -Infinity,
      now: 10,
      cooldown: CELEBRATION_COOLDOWN,
      enabled: false,
    }),
    false
  );
});

test("shouldCelebrate : jamais sans franchissement, même activé", () => {
  assert.equal(
    shouldCelebrate({
      prevYear: 1700,
      year: 1750,
      threshold: 1889.3,
      lastTriggerTime: -Infinity,
      now: 10,
      cooldown: CELEBRATION_COOLDOWN,
      enabled: true,
    }),
    false
  );
});

test("shouldCelebrate : throttle — pas de second déclenchement dans la fenêtre de cooldown", () => {
  assert.equal(
    shouldCelebrate({
      prevYear: 1888,
      year: 1890,
      threshold: 1889.3,
      lastTriggerTime: 9,
      now: 10,
      cooldown: 3,
      enabled: true,
    }),
    false,
    "10 - 9 = 1 < 3 : encore dans le cooldown"
  );
});

test("shouldCelebrate : le cooldown expiré autorise un nouveau déclenchement", () => {
  assert.equal(
    shouldCelebrate({
      prevYear: 1888,
      year: 1890,
      threshold: 1889.3,
      lastTriggerTime: 5,
      now: 10,
      cooldown: 3,
      enabled: true,
    }),
    true,
    "10 - 5 = 5 >= 3"
  );
});

test("shouldCelebrate : le même détecteur générique sert la balise 1860", () => {
  assert.equal(
    shouldCelebrate({
      prevYear: 1855,
      year: 1865,
      threshold: CELEBRATION_1860_THRESHOLD,
      lastTriggerTime: -Infinity,
      now: 0,
      cooldown: CELEBRATION_COOLDOWN,
      enabled: true,
    }),
    true
  );
});

// ============================================================================
// Intégration légère : init/update ne plantent pas, le toggle 📍 coupe tout
// ============================================================================

function baseState(overrides = {}) {
  return {
    year: -100,
    weather: "sun",
    showLandmarks: true,
    voice: false,
    sound: false,
    qualityTier: "haut",
    reducedMotion: false,
    time: 0,
    ...overrides,
  };
}

test("init/update : construit la scène sans planter, le fantôme est visible à -100", () => {
  const scene = new THREE.Scene();
  const childrenBefore = scene.children.length;
  initGhosts({ scene });
  assert.ok(scene.children.length > childrenBefore, "des objets doivent avoir été ajoutés à la scène");

  const state = baseState({ year: -100 });
  updateGhosts(0, state);
  const dbg = debugState(state);
  assert.equal(dbg.ghostVisible, true);
  assert.ok(dbg.ghostOpacity > 0);
  assert.equal(dbg.beaconVisible, true);
});

test("toggle 📍 off : plus rien de visible, même à une année où le fantôme devrait l'être", () => {
  const scene = new THREE.Scene();
  initGhosts({ scene });
  const state = baseState({ year: -100, showLandmarks: false });
  updateGhosts(0, state);
  const dbg = debugState(state);
  assert.equal(dbg.ghostVisible, false);
  assert.equal(dbg.beaconVisible, false);
});

test("scrub à travers 1889 : une célébration se déclenche une seule fois", () => {
  const scene = new THREE.Scene();
  initGhosts({ scene });
  let state = baseState({ year: 1888, time: 0 });
  updateGhosts(0, state);
  assert.equal(debugState(state).burstActive, false);

  state = { ...state, year: 1890, time: 0.1 };
  updateGhosts(0.1, state);
  assert.equal(debugState(state).burstActive, true, "le franchissement de 1889,3 doit déclencher la gerbe");

  // Un second passage immédiat (throttlé) ne relance pas une nouvelle gerbe :
  // burstActive reste vrai simplement parce que la première n'est pas finie.
  state = { ...state, year: 1888, time: 0.2 };
  updateGhosts(0.1, state);
  assert.equal(debugState(state).burstActive, true);
});

test("scrub à travers 1889 avec reducedMotion : pas de gerbe", () => {
  const scene = new THREE.Scene();
  initGhosts({ scene });
  let state = baseState({ year: 1888, time: 0, reducedMotion: true });
  updateGhosts(0, state);
  state = { ...state, year: 1890, time: 0.1 };
  updateGhosts(0.1, state);
  assert.equal(debugState(state).burstActive, false);
});

test("stats : le pool de particules a bien la taille annoncée par le brief (~120)", () => {
  const scene = new THREE.Scene();
  initGhosts({ scene });
  assert.equal(stats().burstParticles, 120);
});

test("les deux repères respectent bien les coordonnées de geography.js", () => {
  assert.deepEqual(LANDMARKS.tourEiffel, { x: -406, z: -60 });
  assert.deepEqual(LANDMARKS.chezNous, { x: -131, z: -497 });
});
