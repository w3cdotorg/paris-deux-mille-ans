import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LANDMARKS,
  RINGS,
  SEINE_POINTS,
  SEINE_ONMAP_COUNT,
  ISLANDS,
  heightAt,
  urbanYear,
  distanceToSeine,
  distanceToSeineFull,
} from "../src/geography.js";

// ============================================================================
// LANDMARKS — the shared conventions table
// ============================================================================

test("geography: LANDMARKS exposes the full conventions table", () => {
  assert.deepEqual(LANDMARKS.notreDame, { x: 0, z: 0 });
  assert.deepEqual(LANDMARKS.louvre, { x: -90, z: -84 });
  assert.deepEqual(LANDMARKS.bastille, { x: 141, z: 0 });
  assert.deepEqual(LANDMARKS.tourEiffel, { x: -406, z: -60 });
  assert.deepEqual(LANDMARKS.sacreCoeur, { x: -50, z: -375 });
  assert.deepEqual(LANDMARKS.chezNous, { x: -131, z: -497 });
  assert.deepEqual(LANDMARKS.arenes, { x: 22, z: 89 });
  assert.deepEqual(LANDMARKS.thermes, { x: -43, z: 28 });
  assert.deepEqual(LANDMARKS.pantheon, { x: -26, z: 76 });
  assert.deepEqual(LANDMARKS.laDefense, { x: -834, z: -433 });
});

// ============================================================================
// RINGS — périphérique / petite ceinture ellipses
// ============================================================================

test("geography: RINGS exposes périphérique and petite ceinture ellipses", () => {
  assert.equal(RINGS.peripherique.cx, -140);
  assert.equal(RINGS.peripherique.cz, -80);
  assert.equal(RINGS.peripherique.rx, 575);
  assert.equal(RINGS.petiteCeinture.cx, -140);
  assert.equal(RINGS.petiteCeinture.cz, -80);
  assert.equal(RINGS.petiteCeinture.rx, 545);
});

test("geography: chez nous is framed by the two rings (petite ceinture south, périphérique north)", () => {
  const { peripherique, petiteCeinture } = RINGS;
  const { x, z } = LANDMARKS.chezNous;

  // Northern-arc z of an ellipse at a given x (north = -z).
  const northZ = (ring) => {
    const dx = (x - ring.cx) / ring.rx;
    const inside = Math.max(0, 1 - dx * dx);
    return ring.cz - ring.rz * Math.sqrt(inside);
  };

  const zPeripherique = northZ(peripherique);
  const zPetiteCeinture = northZ(petiteCeinture);

  // Chez nous must sit strictly between the two northern arcs:
  // south of (i.e. inside) the périphérique, north of (i.e. outside) the petite ceinture.
  assert.ok(
    zPeripherique < z,
    `chez nous (z=${z}) should be south of the périphérique's northern arc (z=${zPeripherique})`
  );
  assert.ok(
    z < zPetiteCeinture,
    `chez nous (z=${z}) should be north of the petite ceinture's northern arc (z=${zPetiteCeinture})`
  );
});

// ============================================================================
// SEINE_POINTS — river polyline control points
// ============================================================================

test("geography: SEINE_POINTS exposes the on-map meander control points verbatim", () => {
  assert.equal(SEINE_ONMAP_COUNT, 12);
  assert.deepEqual(SEINE_POINTS.slice(0, SEINE_ONMAP_COUNT), [
    { x: 300, z: 315 },
    { x: 215, z: 170 },
    { x: 95, z: 60 },
    { x: 30, z: 15 },
    { x: 0, z: 0 },
    { x: -40, z: -15 },
    { x: -95, z: -50 },
    { x: -210, z: -140 },
    { x: -361, z: -122 },
    { x: -456, z: -31 },
    { x: -520, z: 33 },
    { x: -586, z: 292 },
  ]);
});

// ============================================================================
// distanceToSeine — must ignore the off-map return loop (review Important 3:
// "phantom second river"). The full-course variant stays available for the
// rare caller that draws the tail itself.
// ============================================================================

