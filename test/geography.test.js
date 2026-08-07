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
  SEINE_HALF_WIDTH,
  SEINE_ISLAND_HALF_WIDTH,
  seineHalfWidthAt,
  seineIslandInfluence,
  isOnPermanentIsland,
  isOverSeineWater,
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
  // Post-v2 : Saint-Louis est passée de (35, 8) à (24 ; 11,5) — voir le test
  // suivant, qui dit *pourquoi* : à (35, 8) elle était hors de l'eau.
  assert.deepEqual(ISLANDS.saintLouis, { x: 24, z: 11.5, rx: 8, rz: 3 });
  assert.equal(ISLANDS.louviers.x, 120);
  assert.equal(ISLANDS.louviers.z, 18);
  assert.equal(ISLANDS.louviers.rx, 5);
  assert.equal(ISLANDS.louviers.rz, 2);
  assert.equal(ISLANDS.louviers.died, 1843);
});

test("geography: les deux îles permanentes sont posées SUR l'axe du fleuve (post-v2)", () => {
  // C'est l'invariant qui fait qu'une île est une île : son centre doit être
  // dans le lit, sinon aucun bras ne peut passer du côté opposé. Saint-Louis
  // était à 8,6 unités de l'axe pour une demi-largeur de lit de 7 — donc sur la
  // berge, avec un seul bras amorcé.
  for (const [name, isl] of [["cite", ISLANDS.cite], ["saintLouis", ISLANDS.saintLouis]]) {
    const d = distanceToSeine(isl.x, isl.z);
    assert.ok(d < 1.5, `${name} : centre à ${d.toFixed(2)}u de l'axe de la Seine`);
  }
});

// ============================================================================
// Largeur du fleuve — l'évasement autour des îles (post-v2)
// ============================================================================

test("geography: seineHalfWidthAt vaut la largeur standard loin des îles, la largeur d'île devant elles", () => {
  assert.equal(SEINE_HALF_WIDTH, 7);
  assert.equal(SEINE_ISLAND_HALF_WIDTH, 12);
  // Aval, loin de toute île.
  assert.equal(seineHalfWidthAt(-152, -95), SEINE_HALF_WIDTH);
  assert.equal(seineHalfWidthAt(-450, -30), SEINE_HALF_WIDTH);
  // Devant les deux îles, et sur le bief qui les sépare.
  assert.equal(seineHalfWidthAt(ISLANDS.cite.x, ISLANDS.cite.z), SEINE_ISLAND_HALF_WIDTH);
  assert.equal(seineHalfWidthAt(ISLANDS.saintLouis.x, ISLANDS.saintLouis.z), SEINE_ISLAND_HALF_WIDTH);
  assert.equal(seineHalfWidthAt(12, 5.75), SEINE_ISLAND_HALF_WIDTH);
});

test("geography: l'évasement est continu et monotone en s'éloignant de l'île", () => {
  let previous = seineIslandInfluence(ISLANDS.cite.x, ISLANDS.cite.z);
  assert.equal(previous, 1);
  // En descendant le fleuve depuis la Cité : l'influence ne remonte jamais…
  for (let s = 14; s <= 40; s += 2) {
    const x = -0.94 * s;
    const z = -0.342 * s;
    const value = seineIslandInfluence(x, z);
    assert.ok(value <= previous + 1e-9, `remontée d'influence à s=${s}`);
    assert.ok(value >= 0 && value <= 1);
    previous = value;
  }
  // …et elle est bien retombée à zéro au bout du fondu.
  assert.equal(previous, 0);
});

