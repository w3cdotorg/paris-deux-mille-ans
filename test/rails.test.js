import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  PETITE_CEINTURE,
  PERIPHERIQUE,
  VIADUC,
  VEGETATION,
  TRAIN_WINDOW,
  TRAIN_COUNT,
  TRAINS_PER_DIRECTION,
  CAR_COUNT,
  CAR_LANES,
  METRO_BLUE_FROM,
  railsStateAt,
  ringPoint,
  ringYaw,
  ringPerimeter,
  viaductPoint,
  viaductLength,
  shuttleAt,
  vegetationPlan,
  init as initRails,
  forceRescan as railsForceRescan,
  update as updateRails,
  debugCounts as railDebugCounts,
  stats as railStats,
} from "../src/layers/rails.js";
import { RINGS, LANDMARKS, distanceToRing, insideRailCorridor, heightAt } from "../src/geography.js";
import { lifecycle } from "../src/timeEngine.js";

// ============================================================================
// Dates — la configuration réelle, pas des constantes recopiées
// ============================================================================

test("configuration : les dates du brief sont bien celles du code", () => {
  assert.equal(PETITE_CEINTURE.born, 1852);
  assert.equal(PETITE_CEINTURE.buildYears, 17); // bouclage en 1869
  assert.equal(PETITE_CEINTURE.died, undefined, "les rails ne sont jamais enlevés");
  assert.deepEqual(TRAIN_WINDOW, { from: 1869, to: 1934 });
  assert.equal(VEGETATION.born, 1940);
  assert.equal(VEGETATION.buildYears, 60);
  assert.equal(PERIPHERIQUE.born, 1958);
  assert.equal(PERIPHERIQUE.buildYears, 15); // bouclage en 1973
  assert.equal(VIADUC.born, 1903);
  assert.equal(VIADUC.buildYears, 2);
  // Le bouclage de la petite ceinture et la mise en service des trains sont le
  // même événement — c'est ce qui fait que l'anneau « s'allume » d'un coup.
  assert.equal(PETITE_CEINTURE.born + PETITE_CEINTURE.buildYears, TRAIN_WINDOW.from);
});

// ============================================================================
// Petite ceinture — le cycle de vie complet demandé par le brief
// ============================================================================

test("petite ceinture : en 1850, rien du tout", () => {
  const st = railsStateAt(1850);
  assert.equal(st.petiteCeinture.presence, 0);
  assert.equal(st.petiteCeinture.phase, "absent");
  assert.equal(st.trains.active, false);
  assert.equal(st.vegetation.presence, 0);
});

test("petite ceinture : en 1860, l'anneau est à moitié refermé et aucun train ne roule", () => {
  const st = railsStateAt(1860);
  assert.equal(st.petiteCeinture.phase, "building");
  assert.ok(st.petiteCeinture.presence > 0.4 && st.petiteCeinture.presence < 0.6);
  assert.equal(st.trains.active, false, "pas de train avant le bouclage de 1869");
});

test("petite ceinture : en 1875, anneau complet et les trains à vapeur circulent", () => {
  const st = railsStateAt(1875);
  assert.equal(st.petiteCeinture.presence, 1);
  assert.equal(st.petiteCeinture.phase, "alive");
  assert.equal(st.trains.active, true);
  assert.equal(st.trains.count, TRAIN_COUNT);
  // 12 trains, 6 par sens : voir la note de TRAIN_COUNT — 3 trains sur un
  // anneau de 30 km seraient invisibles depuis la vue « chez nous ».
  assert.equal(st.trains.count, 12);
  assert.equal(TRAINS_PER_DIRECTION, 6);
  assert.equal(st.vegetation.presence, 0, "pas encore de broussailles : les trains passent");
});

test("petite ceinture : la fenêtre des trains est bien 1869-1934, bornes comprises/exclues", () => {
  assert.equal(railsStateAt(1868.9).trains.active, false);
  assert.equal(railsStateAt(1869).trains.active, true);
  assert.equal(railsStateAt(1933.9).trains.active, true);
  assert.equal(railsStateAt(1934).trains.active, false);
});

test("petite ceinture : en 1950, plus aucun train, les rails ternissent et la végétation démarre", () => {
  const st = railsStateAt(1950);
  assert.equal(st.petiteCeinture.presence, 1, "les rails restent");
  assert.equal(st.trains.active, false);
  assert.ok(st.railsRust > 0.7, `rouille attendue avancée, obtenue ${st.railsRust}`);
  assert.ok(
    st.vegetation.presence > 0.1 && st.vegetation.presence < 0.25,
    `végétation attendue naissante, obtenue ${st.vegetation.presence}`
  );
});

