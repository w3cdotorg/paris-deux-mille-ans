/**
 * Life layer — bateaux, foules, oiseaux, vignettes.
 *
 * C'est la couche qui fait sentir que chaque époque est *habitée*, pas
 * seulement construite. Quatre systèmes, quatre échelles de temps :
 *
 *  - **Bateaux** : sept flottes se relaient sur la Seine (pirogues, galères
 *    romaines, drakkars du siège de 885, barques et moulins flottants,
 *    coches d'eau et bateaux-lavoirs, péniches, bateaux-mouches). Chaque
 *    flotte a sa fenêtre historique et se fait un fondu — littéralement, en
 *    échelle (`group.scale`) — avec la suivante.
 *  - **Foules** : jusqu'à 3000 silhouettes (un seul InstancedMesh — voir la
 *    note sur la géométrie fusionnée) réparties près des berges, des places
 *    et des grands sites, dont la densité suit la population du moment et la
 *    teinte suit l'époque (bure, redingote, jean).
 *  - **Oiseaux** : 3 vols de 12 en trajectoires de Lissajous, de -250 à 2026
 *    sans interruption — c'est le motif de continuité du projet, comme la
 *    Tour fantôme et la balise de `ghosts.js`.
 *  - **Vignettes** : 28 petites scènes fixes (2 par moment de la frise),
 *    visibles seulement dans la fenêtre de leur époque et seulement si la
 *    caméra n'est pas trop loin — une récompense pour qui zoome.
 *
 * ============================================================================
 * Ce qui est réutilisé plutôt que réécrit
 *
 * `shuttleAt`, `ringPoint` et `ringYaw` viennent de `rails.js` (même famille
 * de problème : une navette le long d'une courbe). `groundHeightAt` vient de
 * `terrain.js`. `urbanYear` (geography.js) sert de porte d'apparition aux
 * silhouettes de foule — exactement le même champ que celui qui décide où
 * `buildings.js` pose une maison, donc les gens n'apparaissent jamais avant
 * que leur quartier n'existe. `momentBlend` (timeEngine.js) porte le fondu de
 * palette des costumes et l'interpolation de population entre deux moments.
 *
 * ============================================================================
 * Une géométrie fusionnée, pas deux InstancedMesh
 *
 * Le brief suggère « 2 triangles corps + tête sphère ou boîte ». Fait avec
 * deux InstancedMesh séparés (corps, tête), c'est 2 draw calls et 2×3000
 * matrices à écrire par frame pour la respiration. Fusionné à la construction
 * (BufferGeometry.toNonIndexed() puis concatenation des attributs — pas
 * besoin de BufferGeometryUtils, non vendorisé), c'est **un seul**
 * InstancedMesh, une seule matrice par personne : moitié moins d'écritures
 * par frame pour un rendu identique. « Silhouette » dans le brief pousse
 * aussi vers une seule teinte par personne (le costume) plutôt que peau+tissu
 * — plus proche d'une ombre chinoise que d'un mannequin, et plus lisible à
 * la distance où on regarde une ville entière.
 *
 * ============================================================================
 * Coût et discipline d'animation
 *
 * Bateaux : 28 groupes (sous la limite de 30 du brief), construits une fois,
 * jamais recréés — seule leur échelle/position bouge. Foules : un
 * InstancedMesh de capacité 3000, réécrit entièrement à chaque changement
 * d'année (comme `walls.js`/`rails.js`), et la respiration (positions Y) ne
 * touche par frame que le sous-ensemble *actif* (`crowd.activeIndices`, pas
 * les 3000 emplacements) — et pas du tout sous `reducedMotion`, où les
 * matrices posées au rescan restent valables sans jamais être retouchées.
 * Oiseaux : 36 Mesh individuels (pas assez nombreux pour justifier
 * l'instancing), toujours en vol. Vignettes : 56 petits groupes (28×2)
 * construits une fois, `visible` togglé par fenêtre + distance caméra —
 * coût nul quand invisible.
 *
 * Aucune allocation dans `update` : matrices/vecteurs scratch partagés
 * (même famille que `rails.js`), tableaux d'indices actifs préalloués.
 */

import * as THREE from "three";
import {
  LANDMARKS,
  RINGS,
  SEINE_POINTS,
  SEINE_ONMAP_COUNT,
  urbanYear,
} from "../geography.js";
import { lerp, smoothstep, momentBlend } from "../timeEngine.js";
import { MOMENTS } from "../timeline.js";
import { groundHeightAt } from "./terrain.js";
import { ringPoint, ringYaw, shuttleAt } from "./rails.js";

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Petit hash déterministe (même famille que geography.js/walls.js/rails.js). */
function hash01(a, b, seed) {
  let h = (a * 374761393 + b * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  return (h >>> 0) / 4294967296;
}

const MOMENT_YEARS = MOMENTS.map((m) => m.year);

// ============================================================================
// Géométries et matériaux partagés — jamais dupliqués par instance/boat/prop
// ============================================================================

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_CONE = new THREE.ConeGeometry(0.5, 1, 6);
const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const UNIT_ICO = new THREE.IcosahedronGeometry(0.5, 0);
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);
const UNIT_GEOMS = { box: UNIT_BOX, cone: UNIT_CONE, cyl: UNIT_CYL, ico: UNIT_ICO, plane: UNIT_PLANE };

const _matCache = new Map();
/** Matériau partagé par (couleur, options) — évite un THREE.Material par pièce. */
function sharedMat(hex, opts) {
  const key = `${hex}|${opts ? JSON.stringify(opts) : ""}`;
  let m = _matCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: hex, ...opts });
    _matCache.set(key, m);
  }
  return m;
}

/**
 * Ajoute une pièce (mesh) à un groupe, en position/échelle/rotation locales.
 * Volontairement plus simple que `monumentModels.piece()` : pas de pousse
 * temporelle ici, seulement des scènes figées.
 * @param {THREE.Group} group
 * @param {"box"|"cone"|"cyl"|"ico"|"plane"} kind
 * @param {number} hex
 * @param {object} o - {x,y,z, sx,sy,sz, rx,ry,rz, mat}
 * @returns {THREE.Mesh}
 */
function part(group, kind, hex, o = {}) {
  const mesh = new THREE.Mesh(UNIT_GEOMS[kind], sharedMat(hex, o.mat));
  mesh.position.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  mesh.scale.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
  if (o.rx) mesh.rotation.x = o.rx;
  if (o.ry) mesh.rotation.y = o.ry;
  if (o.rz) mesh.rotation.z = o.rz;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);
  return mesh;
}

/** Scratch three.js réutilisé — jamais alloué dans update. */
const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

// ============================================================================
// La Seine navigable — courbe partagée par les bateaux et les berges de foule
// ============================================================================

const river = { curve: null, length: 0 };

/**
 * Construit la courbe navigable une seule fois (mémoïsée) — appelée à la
 * fois par `init()` (bateaux) et par `generateCrowdSlots` (berges), qui doit
 * rester une fonction pure et autonome, appelable sans `init()` (déterminisme
 * testé par les node tests).
 */
function ensureRiverCurve() {
  if (river.curve) return;
  const pts = SEINE_POINTS.slice(0, SEINE_ONMAP_COUNT).map((p) => new THREE.Vector3(p.x, 0, p.z));
  river.curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.4);
  river.length = river.curve.getLength();
}

/** Point + tangente (normalisée) sur la Seine navigable à t ∈ [0,1]. Pur hors du curve lui-même. */
function riverPointAndTangent(t) {
  const tt = clamp01(t);
  const point = river.curve.getPointAt(tt);
  const tangent = river.curve.getTangentAt(tt);
  return { point, tangent };
}

// ============================================================================
// Bateaux — silhouettes low-poly par flotte
// ============================================================================

