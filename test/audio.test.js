import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nappeWeights,
  ringProximityGain,
  bellPartials,
  populationToGain,
  BELL_PARTIAL_RATIOS,
  NATURE_TABLE,
  CLOCHES_TABLE,
  NAPPE_CAPS,
  MASTER_TARGET,
  HARD_CAP,
  PC_NEAR,
  PC_FAR,
  setVolume,
  getVolume,
} from "../src/audio.js";
import { MOMENTS } from "../src/timeline.js";

// ============================================================================
// Mix rules — les plafonds respectent bien les contraintes de la tâche
// ============================================================================

test("mix : le gain maître visé ne dépasse jamais 0,5", () => {
  assert.ok(MASTER_TARGET <= 0.5);
});

test("mix : chaque plafond de nappe est ≤ 0,35 (oreilles d'enfant)", () => {
  for (const [name, cap] of Object.entries(NAPPE_CAPS)) {
    assert.ok(cap <= 0.35, `${name} : ${cap} devrait être ≤ 0.35`);
    assert.ok(cap > 0, `${name} : un plafond nul ne servirait à rien`);
  }
  assert.ok(HARD_CAP <= 0.35);
});

// ============================================================================
// Tables par moment — alignées sur timeline.MOMENTS
// ============================================================================

test("tables nature/cloches : une entrée par moment de la frise", () => {
  assert.equal(NATURE_TABLE.length, MOMENTS.length);
  assert.equal(CLOCHES_TABLE.length, MOMENTS.length);
});

// ============================================================================
// nappeWeights — la table de poids pour une année donnée
// ============================================================================

test("nappeWeights(885) : le siège domine, les cloches sont partielles (ni nulles ni pleines)", () => {
  const w = nappeWeights(885);
  assert.ok(w.siege > 0.95, `siege devrait être ≈1, obtenu ${w.siege}`);
  assert.ok(w.cloches > 0.05 && w.cloches < 0.9, `cloches devrait être partiel, obtenu ${w.cloches}`);
  assert.ok(w.vapeur === 0, "la vapeur n'existe pas encore en 885");
  assert.ok(w.circulation === 0, "la circulation n'existe pas encore en 885");
});

test("nappeWeights(1900) : la vapeur est active, la foule est haute", () => {
  const w = nappeWeights(1900);
  assert.ok(w.vapeur > 0.5, `vapeur devrait être active, obtenu ${w.vapeur}`);
  assert.ok(w.foule > 0.8, `foule devrait être haute (2,7M habitants), obtenu ${w.foule}`);
  assert.equal(w.siege, 0, "le siège de 885 est bien terminé en 1900");
});

test("nappeWeights(2026) : circulation + nature résiduelle, pas de vapeur", () => {
  const w = nappeWeights(2026);
  assert.ok(w.circulation > 0.5, `circulation devrait être présente, obtenu ${w.circulation}`);
  assert.ok(w.nature > 0, "la nature ne doit jamais tomber à zéro (résiduelle)");
  assert.ok(w.nature < 0.3, `nature devrait être résiduelle (faible), obtenu ${w.nature}`);
  assert.equal(w.vapeur, 0, "la petite ceinture s'est endormie en 1934 : plus de vapeur en 2026");
  assert.equal(w.siege, 0);
});

test("nappeWeights(-250) : nature forte, tout le reste éteint", () => {
  const w = nappeWeights(-250);
  assert.ok(w.nature > 0.9, `nature devrait être forte (moment 1), obtenu ${w.nature}`);
  assert.equal(w.cloches, 0);
  assert.equal(w.siege, 0);
  assert.equal(w.vapeur, 0);
  assert.equal(w.circulation, 0);
});

test("nappeWeights : jamais négatif, jamais > 1", () => {
  for (const year of [-250, 0, 200, 885, 1200, 1370, 1670, 1789, 1860, 1865, 1869, 1889, 1900, 1934, 1950, 1973, 2000, 2026]) {
    const w = nappeWeights(year);
    for (const [name, value] of Object.entries(w)) {
      assert.ok(value >= 0 && value <= 1, `${name}(${year}) = ${value} hors [0,1]`);
    }
  }
});

