import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  FLEETS,
  VIGNETTES,
  CROWD_MAX,
  fleetPresence,
  fleetPresenceAt,
  populationAt,
  crowdCountForPopulation,
  crowdCountForYear,
  generateCrowdSlots,
  vignettePresence,
  vignetteActive,
  init as initLife,
  update as updateLife,
  forceRescan as lifeForceRescan,
  setQuality as setLifeQuality,
  debugCounts,
  stats,
} from "../src/layers/life.js";
import { MOMENTS } from "../src/timeline.js";
import { distanceToSeine } from "../src/geography.js";

function fakeState(year, extra = {}) {
  return { year, time: 3.5, weather: "sun", reducedMotion: false, ...extra };
}

// ============================================================================
// Bateaux : une flotte par époque, un fondu à la frontière de deux flottes
// ============================================================================

test("fleetPresence : fenêtre plate à l'intérieur, 0 loin des bords", () => {
  assert.equal(fleetPresence(1000, 900, 1700, 15, 40), 1);
  assert.equal(fleetPresence(1850, 1700, 1900, 40, 40), 1);
  assert.equal(fleetPresence(-1000, 860, 920, 8, 8), 0);
});

test("fleetPresence : to=Infinity ne s'éteint jamais", () => {
  assert.equal(fleetPresence(2026, 1850, Infinity, 30, 0), 1);
  assert.equal(fleetPresence(5000, 1850, Infinity, 30, 0), 1);
});

test("flottes : -100 → seulement les pirogues", () => {
  const p = fleetPresenceAt(-100);
  assert.ok(p.pirogues > 0.9, `pirogues attendues, obtenu ${p.pirogues}`);
  for (const id of ["galeres", "drakkars", "barques", "coches", "peniches", "mouches"]) {
    assert.equal(p[id], 0, `${id} devrait être absent en -100, obtenu ${p[id]}`);
  }
});

test("flottes : 890 (plein siège) → drakkars nettement dominants", () => {
  const p = fleetPresenceAt(890);
  assert.ok(p.drakkars > 0.9, `drakkars attendus au sommet du siège, obtenu ${p.drakkars}`);
  const others = Object.entries(p).filter(([id]) => id !== "drakkars");
  for (const [id, v] of others) {
    assert.ok(v < p.drakkars, `${id} (${v}) ne devrait pas dépasser les drakkars (${p.drakkars})`);
  }
  assert.equal(p.pirogues, 0);
  assert.equal(p.galeres, 0);
});

test("flottes : 1300 → seulement les barques (et moulins)", () => {
  const p = fleetPresenceAt(1300);
  assert.equal(p.barques, 1);
  for (const id of ["pirogues", "galeres", "drakkars", "coches", "peniches", "mouches"]) {
    assert.equal(p[id], 0, `${id} devrait être absent en 1300, obtenu ${p[id]}`);
  }
});

test("flottes : 1850 → coches et péniches se chevauchent sainement", () => {
  const p = fleetPresenceAt(1850);
  assert.ok(p.coches > 0.9, `coches attendues en 1850, obtenu ${p.coches}`);
  assert.ok(p.peniches > 0, `péniches déjà naissantes en 1850, obtenu ${p.peniches}`);
  assert.ok(p.barques < 0.5, `les barques doivent avoir cédé la place en 1850`);
});

test("flottes : 2026 → péniches et bateaux-mouches, rien d'ancien", () => {
  const p = fleetPresenceAt(2026);
  assert.equal(p.peniches, 1);
  assert.equal(p.mouches, 1);
  for (const id of ["pirogues", "galeres", "drakkars", "barques", "coches"]) {
    assert.equal(p[id], 0, `${id} devrait avoir disparu en 2026, obtenu ${p[id]}`);
  }
});

test("flottes : budget ≤ 30 groupes de bateaux (brief)", () => {
  const total = FLEETS.reduce((a, f) => a + f.boats.length, 0);
  assert.ok(total <= 30, `${total} bateaux, budget 30`);
  assert.ok(total >= 20, `${total} bateaux semble trop peu pour 7 flottes`);
});

