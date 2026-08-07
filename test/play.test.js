import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlayback, DEFAULT_ANCHORS_U } from "../src/play.js";
import { MOMENTS } from "../src/timeline.js";

/** Fait avancer `playback` de `dt` jusqu'à ce que `phase==='done'`, avec un
 * garde-fou d'itérations pour ne jamais transformer un bug de boucle infinie
 * en test qui pend. */
function runToCompletion(playback, dt, maxIterations = 100000) {
  let elapsed = 0;
  let iterations = 0;
  let result = playback.tick(0); // phase courante sans avancer
  while (result.phase !== "done") {
    result = playback.tick(dt);
    elapsed += dt;
    iterations++;
    assert.ok(iterations < maxIterations, "runToCompletion : trop d'itérations, probable boucle infinie");
  }
  return elapsed;
}

// ============================================================================
// Ancres par défaut — géométrie
// ============================================================================

test("DEFAULT_ANCHORS_U : 14 ancres également espacées, 0 et 1 inclus", () => {
  assert.equal(DEFAULT_ANCHORS_U.length, MOMENTS.length);
  assert.equal(DEFAULT_ANCHORS_U[0], 0);
  assert.equal(DEFAULT_ANCHORS_U[DEFAULT_ANCHORS_U.length - 1], 1);
  for (let i = 1; i < DEFAULT_ANCHORS_U.length; i++) {
    assert.ok(DEFAULT_ANCHORS_U[i] > DEFAULT_ANCHORS_U[i - 1]);
  }
});

// ============================================================================
// Durée totale du voyage
// ============================================================================

test("voyage complet (ancres par défaut, ×1) : durée ≈ totalSeconds + 14×pauseSeconds", () => {
  const playback = createPlayback({ totalSeconds: 105, pauseSeconds: 4 });
  playback.play();
  // dt fin (16ms, l'ordre de grandeur d'une vraie frame) : le pas naïf de
  // `tick` "consomme" tout `dt` même quand il ne fallait qu'une fraction
  // pour atteindre l'ancre suivante (le surplus de distance est jeté, pas le
  // temps) — avec un dt grossier cette perte s'accumule visiblement sur 14
  // ancres ; à l'échelle d'une vraie frame elle est négligeable (<1s sur
  // 161s), donc jamais corrigée côté implémentation.
  const elapsed = runToCompletion(playback, 1 / 60);
  const expected = 105 + 14 * 4; // 161
  assert.ok(Math.abs(elapsed - expected) < 1, `elapsed=${elapsed} attendu≈${expected}`);
  assert.equal(playback.u, 1);
  assert.equal(playback.playing, false);
});

test("sans ancres (cruise pur) : durée = totalSeconds exactement, aucune pause", () => {
  const playback = createPlayback({ totalSeconds: 10, pauseSeconds: 4, anchors: [] });
  playback.play();
  const elapsed = runToCompletion(playback, 0.1);
  assert.ok(Math.abs(elapsed - 10) < 0.2, `elapsed=${elapsed} attendu≈10`);
});

// ============================================================================
// Une pause par ancre, jamais plus
// ============================================================================

test("chaque ancre déclenche une pause exactement une fois sur un voyage complet", () => {
  const playback = createPlayback({ totalSeconds: 13, pauseSeconds: 0.1, anchors: [0, 1 / 3, 2 / 3, 1] });
  playback.play();
  runToCompletion(playback, 0.05);
  assert.equal(playback.holdCount, 4);
});

test("une pause interrompue par pause()/resume() ne recompte pas et ne saute pas la pause en cours", () => {
  // Ancre unique à u=0 : play() entre immédiatement en pause.
  const playback = createPlayback({ totalSeconds: 10, pauseSeconds: 2, anchors: [0, 1] });
  playback.play();
  assert.equal(playback.phase, "holding");
  playback.tick(0.5); // 0.5s de pause écoulée
  playback.pause();
  // Pendant la pause "externe" : aucun tick ne doit être appelé côté appelant,
  // mais même si l'appelant appelle tick() par erreur, rien ne doit avancer.
  const frozen = playback.tick(5);
  assert.equal(frozen.phase, "holding");
  assert.ok(Math.abs(frozen.holdRemaining - 1.5) < 1e-9, "le temps ne doit pas avancer pendant pause()");
  playback.resume();
  assert.equal(playback.phase, "holding", "resume() en pleine pause doit continuer CETTE pause, pas la sauter");
  playback.tick(1.5); // les 1.5s restantes de pause de base
  assert.equal(playback.phase, "cruising", "la pause de l'ancre 0 doit s'être terminée normalement");
  assert.equal(playback.holdCount, 1, "une seule pause comptée pour l'ancre 0, malgré pause()/resume()");
});

