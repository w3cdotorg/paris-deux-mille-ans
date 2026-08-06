/**
 * Walls layer — les 4 enceintes de Paris qui s'assemblent puis s'effondrent.
 *
 * Pédagogiquement, c'est l'une des pièces les plus importantes de toute la
 * scène : chaque enceinte rend visible la croissance de la ville d'un coup
 * d'oeil depuis la vue aérienne. Hauteurs/épaisseurs volontairement
 * généreuses au-delà de la stricte échelle (lecture "maquette de village"),
 * comme demandé par le brief.
 *
 * ============================================================================
 * Géométrie pure (exportée, testable sous `node --test`, aucune dépendance
 * three.js) :
 *
 *  - `wallRingPlan(points, opts)` : construit le plan d'une enceinte —
 *    segments de courtine (portions de polyligne, moins les portes et les
 *    franchissements de fleuve) + positions de tours, tous indexés par
 *    distance cumulée le long du périmètre depuis `points[0]`. C'est cette
 *    coordonnée "distance le long du périmètre" que lit `segmentPresence`
 *    pour produire l'effet "pierre par pierre".
 *  - `segmentPresence(distStart, distEnd, totalLength, overallPresence)` :
 *    la vague de construction/démolition. `overallPresence` vient de
 *    `timeEngine.lifecycle` (0->1 à la construction, 1->0 à la démolition) ;
 *    cette fonction traduit cette présence *globale* en présence *locale* à
 *    un segment donné, proportionnelle à sa position sur le périmètre — d'où
 *    "les segments montent un à un le long du périmètre".
 *  - `sampleEllipsePoints` / `compassTargets` / `ellipseBastionPositions` /
 *    `boulevardTreePositions` : générateurs de points, purs eux aussi.
 *
 * ============================================================================
 * Rendu three.js : chaque enceinte (sauf les Boulevards, qui sont un rang
 * d'arbres, pas un mur) devient un `wallGroup` — un jeu d'InstancedMesh de
 * capacité *fixe* (courtine, tours, toits coniques, merlons, bastions) que
 * `applyYear` réécrit chaque année sans jamais changer `mesh.count` : les
 * instances absentes reçoivent une matrice à échelle nulle, exactement comme
 * `buildings.js`/`terrain.js`. Les comptes étant petits (dizaines à ~200 par
 * enceinte), pas besoin du système de LOD/repack de `buildings.js`.
 *
 * Conventions héritées de geography.js : 1 unité = 10 m, x = est, z = sud.
 */

import * as THREE from "three";
import { RINGS } from "../geography.js";
import { lifecycle, lerp, easeOutBack } from "../timeEngine.js";
import { groundHeightAt } from "./terrain.js";

// ============================================================================
// Petit hash déterministe (même famille que geography.js/terrain.js/buildings.js)
// ============================================================================

function hash01(a, b, seed) {
  let h = (a * 374761393 + b * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  return (h >>> 0) / 4294967296;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ============================================================================
// Géométrie pure — polylignes, plan d'enceinte, vague de présence
// ============================================================================

/** Arêtes consécutives d'une polyligne (bouclée ou non). */
export function polylineEdges(points, closed) {
  const n = points.length;
  const count = closed ? n : n - 1;
  const edges = [];
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    edges.push({ a, b, len: Math.hypot(b.x - a.x, b.z - a.z) });
  }
  return edges;
}

/** Longueur totale de la polyligne. */
export function perimeterLength(points, closed) {
  return polylineEdges(points, closed).reduce((s, e) => s + e.len, 0);
}

/**
 * Distance le long du périmètre du point de la polyligne le plus proche de
 * la direction (targetX, targetZ) — utilisé pour placer une porte "sur l'axe
 * nord/sud/est/ouest" : on vise un point très loin dans cette direction et on
 * trouve où la muraille en est la plus proche.
 * @returns {number} distance cumulée depuis points[0]
 */
export function nearestDistanceToward(points, closed, targetX, targetZ) {
  const edges = polylineEdges(points, closed);
  let best = Infinity;
  let bestAlong = 0;
  let acc = 0;
  for (const e of edges) {
    const abx = e.b.x - e.a.x;
    const abz = e.b.z - e.a.z;
    const len2 = abx * abx + abz * abz;
    let t = len2 === 0 ? 0 : ((targetX - e.a.x) * abx + (targetZ - e.a.z) * abz) / len2;
    t = clamp01(t);
    const px = e.a.x + abx * t;
    const pz = e.a.z + abz * t;
    const d = Math.hypot(px - targetX, pz - targetZ);
    if (d < best) {
      best = d;
      bestAlong = acc + t * e.len;
    }
    acc += e.len;
  }
  return bestAlong;
}

function pointAtDistanceOnEdges(edges, edgeStart, totalLength, closed, d) {
  let wrapped = d;
  if (closed && totalLength > 0) {
    wrapped = ((d % totalLength) + totalLength) % totalLength;
  } else {
    wrapped = clamp01(d / (totalLength || 1)) * totalLength;
  }
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const s0 = edgeStart[i];
    const s1 = s0 + e.len;
    if (wrapped <= s1 + 1e-9 || i === edges.length - 1) {
      const t = e.len > 0 ? clamp01((wrapped - s0) / e.len) : 0;
      return { x: lerp(e.a.x, e.b.x, t), z: lerp(e.a.z, e.b.z, t) };
    }
  }
  const last = edges[edges.length - 1];
  return { x: last.b.x, z: last.b.z };
}