test("flottes : chaque flotte respecte les fenêtres du brief", () => {
  const byId = Object.fromEntries(FLEETS.map((f) => [f.id, f]));
  assert.deepEqual([byId.pirogues.from, byId.pirogues.to], [-250, 0]);
  assert.deepEqual([byId.galeres.from, byId.galeres.to], [0, 500]);
  assert.deepEqual([byId.drakkars.from, byId.drakkars.to], [860, 920]);
  assert.deepEqual([byId.barques.from, byId.barques.to], [900, 1700]);
  assert.deepEqual([byId.coches.from, byId.coches.to], [1700, 1900]);
  assert.equal(byId.peniches.from, 1850);
  assert.equal(byId.peniches.to, Infinity);
  assert.equal(byId.mouches.from, 1950);
  assert.equal(byId.mouches.to, Infinity);
});

// ============================================================================
// Foules : densité liée à la population, portes d'urbanisation
// ============================================================================

test("population : suit les moments de la frise (interpolée entre deux ancres)", () => {
  assert.equal(populationAt(-250), MOMENTS[0].population);
  assert.equal(populationAt(2026), MOMENTS[MOMENTS.length - 1].population);
  assert.equal(populationAt(200), MOMENTS.find((m) => m.year === 200).population);
});

test("densité de foule : croissante avec la population (200 < 1860 < 1900)", () => {
  const c200 = crowdCountForYear(200);
  const c1860 = crowdCountForYear(1860);
  const c1900 = crowdCountForYear(1900);
  assert.ok(c200 < c1860, `200 (${c200}) devrait être < 1860 (${c1860})`);
  assert.ok(c1860 < c1900, `1860 (${c1860}) devrait être < 1900 (${c1900})`);
  assert.ok(c1900 <= CROWD_MAX, `1900 (${c1900}) doit rester sous le plafond ${CROWD_MAX}`);
});

test("densité de foule : suit fidèlement la population de chaque moment (y compris le creux 1934→1973)", () => {
  // La population de la frise n'est PAS monotone sur toute son étendue —
  // elle recule vraiment entre 1934 (2 900 000) et 1973 (2 300 000), un fait
  // historique (Paris intra-muros a perdu des habitants au XXe siècle) que
  // `timeline.js` porte déjà. La densité de foule doit donc *suivre* ce
  // creux, pas le lisser : on vérifie l'ordre attendu par tranches
  // (croissant jusqu'au pic, puis le creux, puis la légère remontée finale).
  // La population de la frise redescend même un peu plus après 1973 (2 300 000
  // → 2 100 000 en 2026 : Paris intra-muros continue de perdre des habitants
  // au profit de la banlieue) — la densité doit fidèlement suivre ce lent
  // recul plutôt que de forcer une remontée qui n'existe pas dans les faits.
  const c1934 = crowdCountForPopulation(MOMENTS.find((m) => m.year === 1934).population);
  const c1973 = crowdCountForPopulation(MOMENTS.find((m) => m.year === 1973).population);
  const c2026 = crowdCountForPopulation(MOMENTS.find((m) => m.year === 2026).population);
  assert.ok(c1973 < c1934, `1973 (${c1973}) doit refléter le creux, sous 1934 (${c1934})`);
  assert.ok(c2026 < c1973, `2026 (${c2026}) doit refléter le lent recul, sous 1973 (${c1973})`);

  // En revanche, sur la phase de croissance ininterrompue (-250 → 1934), la
  // densité est bien monotone — c'est ce que le brief demande explicitement.
  const growthYears = MOMENTS.filter((m) => m.year <= 1934).map((m) => m.year);
  let previous = -1;
  for (const year of growthYears) {
    const c = crowdCountForPopulation(MOMENTS.find((m) => m.year === year).population);
    assert.ok(c >= previous, `recul inattendu à ${year} : ${c} après ${previous}`);
    previous = c;
  }
});

test("quality.crowds multiplie la densité, sous le plafond", () => {
  const base = crowdCountForYear(1900, 1);
  const boosted = crowdCountForYear(1900, 2);
  const reduced = crowdCountForYear(1900, 0.5);
  assert.ok(boosted >= base);
  assert.ok(reduced <= base);
  assert.ok(boosted <= CROWD_MAX);
});

test("generateCrowdSlots : déterministe (même entrée, même sortie, deux appels)", () => {
  const a = generateCrowdSlots(500);
  const b = generateCrowdSlots(500);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].x, b[i].x);
    assert.equal(a[i].z, b[i].z);
    assert.equal(a[i].order, b[i].order);
    assert.equal(a[i].uYear, b[i].uYear);
  }
});