test("petite ceinture : en 2026, la coulée verte est complète — rails toujours là, végétation à fond", () => {
  const st = railsStateAt(2026);
  assert.equal(st.petiteCeinture.presence, 1);
  assert.equal(st.trains.active, false);
  assert.equal(st.vegetation.presence, 1);
  assert.equal(st.railsRust, 1);
});

test("petite ceinture : la végétation croît de façon monotone de 1940 à 2000", () => {
  let previous = -1;
  for (let year = 1935; year <= 2026; year += 5) {
    const v = railsStateAt(year).vegetation.presence;
    assert.ok(v >= previous, `la végétation recule entre ${year - 5} et ${year}`);
    previous = v;
  }
  assert.equal(railsStateAt(1999).vegetation.presence < 1, true);
  assert.equal(railsStateAt(2000).vegetation.presence, 1);
});

// ============================================================================
// Périphérique
// ============================================================================

test("périphérique : en 1950, rien ; en 1965, il se coule ; en 1975, il est bouclé et les voitures roulent", () => {
  assert.equal(railsStateAt(1950).peripherique.presence, 0);
  assert.equal(railsStateAt(1950).peripherique.cars, 0);

  const mid = railsStateAt(1965).peripherique;
  assert.equal(mid.phase, "building");
  assert.ok(mid.presence > 0.4 && mid.presence < 0.55);
  assert.ok(mid.cars > 0 && mid.cars < CAR_COUNT, "le flux ne remplit que la partie construite");

  const full = railsStateAt(1975).peripherique;
  assert.equal(full.presence, 1);
  assert.equal(full.phase, "alive");
  assert.equal(full.cars, CAR_COUNT);
  assert.equal(full.cars, 640);
});

test("périphérique : bouclé en 1973, l'année où il encercle le quartier", () => {
  assert.ok(railsStateAt(1972.9).peripherique.presence < 1);
  assert.equal(railsStateAt(1973).peripherique.presence, 1);
});

test("périphérique : 4 files, deux dans chaque sens, encadrant le terre-plein", () => {
  assert.equal(CAR_LANES.length, 4);
  const negatives = CAR_LANES.filter((o) => o < 0);
  const positives = CAR_LANES.filter((o) => o > 0);
  assert.equal(negatives.length, 2);
  assert.equal(positives.length, 2);
  // Aucune file dans le terre-plein central.
  for (const o of CAR_LANES) assert.ok(Math.abs(o) > PERIPHERIQUE.laneGap / 2);
});

// ============================================================================
// Viaduc de Barbès
// ============================================================================

test("viaduc : absent en 1900, debout en 1910, avec une rame qui circule", () => {
  const before = railsStateAt(1900).viaduc;
  assert.equal(before.presence, 0);
  assert.equal(before.metro, false);

  const after = railsStateAt(1910).viaduc;
  assert.equal(after.presence, 1);
  assert.equal(after.phase, "alive");
  assert.equal(after.metro, true);
});

test("viaduc : en 1904 il est encore en chantier, donc pas de rame", () => {
  const st = railsStateAt(1904).viaduc;
  assert.equal(st.phase, "building");
  assert.ok(st.presence > 0 && st.presence < 1);
  assert.equal(st.metro, false, "aucune rame avant la dernière travée");
});

test("viaduc : sa géométrie relie bien les deux points du brief", () => {
  assert.deepEqual(VIADUC.a, { x: -20, z: -338 });
  assert.deepEqual(VIADUC.b, { x: 120, z: -348 });
  const a = viaductPoint(VIADUC, 0);
  const b = viaductPoint(VIADUC, 1);
  assert.deepEqual(a, VIADUC.a);
  assert.deepEqual(b, VIADUC.b);
  const mid = viaductPoint(VIADUC, 0.5);
  assert.equal(mid.x, 50);
  assert.equal(mid.z, -343);
  assert.ok(Math.abs(viaductLength(VIADUC) - Math.hypot(140, 10)) < 1e-9);
});