/**
 * Construit le plan géométrique d'une enceinte : segments de courtine (la
 * polyligne moins les portes et les franchissements de fleuve) et positions
 * de tours, tous indexés par distance cumulée le long du périmètre.
 *
 * @param {Array<{x:number,z:number}>} points
 * @param {object} [opts]
 * @param {boolean} [opts.closed=true]
 * @param {number} [opts.towerEvery=0] - 0 = pas de tours régulières (seules les tours de porte existent)
 * @param {Array<{x:number,z:number}>} [opts.gates] - cibles de direction (voir `nearestDistanceToward`)
 * @param {number} [opts.gateWidth=3]
 * @param {number[]} [opts.riverCrossings] - indices d'arêtes brutes sans aucune courtine (franchissement du fleuve)
 * @returns {{segments: Array, towers: Array, totalLength: number, gateDistances: number[]}}
 */
export function wallRingPlan(points, opts = {}) {
  const {
    closed = true,
    towerEvery = 0,
    gates = [],
    gateWidth = 3,
    riverCrossings = [],
  } = opts;

  const edges = polylineEdges(points, closed);
  const totalLength = edges.reduce((s, e) => s + e.len, 0);
  const edgeStart = [];
  {
    let acc = 0;
    for (const e of edges) {
      edgeStart.push(acc);
      acc += e.len;
    }
  }

  const gateDistances = gates.map((g) => nearestDistanceToward(points, closed, g.x, g.z));
  const excluded = gateDistances.map((d) => ({ from: d - gateWidth / 2, to: d + gateWidth / 2 }));
  // Note : les franchissements de fleuve sont ajoutés à `excluded` (donc la
  // courtine s'y arrête bien) mais ne participent volontairement pas au
  // calcul des tours flanquantes plus bas (voir `gateDistances.forEach`) —
  // seules les vraies portes en reçoivent, pas le milieu du fleuve.
  const riverIntervals = riverCrossings.map((idx) => ({
    from: edgeStart[idx],
    to: edgeStart[idx] + edges[idx].len,
  }));
  excluded.push(...riverIntervals);
  excluded.sort((a, b) => a.from - b.from);

  function insideExcluded(d) {
    return excluded.some((iv) => d > iv.from + 1e-9 && d < iv.to - 1e-9);
  }

  const segments = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const s0 = edgeStart[i];
    const s1 = s0 + e.len;
    const cuts = [s0, s1];
    for (const iv of excluded) {
      if (iv.from > s0 && iv.from < s1) cuts.push(iv.from);
      if (iv.to > s0 && iv.to < s1) cuts.push(iv.to);
    }
    cuts.sort((a, b) => a - b);
    for (let k = 0; k < cuts.length - 1; k++) {
      const a = cuts[k];
      const b = cuts[k + 1];
      if (b - a < 1e-6) continue;
      const mid = (a + b) / 2;
      if (insideExcluded(mid)) continue;
      const t0 = e.len > 0 ? (a - s0) / e.len : 0;
      const t1 = e.len > 0 ? (b - s0) / e.len : 0;
      const x1 = lerp(e.a.x, e.b.x, t0);
      const z1 = lerp(e.a.z, e.b.z, t0);
      const x2 = lerp(e.a.x, e.b.x, t1);
      const z2 = lerp(e.a.z, e.b.z, t1);
      segments.push({
        x1,
        z1,
        x2,
        z2,
        midX: (x1 + x2) / 2,
        midZ: (z1 + z2) / 2,
        length: b - a,
        distStart: a,
        distEnd: b,
        // Angle de lacet (autour de +Y) tel que Quaternion.setFromAxisAngle(UP, angle)
        // envoie l'axe local +X sur la direction (x2-x1, z2-z1) — voir la note de
        // dérivation dans le rapport de tâche. Utilisé pour aligner les boîtes de
        // courtine sur le segment.
        angle: Math.atan2(-(z2 - z1), x2 - x1),
      });
    }
  }

  const towerDistanceSet = new Map(); // clé arrondie -> distance exacte (dédoublonnage)
  if (towerEvery > 0) {
    for (let d = 0; d < totalLength - 1e-6; d += towerEvery) {
      if (!insideExcluded(d)) towerDistanceSet.set(Math.round(d * 1e6), d);
    }
  }
  gateDistances.forEach((d) => {
    const from = d - gateWidth / 2;
    const to = d + gateWidth / 2;
    towerDistanceSet.set(Math.round(from * 1e6), from);
    towerDistanceSet.set(Math.round(to * 1e6), to);
  });

  const towerDistances = Array.from(towerDistanceSet.values()).sort((a, b) => a - b);
  const towers = towerDistances.map((d) => {
    const p = pointAtDistanceOnEdges(edges, edgeStart, totalLength, closed, d);
    return { x: p.x, z: p.z, distAlong: d };
  });

  return { segments, towers, totalLength, gateDistances };
}