test("geography: distanceToSeine ignores the off-map return loop near La Défense", () => {
  // (-750, 150) sits far from the real, on-map river course but close to the
  // off-map return loop's westward bulge (-742, 300)-(-788, 110). Before the
  // fix, distanceToSeine used the full 18-point polyline and read this point
  // as practically on the riverbank — painting a phantom second river swoosh
  // and wrongly excluding nearby land as unbuildable.
  const d = distanceToSeine(-750, 150);
  assert.ok(d > 50, `distanceToSeine(-750, 150) = ${d}, expected > 50`);
  // Sanity check: the full-course variant genuinely does read this point as
  // close to the (stylized, off-map) loop — confirming the two functions
  // differ for the reason this test exists, not by coincidence.
  const dFull = distanceToSeineFull(-750, 150);
  assert.ok(dFull < d, `expected distanceToSeineFull (${dFull}) < distanceToSeine (${d})`);
});

test("geography: SEINE_POINTS extends past the map with the off-map return loop toward La Défense", () => {
  // The brief calls for a loop hors carte vers le NO, back toward La Défense
  // (-834,-433), exiting the map. The tail must keep going past the last
  // on-map point, not stop at (-586,292).
  assert.ok(
    SEINE_POINTS.length > SEINE_ONMAP_COUNT,
    "SEINE_POINTS should have additional off-map points after the on-map course"
  );
  const last = SEINE_POINTS[SEINE_POINTS.length - 1];
  assert.ok(last.x < -700, `last Seine point should exit west (x=${last.x})`);
  assert.ok(last.z < -350, `last Seine point should exit north (z=${last.z})`);
});

// ============================================================================
// ISLANDS — Cité, Saint-Louis, Louviers
// ============================================================================

test("geography: ISLANDS exposes Cité, Saint-Louis and Louviers (died 1843)", () => {
  assert.deepEqual(ISLANDS.cite, { x: 0, z: 0, rx: 12, rz: 5 });
  assert.deepEqual(ISLANDS.saintLouis, { x: 35, z: 8, rx: 8, rz: 3 });
  assert.equal(ISLANDS.louviers.x, 120);
  assert.equal(ISLANDS.louviers.z, 18);
  assert.equal(ISLANDS.louviers.rx, 5);
  assert.equal(ISLANDS.louviers.rz, 2);
  assert.equal(ISLANDS.louviers.died, 1843);
});

// ============================================================================
// heightAt — relief
// ============================================================================

test("geography: heightAt(Montmartre) is at least 8 above heightAt(Notre-Dame)", () => {
  const montmartre = heightAt(LANDMARKS.sacreCoeur.x, LANDMARKS.sacreCoeur.z);
  const notreDame = heightAt(LANDMARKS.notreDame.x, LANDMARKS.notreDame.z);
  assert.ok(
    montmartre > notreDame + 8,
    `heightAt(Montmartre)=${montmartre} should exceed heightAt(Notre-Dame)=${notreDame} + 8`
  );
});

test("geography: heightAt is deterministic", () => {
  assert.equal(heightAt(-131, -497), heightAt(-131, -497));
  assert.equal(heightAt(180, -280), heightAt(180, -280));
});

// ============================================================================
// urbanYear — urbanization field
// ============================================================================

test("geography: urbanYear at the île de la Cité is <= -250", () => {
  assert.ok(urbanYear(LANDMARKS.notreDame.x, LANDMARKS.notreDame.z) <= -250);
});

test("geography: urbanYear at the Thermes (Roman left bank) is <= 300", () => {
  assert.ok(urbanYear(LANDMARKS.thermes.x, LANDMARKS.thermes.z) <= 300);
});

test("geography: urbanYear at chez nous is within [1750, 1900]", () => {
  const year = urbanYear(LANDMARKS.chezNous.x, LANDMARKS.chezNous.z);
  assert.ok(year >= 1750 && year <= 1900, `urbanYear(chez nous)=${year}`);
});

test("geography: urbanYear beyond the périphérique (countryside) is Infinity", () => {
  assert.equal(urbanYear(0, -900), Infinity);
});

test("geography: urbanYear at La Défense is within [1960, 2000]", () => {
  const year = urbanYear(LANDMARKS.laDefense.x, LANDMARKS.laDefense.z);
  assert.ok(year >= 1960 && year <= 2000, `urbanYear(La Défense)=${year}`);
});

test("geography: urbanYear is deterministic across repeated calls", () => {
  assert.equal(
    urbanYear(LANDMARKS.chezNous.x, LANDMARKS.chezNous.z),
    urbanYear(LANDMARKS.chezNous.x, LANDMARKS.chezNous.z)
  );
  assert.equal(urbanYear(-300, -200), urbanYear(-300, -200));
  assert.equal(urbanYear(0, -900), urbanYear(0, -900));
});
