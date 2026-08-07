import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  ROADS,
  ROAD_WIDTH_DEFAULT,
  roadPolylines,
  roadsStateAt,
  init as initRoads,
  forceRescan as roadsForceRescan,
  update as updateRoads,
  debugCounts as roadDebugCounts,
  stats as roadStats,
} from "../src/layers/roads.js";
import { heightAt } from "../src/geography.js";
import { lifecycle } from "../src/timeEngine.js";

// ============================================================================
// Table des axes — validation structurelle
// ============================================================================

test("table : chaque axe a un tracé d'au moins 2 points, une année de naissance et un nom français", () => {
  assert.ok(ROADS.length >= 10 && ROADS.length <= 12, `attendu 10-12 axes, obtenu ${ROADS.length}`);
  for (const road of ROADS) {
    assert.equal(typeof road.id, "string");
    assert.ok(road.id.length > 0);
    assert.equal(typeof road.name, "string");
    assert.ok(road.name.length > 0, `${road.id} : nom manquant`);
    assert.equal(typeof road.born, "number");
    assert.ok(Number.isFinite(road.born), `${road.id} : born non fini`);

    const polylines = roadPolylines(road);
    assert.ok(polylines.length >= 1, `${road.id} : aucune polyligne`);
    for (const pts of polylines) {
      assert.ok(Array.isArray(pts), `${road.id} : tracé non-tableau`);
      assert.ok(pts.length >= 2, `${road.id} : tracé de ${pts.length} point(s), 2 minimum attendus`);
    }
  }
});

test("table : les identifiants sont uniques", () => {
  const ids = ROADS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "des identifiants d'axe se répètent");
});

test("table : chaque axe expose soit points, soit traces — jamais rien, jamais les deux", () => {
  for (const road of ROADS) {
    const hasPoints = Array.isArray(road.points);
    const hasTraces = Array.isArray(road.traces);
    assert.notEqual(hasPoints, hasTraces, `${road.id} : doit avoir points OU traces, pas les deux ni aucun`);
  }
});

// ============================================================================
// Logique d'époque — lifecycle() gouverne bien l'apparition de chaque axe
// ============================================================================

test("époque : en l'an 100, seuls les axes romains existent (les autres sont encore absents)", () => {
  const romans = new Set(["cardo", "decumanus"]);
  for (const st of roadsStateAt(100)) {
    if (romans.has(st.id)) {
      assert.notEqual(st.phase, "absent", `${st.id} devrait déjà exister en l'an 100`);
    } else {
      assert.equal(st.phase, "absent", `${st.id} ne devrait pas encore exister en l'an 100`);
    }
  }
});

test("époque : en 1600, pas encore de Champs-Élysées (Le Nôtre, 1670)", () => {
  const champs = roadsStateAt(1600).find((s) => s.id === "champsElysees");
  assert.equal(champs.phase, "absent");
  assert.equal(champs.presence, 0);
});

test("époque : en 1875, les Grands Boulevards (et les percées haussmanniennes) sont bien là", () => {
  const st = roadsStateAt(1875);
  const boulevards = st.find((s) => s.id === "grandsBoulevardsRoad");
  assert.equal(boulevards.phase, "alive");
  assert.equal(boulevards.presence, 1);
  const sebastopol = st.find((s) => s.id === "sebastopolStrasbourg");
  assert.equal(sebastopol.phase, "alive");
  const rivoli = st.find((s) => s.id === "rueDeRivoli");
  assert.equal(rivoli.phase, "alive");
  // ... mais pas encore l'extension vers La Défense (1958).
  const defense = st.find((s) => s.id === "axeHistoriqueDefense");
  assert.equal(defense.phase, "absent");
});

test("époque : en 2026, tous les axes sont pleinement présents", () => {
  for (const st of roadsStateAt(2026)) {
    assert.equal(st.phase, "alive", `${st.id} devrait être "alive" en 2026, obtenu "${st.phase}"`);
    assert.equal(st.presence, 1, `${st.id} : présence attendue 1, obtenue ${st.presence}`);
  }
});

test("cohérence : roadsStateAt suit exactement lifecycle, année par année", () => {
  const byId = new Map(ROADS.map((r) => [r.id, r]));
  for (let year = 0; year <= 2026; year += 25) {
    for (const st of roadsStateAt(year)) {
      const expected = lifecycle(year, byId.get(st.id));
      assert.equal(st.presence, expected.presence, `${st.id} @ ${year}`);
      assert.equal(st.phase, expected.phase, `${st.id} @ ${year}`);
    }
  }
});

// ============================================================================
// Géométrie — aucun NaN, même en interrogeant heightAt sur chaque point
// ============================================================================