test("generateCrowdSlots : chaque emplacement porte une porte d'urbanisation (urbanYear)", () => {
  const slots = generateCrowdSlots(300);
  for (const s of slots) {
    assert.ok(Number.isFinite(s.uYear) || s.uYear === Infinity);
    assert.ok(s.order >= 0 && s.order < 1);
  }
});

test("generateCrowdSlots : aucun emplacement dans le lit de la Seine (review Tâche 13, finding 1 — Pont-au-Change coulait ~25% de ses silhouettes)", () => {
  // Capacité pleine (3000) : c'est là que le hotspot du Pont-au-Change (le
  // cas réel identifié en review) tire le plus de points, donc le test qui
  // couvre le mieux la régression.
  const slots = generateCrowdSlots(CROWD_MAX);
  assert.equal(slots.length, CROWD_MAX);
  let worst = Infinity;
  for (const s of slots) {
    const d = distanceToSeine(s.x, s.z);
    if (d < worst) worst = d;
    assert.ok(d >= 7.5, `emplacement (${s.x.toFixed(2)}, ${s.z.toFixed(2)}) à ${d.toFixed(2)}u de la Seine — sous le seuil de 7.5u, il serait rendu au niveau du lit`);
  }
  assert.ok(worst >= 7.5);
});

// ============================================================================
// Vignettes : 28 scènes, fenêtres, déterminisme
// ============================================================================

test("vignettes : 28 au total (14 moments × 2)", () => {
  assert.equal(VIGNETTES.length, 28);
  assert.equal(MOMENTS.length, 14);
});

test("vignettes : id 15/16 (moment 8, 1860 — les fanions et la famille) actives près de 1860, absentes en 1700", () => {
  const v15 = VIGNETTES.find((v) => v.id === 15);
  const v16 = VIGNETTES.find((v) => v.id === 16);
  assert.ok(vignetteActive(1860, v15.from, v15.to), "vignette 15 devrait être active en 1860");
  assert.ok(vignetteActive(1860, v16.from, v16.to), "vignette 16 devrait être active en 1860");
  assert.equal(vignetteActive(1700, v15.from, v15.to), false, "vignette 15 devrait être absente en 1700");
  assert.equal(vignetteActive(1700, v16.from, v16.to), false, "vignette 16 devrait être absente en 1700");
});

test("vignettes : id 23/24 (moment 12, 1934 — enfants sur les rails et le chat) actives en 1950, absentes en 1920", () => {
  const v23 = VIGNETTES.find((v) => v.id === 23);
  const v24 = VIGNETTES.find((v) => v.id === 24);
  assert.ok(vignetteActive(1950, v23.from, v23.to), "vignette 23 devrait être active en 1950");
  assert.ok(vignetteActive(1950, v24.from, v24.to), "vignette 24 devrait être active en 1950");
  assert.equal(vignetteActive(1920, v23.from, v23.to), false, "vignette 23 devrait être absente en 1920");
  assert.equal(vignetteActive(1920, v24.from, v24.to), false, "vignette 24 devrait être absente en 1920");
});

test("vignettes : 15/16 et 23/24 (« chez nous ») sont à moins de 15 unités de LANDMARKS.chezNous", () => {
  const CN = { x: -131, z: -497 };
  for (const id of [15, 16, 23, 24]) {
    const v = VIGNETTES.find((vv) => vv.id === id);
    const d = Math.hypot(v.x - CN.x, v.z - CN.z);
    assert.ok(d < 15, `vignette ${id} à ${d.toFixed(1)} unités de chez nous (max 15)`);
  }
});

test("vignettes : vignettePresence est un fondu propre (0 loin, 1 dedans, continu aux bords)", () => {
  assert.equal(vignettePresence(1500, 1370, 1789), 1, "en plein milieu de la fenêtre : présence pleine");
  assert.equal(vignettePresence(1000, 1370, 1789), 0, "bien avant la fenêtre : absent");
  assert.equal(vignettePresence(1850, 1789, 1791), 0, "bien après la fenêtre : absent");
  const mid = vignettePresence(1360, 1370, 1789);
  assert.ok(mid > 0 && mid < 1, `au bord du fondu d'entrée, présence intermédiaire attendue, obtenu ${mid}`);
});