/**
 * Présence d'une flotte à `year` : 1 dans sa fenêtre [from,to], un fondu
 * `smoothstep` de `fadeIn`/`fadeOut` années aux bords. `to = Infinity` = la
 * flotte ne s'éteint jamais (péniches, bateaux-mouches : toujours là
 * aujourd'hui). C'est ce fondu — pas `momentBlend` sur les 14 ancres, dont
 * les flottes ne suivent pas les dates — qui réalise le « crossfade » demandé
 * par le brief : une flotte grandit en échelle pendant que la précédente
 * rétrécit, exactement sur la fenêtre partagée des deux (voir `updateBoats`).
 * @param {number} year
 * @param {number} from
 * @param {number} to
 * @param {number} fadeIn
 * @param {number} fadeOut
 * @returns {number} présence dans [0,1]
 */
export function fleetPresence(year, from, to, fadeIn = 20, fadeOut = 20) {
  if (year < from) {
    if (fadeIn <= 0) return 0;
    const t = (year - (from - fadeIn)) / fadeIn;
    return t <= 0 ? 0 : smoothstep(t);
  }
  if (to !== Infinity && year > to) {
    if (fadeOut <= 0) return 0;
    const t = 1 - (year - to) / fadeOut;
    return t <= 0 ? 0 : smoothstep(t);
  }
  return 1;
}

// --- constructeurs de silhouettes (groupe local : +X = avant du bateau) ----

function buildPirogue(hex = 0x5a4632) {
  const g = new THREE.Group();
  part(g, "box", hex, { x: 0, y: 0.09, z: 0, sx: 1.5, sy: 0.16, sz: 0.32 });
  part(g, "box", 0x3f3122, { x: 0, y: 0.19, z: 0, sx: 1.35, sy: 0.05, sz: 0.24 });
  return g;
}

function buildGalere(hex = 0x6b4a32) {
  const g = new THREE.Group();
  part(g, "box", hex, { x: 0, y: 0.13, z: 0, sx: 2.2, sy: 0.22, sz: 0.5 });
  part(g, "box", 0x8a6a44, { x: 0, y: 0.27, z: 0, sx: 2.0, sy: 0.06, sz: 0.46 });
  part(g, "box", 0x4a3624, { x: -0.1, y: 0.9, z: 0, sx: 0.06, sy: 1.4, sz: 0.06 });
  part(g, "plane", 0xd8cbb0, { x: -0.1, y: 1.1, z: 0, sx: 0.8, sy: 0.8, sz: 1, ry: Math.PI / 2, mat: { side: THREE.DoubleSide } });
  return g;
}

/** Le drakkar : signature du siège de 885. Proue haute, tête de dragon, voile rouge. */
function buildDrakkar() {
  const g = new THREE.Group();
  part(g, "box", 0x3a2a1c, { x: 0, y: 0.14, z: 0, sx: 2.6, sy: 0.24, sz: 0.55 });
  part(g, "box", 0x2a1d12, { x: 0, y: 0.29, z: 0, sx: 2.4, sy: 0.07, sz: 0.5 });
  // proue qui se redresse vers l'avant, jusqu'à la tête de dragon
  part(g, "box", 0x2a1d12, { x: 1.32, y: 0.55, z: 0, sx: 0.16, sy: 0.85, sz: 0.16, rz: -0.55 });
  part(g, "cone", 0x1c130b, { x: 1.68, y: 0.98, z: 0, sx: 0.32, sy: 0.42, sz: 0.32, rz: -1.15 });
  part(g, "box", 0x241a10, { x: 0, y: 0.95, z: 0, sx: 0.07, sy: 1.3, sz: 0.07 });
  part(g, "plane", 0xb3352b, { x: 0.32, y: 1.1, z: 0, sx: 0.85, sy: 0.72, sz: 1, ry: Math.PI / 2, mat: { side: THREE.DoubleSide } });
  return g;
}

function buildBarque(hex = 0x6b5238) {
  const g = new THREE.Group();
  part(g, "box", hex, { x: 0, y: 0.08, z: 0, sx: 1.0, sy: 0.16, sz: 0.34 });
  part(g, "box", 0x4a3a26, { x: 0, y: 0.17, z: 0, sx: 0.9, sy: 0.04, sz: 0.28 });
  return g;
}

/** Le moulin flottant : barge amarrée + roue à aubes qui tourne lentement. */
function buildMoulinFlottant() {
  const g = new THREE.Group();
  part(g, "box", 0x5a4a34, { x: 0, y: 0.14, z: 0, sx: 1.3, sy: 0.26, sz: 0.5 });
  part(g, "box", 0x3a2f20, { x: 0, y: 0.55, z: 0, sx: 0.9, sy: 0.5, sz: 0.42 });
  part(g, "cone", 0x2a2216, { x: 0, y: 0.82, z: 0, sx: 0.78, sy: 0.42, sz: 0.62 });
  const wheel = part(g, "cyl", 0x8a7050, { x: 0, y: 0.32, z: 0.4, sx: 0.58, sy: 0.1, sz: 0.58, rx: Math.PI / 2 });
  g.userData.wheel = wheel;
  return g;
}

function buildCoche(hex = 0x5a4a3a) {
  const g = new THREE.Group();
  part(g, "box", hex, { x: 0, y: 0.14, z: 0, sx: 1.8, sy: 0.26, sz: 0.42 });
  part(g, "box", 0x8a6a4a, { x: -0.2, y: 0.42, z: 0, sx: 0.9, sy: 0.3, sz: 0.38 });
  part(g, "box", 0x3a2c1c, { x: 0.75, y: 0.5, z: 0, sx: 0.05, sy: 0.6, sz: 0.05 });
  part(g, "plane", 0x9b3b3b, { x: 0.78, y: 0.75, z: 0, sx: 0.26, sy: 0.15, sz: 1 });
  return g;
}

/** Le bateau-lavoir : cabane rectangulaire amarrée, jamais en mouvement. */
function buildLavoir() {
  const g = new THREE.Group();
  part(g, "box", 0x4a3c2c, { x: 0, y: 0.12, z: 0, sx: 2.0, sy: 0.22, sz: 0.7 });
  part(g, "box", 0xcfc3a8, { x: 0, y: 0.45, z: 0, sx: 1.85, sy: 0.5, sz: 0.62 });
  part(g, "box", 0x6b5540, { x: 0, y: 0.75, z: 0, sx: 2.0, sy: 0.1, sz: 0.78 });
  return g;
}

function buildPeniche(hex = 0x384048) {
  const g = new THREE.Group();
  part(g, "box", hex, { x: 0, y: 0.16, z: 0, sx: 3.0, sy: 0.3, sz: 0.6 });
  part(g, "box", 0x2c333a, { x: 1.1, y: 0.4, z: 0, sx: 0.65, sy: 0.22, sz: 0.55 });
  part(g, "box", 0x5a5248, { x: -0.35, y: 0.4, z: 0, sx: 1.5, sy: 0.2, sz: 0.5 });
  return g;
}

/** Le bateau-mouche : long, bas, silhouette vitrée. */
function buildMouche() {
  const g = new THREE.Group();
  part(g, "box", 0xf2f2f0, { x: 0, y: 0.14, z: 0, sx: 2.4, sy: 0.24, sz: 0.55 });
  // Verrière vitrée : seule pièce transparente du bateau — c'est elle qui
  // porte la « silhouette vitrée » demandée par le brief.
  part(g, "box", 0xbfe0f0, { x: 0, y: 0.42, z: 0, sx: 2.2, sy: 0.3, sz: 0.5, mat: { transparent: true, opacity: 0.55 } });
  part(g, "box", 0x2a2a2a, { x: 0, y: 0.58, z: 0, sx: 2.2, sy: 0.04, sz: 0.5 });
  return g;
}

// --- configuration des flottes -----------------------------------------