/**
 * La vague "pierre par pierre" : traduit une présence *globale* (venant de
 * `timeEngine.lifecycle`, 0->1 à la construction, 1->0 à la démolition) en
 * présence *locale* pour un segment situé à [distStart, distEnd] sur un
 * périmètre de longueur `totalLength`. `overallPresence * totalLength` est la
 * longueur "déjà construite" depuis le début du périmètre ; un segment est
 * entièrement construit si cette longueur dépasse sa fin, pas encore
 * commencé si elle n'atteint pas son début, et interpolé linéairement entre
 * les deux sinon. La même formule, appliquée à une présence qui redescend de
 * 1 à 0 pendant la démolition, fait disparaître les segments dans l'ordre
 * inverse du périmètre — un effondrement cohérent avec la construction,
 * sans code séparé.
 * @param {number} distStart
 * @param {number} distEnd
 * @param {number} totalLength
 * @param {number} overallPresence
 * @returns {number} dans [0, 1]
 */
export function segmentPresence(distStart, distEnd, totalLength, overallPresence) {
  if (overallPresence <= 0) return 0;
  if (overallPresence >= 1) return 1;
  const builtLen = overallPresence * totalLength;
  const segLen = distEnd - distStart;
  if (segLen <= 0) return 0;
  return clamp01((builtLen - distStart) / segLen);
}

// ============================================================================
// Générateurs de points — purs
// ============================================================================

/** `count` points échantillonnés sur une ellipse, dans l'ordre trigonométrique. */
export function sampleEllipsePoints(cx, cz, rx, rz, count) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * rx, z: cz + Math.sin(a) * rz });
  }
  return pts;
}

/** `n` points très loin du centre, répartis uniformément en direction (boussole). */
export function compassTargets(cx, cz, n, radius = 3000) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * radius, z: cz + Math.sin(a) * radius });
  }
  return out;
}

/**
 * `count` bastions triangulaires évenly espacés sur une ellipse, avec leur
 * direction radiale sortante (pour orienter la protrusion).
 */
export function ellipseBastionPositions(cx, cz, rx, rz, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const x = cx + Math.cos(a) * rx;
    const z = cz + Math.sin(a) * rz;
    const dx = Math.cos(a) / rx;
    const dz = Math.sin(a) / rz;
    const len = Math.hypot(dx, dz) || 1;
    out.push({ x, z, dirX: dx / len, dirZ: dz / len });
  }
  return out;
}

/**
 * Positions d'un double rang d'arbres le long d'une polyligne (trace d'une
 * ancienne muraille) — un arbre de chaque côté, décalé perpendiculairement de
 * `offset`, tous les `spacing` unités.
 */
export function boulevardTreePositions(points, closed, spacing, offset) {
  const edges = polylineEdges(points, closed);
  const total = edges.reduce((s, e) => s + e.len, 0);
  const out = [];
  if (total <= 0) return out;
  for (let d = spacing / 2; d < total; d += spacing) {
    let acc = 0;
    let edge = edges[edges.length - 1];
    for (const e of edges) {
      if (d <= acc + e.len) {
        edge = e;
        break;
      }
      acc += e.len;
    }
    const t = edge.len > 0 ? (d - acc) / edge.len : 0;
    const x = lerp(edge.a.x, edge.b.x, t);
    const z = lerp(edge.a.z, edge.b.z, t);
    const dx = edge.b.x - edge.a.x;
    const dz = edge.b.z - edge.a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    out.push({ x: x + nx * offset, z: z + nz * offset, side: 1 });
    out.push({ x: x - nx * offset, z: z - nz * offset, side: -1 });
  }
  return out;
}

// ============================================================================
// Les 4 enceintes + la Bastille + les Grands Boulevards — données
// ============================================================================

const PA_POINTS = [
  // rive droite
  { x: -95, z: -55 },
  { x: -60, z: -105 },
  { x: 20, z: -110 },
  { x: 75, z: -45 },
  // rive gauche
  { x: 55, z: 45 },
  { x: 0, z: 80 },
  { x: -45, z: 60 },
  { x: -80, z: 0 },
];
// Arêtes (index i relie points[i] -> points[i+1]) qui franchissent la Seine :
// 3->4 (rive droite -> rive gauche, à l'est) et 7->0 (rive gauche -> rive
// droite, à l'ouest) — aucune courtine n'y est construite ("le mur s'arrête
// aux berges : laisser des vides au-dessus de l'eau", brief).
const PA_RIVER_EDGES = [3, 7];

const CHARLES_V_POINTS = [
  { x: -110, z: -60 },
  { x: -70, z: -160 },
  { x: 95, z: -150 },
  { x: 141, z: -5 },
];