test("navette : le va-et-vient reste dans [0,1] et change de sens aux extrémités", () => {
  assert.deepEqual(shuttleAt(0), { t: 0, dir: 1 });
  assert.deepEqual(shuttleAt(0.5), { t: 0.5, dir: 1 });
  assert.deepEqual(shuttleAt(1), { t: 1, dir: 1 });
  assert.deepEqual(shuttleAt(1.5), { t: 0.5, dir: -1 });
  assert.deepEqual(shuttleAt(2), { t: 0, dir: 1 });
  for (let u = -3; u <= 6; u += 0.13) {
    const s = shuttleAt(u);
    assert.ok(s.t >= 0 && s.t <= 1, `t hors bornes pour u=${u} : ${s.t}`);
    assert.ok(s.dir === 1 || s.dir === -1);
  }
});

// ============================================================================
// Géométrie des anneaux
// ============================================================================

test("anneaux : ringPoint reste sur l'ellipse, ringYaw suit la tangente", () => {
  for (const ring of [RINGS.petiteCeinture, RINGS.peripherique]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const p = ringPoint(ring, a);
      const dx = (p.x - ring.cx) / ring.rx;
      const dz = (p.z - ring.cz) / ring.rz;
      assert.ok(Math.abs(dx * dx + dz * dz - 1) < 1e-9, "point hors ellipse");
      // La tangente numérique doit coïncider avec le lacet annoncé.
      const eps = 1e-4;
      const q = ringPoint(ring, a + eps);
      const expected = Math.atan2(-(q.z - p.z), q.x - p.x);
      const got = ringYaw(ring, a);
      const diff = Math.abs(Math.atan2(Math.sin(got - expected), Math.cos(got - expected)));
      assert.ok(diff < 1e-3, `lacet ${got} vs tangente ${expected} à a=${a}`);
    }
    // Sens inverse : exactement l'opposé.
    const f = ringYaw(ring, 1.1, 1);
    const b = ringYaw(ring, 1.1, -1);
    const delta = Math.abs(Math.atan2(Math.sin(b - f - Math.PI), Math.cos(b - f - Math.PI)));
    assert.ok(delta < 1e-9, "le sens inverse doit être à 180°");
  }
});

test("anneaux : le périmètre approché est cohérent avec un échantillonnage fin", () => {
  for (const ring of [RINGS.petiteCeinture, RINGS.peripherique]) {
    let sampled = 0;
    const N = 20000;
    let prev = ringPoint(ring, 0);
    for (let i = 1; i <= N; i++) {
      const p = ringPoint(ring, (i / N) * Math.PI * 2);
      sampled += Math.hypot(p.x - prev.x, p.z - prev.z);
      prev = p;
    }
    const approx = ringPerimeter(ring);
    assert.ok(
      Math.abs(approx - sampled) / sampled < 1e-4,
      `périmètre ${approx} vs ${sampled} (écart relatif trop grand)`
    );
  }
});

test("végétation : le plan est déterministe et son ordre d'apparition est brassé", () => {
  const a = vegetationPlan(50);
  const b = vegetationPlan(50);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // Les 10 premières touffes ne doivent pas être les 10 premières à pousser :
  // sinon la coulée verte balaierait l'anneau au lieu d'apparaître par taches.
  const firstTen = a.slice(0, 10).map((v) => v.order);
  assert.ok(Math.max(...firstTen) > 0.5, "l'ordre d'apparition n'est pas brassé");
});

// ============================================================================
// Chez nous : la maison est BIEN entre les deux anneaux
// ============================================================================

test("chez nous : la petite ceinture passe au sud, le périphérique au nord", () => {
  const home = LANDMARKS.chezNous;
  // Arc nord des deux ellipses à l'abscisse de la maison.
  const zPC = RINGS.petiteCeinture.cz - RINGS.petiteCeinture.rz * Math.sqrt(1 - ((home.x - RINGS.petiteCeinture.cx) / RINGS.petiteCeinture.rx) ** 2);
  const zPeri = RINGS.peripherique.cz - RINGS.peripherique.rz * Math.sqrt(1 - ((home.x - RINGS.peripherique.cx) / RINGS.peripherique.rx) ** 2);
  // z croît vers le sud : le périph est au nord (z plus petit), la PC au sud.
  assert.ok(zPeri < home.z, `le périphérique (${zPeri}) doit être au nord de la maison (${home.z})`);
  assert.ok(zPC > home.z, `la petite ceinture (${zPC}) doit être au sud de la maison (${home.z})`);
  // Et elle passe *tout près* : au bout de la rue, pas à l'autre bout du 18e.
  assert.ok(Math.abs(zPC - home.z) < 4, `la petite ceinture est à ${Math.abs(zPC - home.z)} unités`);
});