/** Vitesses gentilles (u/s le long de la courbe) — voir la note de rails.js sur l'échelle. */
export const FLEETS = [
  {
    id: "pirogues",
    label: "Pirogues gauloises",
    from: -250,
    to: 0,
    fadeIn: 0,
    fadeOut: 30,
    boats: [
      { build: buildPirogue, speed: 0.5 },
      { build: buildPirogue, speed: 0.42 },
      { build: buildPirogue, speed: 0.58 },
      { build: buildPirogue, speed: 0.36 },
    ],
  },
  {
    id: "galeres",
    label: "Galères et gabarres romaines",
    from: 0,
    to: 500,
    fadeIn: 30,
    fadeOut: 40,
    boats: [
      { build: buildGalere, speed: 0.55 },
      { build: buildGalere, speed: 0.48 },
      { build: buildGalere, speed: 0.62 },
    ],
  },
  {
    id: "drakkars",
    label: "Drakkars vikings — le siège de 885",
    from: 860,
    to: 920,
    fadeIn: 8,
    fadeOut: 8,
    boats: [
      { build: buildDrakkar, speed: 0.85 },
      { build: buildDrakkar, speed: 0.78 },
      { build: buildDrakkar, speed: 0.92 },
      { build: buildDrakkar, speed: 0.7 },
    ],
  },
  {
    id: "barques",
    label: "Barques et moulins flottants",
    from: 900,
    to: 1700,
    fadeIn: 15,
    fadeOut: 40,
    boats: [
      { build: () => buildBarque(0x6b5238), speed: 0.45 },
      { build: () => buildBarque(0x5a4530), speed: 0.4 },
      { build: () => buildBarque(0x7a5f3f), speed: 0.5 },
      { build: buildMoulinFlottant, moored: true },
      { build: buildMoulinFlottant, moored: true },
    ],
  },
  {
    id: "coches",
    label: "Coches d'eau et bateaux-lavoirs",
    from: 1700,
    to: 1900,
    fadeIn: 40,
    fadeOut: 40,
    boats: [
      { build: () => buildCoche(0x5a4a3a), speed: 0.5 },
      { build: () => buildCoche(0x4a3d2e), speed: 0.44 },
      { build: () => buildCoche(0x6a5644), speed: 0.56 },
      { build: buildLavoir, moored: true },
      { build: buildLavoir, moored: true },
    ],
  },
  {
    id: "peniches",
    label: "Péniches",
    from: 1850,
    to: Infinity,
    fadeIn: 30,
    fadeOut: 0,
    boats: [
      { build: () => buildPeniche(0x384048), speed: 0.4 },
      { build: () => buildPeniche(0x40352e), speed: 0.35 },
      { build: () => buildPeniche(0x33424a), speed: 0.44 },
      { build: () => buildPeniche(0x4a4038), speed: 0.38 },
    ],
  },
  {
    id: "mouches",
    label: "Bateaux-mouches",
    from: 1950,
    to: Infinity,
    fadeIn: 30,
    fadeOut: 0,
    boats: [
      { build: buildMouche, speed: 0.85 },
      { build: buildMouche, speed: 0.75 },
      { build: buildMouche, speed: 0.95 },
    ],
  },
];

/**
 * Présence de chaque flotte à `year` — la fonction pure testée par le node
 * test « fleet-for-year » (pirogues seules en -100, drakkars en 890, ...).
 * @param {number} year
 * @returns {Record<string, number>}
 */
export function fleetPresenceAt(year) {
  const out = {};
  for (const fleet of FLEETS) {
    out[fleet.id] = fleetPresence(year, fleet.from, fleet.to, fleet.fadeIn, fleet.fadeOut);
  }
  return out;
}

const boats = { instances: [] };

/**
 * Les bateaux sont modélisés à une échelle proche du réel (un drakkar de
 * ~26 m devient 2,6 unités). Correct pour la géographie, mais illisible
 * depuis les cadrages habituels de la frise : à distance 80-110 (préréglages
 * `cite`/`eiffel`/`chezNous`), un bateau de 2,6 unités occupe quelques
 * pixels — constat de capture (`task13-885.png`, première passe : la Seine
 * semblait vide). Même stylisation que les voitures/trains de `rails.js`
 * (grossis pour rester lisibles à l'échelle de la ville) : chaque bateau est
 * construit à sa taille "réelle" puis logé dans un groupe interne agrandi
 * ×`BOAT_VISUAL_SCALE` — le groupe *externe* (`b.group`, ci-dessous) reste à
 * l'échelle 1 pour que `scale.setScalar(presence)` (le fondu de flotte)
 * continue de partir de 1, pas de `BOAT_VISUAL_SCALE`.
 */
const BOAT_VISUAL_SCALE = 3.6;

function buildBoats(ctx) {
  boats.instances.length = 0;
  let globalIdx = 0;
  for (const fleet of FLEETS) {
    fleet.boats.forEach((spec) => {
      const inner = spec.build();
      inner.scale.setScalar(BOAT_VISUAL_SCALE);
      const group = new THREE.Group();
      group.add(inner);
      group.visible = false;
      group.frustumCulled = false;
      ctx.scene.add(group);
      const staticT = 0.15 + hash01(globalIdx, 1, 733) * 0.7;
      boats.instances.push({
        group,
        fleet,
        moored: spec.moored === true,
        speed: spec.speed ?? 0.4,
        phase: hash01(globalIdx, 2, 811) * (fleet.to === Infinity ? river.length || 1 : river.length || 1),
        lateral: (hash01(globalIdx, 3, 907) - 0.5) * 9.0,
        staticT,
        bobPhase: hash01(globalIdx, 4, 991) * Math.PI * 2,
        wheel: inner.userData.wheel ?? null,
      });
      globalIdx++;
    });
  }
}

function updateBoats(state) {
  if (river.length <= 0) return;
  const time = state.reducedMotion ? 0 : state.time;
  for (const b of boats.instances) {
    const presence = fleetPresence(state.year, b.fleet.from, b.fleet.to, b.fleet.fadeIn, b.fleet.fadeOut);
    if (presence <= 0.015) {
      if (b.group.visible) b.group.visible = false;
      continue;
    }
    b.group.visible = true;
    let t;
    if (b.moored) {
      t = b.staticT;
    } else {
      const u = (time * b.speed) / river.length + b.phase / river.length;
      t = shuttleAt(u * 2).t;
    }
    const { point, tangent } = riverPointAndTangent(t);
    const yaw = Math.atan2(-tangent.z, tangent.x);
    const nx = Math.sin(yaw);
    const nz = Math.cos(yaw);
    const bob = state.reducedMotion ? 0 : Math.sin(time * 1.1 + b.bobPhase) * 0.03;
    b.group.position.set(point.x + nx * b.lateral, 0.02 + bob, point.z + nz * b.lateral);
    b.group.rotation.set(0, yaw, state.reducedMotion ? 0 : Math.sin(time * 0.9 + b.bobPhase) * 0.02);
    b.group.scale.setScalar(presence);
    if (b.wheel) {
      // Angle absolu depuis `time` (gelé à 0 sous reducedMotion, comme le
      // reste de la couche) — pas d'intégration de `dt`, donc aucune dérive
      // et un état identique quel que soit le framerate.
      b.wheel.rotation.z = time * 0.6;
    }
  }
}

// ============================================================================
// Foules — un InstancedMesh, densité par population, teinte par époque
// ============================================================================

export const CROWD_MAX = 3000;