export const GALLO_ROMAIN = {
  id: "galloRomain",
  born: 308,
  buildYears: 8,
  died: 1190,
  razeYears: 40,
  points: sampleEllipsePoints(0, 0, 14, 7, 24),
  closed: true,
  towerEvery: 12,
  // 2 portes seulement : le petit rempart antique de l'île n'ouvrait
  // essentiellement que sur les deux ponts (Petit Pont au sud, Pont au
  // Change au nord) — pas les 3-5 portes des enceintes médiévales bien plus
  // grandes ci-dessous.
  gateTargets: [
    { x: 0, z: -1000 },
    { x: 0, z: 1000 },
  ],
  gateWidth: 2,
  h: 2.6,
  thickness: 1.0,
  towerRadius: 1.1,
  towerHeightMul: 1.25,
  stoneColor: 0xb7ac95,
  crenellation: false,
  roofColor: null,
};

export const PHILIPPE_AUGUSTE = {
  id: "philippeAuguste",
  born: 1190,
  buildYears: 30,
  died: 1670,
  razeYears: 40,
  points: PA_POINTS,
  closed: true,
  towerEvery: 26,
  // 4 portes (nord/Saint-Denis, est, sud, ouest, dans l'esprit du brief),
  // visées au milieu des arêtes terrestres 0/2/4/6 plutôt que par direction
  // boussole lointaine : le sommet (-95,-55) est le point le plus à l'ouest
  // de tout l'octogone, donc tout rayon purement "ouest" retombe sur lui —
  // exactement le sommet partagé avec le franchissement de la Seine (arête
  // 7, exclue) plutôt que sur le tronçon terrestre voisin. Viser le milieu
  // de chaque arête garantit 4 portes réellement distinctes, à l'intérieur
  // de la courtine, jamais confondues avec un vide de fleuve.
  gateTargets: [
    { x: -77.5, z: -80 }, // arête 0 — nord-ouest, rive droite (vers Saint-Denis)
    { x: 47.5, z: -77.5 }, // arête 2 — nord-est, rive droite
    { x: 27.5, z: 62.5 }, // arête 4 — sud-est, rive gauche (vers Orléans)
    { x: -62.5, z: 30 }, // arête 6 — ouest, rive gauche
  ],
  gateWidth: 3,
  riverCrossings: PA_RIVER_EDGES,
  h: 3.2,
  thickness: 1.15,
  towerRadius: 1.5,
  towerHeightMul: 1.35,
  // Gris froid volontairement éloigné (perceptuellement) de la palette chaude
  // des enceintes bâties (PAL.plaster/stucco/stone, toutes beige/crème) —
  // sinon la muraille se confond avec "encore des bâtiments" vue du ciel
  // (finding de revue de la tâche 9). Cf. rapport pour le delta RGB mesuré.
  stoneColor: 0x8f9099,
  crenellation: true,
  roofColor: 0x4e5766, // slate blue
};

export const CHARLES_V = {
  id: "charlesV",
  born: 1356,
  buildYears: 27,
  died: 1670,
  razeYears: 30,
  points: CHARLES_V_POINTS,
  closed: false, // rive droite seulement : les deux bouts touchent déjà la Seine
  towerEvery: 30,
  // 3 portes, une par tronçon de la polyligne (visée au milieu de chaque
  // arête plutôt que par direction boussole) : sur ce tracé ouvert et très
  // coudé, des cibles nord/sud/est/ouest lointaines convergeaient toutes
  // vers la même extrémité est (141,-5), laissant le reste du tracé sans
  // porte distincte.
  gateTargets: [
    { x: -90, z: -110 }, // milieu du 1er tronçon (vers Montmartre)
    { x: 12.5, z: -155 }, // milieu du 2e tronçon (nord)
    { x: 118, z: -77.5 }, // milieu du 3e tronçon (vers la Bastille)
  ],
  gateWidth: 3,
  h: 3.2,
  thickness: 1.2,
  towerRadius: 1.55,
  towerHeightMul: 1.35,
  // Même famille de gris froid que Philippe Auguste (voir sa note), une nuance
  // plus sombre pour que les deux enceintes médiévales restent distinguables
  // l'une de l'autre tout en étant toutes deux nettement plus froides que la
  // ville bâtie.
  stoneColor: 0x82838d,
  crenellation: true,
  roofColor: 0x4e5766,
};

const THIERS_POINTS = sampleEllipsePoints(
  RINGS.peripherique.cx,
  RINGS.peripherique.cz,
  RINGS.peripherique.rx,
  RINGS.peripherique.rz,
  64
);

export const THIERS = {
  id: "thiers",
  born: 1841,
  buildYears: 4,
  died: 1919,
  razeYears: 10,
  points: THIERS_POINTS,
  closed: true,
  towerEvery: 0, // pas de tours rondes régulières — seules les tours de porte
  gateTargets: compassTargets(RINGS.peripherique.cx, RINGS.peripherique.cz, 9, 3000),
  gateWidth: 4,
  h: 3.0,
  thickness: 1.3,
  towerRadius: 1.3,
  towerHeightMul: 1.15,
  stoneColor: 0x9c9686,
  crenellation: false,
  roofColor: null,
  bastionCount: 17,
};