test("chez nous : la maison n'est pas dans le couloir des anneaux (elle n'est pas rasée)", () => {
  const home = LANDMARKS.chezNous;
  assert.equal(insideRailCorridor(home.x, home.z), false);
  // ... mais un pas au sud, si : les rails frôlent vraiment le pâté de maisons.
  assert.equal(insideRailCorridor(home.x, home.z + 2.1), true);
  assert.ok(distanceToRing(home.x, home.z, RINGS.petiteCeinture) < 3);
  assert.ok(distanceToRing(home.x, home.z, RINGS.peripherique) > 10);
});

test("couloirs : un point du centre de Paris n'est dans aucun couloir", () => {
  assert.equal(insideRailCorridor(0, 0), false);
  assert.equal(insideRailCorridor(-90, -84), false); // le Louvre
  // Un point pris exactement sur chaque ellipse, lui, y est.
  for (const ring of [RINGS.petiteCeinture, RINGS.peripherique]) {
    const p = ringPoint(ring, 0.7);
    assert.equal(insideRailCorridor(p.x, p.z), true);
    assert.ok(distanceToRing(p.x, p.z, ring) < 1e-6);
  }
});

// ============================================================================
// Rendu réel (three.js sans WebGL) — les instances suivent bien l'année
// ============================================================================

function fakeState(year, extra = {}) {
  return { year, time: 3.5, weather: "sun", reducedMotion: false, ...extra };
}

test("rendu : la couche s'initialise, écrit ses instances et suit les années", () => {
  const scene = new THREE.Group();
  initRails({ scene });

  const s = railStats();
  assert.ok(s.pcEmbankment > 100, `remblai : ${s.pcEmbankment} segments`);
  assert.equal(s.pcRails, s.pcEmbankment * 2, "deux files de rails par segment");
  assert.equal(s.cars, CAR_COUNT);
  assert.equal(s.headlights, CAR_COUNT);
  assert.equal(s.trainCars, TRAIN_COUNT * 4);
  assert.equal(s.trainCars, 48);

  // 1850 : rien de posé sur les deux anneaux.
  railsForceRescan(1850);
  let d = railDebugCounts(1850);
  assert.equal(d.petiteCeinture.segments, 0);
  assert.equal(d.peripherique.segments, 0);
  assert.equal(d.viaduc.presence, 0);

  // 1860 : l'anneau se referme — une partie seulement des segments est posée.
  railsForceRescan(1860);
  d = railDebugCounts(1860);
  assert.ok(
    d.petiteCeinture.segments > 0 && d.petiteCeinture.segments < d.petiteCeinture.totalSegments,
    `segments posés en 1860 : ${d.petiteCeinture.segments}/${d.petiteCeinture.totalSegments}`
  );

  // 1875 : anneau complet, trains visibles après un update.
  railsForceRescan(1875);
  updateRails(0.016, fakeState(1875));
  d = railDebugCounts(1875);
  assert.equal(d.petiteCeinture.segments, d.petiteCeinture.totalSegments);
  assert.equal(d.trains.active, true);
  assert.equal(d.trains.visible, true);
  assert.equal(d.vegetation.visible, 0);
  assert.equal(d.peripherique.carsVisible, false);

  // 1950 : trains partis, broussailles en place, rails rouillés.
  railsForceRescan(1950);
  updateRails(0.016, fakeState(1950));
  d = railDebugCounts(1950);
  assert.equal(d.trains.visible, false);
  assert.ok(d.vegetation.visible > 0, "des broussailles doivent être visibles en 1950");
  assert.ok(d.petiteCeinture.rust > 0.7);

  // 1975 : périph bouclé, voitures visibles, phares éteints (il fait jour).
  railsForceRescan(1975);
  updateRails(0.016, fakeState(1975));
  d = railDebugCounts(1975);
  assert.equal(d.peripherique.segments, 128);
  assert.equal(d.peripherique.cars, CAR_COUNT);
  assert.equal(d.peripherique.carsVisible, true);
  assert.equal(d.peripherique.headlights, false);

  // ... et allumés la nuit.
  updateRails(0.016, fakeState(1975, { weather: "night" }));
  assert.equal(railDebugCounts(1975).peripherique.headlights, true);

  // 2026 : coulée verte complète.
  railsForceRescan(2026);
  updateRails(0.016, fakeState(2026));
  d = railDebugCounts(2026);
  assert.equal(d.vegetation.presence, 1);
  assert.equal(d.vegetation.visible, 900);
  assert.equal(d.trains.visible, false);
});