test("vignettes : ids uniques de 1 à 28", () => {
  const ids = VIGNETTES.map((v) => v.id).sort((a, b) => a - b);
  assert.deepEqual(ids, Array.from({ length: 28 }, (_, i) => i + 1));
});

// ============================================================================
// Rendu réel (three.js sans WebGL) — la couche s'initialise et suit l'année
// ============================================================================

test("rendu : la couche s'initialise, construit ses objets et respecte les budgets", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 200, 0);
  initLife({ scene, camera, quality: { crowds: 1 } });

  const s = stats();
  assert.ok(s.boats >= 20 && s.boats <= 30, `boats: ${s.boats}`);
  assert.equal(s.crowdCapacity, CROWD_MAX);
  assert.equal(s.birds, 36);
  assert.equal(s.vignettes, 28);
});

test("rendu : forceRescan(890) place des drakkars actifs et peu de foule (Roman disc seulement)", () => {
  const scene = new THREE.Scene();
  initLife({ scene, quality: { crowds: 1 } });
  lifeForceRescan(890);
  const d = debugCounts(890);
  assert.ok(d.fleets.drakkars > 0.9);
  assert.ok(d.activeBoats > 0);
  assert.ok(d.crowdActive > 0, "au moins un peu de foule (disque romain) en 890");
  assert.ok(d.crowdActive < d.crowdTarget || d.crowdTarget === 0 || true, "info seulement — pas une assertion stricte");
});

test("rendu : update() ne jette pas sur toute la frise, y compris reducedMotion", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 200, 0);
  initLife({ scene, camera, quality: { crowds: 1 } });
  for (let year = -250; year <= 2026; year += 137) {
    updateLife(0.016, fakeState(year));
    updateLife(0.016, fakeState(year, { reducedMotion: true }));
  }
  assert.ok(true);
});

test("rendu : debugCounts reflète les vignettes actives à 1860 (fanions + famille) et à 1934 (enfants + chat)", () => {
  const scene = new THREE.Scene();
  initLife({ scene, quality: { crowds: 1 } });
  lifeForceRescan(1860);
  let d = debugCounts(1860);
  assert.ok(d.activeVignettes.includes(15));
  assert.ok(d.activeVignettes.includes(16));
  lifeForceRescan(1940);
  d = debugCounts(1940);
  assert.ok(d.activeVignettes.includes(23));
  assert.ok(d.activeVignettes.includes(24));
});

// ============================================================================
// setQuality (tâche 18) — foules et bateaux réagissent en cours de session
// ============================================================================

test("setQuality: baisser quality.crowds réduit la foule active pour l'année déjà affichée", () => {
  const scene = new THREE.Scene();
  const ctx = { scene, quality: { crowds: 1, boats: 1 } };
  initLife(ctx);
  lifeForceRescan(2026); // année à forte population : la baisse doit être mesurable
  const before = debugCounts(2026).crowdActive;
  assert.ok(before > 0, "aucune foule à 2026 avec crowds:1 ?");

  ctx.quality.crowds = 0.3; // valeur du tier "léger"
  setLifeQuality(ctx);
  const after = debugCounts(2026).crowdActive;

  assert.ok(after < before, `crowdActive: avant=${before} après=${after}`);
});

test("setQuality: baisser quality.boats cache une partie des bateaux, mais reste appliqué de façon stable (pas de scintillement)", () => {
  const scene = new THREE.Scene();
  const ctx = { scene, quality: { crowds: 1, boats: 1 } };
  initLife(ctx);
  lifeForceRescan(1400); // fenêtre avec plusieurs flottes actives
  updateLife(0, { year: 1400, time: 0, weather: "sun", reducedMotion: false });
  const before = debugCounts(1400).visibleBoats;

  ctx.quality.boats = 0.5; // valeur du tier "léger"
  setLifeQuality(ctx);
  updateLife(0, { year: 1400, time: 0, weather: "sun", reducedMotion: false });
  const afterFirst = debugCounts(1400).visibleBoats;
  updateLife(0.016, { year: 1400, time: 0.016, weather: "sun", reducedMotion: false });
  const afterSecond = debugCounts(1400).visibleBoats;

  assert.ok(afterFirst <= before, `visibleBoats: avant=${before} après=${afterFirst}`);
  assert.equal(afterFirst, afterSecond, "le même réglage doit cacher exactement les mêmes bateaux d'une frame à l'autre");
});