const CROWD_HOTSPOTS = [
  { x: LANDMARKS.notreDame.x, z: LANDMARKS.notreDame.z + 9, r: 10, weight: 3 },
  { x: LANDMARKS.forum.x, z: LANDMARKS.forum.z, r: 13, weight: 2 },
  { x: LANDMARKS.arenes.x, z: LANDMARKS.arenes.z, r: 13, weight: 2 },
  { x: LANDMARKS.louvre.x + 5, z: LANDMARKS.louvre.z + 14, r: 15, weight: 2 },
  { x: LANDMARKS.bastille.x, z: LANDMARKS.bastille.z, r: 15, weight: 3 },
  { x: LANDMARKS.operaGarnier.x, z: LANDMARKS.operaGarnier.z + 14, r: 13, weight: 2 },
  { x: LANDMARKS.tourEiffel.x, z: LANDMARKS.tourEiffel.z + 18, r: 15, weight: 3 },
  { x: LANDMARKS.chezNous.x, z: LANDMARKS.chezNous.z, r: 11, weight: 2 },
  { x: LANDMARKS.sacreCoeur.x, z: LANDMARKS.sacreCoeur.z + 12, r: 11, weight: 1 },
  { x: LANDMARKS.pontAuChange.x, z: LANDMARKS.pontAuChange.z - 8, r: 9, weight: 2 },
  { x: LANDMARKS.pantheon.x, z: LANDMARKS.pantheon.z, r: 10, weight: 1 },
  { x: LANDMARKS.invalides.x, z: LANDMARKS.invalides.z + 10, r: 10, weight: 1 },
];

/** Points de berge générés le long de la Seine navigable, des deux côtés. */
function riverbankHotspots() {
  ensureRiverCurve();
  const out = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const { point, tangent } = riverPointAndTangent(t);
    const yaw = Math.atan2(-tangent.z, tangent.x);
    const nx = Math.sin(yaw);
    const nz = Math.cos(yaw);
    for (const side of [-1, 1]) {
      out.push({ x: point.x + nx * side * 17, z: point.z + nz * side * 17, r: 7, weight: 1 });
    }
  }
  return out;
}

/**
 * Plan déterministe des emplacements de foule : hotspots pondérés (berges +
 * grands sites), dispersion par hash. Pur — aucune dépendance three.js/DOM,
 * donc testable pour la déterminisme demandée par le brief.
 * @param {number} count
 * @returns {Array<{x:number,z:number,order:number,uYear:number,yaw:number,bobPhase:number,shade:number}>}
 */
export function generateCrowdSlots(count = CROWD_MAX) {
  const hotspots = [...CROWD_HOTSPOTS, ...riverbankHotspots()];
  const totalWeight = hotspots.reduce((a, h) => a + h.weight, 0);
  const out = [];
  let hIdx = 0;
  for (const hs of hotspots) {
    const n = Math.round((hs.weight / totalWeight) * count);
    for (let i = 0; i < n && out.length < count; i++) {
      const ang = hash01(hIdx, i, 1201) * Math.PI * 2;
      const rad = Math.sqrt(hash01(hIdx, i, 1301)) * hs.r;
      const x = hs.x + Math.cos(ang) * rad;
      const z = hs.z + Math.sin(ang) * rad;
      out.push({
        x,
        z,
        order: hash01(hIdx, i, 1409),
        uYear: urbanYear(x, z),
        yaw: hash01(hIdx, i, 1511) * Math.PI * 2,
        bobPhase: hash01(hIdx, i, 1607) * Math.PI * 2,
        shade: 0.75 + hash01(hIdx, i, 1709) * 0.5,
      });
    }
    hIdx++;
  }
  // Complète jusqu'à `count` avec des emplacements génériques autour du
  // centre romain si les hotspots pondérés n'ont pas rempli le quota (arrondi).
  let filler = 0;
  while (out.length < count) {
    const ang = hash01(9000, filler, 1801) * Math.PI * 2;
    const rad = 20 + hash01(9000, filler, 1901) * 200;
    const x = Math.cos(ang) * rad;
    const z = 60 + Math.sin(ang) * rad;
    out.push({
      x,
      z,
      order: hash01(9000, filler, 1409),
      uYear: urbanYear(x, z),
      yaw: hash01(9000, filler, 1511) * Math.PI * 2,
      bobPhase: hash01(9000, filler, 1607) * Math.PI * 2,
      shade: 0.75 + hash01(9000, filler, 1709) * 0.5,
    });
    filler++;
  }
  return out;
}

/**
 * Population interpolée à une année quelconque (fondu linéaire entre les deux
 * moments de la frise qui l'encadrent — `MOMENTS[i].population`).
 * @param {number} year
 * @returns {number}
 */
export function populationAt(year) {
  const { i, j, t } = momentBlend(year, MOMENT_YEARS);
  return lerp(MOMENTS[i].population, MOMENTS[j].population, t);
}

const POP_REF = 3_000_000; // légèrement au-dessus du pic de la frise (2 900 000 en 1934)

/**
 * Nombre de silhouettes actives pour une population donnée — échelle
 * logarithmique (une ville de 1000 habitants et une ville de 3 000 000 ne
 * doivent pas différer d'un facteur 3000 à l'écran, sous peine de rendre les
 * âges anciens invisibles ou les âges modernes écrasants), multipliée par
 * `qualityCrowds` et plafonnée à `CROWD_MAX`.
 * @param {number} population
 * @param {number} [qualityCrowds=1]
 * @returns {number}
 */
export function crowdCountForPopulation(population, qualityCrowds = 1) {
  const base = clamp01(Math.log10(Math.max(population, 1) + 1) / Math.log10(POP_REF));
  return Math.min(CROWD_MAX, Math.max(0, Math.round(CROWD_MAX * base * qualityCrowds)));
}

/** Combine populationAt + crowdCountForPopulation — ce que `update` appelle. */
export function crowdCountForYear(year, qualityCrowds = 1) {
  return crowdCountForPopulation(populationAt(year), qualityCrowds);
}

/**
 * Palette costume par moment de la frise — une seule teinte par silhouette
 * (« ombre chinoise », voir la note de tête de fichier), du gaulois au jean
 * contemporain.
 */
const CROWD_PALETTES = [
  0x5a4a30, // -250 bure gauloise
  0xc9b48a, // 200 toges claires romaines
  0x4a3c2c, // 885 bure sombre du siège
  0x5c4630, // 1200 bure médiévale
  0x6b3f36, // 1370 rouges/bruns médiévaux tardifs
  0x3d4568, // 1670 habits du Grand Siècle
  0x33415e, // 1789 bleu/rouge révolutionnaire
  0x2c2c30, // 1860 redingotes sombres
  0x2c2c30, // 1865 redingotes sombres
  0x302e34, // 1889 robes/redingotes fin de siècle
  0x4a3b52, // 1900 belle époque, un peu plus colorée
  0x585044, // 1934 gris/beige
  0xb0722f, // 1973 couleurs vives 70s
  0x3a5f8a, // 2026 jean contemporain
];

/** Couleur costume à `year`, fondue entre les deux palettes voisines. */
function crowdBaseColor(year) {
  const { i, j, t } = momentBlend(year, MOMENT_YEARS);
  return new THREE.Color(CROWD_PALETTES[i]).lerp(new THREE.Color(CROWD_PALETTES[j]), t);
}

// --- géométrie fusionnée (corps + tête, un seul InstancedMesh) -------------

function buildPersonGeometry() {
  const bodyW = 0.14;
  const bodyH = 0.17;
  const bodyD = 0.1;
  const headR = 0.055;
  const body = new THREE.BoxGeometry(bodyW, bodyH, bodyD);
  body.translate(0, bodyH / 2, 0);
  const head = new THREE.IcosahedronGeometry(headR, 0);
  head.translate(0, bodyH + headR * 0.85, 0);
  // IcosahedronGeometry (contrairement à BoxGeometry) est déjà non-indexée :
  // lui appliquer toNonIndexed() quand même produit un avertissement console
  // inutile — on ne convertit donc que ce qui a effectivement un index.
  const bodyN = body.index ? body.toNonIndexed() : body;
  const headN = head.index ? head.toNonIndexed() : head;
  const bp = bodyN.getAttribute("position").array;
  const bn = bodyN.getAttribute("normal").array;
  const hp = headN.getAttribute("position").array;
  const hn = headN.getAttribute("normal").array;
  const pos = new Float32Array(bp.length + hp.length);
  pos.set(bp, 0);
  pos.set(hp, bp.length);
  const norm = new Float32Array(bn.length + hn.length);
  norm.set(bn, 0);
  norm.set(hn, bn.length);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(norm, 3));
  body.dispose();
  head.dispose();
  bodyN.dispose();
  headN.dispose();
  return geo;
}

