import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { groundUrbanBlend, isForestCandidate, init, setQuality, stats, forceRescan } from "../src/layers/terrain.js";
import { urbanYear } from "../src/geography.js";

function fakeCtx(quality) {
  return { scene: new THREE.Scene(), quality };
}

// ============================================================================
// groundUrbanBlend — pure forest<->urban colour decision, no THREE/WebGL
// ============================================================================

test("groundUrbanBlend: the core cell (0,0) is fully urban-coloured at 2026", () => {
  const uYear = urbanYear(0, 0);
  assert.equal(groundUrbanBlend(uYear, 2026), 1);
});

test("groundUrbanBlend: the core cell (0,0) is not fully urban-coloured at -250", () => {
  // (0,0) is île de la Cité's own center, born exactly at -250 — so this is
  // the one cell where "not yet urban" reads as a half-blend (the very
  // first instant of settlement) rather than pure forest; the invariant
  // that matters is that it's strictly less blended than at 2026.
  const uYear = urbanYear(0, 0);
  assert.ok(groundUrbanBlend(uYear, -250) < groundUrbanBlend(uYear, 2026));
  assert.equal(groundUrbanBlend(uYear, -250) < 1, true);
});

test("groundUrbanBlend: a typical medieval-era cell is pure forest at -250, pure urban at 2026", () => {
  const uYear = 1300; // representative of the Philippe-Auguste growth band
  assert.equal(groundUrbanBlend(uYear, -250), 0);
  assert.equal(groundUrbanBlend(uYear, 2026), 1);
});

test("groundUrbanBlend: land that never urbanizes (uYear=Infinity) is always forest", () => {
  assert.equal(groundUrbanBlend(Infinity, 2026), 0);
  assert.equal(groundUrbanBlend(Infinity, -250), 0);
});

test("groundUrbanBlend: exactly at the frontier year gives a half blend", () => {
  // raw = (year - uYear)/transitionYears + 0.5; at year === uYear, raw = 0.5.
  assert.equal(groundUrbanBlend(1000, 1000, 100), 0.5);
});

test("groundUrbanBlend: monotonically increases with year for a fixed uYear", () => {
  const uYear = 1500;
  const early = groundUrbanBlend(uYear, 1000);
  const mid = groundUrbanBlend(uYear, 1500);
  const late = groundUrbanBlend(uYear, 3000);
  assert.ok(early <= mid);
  assert.ok(mid <= late);
});

// ============================================================================
// isForestCandidate — pure tree-placement predicate, no THREE/WebGL
// ============================================================================

test("isForestCandidate: excludes cells too close to the Seine even if never urbanized", () => {
  assert.equal(isForestCandidate(3, Infinity, 2026, 9), false);
});

test("isForestCandidate: excludes cells already urbanized by `year`", () => {
  assert.equal(isForestCandidate(20, 1800, 2026, 9), false);
});

test("isForestCandidate: keeps cells that are far from water and not yet urbanized", () => {
  assert.equal(isForestCandidate(20, 2100, 2026, 9), true);
});

test("isForestCandidate: land that never urbanizes is a tree candidate at any year", () => {
  assert.equal(isForestCandidate(20, Infinity, -250, 9), true);
  assert.equal(isForestCandidate(20, Infinity, 2026, 9), true);
});

test("isForestCandidate: the Seine margin boundary is land-inclusive, water just below it", () => {
  assert.equal(isForestCandidate(9, 3000, 2026, 9), true); // exactly at the margin: land
  assert.equal(isForestCandidate(8.99, 3000, 2026, 9), false); // just below it: water
});

test("isForestCandidate: a cell that just urbanized (uYear === year) is excluded", () => {
  assert.equal(isForestCandidate(20, 2026, 2026, 9), false);
});

// ============================================================================
// setQuality (tâche 18) — la forêt reconstruit sa densité en cours de session
// ============================================================================

test("setQuality: baisser ctx.quality.trees réduit vraiment le nombre d'arbres construits", () => {
  const ctx = fakeCtx({ trees: 1 });
  init(ctx);
  forceRescan(2026);
  const before = stats();
  assert.ok(before.forestCandidates > 0, "aucun candidat construit à trees:1");

  ctx.quality.trees = 0.4; // valeur du tier "léger"
  setQuality(ctx);
  const after = stats();

  assert.ok(
    after.forestCandidates < before.forestCandidates,
    `candidats: avant=${before.forestCandidates} après=${after.forestCandidates}`
  );
  assert.ok(after.treesActive < before.treesActive, `actifs: avant=${before.treesActive} après=${after.treesActive}`);
});

test("setQuality: remonter la qualité reconstruit une forêt plus dense, sans exception", () => {
  const ctx = fakeCtx({ trees: 0.4 });
  init(ctx);
  forceRescan(2026);
  const low = stats();

  ctx.quality.trees = 1;
  setQuality(ctx);
  const high = stats();

  assert.ok(high.forestCandidates > low.forestCandidates);
  assert.ok(high.treesActive > low.treesActive);
});