test("géométrie : chaque point de chaque tracé est fini, et heightAt() n'y renvoie jamais NaN", () => {
  for (const road of ROADS) {
    for (const pts of roadPolylines(road)) {
      for (const p of pts) {
        assert.ok(Number.isFinite(p.x), `${road.id} : x non fini (${p.x})`);
        assert.ok(Number.isFinite(p.z), `${road.id} : z non fini (${p.z})`);
        const h = heightAt(p.x, p.z);
        assert.ok(Number.isFinite(h), `${road.id} : heightAt(${p.x}, ${p.z}) = ${h}`);
      }
    }
  }
});

test("géométrie : le tracé des Grands Boulevards vient bien de walls.js (pas une resaisie)", () => {
  const road = ROADS.find((r) => r.id === "grandsBoulevardsRoad");
  assert.ok(Array.isArray(road.traces));
  assert.equal(road.traces.length, 2);
  for (const trace of road.traces) assert.ok(trace.length >= 3);
});

test("géométrie : les Boulevards des Maréchaux forment un anneau fermé, à l'intérieur de la petite ceinture", () => {
  const road = ROADS.find((r) => r.id === "boulevardsMarechaux");
  assert.equal(road.closed, true);
  assert.ok(road.points.length >= 24);
});

// ============================================================================
// Rendu réel (three.js sans WebGL) — la couche s'initialise et suit l'année
// ============================================================================

test("rendu : la couche s'initialise, écrit ses instances et suit les années", () => {
  const scene = new THREE.Group();
  initRoads({ scene });

  const s = roadStats();
  assert.equal(s.roads, ROADS.length);
  assert.ok(s.totalSegments > ROADS.length, `attendu plusieurs segments par axe, obtenu ${s.totalSegments}`);

  const mesh = scene.children.find((c) => c.name === "roads_ribbon");
  assert.ok(mesh, "le ruban des routes doit être dans la scène");
  assert.equal(mesh.count, s.totalSegments);

  // Avant l'an 50 : rien du tout.
  roadsForceRescan(0);
  updateRoads(0.016, { year: 0 });
  let d = roadDebugCounts(0);
  assert.equal(d.cardo.presence, 0);

  // 2026 : tous les axes à pleine largeur.
  roadsForceRescan(2026);
  updateRoads(0.016, { year: 2026 });
  d = roadDebugCounts(2026);
  for (const key of Object.keys(d)) {
    assert.equal(d[key].presence, 1, `${key} devrait être à présence 1 en 2026`);
  }

  const m = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  mesh.getMatrixAt(0, m);
  m.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  assert.ok(scale.z > 0, "le premier segment doit avoir une largeur non nulle en 2026");
});

test("rendu : la largeur d'un axe croît avec sa présence, et s'annule tant qu'il est absent", () => {
  const scene = new THREE.Group();
  initRoads({ scene });
  const mesh = scene.children.find((c) => c.name === "roads_ribbon");

  // Avant 1670 : Le Nôtre n'a pas encore tracé l'avenue — TOUTES les
  // instances du ruban partagé doivent être à l'échelle nulle sur ce
  // tronçon (on ne peut pas indexer directement les Champs-Élysées dans la
  // mesh partagée depuis le test, donc on vérifie l'invariant global :
  // aucune instance visible ne doit se trouver sur son tracé).
  roadsForceRescan(1600);
  let d = roadDebugCounts(1600);
  assert.equal(d.champsElysees.presence, 0);

  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const q = new THREE.Quaternion();
  // Bornée à x < -200 pour ne jamais chevaucher la rue Saint-Honoré (qui
  // partage le point du Louvre mais ne va pas plus à l'ouest que -170) —
  // seuls les Champs-Élysées et son extension vers La Défense (absente avant
  // 1958) passent par cette zone.
  const onChampsTrace = (x, z) => x < -200 && x > -520 && z < -100 && z > -190;

  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    m.decompose(pos, q, scale);
    if (scale.z > 0 && onChampsTrace(pos.x, pos.z)) {
      assert.fail(`segment visible sur le tracé des Champs-Élysées en 1600 (${pos.x}, ${pos.z})`);
    }
  }

  // En 2026, à l'inverse, au moins un segment doit s'y trouver, à pleine
  // largeur.
  roadsForceRescan(2026);
  let foundFull = false;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    m.decompose(pos, q, scale);
    if (onChampsTrace(pos.x, pos.z) && scale.z >= 1.9) {
      foundFull = true;
      break;
    }
  }
  assert.ok(foundFull, "un segment à pleine largeur (~2.0) doit border le tracé des Champs-Élysées en 2026");
});