const crowd = {
  mesh: null,
  slots: [],
  slotY: null,
  activeIndices: null,
  activeCount: 0,
  lastYear: null,
  frameParity: 0,
};

function buildCrowd(ctx) {
  const geo = buildPersonGeometry();
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  crowd.mesh = new THREE.InstancedMesh(geo, mat, CROWD_MAX);
  crowd.mesh.count = CROWD_MAX;
  crowd.mesh.frustumCulled = false;
  crowd.mesh.name = "life_crowd";
  const colors = new Float32Array(CROWD_MAX * 3);
  crowd.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  ctx.scene.add(crowd.mesh);

  crowd.slots = generateCrowdSlots(CROWD_MAX);
  crowd.slotY = new Float32Array(CROWD_MAX);
  for (let i = 0; i < crowd.slots.length; i++) {
    const s = crowd.slots[i];
    crowd.slotY[i] = groundHeightAt(s.x, s.z);
  }
  crowd.activeIndices = new Int32Array(CROWD_MAX);
  crowd.activeCount = 0;
  crowd.lastYear = null;
}

const _color = new THREE.Color();

/** Réécrit tout l'InstancedMesh pour `year` — appelé au changement d'année, pas par frame. */
function applyCrowdYear(year, qualityCrowds) {
  const activeCount = crowdCountForYear(year, qualityCrowds);
  const fraction = CROWD_MAX > 0 ? activeCount / CROWD_MAX : 0;
  const base = crowdBaseColor(year);
  let k = 0;
  for (let i = 0; i < crowd.slots.length; i++) {
    const s = crowd.slots[i];
    const active = year >= s.uYear && s.order <= fraction;
    if (!active) {
      crowd.mesh.setMatrixAt(i, _zero);
      continue;
    }
    _p.set(s.x, crowd.slotY[i], s.z);
    _q.setFromAxisAngle(UP, s.yaw);
    _s.set(1, 1, 1);
    _m.compose(_p, _q, _s);
    crowd.mesh.setMatrixAt(i, _m);
    _color.copy(base).multiplyScalar(s.shade);
    crowd.mesh.instanceColor.setXYZ(i, _color.r, _color.g, _color.b);
    crowd.activeIndices[k++] = i;
  }
  crowd.activeCount = k;
  crowd.mesh.instanceMatrix.needsUpdate = true;
  crowd.mesh.instanceColor.needsUpdate = true;
}

/** Respiration : ne retouche que les instances actives, jamais sous reducedMotion (déjà posées ci-dessus). */
function updateCrowdMotion(state) {
  if (crowd.activeCount === 0) return;
  crowd.frameParity ^= 1;
  if (crowd.frameParity === 0) return; // un cycle sur deux : la respiration reste lisible, moitié moins d'écritures
  const time = state.time;
  for (let k = 0; k < crowd.activeCount; k++) {
    const i = crowd.activeIndices[k];
    const s = crowd.slots[i];
    const bob = Math.sin(time * 1.6 + s.bobPhase) * 0.012;
    _p.set(s.x, crowd.slotY[i] + bob, s.z);
    _q.setFromAxisAngle(UP, s.yaw);
    _s.set(1, 1, 1);
    _m.compose(_p, _q, _s);
    crowd.mesh.setMatrixAt(i, _m);
  }
  crowd.mesh.instanceMatrix.needsUpdate = true;
}

// ============================================================================
// Oiseaux — 3 vols en Lissajous, toutes époques, motif de continuité
// ============================================================================

const BIRD_FLOCKS = [
  { cx: -90, cz: -140, ax: 260, az: 190, wx: 0.15, wz: 0.24, phase: 0.0, height: 58, color: 0x2b2b2b, count: 12 },
  { cx: 60, cz: 40, ax: 300, az: 170, wx: 0.11, wz: 0.19, phase: 2.1, height: 70, color: 0x40372b, count: 12 },
  { cx: -320, cz: 30, ax: 210, az: 250, wx: 0.18, wz: 0.13, phase: 4.4, height: 48, color: 0x555f66, count: 12 },
];

const BIRD_TRAIL_DT = 0.22;
const BIRD_SPACING = 2.4;
/** Instant figé sous reducedMotion — au milieu d'un cycle, pas au démarrage (aile mi-ouverte, en plein vol). */
const BIRD_FROZEN_T = 37.5;

function buildBirdGeometry() {
  // Deux triangles partageant le nez : silhouette d'oiseau en V vu de dessus,
  // +X = avant (même convention que les bateaux : yaw = atan2(-dz, dx)).
  const positions = new Float32Array([
    // triangle 1 : nez, aile gauche, centre arrière
    0.55, 0, 0, -0.5, 0.05, -0.55, -0.32, -0.02, 0,
    // triangle 2 : nez, centre arrière, aile droite
    0.55, 0, 0, -0.32, -0.02, 0, -0.5, 0.05, 0.55,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

const birds = { list: [] };

function buildBirds(ctx) {
  birds.list.length = 0;
  const geo = buildBirdGeometry();
  for (const flock of BIRD_FLOCKS) {
    const mat = sharedMat(flock.color, { side: THREE.DoubleSide });
    for (let k = 0; k < flock.count; k++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.scale.setScalar(1.1);
      ctx.scene.add(mesh);
      birds.list.push({ mesh, flock, k });
    }
  }
}

function updateBirds(state) {
  const time = state.reducedMotion ? BIRD_FROZEN_T : state.time;
  for (const b of birds.list) {
    const f = b.flock;
    const t = time - b.k * BIRD_TRAIL_DT;
    const wx = t * f.wx + f.phase;
    const wz = t * f.wz + f.phase + Math.PI / 2;
    const x0 = f.cx + Math.sin(wx) * f.ax;
    const z0 = f.cz + Math.sin(wz) * f.az;
    const dx = f.ax * f.wx * Math.cos(wx);
    const dz = f.az * f.wz * Math.cos(wz);
    const yaw = Math.atan2(-dz, dx);
    const nx = Math.sin(yaw);
    const nz = Math.cos(yaw);
    const lateral = (b.k - (f.count - 1) / 2) * BIRD_SPACING;
    b.mesh.position.set(x0 + nx * lateral, f.height + Math.sin(t * 0.6 + b.k) * 3, z0 + nz * lateral);
    b.mesh.rotation.set(0, yaw, 0);
    // battement d'aile : oscillation d'échelle (pas de vertex shader), gelé si reducedMotion.
    const flap = state.reducedMotion ? 1 : 0.65 + 0.35 * Math.sin(t * 9 + b.k * 0.7);
    b.mesh.scale.set(1.1, 1.1, 1.1 * flap);
  }
}

// ============================================================================
// Vignettes — 28 petites scènes, 2 par moment de la frise
// ============================================================================

const VIGNETTE_FADE = 15;

/**
 * Présence [0,1] d'une vignette à `year` — fenêtre [from,to] avec fondu
 * `VIGNETTE_FADE` années (`to = Infinity` : ne s'éteint jamais).
 * @param {number} year
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
export function vignettePresence(year, from, to) {
  if (year < from) {
    const t = (year - (from - VIGNETTE_FADE)) / VIGNETTE_FADE;
    return t <= 0 ? 0 : smoothstep(t);
  }
  if (to !== Infinity && year > to) {
    const t = 1 - (year - to) / VIGNETTE_FADE;
    return t <= 0 ? 0 : smoothstep(t);
  }
  return 1;
}

/** true si la vignette se lit comme « active » (au-delà du milieu du fondu). */
export function vignetteActive(year, from, to) {
  return vignettePresence(year, from, to) > 0.5;
}

const CN = LANDMARKS.chezNous; // (-131, -497) — les vignettes 8 et 12 y vivent

// --- petits accessoires de scène (réutilisent `part()`) --------------------

function propBoar() {
  const g = new THREE.Group();
  part(g, "box", 0x4a3626, { x: 0, y: 0.1, z: 0, sx: 0.5, sy: 0.2, sz: 0.22 });
  part(g, "cone", 0x3a2a1c, { x: 0.28, y: 0.12, z: 0, sx: 0.14, sy: 0.2, sz: 0.14, rz: -1.4 });
  return g;
}

function propFisherman() {
  const g = buildPirogue(0x4a3a2a);
  part(g, "box", 0x6b4a34, { x: 0, y: 0.28, z: 0, sx: 0.13, sy: 0.22, sz: 0.1 });
  part(g, "ico", 0xd8b98a, { x: 0, y: 0.4, z: 0, sx: 0.09, sy: 0.09, sz: 0.09 });
  return g;
}

function propBlobPeople(n, hex, spread = 1.2) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const a = hash01(i, 1, 2003) * Math.PI * 2;
    const r = hash01(i, 2, 2011) * spread;
    part(g, "box", hex, { x: Math.cos(a) * r, y: 0.11, z: Math.sin(a) * r, sx: 0.14, sy: 0.22, sz: 0.11 });
    part(g, "ico", 0xd8b98a, { x: Math.cos(a) * r, y: 0.24, z: Math.sin(a) * r, sx: 0.09, sy: 0.09, sz: 0.09 });
  }
  return g;
}

function propGladiators() {
  const g = new THREE.Group();
  for (let i = 0; i < 2; i++) {
    const x = i === 0 ? -0.18 : 0.18;
    part(g, "box", 0xc9b48a, { x, y: 0.12, z: 0, sx: 0.15, sy: 0.24, sz: 0.12 });
    part(g, "ico", 0xd8b98a, { x, y: 0.26, z: 0, sx: 0.09, sy: 0.09, sz: 0.09 });
    part(g, "box", 0x8a8a8a, { x: x + (i === 0 ? 0.1 : -0.1), y: 0.2, z: 0, sx: 0.03, sy: 0.22, sz: 0.03 });
  }
  return g;
}

function propMiniDrakkars(count) {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const mini = new THREE.Group();
    part(mini, "box", 0x2a1d12, { x: 0, y: 0.08, z: 0, sx: 0.7, sy: 0.14, sz: 0.2 });
    part(mini, "cone", 0x1c130b, { x: 0.42, y: 0.2, z: 0, sx: 0.12, sy: 0.2, sz: 0.12, rz: -1.1 });
    mini.position.set(0, 0, i * 0.6 - count * 0.3);
    g.add(mini);
  }
  return g;
}