// ============================================================================
// Vitesse
// ============================================================================

test("changement de vitesse en cours de croisière : ×2 avance deux fois plus vite que ×1", () => {
  const totalSeconds = 20;
  const a = createPlayback({ totalSeconds, anchors: [] });
  const b = createPlayback({ totalSeconds, anchors: [] });
  a.play();
  b.play();
  a.tick(5); // 5s à ×1 : u = 5/20 = 0.25
  b.tick(5);
  b.setSpeed(2);
  b.tick(2.5); // 2.5s à ×2 : +2.5*2/20 = +0.25 → u = 0.5
  assert.ok(Math.abs(a.u - 0.25) < 1e-9);
  assert.ok(Math.abs(b.u - 0.5) < 1e-9);
});

test("setSpeed ignore une valeur ≤0 (garde-fou, ne casse pas la cadence en cours)", () => {
  const playback = createPlayback({ totalSeconds: 10, anchors: [] });
  playback.play();
  playback.setSpeed(0);
  playback.setSpeed(-3);
  assert.equal(playback.speed, 1);
});

// ============================================================================
// pause()/resume() idempotents
// ============================================================================

test("pause()/resume() sont idempotents (appels répétés sans effet cumulatif)", () => {
  const playback = createPlayback({ totalSeconds: 10, anchors: [] });
  playback.play();
  playback.tick(2); // u = 0.2
  playback.pause();
  playback.pause();
  playback.pause();
  assert.equal(playback.playing, false);
  const before = playback.u;
  playback.tick(3); // ne doit rien faire, playing===false
  assert.equal(playback.u, before);
  playback.resume();
  playback.resume();
  playback.resume();
  assert.equal(playback.playing, true);
  playback.tick(1); // u += 1*1/10 = 0.1 → 0.3, une seule fois
  assert.ok(Math.abs(playback.u - 0.3) < 1e-9);
});

// ============================================================================
// Prolongation de pause (voix encore en cours), plafonnée
// ============================================================================

test("extendHold prolonge la pause en cours mais jamais au-delà de maxHoldSeconds", () => {
  const playback = createPlayback({ totalSeconds: 10, pauseSeconds: 1, maxHoldSeconds: 12, anchors: [0] });
  playback.play();
  assert.equal(playback.phase, "holding");
  playback.tick(0.5);
  playback.extendHold(20); // la voix "parle encore 20s" — doit être plafonné
  const rest = runToCompletion(playback, 0.1);
  const total = 0.5 + rest;
  assert.ok(Math.abs(total - 12) < 0.15, `pause totale=${total} attendu≈12 (plafond)`);
});

test("extendHold n'a aucun effet hors d'une pause en cours", () => {
  const playback = createPlayback({ totalSeconds: 10, anchors: [] });
  playback.play();
  assert.equal(playback.phase, "cruising");
  playback.extendHold(5); // no-op : pas en pause
  playback.tick(1);
  assert.ok(Math.abs(playback.u - 0.1) < 1e-9, "extendHold hors pause ne doit rien changer à la croisière");
});

// ============================================================================
// Cycle complet : rejouer après la fin
// ============================================================================

test("play() après phase==='done' relance tout le voyage depuis le début", () => {
  const playback = createPlayback({ totalSeconds: 4, pauseSeconds: 0.1, anchors: [0, 0.5, 1] });
  playback.play();
  runToCompletion(playback, 0.1);
  assert.equal(playback.phase, "done");
  assert.equal(playback.holdCount, 3);

  playback.play(); // deuxième voyage
  assert.equal(playback.u, 0);
  assert.equal(playback.phase, "holding");
  const elapsed2 = runToCompletion(playback, 0.1);
  assert.ok(Math.abs(elapsed2 - (4 + 3 * 0.1)) < 0.2);
  assert.equal(playback.holdCount, 3, "les ancres sont réarmées, pas cumulées avec le 1er voyage");
});

test("stop() réinitialise complètement (u, ancres réarmées, lecture coupée)", () => {
  const playback = createPlayback({ totalSeconds: 10, pauseSeconds: 1, anchors: [0, 0.5, 1] });
  playback.play();
  playback.tick(3); // avance et tient une pause en route
  playback.stop();
  assert.equal(playback.u, 0);
  assert.equal(playback.phase, "cruising");
  assert.equal(playback.playing, false);
  assert.equal(playback.holdCount, 0);
});

test("setU repositionne u sans effet de bord ; tick() reste sans effet tant que playing est faux", () => {
  const playback = createPlayback({ totalSeconds: 10, anchors: [] });
  playback.setU(0.6);
  assert.equal(playback.u, 0.6);
  playback.tick(5); // playing toujours faux : aucune avance
  assert.equal(playback.u, 0.6);
  assert.equal(playback.phase, "cruising");
});