// La Bastille : forteresse à part, rectangle de 8 tours rondes (voir le
// brief), calée sur l'extrémité est de Charles V (141,-5). towerEvery choisi
// pour tomber *exactement* sur 8 tours : périmètre = 2*(2*6.5+2*4) = 42,
// towerEvery = 42/8 = 5.25.
const BASTILLE_W = 6.5;
const BASTILLE_D = 4;
const BASTILLE_CX = 141;
const BASTILLE_CZ = -5;
const BASTILLE_POINTS = [
  { x: BASTILLE_CX - BASTILLE_W, z: BASTILLE_CZ - BASTILLE_D },
  { x: BASTILLE_CX + BASTILLE_W, z: BASTILLE_CZ - BASTILLE_D },
  { x: BASTILLE_CX + BASTILLE_W, z: BASTILLE_CZ + BASTILLE_D },
  { x: BASTILLE_CX - BASTILLE_W, z: BASTILLE_CZ + BASTILLE_D },
];

export const BASTILLE = {
  id: "bastille",
  born: 1370,
  buildYears: 12,
  died: 1789,
  razeYears: 2, // démontage rapide et théâtral
  points: BASTILLE_POINTS,
  closed: true,
  towerEvery: (4 * (BASTILLE_W + BASTILLE_D)) / 8,
  gateTargets: [],
  gateWidth: 0,
  h: 3.6,
  thickness: 1.3,
  towerRadius: 1.8,
  towerHeightMul: 1.4,
  stoneColor: 0x8b8478,
  crenellation: false,
  roofColor: 0x4e5766,
  dustIntensity: 2.4,
};

export const BOULEVARDS = {
  id: "boulevards",
  born: 1670,
  buildYears: 15,
  // died volontairement omis : les Grands Boulevards n'ont jamais été
  // démolis (contrairement aux murailles qu'ils remplacent) — lifecycle()
  // les traite alors comme "alive" pour toujours une fois construits.
  traces: [
    // rive droite de Philippe Auguste (les 4 premiers points de PA_POINTS)
    { points: PA_POINTS.slice(0, 4), closed: false },
    { points: CHARLES_V_POINTS, closed: false },
  ],
  spacing: 9,
  offset: 2.4,
};

export const WALLS = [GALLO_ROMAIN, PHILIPPE_AUGUSTE, CHARLES_V, THIERS, BASTILLE];

// ============================================================================
// Tunables de rendu
// ============================================================================

const MERLON_SPACING = 1.5;
const MERLON_W = 0.55;
const MERLON_D = 0.5;
const MERLON_H = 0.5;
const BASTION_HEIGHT = 1.6;
const BASTION_RADIUS = 1.3;

const DUST_POOL_SIZE = 48;
const DUST_LIFE = 1.7; // secondes

// ============================================================================
// Scratch three.js (réutilisé, jamais alloué en boucle d'update)
// ============================================================================

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const _dir = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qTilt = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

// ============================================================================
// Poussière de démolition — pool fixe de mesh simples (comptes minuscules,
// pas besoin d'instancing ; chaque puff a son propre matériau pour une
// opacité indépendante).
// ============================================================================

const dust = { slots: [] };

function buildDust(ctx) {
  const geo = new THREE.IcosahedronGeometry(0.3, 0);
  for (let i = 0; i < DUST_POOL_SIZE; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xcfc6ad,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    ctx.scene.add(mesh);
    dust.slots.push({
      mesh,
      mat,
      active: false,
      spawnTime: 0,
      life: DUST_LIFE,
      baseX: 0,
      baseY: 0,
      baseZ: 0,
      scale: 1,
    });
  }
}

function spawnDust(x, y, z, time, scale, life) {
  const slot = dust.slots.find((d) => !d.active);
  if (!slot) return;
  slot.active = true;
  slot.mesh.visible = true;
  slot.spawnTime = time;
  slot.life = life;
  slot.scale = scale;
  slot.baseX = x;
  slot.baseY = y;
  slot.baseZ = z;
}

function updateDust(time) {
  for (const d of dust.slots) {
    if (!d.active) continue;
    const t = (time - d.spawnTime) / d.life;
    if (t >= 1) {
      d.active = false;
      d.mesh.visible = false;
      d.mat.opacity = 0;
      continue;
    }
    const rise = t * 1.3;
    const grow = lerp(0.4, 1.3, t) * d.scale;
    d.mesh.position.set(d.baseX, d.baseY + rise, d.baseZ);
    d.mesh.scale.setScalar(grow);
    d.mat.opacity = (1 - t) * 0.55;
  }
}

function clearDust() {
  for (const d of dust.slots) {
    d.active = false;
    d.mesh.visible = false;
    d.mat.opacity = 0;
  }
}

// ============================================================================
// Groupe d'enceinte — InstancedMesh de capacité fixe, réécrits chaque année
// ============================================================================