function propDefenders(n) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const z = i * 0.4 - (n - 1) * 0.2;
    part(g, "box", 0x555a5f, { x: 0, y: 0.13, z, sx: 0.14, sy: 0.24, sz: 0.11 });
    part(g, "ico", 0xd8b98a, { x: 0, y: 0.28, z, sx: 0.09, sy: 0.09, sz: 0.09 });
  }
  return g;
}

function propMarketStalls(n) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const x = i * 0.5 - (n - 1) * 0.25;
    part(g, "box", 0x6b5238, { x, y: 0.1, z: 0, sx: 0.32, sy: 0.2, sz: 0.32 });
    part(g, "cone", 0xb04434, { x, y: 0.24, z: 0, sx: 0.4, sy: 0.16, sz: 0.4 });
  }
  return g;
}

function propGuard() {
  const g = new THREE.Group();
  part(g, "box", 0x3a3a44, { x: 0, y: 0.13, z: 0, sx: 0.15, sy: 0.26, sz: 0.12 });
  part(g, "ico", 0xd8b98a, { x: 0, y: 0.28, z: 0, sx: 0.09, sy: 0.09, sz: 0.09 });
  part(g, "box", 0x8a8a8a, { x: 0.1, y: 0.24, z: 0, sx: 0.03, sy: 0.3, sz: 0.03 });
  return g;
}

function propSheep(n) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const a = hash01(i, 5, 2101) * Math.PI * 2;
    const r = hash01(i, 6, 2109) * 1.1;
    part(g, "ico", 0xe8e4d8, { x: Math.cos(a) * r, y: 0.1, z: Math.sin(a) * r, sx: 0.16, sy: 0.13, sz: 0.16 });
    part(g, "box", 0x2a2a2a, { x: Math.cos(a) * r + 0.1, y: 0.09, z: Math.sin(a) * r, sx: 0.06, sy: 0.06, sz: 0.06 });
  }
  return g;
}

function propStrollers(n) {
  return propBlobPeople(n, 0x3d4568, 1.4);
}

function propCarriage() {
  const g = new THREE.Group();
  part(g, "box", 0x4a2f22, { x: 0, y: 0.18, z: 0, sx: 0.6, sy: 0.22, sz: 0.3 });
  part(g, "box", 0x8a6a44, { x: 0, y: 0.34, z: 0, sx: 0.5, sy: 0.12, sz: 0.28 });
  for (const sx of [-0.22, 0.22]) {
    part(g, "cyl", 0x2a2018, { x: sx, y: 0.09, z: 0.17, sx: 0.16, sy: 0.05, sz: 0.16, rx: Math.PI / 2 });
    part(g, "cyl", 0x2a2018, { x: sx, y: 0.09, z: -0.17, sx: 0.16, sy: 0.05, sz: 0.16, rx: Math.PI / 2 });
  }
  return g;
}

function propCrowdAndSmoke(nPeople) {
  const g = propBlobPeople(nPeople, 0x33415e, 1.6);
  for (let i = 0; i < 3; i++) {
    part(g, "ico", 0x8a8880, { x: (i - 1) * 0.3, y: 0.5 + i * 0.15, z: 0, sx: 0.3 + i * 0.08, sy: 0.3 + i * 0.08, sz: 0.3 + i * 0.08, mat: { transparent: true, opacity: 0.4 } });
  }
  return g;
}

function propTrainFlags() {
  const g = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const x = i * 0.35 - 0.52;
    part(g, "box", 0x5a4a34, { x, y: 0.2, z: 0, sx: 0.02, sy: 0.4, sz: 0.02 });
    part(g, "plane", i % 2 === 0 ? 0x33415e : 0xb04434, { x, y: 0.36, z: 0.1, sx: 0.16, sy: 0.11, sz: 1 });
  }
  return g;
}

function propFamily() {
  const g = new THREE.Group();
  part(g, "box", 0x6b4a3a, { x: -0.15, y: 0.14, z: 0, sx: 0.15, sy: 0.26, sz: 0.12 });
  part(g, "ico", 0xd8b98a, { x: -0.15, y: 0.29, z: 0, sx: 0.09, sy: 0.09, sz: 0.09 });
  part(g, "box", 0x8a5a4a, { x: 0.12, y: 0.14, z: 0, sx: 0.14, sy: 0.24, sz: 0.11 });
  part(g, "ico", 0xd8b98a, { x: 0.12, y: 0.28, z: 0, sx: 0.085, sy: 0.085, sz: 0.085 });
  part(g, "box", 0xb0722f, { x: -0.02, y: 0.08, z: 0.1, sx: 0.09, sy: 0.15, sz: 0.08 });
  part(g, "ico", 0xd8b98a, { x: -0.02, y: 0.17, z: 0.1, sx: 0.06, sy: 0.06, sz: 0.06 });
  return g;
}

