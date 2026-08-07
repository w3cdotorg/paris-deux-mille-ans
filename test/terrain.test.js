import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  groundUrbanBlend,
  isForestCandidate,
  islandProfile,
  islandFreeboardAt,
  groundHeightAt,
  seineWaterHeightAt,
  init,
  setQuality,
  stats,
  forceRescan,
} from "../src/layers/terrain.js";
import {
  urbanYear,
  ISLANDS,
  LANDMARKS,
  seineHalfWidthAt,
  isOnPermanentIsland,
  distanceToSeine,
} from "../src/geography.js";

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
// Îles (post-v2) — « l'île est une terre au milieu du fleuve »
// ============================================================================

test("islandProfile : plateau plein au coeur, zéro au trait de rive, décroissant entre les deux", () => {
  assert.equal(islandProfile(0), 1);
  assert.equal(islandProfile(0.5), 1);
  assert.equal(islandProfile(0.82), 1); // exactement au bord du plateau
  assert.equal(islandProfile(1), 0);
  assert.equal(islandProfile(1.2), 0);
  let previous = 1;
  for (let k = 0.82; k <= 1.001; k += 0.02) {
    const value = islandProfile(k);
    assert.ok(value <= previous + 1e-9, `remontée du profil à k=${k.toFixed(2)}`);
    assert.ok(value >= 0 && value <= 1);
    previous = value;
  }
});

test("islandFreeboardAt : franc-bord plein sur les deux îles, nul sur les berges", () => {
  const cite = islandFreeboardAt(ISLANDS.cite.x, ISLANDS.cite.z);
  const stl = islandFreeboardAt(ISLANDS.saintLouis.x, ISLANDS.saintLouis.z);
  assert.ok(cite > 1.5, `franc-bord de la Cité : ${cite}`);
  assert.equal(stl, cite, "les deux îles ont le même franc-bord");
  // Notre-Dame et la Sainte-Chapelle sont sur le plateau, pas sur le talus.
  assert.equal(islandFreeboardAt(LANDMARKS.notreDame.x, LANDMARKS.notreDame.z), cite);
  assert.equal(islandFreeboardAt(LANDMARKS.sainteChapelle.x, LANDMARKS.sainteChapelle.z), cite);
  // Rives et campagne : rien du tout.
  assert.equal(islandFreeboardAt(0, 30), 0);
  assert.equal(islandFreeboardAt(-152, -95), 0);
  assert.equal(islandFreeboardAt(ISLANDS.louviers.x, ISLANDS.louviers.z), 0);
});

test("les deux îles émergent réellement du plan d'eau rendu (le test du gamin, en chiffres)", () => {
  const ctx = fakeCtx({ trees: 0.4 });
  init(ctx);
  forceRescan(-250);

  for (const [name, isl] of [["Cité", ISLANDS.cite], ["Saint-Louis", ISLANDS.saintLouis]]) {
    const top = groundHeightAt(isl.x, isl.z);
    const water = seineWaterHeightAt(isl.x, isl.z);
    assert.ok(
      top - water > 1.2,
      `${name} : plateau à ${top.toFixed(2)}, eau à ${water.toFixed(2)} — l'île se noie`
    );
  }

  // Notre-Dame, au centre de l'île, est au sec sur le plateau.
  const nd = groundHeightAt(LANDMARKS.notreDame.x, LANDMARKS.notreDame.z);
  assert.ok(nd - seineWaterHeightAt(0, 0) > 1.2, "Notre-Dame a les pieds dans l'eau");

  // Et de chaque côté de la Cité, mesuré le long de la normale au fleuve : de
  // l'eau (donc PAS de terre d'île), plus haute que le lit, sur les deux bras.
  const n = { x: 0.342, z: -0.94 };
  for (const side of [1, -1]) {
    const probe = seineHalfWidthAt(0, 0) - 2; // 2 unités en dedans du bord
    const px = n.x * side * probe;
    const pz = n.z * side * probe;
    assert.equal(
      isOnPermanentIsland(px, pz),
      false,
      `bras ${side > 0 ? "nord" : "sud"} : la terre de l'île y arrive encore`
    );
    assert.ok(
      distanceToSeine(px, pz) < seineHalfWidthAt(px, pz),
      `bras ${side > 0 ? "nord" : "sud"} : le point sondé n'est pas dans le lit`
    );
    assert.ok(
      seineWaterHeightAt(px, pz) > groundHeightAt(px, pz) - 0.01,
      `bras ${side > 0 ? "nord" : "sud"} : le plan d'eau passe sous le sol`
    );
  }

  const s = stats();
  assert.equal(s.islandMeshes, 2, "les deux îles doivent avoir leur maillage");
});

test("stats() expose de quoi vérifier mécaniquement que la Cité émerge", () => {
  const ctx = fakeCtx({ trees: 0.4 });
  init(ctx);
  forceRescan(1400);
  const s = stats();
  assert.ok(s.citeTopY - s.citeWaterY > 1.2);
  assert.ok(Number.isFinite(s.saintLouisTopY));
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