test("rendu : la rame du viaduc est verte avant 1970 et bleue après", () => {
  const scene = new THREE.Group();
  initRails({ scene });

  railsForceRescan(1910);
  updateRails(0.016, fakeState(1910));
  let d = railDebugCounts(1910);
  assert.equal(d.viaduc.metroVisible, true);
  assert.equal(d.viaduc.metroColor, "#2f6b4a", "rame verte (Sprague) avant 1970");

  railsForceRescan(1990);
  updateRails(0.016, fakeState(1990));
  d = railDebugCounts(1990);
  assert.equal(d.viaduc.metroVisible, true);
  assert.equal(d.viaduc.metroColor, "#2b4f88", "rame bleue après 1970");
  assert.ok(METRO_BLUE_FROM === 1970);

  railsForceRescan(1900);
  updateRails(0.016, fakeState(1900));
  assert.equal(railDebugCounts(1900).viaduc.metroVisible, false);
});

test("rendu : les trains bougent avec le temps, et sont figés sous reducedMotion", () => {
  const scene = new THREE.Group();
  initRails({ scene });
  railsForceRescan(1900);

  const bodies = scene.children.find((c) => c.name === "pc_train_bodies");
  assert.ok(bodies, "les caisses de train doivent être dans la scène");
  const read = () => {
    const m = new THREE.Matrix4();
    bodies.getMatrixAt(0, m);
    return new THREE.Vector3().setFromMatrixPosition(m);
  };

  updateRails(0.016, fakeState(1900, { time: 0 }));
  const p0 = read();
  updateRails(0.016, fakeState(1900, { time: 12 }));
  const p1 = read();
  assert.ok(p0.distanceTo(p1) > 1, `la locomotive doit avancer (a bougé de ${p0.distanceTo(p1)})`);

  // reducedMotion : la position ne dépend plus du temps.
  updateRails(0.016, fakeState(1900, { time: 30, reducedMotion: true }));
  const r0 = read();
  updateRails(0.016, fakeState(1900, { time: 90, reducedMotion: true }));
  const r1 = read();
  assert.ok(r0.distanceTo(r1) < 1e-9, "sous reducedMotion, aucun mouvement");
  assert.equal(railDebugCounts(1900).trains.smoke, 0, "aucune fumée sous reducedMotion");
});

test("rendu : les voitures roulent dans les deux sens, de part et d'autre du terre-plein", () => {
  const scene = new THREE.Group();
  initRails({ scene });
  railsForceRescan(1990);
  updateRails(0.016, fakeState(1990, { time: 0 }));

  const cars = scene.children.find((c) => c.name === "peri_cars");
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const ring = RINGS.peripherique;
  let inner = 0;
  let outer = 0;
  for (let i = 0; i < 8; i++) {
    cars.getMatrixAt(i, m);
    pos.setFromMatrixPosition(m);
    // Rayon normalisé : < 1 = côté intérieur de l'ellipse, > 1 = extérieur.
    const k = Math.hypot((pos.x - ring.cx) / ring.rx, (pos.z - ring.cz) / ring.rz);
    if (k < 1) inner++;
    else outer++;
  }
  assert.ok(inner > 0 && outer > 0, `files attendues des deux côtés (int ${inner}, ext ${outer})`);

  // Et le flux avance.
  cars.getMatrixAt(0, m);
  const before = new THREE.Vector3().setFromMatrixPosition(m);
  updateRails(0.016, fakeState(1990, { time: 20 }));
  cars.getMatrixAt(0, m);
  const after = new THREE.Vector3().setFromMatrixPosition(m);
  assert.ok(before.distanceTo(after) > 1, "les voitures doivent avancer");
});

test("rendu : le tablier du viaduc suit le relief (il ne traverse pas la butte)", () => {
  const scene = new THREE.Group();
  initRails({ scene });
  railsForceRescan(1930);

  const deck = scene.children.find((c) => c.name === "viaduc_deck");
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  for (let i = 0; i < VIADUC.spans; i++) {
    deck.getMatrixAt(i, m);
    pos.setFromMatrixPosition(m);
    // Toutes les travées doivent être *au-dessus* du sol qu'elles franchissent,
    // et pas plus haut qu'un immeuble : le tablier épouse la pente.
    // Le terrain n'est pas maillé dans ce contexte : `groundHeightAt` retombe
    // sur `geography.heightAt`, qu'on interroge donc directement ici.
    const groundHere = heightAt(pos.x, pos.z);
    assert.ok(pos.y - groundHere > 0.5, `travée ${i} trop basse (${pos.y} vs sol ${groundHere})`);
    assert.ok(pos.y - groundHere < 2.5, `travée ${i} trop haute (${pos.y} vs sol ${groundHere})`);
  }
});