function propScaffolding() {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const y = 0.1 + i * 0.22;
    part(g, "box", 0x6a6f74, { x: 0, y, z: 0, sx: 0.55, sy: 0.03, sz: 0.03 });
    part(g, "box", 0x6a6f74, { x: 0, y, z: 0.2, sx: 0.55, sy: 0.03, sz: 0.03 });
  }
  for (const x of [-0.27, 0.27]) {
    part(g, "box", 0x6a6f74, { x, y: 0.35, z: 0, sx: 0.03, sy: 0.7, sz: 0.03 });
    part(g, "box", 0x6a6f74, { x, y: 0.35, z: 0.2, sx: 0.03, sy: 0.7, sz: 0.03 });
  }
  return g;
}

function propOmnibus() {
  const g = new THREE.Group();
  part(g, "box", 0x4a3a2c, { x: -0.2, y: 0.2, z: 0, sx: 0.55, sy: 0.3, sz: 0.28 });
  part(g, "box", 0x2a2a2a, { x: 0.35, y: 0.14, z: 0, sx: 0.35, sy: 0.22, sz: 0.16 }); // le cheval, silhouette simple
  for (const sx of [-0.4, 0]) {
    part(g, "cyl", 0x1a1a1a, { x: sx, y: 0.09, z: 0.15, sx: 0.16, sy: 0.05, sz: 0.16, rx: Math.PI / 2 });
    part(g, "cyl", 0x1a1a1a, { x: sx, y: 0.09, z: -0.15, sx: 0.16, sy: 0.05, sz: 0.16, rx: Math.PI / 2 });
  }
  return g;
}

function propTripodPhotographer() {
  const g = new THREE.Group();
  for (const a of [0, 2.1, 4.2]) {
    part(g, "box", 0x2a2018, { x: Math.cos(a) * 0.12, y: 0.15, z: Math.sin(a) * 0.12, sx: 0.02, sy: 0.3, sz: 0.02, rz: Math.cos(a) * 0.15, rx: Math.sin(a) * 0.15 });
  }
  part(g, "box", 0x1a1a1a, { x: 0, y: 0.32, z: 0, sx: 0.14, sy: 0.1, sz: 0.16 });
  part(g, "box", 0x3a3a44, { x: 0, y: 0.13, z: 0.2, sx: 0.14, sy: 0.24, sz: 0.11 });
  part(g, "ico", 0xd8b98a, { x: 0, y: 0.28, z: 0.2, sx: 0.09, sy: 0.09, sz: 0.09 });
  return g;
}

function propMetroQueueAndArch() {
  const g = propBlobPeople(4, 0x4a3b52, 0.9);
  part(g, "box", 0x2f6b4a, { x: 0, y: 0.35, z: -0.5, sx: 0.7, sy: 0.05, sz: 0.05 });
  part(g, "box", 0x2f6b4a, { x: -0.34, y: 0.18, z: -0.5, sx: 0.05, sy: 0.4, sz: 0.05 });
  part(g, "box", 0x2f6b4a, { x: 0.34, y: 0.18, z: -0.5, sx: 0.05, sy: 0.4, sz: 0.05 });
  return g;
}

function propKiosk() {
  const g = new THREE.Group();
  part(g, "cyl", 0x2f5f4a, { x: 0, y: 0.25, z: 0, sx: 0.4, sy: 0.5, sz: 0.4 });
  part(g, "cone", 0x1a1a1a, { x: 0, y: 0.52, z: 0, sx: 0.5, sy: 0.22, sz: 0.5 });
  return g;
}

function propChildrenOnRails() {
  return propBlobPeople(2, 0xb0722f, 0.5);
}

function propCat() {
  const g = new THREE.Group();
  part(g, "box", 0x3a3a3a, { x: 0, y: 0.08, z: 0, sx: 0.24, sy: 0.1, sz: 0.1 });
  part(g, "ico", 0x3a3a3a, { x: 0.14, y: 0.12, z: 0, sx: 0.08, sy: 0.08, sz: 0.08 });
  return g;
}

function propMovingTruck() {
  const g = new THREE.Group();
  part(g, "box", 0xd8d3c4, { x: -0.15, y: 0.22, z: 0, sx: 0.5, sy: 0.35, sz: 0.3 });
  part(g, "box", 0x8a2f2f, { x: 0.28, y: 0.18, z: 0, sx: 0.24, sy: 0.24, sz: 0.28 });
  for (const sx of [-0.35, 0.05, 0.4]) {
    part(g, "cyl", 0x1a1a1a, { x: sx, y: 0.07, z: 0.16, sx: 0.14, sy: 0.06, sz: 0.14, rx: Math.PI / 2 });
    part(g, "cyl", 0x1a1a1a, { x: sx, y: 0.07, z: -0.16, sx: 0.14, sy: 0.06, sz: 0.14, rx: Math.PI / 2 });
  }
  return g;
}

function propRoofAntennas(n) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const x = i * 0.45 - (n - 1) * 0.22;
    part(g, "box", 0x8a8a8a, { x, y: 0.2, z: 0, sx: 0.02, sy: 0.4, sz: 0.02 });
    part(g, "box", 0x8a8a8a, { x, y: 0.35, z: 0, sx: 0.22, sy: 0.02, sz: 0.02 });
    part(g, "box", 0x8a8a8a, { x, y: 0.3, z: 0, sx: 0.14, sy: 0.02, sz: 0.02 });
  }
  return g;
}

function propJoggers(n) {
  return propBlobPeople(n, 0xb0722f, 1.0);
}

function propFamilyOverlook() {
  const g = propFamily();
  return g;
}

// --- table des 28 vignettes -------------------------------------------------

/**
 * @typedef {{id:number, label:string, x:number, z:number, from:number, to:number, build:() => THREE.Group}} VignetteDef
 * @type {VignetteDef[]}
 */