function buildWallGroup(ctx, cfg) {
  const planOpts = {
    closed: cfg.closed,
    towerEvery: cfg.towerEvery,
    gates: cfg.gateTargets,
    gateWidth: cfg.gateWidth,
    riverCrossings: cfg.riverCrossings ?? [],
  };
  const plan = wallRingPlan(cfg.points, planOpts);

  const stoneMat = new THREE.MeshLambertMaterial({ color: cfg.stoneColor });
  const roofMat = cfg.roofColor ? new THREE.MeshLambertMaterial({ color: cfg.roofColor }) : null;

  const courtineGeo = new THREE.BoxGeometry(1, 1, 1);
  const courtine = new THREE.InstancedMesh(courtineGeo, stoneMat, Math.max(plan.segments.length, 1));
  courtine.count = plan.segments.length;
  courtine.frustumCulled = false;
  courtine.name = `wall_${cfg.id}_courtine`;
  ctx.scene.add(courtine);

  const towerGeo = new THREE.CylinderGeometry(1, 1, 1, 12);
  const towers = new THREE.InstancedMesh(towerGeo, stoneMat, Math.max(plan.towers.length, 1));
  towers.count = plan.towers.length;
  towers.frustumCulled = false;
  towers.name = `wall_${cfg.id}_towers`;
  ctx.scene.add(towers);

  let roofs = null;
  if (roofMat) {
    const roofGeo = new THREE.ConeGeometry(1, 1, 12);
    roofs = new THREE.InstancedMesh(roofGeo, roofMat, Math.max(plan.towers.length, 1));
    roofs.count = plan.towers.length;
    roofs.frustumCulled = false;
    roofs.name = `wall_${cfg.id}_roofs`;
    ctx.scene.add(roofs);
  }

  // Merlons (medieval walls only) : quelques slots par segment, capacité fixe
  // précalculée. Chaque slot mémorise à quel segment il appartient — sa
  // présence/hauteur suivent celles de ce segment.
  let merlons = null;
  const merlonOwner = []; // index de segment par slot
  const merlonT = []; // position [0,1] le long du segment
  if (cfg.crenellation) {
    for (let si = 0; si < plan.segments.length; si++) {
      const seg = plan.segments[si];
      const count = Math.max(1, Math.floor(seg.length / MERLON_SPACING));
      for (let k = 0; k < count; k++) {
        merlonOwner.push(si);
        merlonT.push((k + 0.5) / count);
      }
    }
    const merlonGeo = new THREE.BoxGeometry(1, 1, 1);
    merlons = new THREE.InstancedMesh(merlonGeo, stoneMat, Math.max(merlonOwner.length, 1));
    merlons.count = merlonOwner.length;
    merlons.frustumCulled = false;
    merlons.name = `wall_${cfg.id}_merlons`;
    ctx.scene.add(merlons);
  }

  // Bastions triangulaires (Thiers only).
  let bastions = null;
  let bastionPositions = [];
  if (cfg.bastionCount) {
    const { cx, cz, rx, rz } = RINGS.peripherique;
    bastionPositions = ellipseBastionPositions(cx, cz, rx, rz, cfg.bastionCount);
    const bastionGeo = new THREE.ConeGeometry(1, 1, 3);
    bastions = new THREE.InstancedMesh(bastionGeo, stoneMat, Math.max(bastionPositions.length, 1));
    bastions.count = bastionPositions.length;
    bastions.frustumCulled = false;
    bastions.name = `wall_${cfg.id}_bastions`;
    ctx.scene.add(bastions);
  }

  return {
    cfg,
    plan,
    courtine,
    towers,
    roofs,
    merlons,
    merlonOwner,
    merlonT,
    bastions,
    bastionPositions,
    // état de dé-doublonnage du dust : distance-le-long-du-périmètre déjà
    // "poussiérée" récemment, pour ne pas spammer le même point à chaque tick.
    dustCooldown: new Map(),
  };
}