test("geography: un bras d'eau dégagé de chaque côté des deux îles", () => {
  // Le test du gamin, en géométrie : sur toute la longueur de chaque île, la
  // distance entre la rive et le bord de l'eau doit rester franchement positive
  // des DEUX côtés. Le bras le plus étroit mesuré ici valait 0,76 unité avant
  // le correctif (île de la Cité), pour une demi-largeur de lit de 7.
  const armWidth = (isl, tan) => {
    const len = Math.hypot(tan.x, tan.z);
    const nx = -tan.z / len;
    const nz = tan.x / len;
    let narrowest = { north: Infinity, south: Infinity };
    for (let s = -isl.rx * 1.4; s <= isl.rx * 1.4; s += 0.5) {
      const cx = isl.x + (tan.x / len) * s;
      const cz = isl.z + (tan.z / len) * s;
      for (const side of [1, -1]) {
        let shore = 0;
        for (let t = 0; t < 20; t += 0.1) {
          const px = cx + nx * side * t;
          const pz = cz + nz * side * t;
          if (isOnPermanentIsland(px, pz)) shore = t;
        }
        if (shore <= 0) continue; // cette section ne coupe pas l'île
        const arm = seineHalfWidthAt(cx, cz) - shore;
        const key = side === 1 ? "north" : "south";
        if (arm < narrowest[key]) narrowest[key] = arm;
      }
    }
    return narrowest;
  };

  const cite = armWidth(ISLANDS.cite, { x: -0.94, z: -0.342 });
  assert.ok(cite.north > 4, `bras nord de la Cité : ${cite.north.toFixed(2)}u`);
  assert.ok(cite.south > 4, `bras sud de la Cité : ${cite.south.toFixed(2)}u`);

  const stl = armWidth(ISLANDS.saintLouis, { x: -0.868, z: -0.496 });
  assert.ok(stl.north > 4, `bras nord de Saint-Louis : ${stl.north.toFixed(2)}u`);
  assert.ok(stl.south > 4, `bras sud de Saint-Louis : ${stl.south.toFixed(2)}u`);
});

test("geography: isOverSeineWater reproduit exactement l'ancienne marge de 9 loin des îles", () => {
  // Les consommateurs (bâti, foule, arbres, fenêtres éclairées) avaient tous une
  // marge absolue calée sur la demi-largeur de 7 ; ce test verrouille le fait que
  // le passage à une marge « depuis le bord de l'eau » ne change RIEN là où le
  // fleuve n'est pas élargi.
  for (const [x, z] of [[-152, -95], [-250, -160], [-450, -30], [200, 155]]) {
    const d = distanceToSeine(x, z);
    assert.equal(isOverSeineWater(x, z, 2), d < 9);
  }
  // Sur l'axe même, loin des îles : dans l'eau.
  assert.equal(isOverSeineWater(-152, -95, 2), true);
});

test("geography: la terre ferme des îles n'est jamais « dans l'eau », quelle que soit la marge", () => {
  for (const isl of [ISLANDS.cite, ISLANDS.saintLouis]) {
    assert.equal(isOnPermanentIsland(isl.x, isl.z), true);
    assert.equal(isOverSeineWater(isl.x, isl.z, 20), false);
  }
  // Notre-Dame et la Sainte-Chapelle, les deux monuments de l'île.
  assert.equal(isOverSeineWater(LANDMARKS.notreDame.x, LANDMARKS.notreDame.z, 2), false);
  assert.equal(isOverSeineWater(LANDMARKS.sainteChapelle.x, LANDMARKS.sainteChapelle.z, 2), false);
  // Louviers, elle, reste une berge ordinaire (pas d'exemption).
  assert.equal(isOnPermanentIsland(ISLANDS.louviers.x, ISLANDS.louviers.z), false);
});

test("geography: le pont au Change franchit vraiment le bras nord élargi", () => {
  // Le pont suit la normale « vers le nord » du fleuve, (0,351 ; -0,937), sur
  // BRIDGE_LEN = 15,6 unités (monumentModels.js). Ses deux extrémités doivent
  // tomber sur la terre ferme : l'île au sud, la rive droite au nord.
  const c = LANDMARKS.pontAuChange;
  const n = { x: 0.351, z: -0.937 };
  const half = 15.6 / 2;
  const south = { x: c.x - n.x * half, z: c.z - n.z * half };
  const north = { x: c.x + n.x * half, z: c.z + n.z * half };
  assert.equal(isOnPermanentIsland(south.x, south.z), true);
  assert.equal(isOverSeineWater(north.x, north.z), false);
  // …et le milieu du pont est bien au-dessus de l'eau (sinon ce n'est pas un pont).
  assert.equal(isOverSeineWater(c.x, c.z), true);
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