export const VIGNETTES = [
  { id: 1, label: "sanglier près des huttes", x: LANDMARKS.notreDame.x - 6, z: LANDMARKS.notreDame.z - 4, from: -250, to: 0, build: propBoar },
  { id: 2, label: "pêcheur sur pirogue", x: LANDMARKS.notreDame.x + 14, z: LANDMARKS.notreDame.z + 6, from: -250, to: 20, build: propFisherman },
  { id: 3, label: "file au forum", x: LANDMARKS.forum.x, z: LANDMARKS.forum.z + 3, from: 0, to: 500, build: () => propBlobPeople(4, 0xc9b48a, 1.1) },
  { id: 4, label: "gladiateurs aux arènes", x: LANDMARKS.arenes.x, z: LANDMARKS.arenes.z, from: 0, to: 500, build: propGladiators },
  { id: 5, label: "drakkars alignés bras nord", x: LANDMARKS.notreDame.x + 26, z: LANDMARKS.notreDame.z - 12, from: 860, to: 920, build: () => propMiniDrakkars(3) },
  { id: 6, label: "défenseurs sur le rempart", x: LANDMARKS.notreDame.x - 8, z: LANDMARKS.notreDame.z + 3, from: 860, to: 920, build: () => propDefenders(3) },
  { id: 7, label: "marché sur le parvis (remplace les grues)", x: LANDMARKS.notreDame.x, z: LANDMARKS.notreDame.z + 8, from: 1160, to: 1345, build: () => propMarketStalls(3) },
  { id: 8, label: "marché sur le pont au Change", x: LANDMARKS.pontAuChange.x, z: LANDMARKS.pontAuChange.z, from: 1160, to: 1345, build: () => propMarketStalls(3) },
  { id: 9, label: "garde à la Bastille", x: LANDMARKS.bastille.x - 3, z: LANDMARKS.bastille.z, from: 1370, to: 1789, build: propGuard },
  { id: 10, label: "moutons hors les murs", x: -190, z: -230, from: 1370, to: 1670, build: () => propSheep(4) },
  { id: 11, label: "promeneurs sur les boulevards", x: -60, z: -150, from: 1600, to: 1789, build: () => propStrollers(3) },
  { id: 12, label: "carrosse au Louvre", x: LANDMARKS.louvre.x + 10, z: LANDMARKS.louvre.z + 12, from: 1600, to: 1789, build: propCarriage },
  { id: 13, label: "foule dense place de la Bastille", x: LANDMARKS.bastille.x + 4, z: LANDMARKS.bastille.z + 4, from: 1788, to: 1791, build: () => propCrowdAndSmoke(4) },
  { id: 14, label: "fumées", x: LANDMARKS.bastille.x - 4, z: LANDMARKS.bastille.z - 6, from: 1788, to: 1793, build: () => propCrowdAndSmoke(0) },
  { id: 15, label: "fanions au premier train (chez nous)", x: CN.x + 6, z: CN.z + 3, from: 1820, to: 1900, build: propTrainFlags },
  { id: 16, label: "famille qui regarde passer (chez nous)", x: CN.x - 6, z: CN.z - 2, from: 1820, to: 1900, build: propFamily },
  { id: 17, label: "échafaudages haussmanniens", x: -100, z: -110, from: 1850, to: 1900, build: propScaffolding },
  { id: 18, label: "omnibus à chevaux", x: -70, z: -140, from: 1850, to: 1900, build: propOmnibus },
  { id: 19, label: "foule au pied de la Tour", x: LANDMARKS.tourEiffel.x, z: LANDMARKS.tourEiffel.z + 12, from: 1889, to: 1930, build: () => propBlobPeople(4, 0x302e34, 1.3) },
  { id: 20, label: "photographe à trépied", x: LANDMARKS.tourEiffel.x + 10, z: LANDMARKS.tourEiffel.z + 6, from: 1889, to: 1930, build: propTripodPhotographer },
  { id: 21, label: "file à la bouche de métro Art nouveau", x: LANDMARKS.operaGarnier.x, z: LANDMARKS.operaGarnier.z + 8, from: 1900, to: 1939, build: propMetroQueueAndArch },
  { id: 22, label: "kiosque à journaux (remplace la rame déjà là)", x: -110, z: -130, from: 1870, to: 1990, build: propKiosk },
  { id: 23, label: "enfants qui jouent sur les rails morts (chez nous)", x: CN.x + 3, z: CN.z + 8, from: 1937, to: Infinity, build: propChildrenOnRails },
  { id: 24, label: "chat sur le remblai (chez nous)", x: CN.x - 4, z: CN.z + 5, from: 1937, to: Infinity, build: propCat },
  { id: 25, label: "déménagement en camion", x: -60, z: -420, from: 1955, to: 2000, build: propMovingTruck },
  { id: 26, label: "antennes TV sur les toits", x: -40, z: -400, from: 1955, to: 2010, build: () => propRoofAntennas(3) },
  { id: 27, label: "joggeurs sur la coulée verte", x: ringPoint(RINGS.petiteCeinture, 0.9).x, z: ringPoint(RINGS.petiteCeinture, 0.9).z, from: 2000, to: Infinity, build: () => propJoggers(2) },
  { id: 28, label: "famille qui montre la Tour depuis Montmartre (= vous)", x: LANDMARKS.sacreCoeur.x + 6, z: LANDMARKS.sacreCoeur.z + 4, from: 2000, to: Infinity, build: propFamilyOverlook },
];

export const VIGNETTE_VISIBLE_DISTANCE = 400;

const vignettes = { entries: [] };
let camera = null;

function buildVignettes(ctx) {
  vignettes.entries.length = 0;
  for (const def of VIGNETTES) {
    const group = def.build();
    const y = groundHeightAt(def.x, def.z);
    group.position.set(def.x, y, def.z);
    group.visible = false;
    group.frustumCulled = false;
    ctx.scene.add(group);
    vignettes.entries.push({ def, group });
  }
}

function updateVignettes(state) {
  const camPos = camera ? camera.position : null;
  for (const v of vignettes.entries) {
    const presence = vignettePresence(state.year, v.def.from, v.def.to);
    if (presence <= 0.02) {
      if (v.group.visible) v.group.visible = false;
      continue;
    }
    let farAway = false;
    if (camPos) {
      const dx = camPos.x - v.def.x;
      const dz = camPos.z - v.def.z;
      farAway = dx * dx + dz * dz > VIGNETTE_VISIBLE_DISTANCE * VIGNETTE_VISIBLE_DISTANCE;
    }
    if (farAway) {
      if (v.group.visible) v.group.visible = false;
      continue;
    }
    v.group.visible = true;
    v.group.scale.setScalar(presence);
  }
}

// ============================================================================
// Contrat de layer
// ============================================================================

let lastAppliedYear = null;
// `ctx.quality.crowds` est capturé une fois à l'init — même convention que
// `terrain.js` (`buildForestCandidates(ctx.quality)`, lu seulement à l'init) :
// `state` n'a pas de champ `quality` dans le contrat actuel de main.js, donc
// aucun layer ne le relit à chaque rescan.
let qualityCrowds = 1;

function rescanAll(year) {
  applyCrowdYear(year, qualityCrowds);
}

export function init(ctx) {
  ensureRiverCurve();
  qualityCrowds = ctx.quality?.crowds ?? 1;
  buildBoats(ctx);
  buildCrowd(ctx);
  buildBirds(ctx);
  buildVignettes(ctx);
  camera = ctx.camera ?? null;
  lastAppliedYear = null;
  rescanAll(2026);
  lastAppliedYear = 2026;
}

export function update(dt, state) {
  if (state.year !== lastAppliedYear) {
    rescanAll(state.year);
    lastAppliedYear = state.year;
  }
  updateBoats(state);
  if (!state.reducedMotion) updateCrowdMotion(state);
  updateBirds(state);
  updateVignettes(state);
}

/** Même contrat que rails.forceRescan / walls.forceRescan. */
export function forceRescan(year) {
  rescanAll(year);
  lastAppliedYear = year;
}

/** Diagnostic pour la vérification automatisée (window.__paris). */
export function debugCounts(year) {
  const fleets = fleetPresenceAt(year);
  const activeBoats = boats.instances.filter((b) => fleetPresence(year, b.fleet.from, b.fleet.to, b.fleet.fadeIn, b.fleet.fadeOut) > 0.5).length;
  const activeVignettes = VIGNETTES.filter((v) => vignetteActive(year, v.from, v.to)).map((v) => v.id);
  return {
    fleets,
    activeBoats,
    totalBoats: boats.instances.length,
    crowdActive: crowd.activeCount,
    crowdTarget: crowdCountForYear(year),
    population: Math.round(populationAt(year)),
    activeVignettes,
  };
}

/** Diagnostic oiseaux : position réelle des 3 têtes de vol (vérification automatisée). */
export function debugBirds() {
  return birds.list
    .filter((b) => b.k === 0)
    .map((b) => ({
      x: Math.round(b.mesh.position.x),
      y: Math.round(b.mesh.position.y),
      z: Math.round(b.mesh.position.z),
    }));
}

/** Diagnostic bateaux : position/visibilité réelles (vérification automatisée). */
export function debugBoats() {
  return boats.instances.map((b) => ({
    fleet: b.fleet.id,
    moored: b.moored,
    visible: b.group.visible,
    x: Math.round(b.group.position.x * 10) / 10,
    y: Math.round(b.group.position.y * 100) / 100,
    z: Math.round(b.group.position.z * 10) / 10,
    scale: Math.round(b.group.scale.x * 100) / 100,
  }));
}

/** Nombre d'objets construits (coût de la couche). */
export function stats() {
  return {
    boats: boats.instances.length,
    crowdCapacity: CROWD_MAX,
    birds: birds.list.length,
    vignettes: vignettes.entries.length,
    riverLength: Math.round(river.length),
  };
}