/** Écrit la matrice d'un segment de courtine (et ses merlons) pour l'année courante. */
function writeSegment(group, si, overallPresence, phase, time) {
  const seg = group.plan.segments[si];
  const cfg = group.cfg;
  const presence = segmentPresence(seg.distStart, seg.distEnd, group.plan.totalLength, overallPresence);
  const groundY = groundHeightAt(seg.midX, seg.midZ);

  if (presence <= 0) {
    group.courtine.setMatrixAt(si, _zero);
  } else {
    const height = cfg.h;
    let scaleY;
    let posY;
    let tilt = 0;
    if (phase === "razing") {
      scaleY = Math.max(presence, 0.03);
      posY = groundY + (height * scaleY) / 2 - (1 - presence) * height * 0.35;
      const sign = hash01(Math.round(seg.midX * 10), Math.round(seg.midZ * 10), 71) > 0.5 ? 1 : -1;
      tilt = sign * (1 - presence) * 0.3;
    } else {
      scaleY = easeOutBack(presence, 0.6);
      posY = groundY + (height * scaleY) / 2;
    }
    _q.setFromAxisAngle(UP, seg.angle);
    if (tilt !== 0) {
      _qTilt.setFromAxisAngle(RIGHT, tilt);
      _q.multiply(_qTilt);
    }
    _p.set(seg.midX, posY, seg.midZ);
    _s.set(Math.max(seg.length, 0.05), Math.max(height * scaleY, 0.02), cfg.thickness);
    _m.compose(_p, _q, _s);
    group.courtine.setMatrixAt(si, _m);

    // Poussière : uniquement pendant l'effondrement actif de ce segment
    // (0.05 < presence < 0.95), throttlé par un cooldown pour ne pas spammer.
    if (phase === "razing" && presence > 0.05 && presence < 0.95) {
      const last = group.dustCooldown.get(si) ?? -Infinity;
      if (time - last > 0.9 && hash01(si, Math.round(time * 3), 191) < 0.35) {
        group.dustCooldown.set(si, time);
        const intensity = cfg.dustIntensity ?? 1;
        spawnDust(
          seg.midX + (hash01(si, 1, 202) - 0.5) * 1.5,
          groundY + height * 0.3,
          seg.midZ + (hash01(si, 2, 303) - 0.5) * 1.5,
          time,
          0.7 * intensity,
          DUST_LIFE
        );
      }
    }
  }

  // Merlons de ce segment : même présence/hauteur que la courtine, en plus
  // petit, posés sur le sommet.
  if (group.merlons) {
    for (let slot = 0; slot < group.merlonOwner.length; slot++) {
      if (group.merlonOwner[slot] !== si) continue;
      if (presence <= 0.85) {
        group.merlons.setMatrixAt(slot, _zero);
        continue;
      }
      const t = group.merlonT[slot];
      const mx = lerp(seg.x1, seg.x2, t);
      const mz = lerp(seg.z1, seg.z2, t);
      const height = cfg.h;
      const scaleY = phase === "razing" ? Math.max(presence, 0.03) : easeOutBack(presence, 0.6);
      const topY = groundY + height * scaleY;
      _q.setFromAxisAngle(UP, seg.angle);
      _p.set(mx, topY + (MERLON_H * scaleY) / 2, mz);
      _s.set(MERLON_W, Math.max(MERLON_H * scaleY, 0.02), MERLON_D);
      _m.compose(_p, _q, _s);
      group.merlons.setMatrixAt(slot, _m);
    }
  }
}

/** Écrit la matrice d'une tour (et son toit conique) pour l'année courante. */
function writeTower(group, ti, overallPresence, phase) {
  const tower = group.plan.towers[ti];
  const cfg = group.cfg;
  const span = Math.max(cfg.towerRadius * 2, 2);
  const presence = segmentPresence(
    tower.distAlong - span / 2,
    tower.distAlong + span / 2,
    group.plan.totalLength,
    overallPresence
  );
  const groundY = groundHeightAt(tower.x, tower.z);

  if (presence <= 0) {
    group.towers.setMatrixAt(ti, _zero);
    if (group.roofs) group.roofs.setMatrixAt(ti, _zero);
    return;
  }

  const height = cfg.h * cfg.towerHeightMul;
  let scaleY;
  let posY;
  if (phase === "razing") {
    scaleY = Math.max(presence, 0.03);
    posY = groundY + (height * scaleY) / 2 - (1 - presence) * height * 0.3;
  } else {
    scaleY = easeOutBack(presence, 0.6);
    posY = groundY + (height * scaleY) / 2;
  }
  _q.identity();
  _p.set(tower.x, posY, tower.z);
  _s.set(cfg.towerRadius, Math.max(height * scaleY, 0.02), cfg.towerRadius);
  _m.compose(_p, _q, _s);
  group.towers.setMatrixAt(ti, _m);

  if (group.roofs) {
    const roofH = cfg.towerRadius * 1.3;
    const topY = groundY + height * scaleY;
    _p.set(tower.x, topY + (roofH * scaleY) / 2, tower.z);
    _s.set(cfg.towerRadius * 1.15, Math.max(roofH * scaleY, 0.02), cfg.towerRadius * 1.15);
    _m.compose(_p, _q, _s);
    group.roofs.setMatrixAt(ti, _m);
  }
}

/** Écrit la matrice d'un bastion triangulaire (Thiers) pour l'année courante. */
function writeBastion(group, bi, overallPresence, phase) {
  const b = group.bastionPositions[bi];
  const cfg = group.cfg;
  const presence = overallPresence; // pas de vague le long du périmètre — simple flourish
  if (presence <= 0) {
    group.bastions.setMatrixAt(bi, _zero);
    return;
  }
  const groundY = groundHeightAt(b.x, b.z);
  const scaleY = phase === "razing" ? Math.max(presence, 0.03) : easeOutBack(presence, 0.6);
  const height = cfg.h * 0.55;
  _dir.set(b.dirX, 0, b.dirZ);
  _q.setFromUnitVectors(UP, _dir);
  _p.set(
    b.x + b.dirX * BASTION_RADIUS * 0.4,
    groundY + height * 0.4 + (BASTION_HEIGHT * scaleY) / 2,
    b.z + b.dirZ * BASTION_RADIUS * 0.4
  );
  _s.set(BASTION_RADIUS * scaleY, Math.max(BASTION_HEIGHT * scaleY, 0.02), BASTION_RADIUS * scaleY);
  _m.compose(_p, _q, _s);
  group.bastions.setMatrixAt(bi, _m);
}