// ============================================================================
// Cohérence avec lifecycle sur toute la frise (aucune fenêtre incohérente)
// ============================================================================

test("cohérence : railsStateAt suit exactement lifecycle, année par année", () => {
  for (let year = 1800; year <= 2026; year += 1) {
    const st = railsStateAt(year);
    assert.equal(st.petiteCeinture.presence, lifecycle(year, PETITE_CEINTURE).presence);
    assert.equal(st.peripherique.presence, lifecycle(year, PERIPHERIQUE).presence);
    assert.equal(st.viaduc.presence, lifecycle(year, VIADUC).presence);
    assert.equal(st.vegetation.presence, lifecycle(year, VEGETATION).presence);
    // Un train ne peut jamais rouler sur un anneau incomplet.
    if (st.trains.active) assert.equal(st.petiteCeinture.presence, 1);
    // Une rame ne peut jamais rouler sur un viaduc incomplet.
    if (st.viaduc.metro) assert.equal(st.viaduc.presence, 1);
    // Et il n'y a jamais de voiture avant 1958.
    if (year < PERIPHERIQUE.born) assert.equal(st.peripherique.cars, 0);
  }
});

test("rendu : les 12 trains se répartissent sur les deux voies, en sens inverse", () => {
  const scene = new THREE.Group();
  initRails({ scene });
  railsForceRescan(1900);
  updateRails(0.016, fakeState(1900, { time: 0 }));

  const bodies = scene.children.find((c) => c.name === "pc_train_bodies");
  const ring = RINGS.petiteCeinture;
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  let onOuter = 0;
  let onInner = 0;
  for (let t = 0; t < TRAIN_COUNT; t++) {
    // La locomotive de chaque train (indice 0 de la rame).
    bodies.getMatrixAt(t * 4, m);
    pos.setFromMatrixPosition(m);
    const k = Math.hypot((pos.x - ring.cx) / ring.rx, (pos.z - ring.cz) / ring.rz);
    if (k > 1) onOuter++;
    else onInner++;
  }
  assert.equal(onOuter, TRAINS_PER_DIRECTION, "6 trains sur la voie extérieure");
  assert.equal(onInner, TRAINS_PER_DIRECTION, "6 trains sur la voie intérieure");

  // Les deux sens : un train de chaque groupe, comparés à 1 s d'intervalle,
  // doivent tourner en sens opposés (angle croissant / décroissant).
  const angleOf = (index) => {
    bodies.getMatrixAt(index * 4, m);
    pos.setFromMatrixPosition(m);
    return Math.atan2((pos.z - ring.cz) / ring.rz, (pos.x - ring.cx) / ring.rx);
  };
  const a0 = angleOf(0);
  const b0 = angleOf(TRAINS_PER_DIRECTION);
  updateRails(0.016, fakeState(1900, { time: 1 }));
  const wrap = (d) => Math.atan2(Math.sin(d), Math.cos(d));
  const da = wrap(angleOf(0) - a0);
  const db = wrap(angleOf(TRAINS_PER_DIRECTION) - b0);
  assert.ok(da > 0, `le 1er groupe doit tourner dans le sens croissant (${da})`);
  assert.ok(db < 0, `le 2e groupe doit tourner à contresens (${db})`);
});

test("couloirs : le viaduc de Barbès tient aussi son couloir libre de bâti", () => {
  // Un point au milieu du viaduc y est, un point à 5 unités de côté non.
  const mid = viaductPoint(VIADUC, 0.5);
  assert.equal(insideRailCorridor(mid.x, mid.z), true);
  assert.equal(insideRailCorridor(mid.x, mid.z + 6), false);
  // ... et le couloir s'arrête aux extrémités du viaduc.
  assert.equal(insideRailCorridor(VIADUC.a.x - 6, VIADUC.a.z), false);
  assert.equal(insideRailCorridor(VIADUC.b.x + 6, VIADUC.b.z), false);
});