// ============================================================================
// ringProximityGain — courbe de distance à un anneau (vapeur PC / circulation périph)
// ============================================================================

test("ringProximityGain : 50u → 1, 400u → 0 (valeurs par défaut PC)", () => {
  assert.equal(ringProximityGain(PC_NEAR), 1);
  assert.equal(ringProximityGain(0), 1);
  assert.equal(ringProximityGain(PC_FAR), 0);
  assert.equal(ringProximityGain(1000), 0);
});

test("ringProximityGain : monotone décroissante entre near et far", () => {
  const samples = [50, 100, 150, 200, 250, 300, 350, 400];
  const values = samples.map((d) => ringProximityGain(d));
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] <= values[i - 1], `gain(${samples[i]})=${values[i]} devrait être ≤ gain(${samples[i - 1]})=${values[i - 1]}`);
  }
});

test("ringProximityGain : paramètres near/far personnalisables", () => {
  assert.equal(ringProximityGain(60, 60, 500), 1);
  assert.equal(ringProximityGain(500, 60, 500), 0);
  const mid = ringProximityGain(280, 60, 500);
  assert.ok(mid > 0 && mid < 1);
});

// ============================================================================
// bellPartials — partiels inharmoniques d'une cloche
// ============================================================================

test("bellPartials : fondamentale ×1, ×2.76, ×5.4", () => {
  assert.deepEqual(BELL_PARTIAL_RATIOS, [1, 2.76, 5.4]);
  const partials = bellPartials(200);
  assert.equal(partials.length, 3);
  assert.equal(partials[0], 200);
  assert.equal(partials[1], 200 * 2.76);
  assert.equal(partials[2], 200 * 5.4);
});

test("bellPartials : les partiels montent avec la fondamentale (pitch qui varie)", () => {
  const low = bellPartials(180);
  const high = bellPartials(260);
  for (let i = 0; i < 3; i++) assert.ok(high[i] > low[i]);
});

// ============================================================================
// populationToGain — échelle logarithmique, monotone
// ============================================================================

test("populationToGain : monotone croissante en population", () => {
  const pops = [0, 1000, 10000, 50000, 250000, 500000, 650000, 1700000, 1800000, 2300000, 2700000, 2900000];
  const gains = pops.map((p) => populationToGain(p));
  for (let i = 1; i < gains.length; i++) {
    assert.ok(gains[i] >= gains[i - 1], `gain(${pops[i]})=${gains[i]} devrait être ≥ gain(${pops[i - 1]})=${gains[i - 1]}`);
  }
});

// ============================================================================
// setVolume / getVolume — curseur de volume 🔈 (post-v1)
// ============================================================================
// Sans DOM/AudioContext (Node), setVolume ne peut pas toucher le graphe Web
// Audio (audioCtx reste null) — mais elle doit malgré tout mémoriser la
// cible demandée, exactement ce que getVolume() doit renvoyer ensuite.

test("setVolume(50) : getVolume() renvoie 0.5, la valeur par défaut (curseur à 50%)", () => {
  setVolume(50);
  assert.equal(getVolume(), 0.5);
});

test("setVolume(20) : getVolume() renvoie 0.2 (mapping linéaire, voir volumePercentToGain)", () => {
  setVolume(20);
  assert.equal(getVolume(), 0.2);
});

test("setVolume(0) : getVolume() renvoie 0 (curseur au minimum, silence)", () => {
  setVolume(0);
  assert.equal(getVolume(), 0);
});

test("setVolume(100) : getVolume() renvoie 1", () => {
  setVolume(100);
  assert.equal(getVolume(), 1);
});

test("populationToGain : toujours dans [0,1], jamais négatif même pour une population négative", () => {
  assert.equal(populationToGain(-100), 0);
  assert.ok(populationToGain(10_000_000) <= 1);
});