/** Recalcule toutes les matrices d'un groupe pour l'année/temps courants. */
function applyGroup(group, year, time) {
  const { phase, presence } = lifecycle(year, group.cfg);
  for (let si = 0; si < group.plan.segments.length; si++) writeSegment(group, si, presence, phase, time);
  for (let ti = 0; ti < group.plan.towers.length; ti++) writeTower(group, ti, presence, phase);
  if (group.bastions) {
    for (let bi = 0; bi < group.bastionPositions.length; bi++) writeBastion(group, bi, presence, phase);
  }

  group.courtine.instanceMatrix.needsUpdate = true;
  group.towers.instanceMatrix.needsUpdate = true;
  if (group.roofs) group.roofs.instanceMatrix.needsUpdate = true;
  if (group.merlons) group.merlons.instanceMatrix.needsUpdate = true;
  if (group.bastions) group.bastions.instanceMatrix.needsUpdate = true;
}

// ============================================================================
// Grands Boulevards — double rang d'arbres plantés à la place des murailles
// ============================================================================

function buildBoulevards(ctx, cfg) {
  const candidates = [];
  for (const trace of cfg.traces) {
    for (const p of boulevardTreePositions(trace.points, trace.closed, cfg.spacing, cfg.offset)) {
      candidates.push(p);
    }
  }

  const trunkGeo = new THREE.CylinderGeometry(0.1, 0.14, 1, 6);
  const crownGeo = new THREE.ConeGeometry(0.75, 1.3, 7);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5b4632 });
  const crownMat = new THREE.MeshLambertMaterial({ color: 0x3f7a42 });

  const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, Math.max(candidates.length, 1));
  trunk.count = candidates.length;
  trunk.frustumCulled = false;
  trunk.name = "boulevard_trunks";
  ctx.scene.add(trunk);

  const crown = new THREE.InstancedMesh(crownGeo, crownMat, Math.max(candidates.length, 1));
  crown.count = candidates.length;
  crown.frustumCulled = false;
  crown.name = "boulevard_crowns";
  ctx.scene.add(crown);

  return { cfg, candidates, trunk, crown };
}

function applyBoulevards(group, year) {
  const { presence } = lifecycle(year, group.cfg);
  const grow = presence > 0 ? easeOutBack(presence, 0.4) : 0;
  for (let i = 0; i < group.candidates.length; i++) {
    const c = group.candidates[i];
    if (grow <= 0) {
      group.trunk.setMatrixAt(i, _zero);
      group.crown.setMatrixAt(i, _zero);
      continue;
    }
    const groundY = groundHeightAt(c.x, c.z);
    _q.identity();
    _p.set(c.x, groundY + 0.5 * grow, c.z);
    _s.set(grow, grow, grow);
    _m.compose(_p, _q, _s);
    group.trunk.setMatrixAt(i, _m);
    _p.set(c.x, groundY + 1.15 * grow, c.z);
    _m.compose(_p, _q, _s);
    group.crown.setMatrixAt(i, _m);
  }
  group.trunk.instanceMatrix.needsUpdate = true;
  group.crown.instanceMatrix.needsUpdate = true;
}

// ============================================================================
// Contrat de layer
// ============================================================================

let groups = [];
let boulevardsGroup = null;
let lastAppliedYear = null;

function rescanAll(year, time) {
  for (const g of groups) applyGroup(g, year, time);
  if (boulevardsGroup) applyBoulevards(boulevardsGroup, year);
}

export function init(ctx) {
  groups = WALLS.map((cfg) => buildWallGroup(ctx, cfg));
  boulevardsGroup = buildBoulevards(ctx, BOULEVARDS);
  buildDust(ctx);
  clearDust();
  lastAppliedYear = null;
  rescanAll(2026, 0);
  lastAppliedYear = 2026;
}

export function update(dt, state) {
  if (state.year !== lastAppliedYear) {
    rescanAll(state.year, state.time);
    lastAppliedYear = state.year;
  }
  if (!state.reducedMotion) {
    updateDust(state.time);
  } else {
    clearDust();
  }
}

/**
 * Force une resynchronisation immédiate pour `year` — même contrat que
 * `terrain.forceRescan`/`buildings.rebuildForYear`, utilisé par
 * `window.__paris.setYear`.
 * @param {number} year
 */
export function forceRescan(year) {
  rescanAll(year, performance.now() / 1000);
  lastAppliedYear = year;
}

/** Diagnostic : compte d'instances actuellement visibles (presence > 0) par enceinte, pour la vérification. */
export function debugCounts(year) {
  const out = {};
  for (const g of groups) {
    const { phase, presence } = lifecycle(year, g.cfg);
    let segCount = 0;
    for (const seg of g.plan.segments) {
      if (segmentPresence(seg.distStart, seg.distEnd, g.plan.totalLength, presence) > 0) segCount++;
    }
    out[g.cfg.id] = { phase, presence, segCount, totalSegments: g.plan.segments.length };
  }
  if (boulevardsGroup) {
    out.boulevards = lifecycle(year, boulevardsGroup.cfg);
  }
  out.activeDustPuffs = dust.slots.reduce((n, d) => n + (d.active ? 1 : 0), 0);
  return out;
}
