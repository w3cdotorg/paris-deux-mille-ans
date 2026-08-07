/**
 * Rails layer — les trois rubans qui tournent autour de Paris.
 *
 * C'est la couche la plus personnelle du projet. Chez Raphaël, à (−131, −497),
 * la géographie raconte à elle seule un siècle et demi :
 *
 *  - **1852-1869** : la *petite ceinture* se referme tronçon par tronçon sur
 *    l'ellipse `RINGS.petiteCeinture`. Au nord, elle passe à z ≈ −495 : deux
 *    unités (20 m) au sud de la maison, littéralement **au bout de la rue**.
 *  - **1869-1934** : douze trains à vapeur y tournent (six par sens, un par
 *    voie), panache de fumée compris. C'est *le* bruit de fond du quartier
 *    pendant trois générations.
 *  - **1934** : les trains s'arrêtent. Les rails restent, ternissent, et la
 *    végétation les colonise de 1940 à 2000 — la coulée verte d'aujourd'hui.
 *  - **1958-1973** : le *périphérique* se coule sur l'ellipse `RINGS.
 *    peripherique`, au nord, à z ≈ −510 : treize unités de l'autre côté.
 *
 * Résultat, et c'est la promesse du brief : de 1973 à 2026, **chez nous est
 * exactement entre les deux anneaux** — le périph qui gronde au nord, les rails
 * endormis sous les ronces au sud.
 *
 * S'y ajoute le **viaduc de Barbès** (le métro aérien, 1903), qui traverse le
 * 18e d'est en ouest en surplombant le boulevard sur ses piliers rivetés.
 *
 * ============================================================================
 * Ce qui est réutilisé plutôt que réécrit
 *
 * La progression « tronçon par tronçon » est *exactement* celle des enceintes :
 * `wallRingPlan` découpe une polyligne en segments indexés par distance
 * cumulée, et `segmentPresence` traduit la présence globale de `lifecycle` en
 * présence locale à chaque segment. Ces deux fonctions pures sont donc
 * importées de `walls.js` au lieu d'être dupliquées ici : un anneau de rails et
 * un mur d'enceinte se referment de la même façon, et c'est bien le même
 * mécanisme qu'on veut voir à l'écran.
 *
 * ============================================================================
 * Coût et discipline d'animation
 *
 * Tout est en `InstancedMesh` de capacité fixe, réécrits par année (comme
 * walls.js) ou par frame pour ce qui bouge :
 *
 *  - par changement d'année : ~2 700 matrices (remblai + rails + 1 800 touffes
 *    + ruban et terre-plein du périph + viaduc) ;
 *  - par frame : 48 caisses de train + 12 cheminées + 3 voitures de métro +
 *    640 voitures, plus 640 phares **seulement la nuit** — soit ~700 matrices
 *    en journée, ~1 350 la nuit.
 *
 * Aucune allocation dans `update` : positions paramétriques le long des courbes
 * (pas de physique), scratch three.js partagé, fumée en pool fixe.
 *
 * Conventions héritées de geography.js : 1 unité = 10 m, x = est, z = sud.
 */

import * as THREE from "three";
import { RINGS, VIADUC_AXIS } from "../geography.js";
import { lifecycle, lerp, easeOutBack } from "../timeEngine.js";
import { groundHeightAt } from "./terrain.js";
import { wallRingPlan, segmentPresence, sampleEllipsePoints } from "./walls.js";

// ============================================================================
// Petit hash déterministe (même famille que geography.js/walls.js)
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
// Configuration — les dates, exportées pour être testables
// ============================================================================

/**
 * La petite ceinture : ouverte par tronçons de 1852 à 1869 (c'est l'histoire
 * réelle : le premier tronçon rive droite en 1852, le bouclage complet en 1869).
 */
export const PETITE_CEINTURE = {
  id: "petiteCeinture",
  born: 1852,
  buildYears: 17,
  // Pas de `died` : les rails ne sont *jamais* enlevés. Ils s'endorment.
  ring: RINGS.petiteCeinture,
  segments: 128,
  embankmentW: 2.4, // largeur du remblai
  embankmentH: 0.34, // hauteur du remblai au-dessus du sol
  gauge: 1.05, // écartement des deux rails (voie double stylisée)
};

/**
 * Les trains à vapeur : mis en service au bouclage (1869), service voyageurs
 * arrêté en 1934. En dehors de cette fenêtre, aucun train n'est écrit.
 *
 * **12 trains, et non 3** (écart assumé au brief, chiffré) : l'anneau mesure
 * ~3 030 unités, soit 30 km. Trois trains y occupent 3 × 7 unités, c'est-à-dire
 * 0,7 % du périmètre — depuis la vue « chez nous » (une soixantaine d'unités de
 * large), la probabilité qu'un train soit à l'image à un instant donné tombe
 * sous 3 %, et il faut attendre ~2 minutes de temps réel pour en voir passer
 * un. Autrement dit : la fonctionnalité la plus personnelle du projet — « le
 * train fume au bout de la rue » — serait invisible.
 *
 * 12 trains, c'est aussi le chiffre **historiquement juste** : avec un
 * intervalle de 10 minutes par sens et une vitesse commerciale de 30 km/h, la
 * petite ceinture portait un train tous les 5 km, donc 6 par sens. On les
 * répartit d'ailleurs comme en vrai : 6 sur la voie extérieure, 6 sur la voie
 * intérieure, en sens inverse — et c'est précisément ce que rendent les deux
 * files de rails.
 */
export const TRAIN_WINDOW = { from: 1869, to: 1934 };
export const TRAIN_COUNT = 12;
/** Trains par sens de circulation (une voie chacun). */
export const TRAINS_PER_DIRECTION = TRAIN_COUNT / 2;
export const CARS_PER_TRAIN = 4; // 1 locomotive + 3 wagons

/**
 * La colonisation végétale : elle démarre en 1940 (six ans après le dernier
 * train) et met soixante ans à tout recouvrir — la coulée verte est complète
 * vers 2000 et le reste ensuite.
 */
export const VEGETATION = { born: 1940, buildYears: 60 };
// 900 touffes sur 3 030 unités, soit une tous les 34 m : c'est ce qu'il faut
// pour que l'anneau se lise comme une *coulée* verte continue et non comme une
// file de buissons isolés (constat des captures task11-1960 et task11-coulee).
export const VEGETATION_COUNT = 900;

/**
 * Le périphérique : premier tronçon 1958 (porte de Ternes), bouclage 1973.
 * Il **remplace spatialement** le mur de Thiers (walls.js, mort en 1919) sur la
 * même ellipse — d'où le fait que le couloir soit vide de bâti depuis toujours
 * (voir `insideRailCorridor` dans geography.js).
 */
export const PERIPHERIQUE = {
  id: "peripherique",
  born: 1958,
  buildYears: 15,
  ring: RINGS.peripherique,
  segments: 128,
  laneW: 2.3, // largeur d'une chaussée
  laneGap: 0.55, // terre-plein central
  deckH: 0.22,
};

/**
 * **640 voitures, et non ~200** (second écart assumé au brief, même cause que
 * les trains) : le périphérique mesure ~3 170 unités, soit 32 km. 200 voitures
 * sur 4 files, c'est une voiture tous les 630 m par file — vu de la rue, le
 * ruban est vide. 640 en met une tous les 200 m, ce qui lit enfin comme un
 * *flux*. C'est encore **six fois moins** que la réalité (un périphérique
 * chargé porte ~33 voitures/km/file, donc ~4 000 sur l'anneau) : on reste très
 * en dessous, pour ne pas transformer la chaussée en ruban continu de tôle.
 * Coût : 640 matrices par frame (1 280 la nuit, avec les phares), sur un budget
 * qui tient déjà 75 fps.
 */
export const CAR_COUNT = 640;
/** Décalage latéral des 4 files, du bord intérieur au bord extérieur. */
export const CAR_LANES = [-1.85, -0.75, 0.75, 1.85];

/**
 * Le viaduc de Barbès (ligne 2 du métro, aérienne) : 1903-1905, d'ouest en
 * est au-dessus du boulevard. Les rames y font la navette depuis.
 */
export const VIADUC = {
  id: "viaducBarbes",
  born: 1903,
  buildYears: 2,
  // Tracé partagé avec geography.js, qui en tient le couloir libre de bâti
  // (le métro aérien passe au-dessus d'un boulevard, pas à travers les murs).
  a: VIADUC_AXIS.a,
  b: VIADUC_AXIS.b,
  spans: 20, // travées (donc 21 piliers)
  clearance: 0.95, // hauteur du dessous du tablier au-dessus du sol
  deckW: 1.5,
  deckH: 0.28,
  pillarW: 0.5,
};
/** Année de la mise en service des rames bleues (fin du « Sprague » vert). */
export const METRO_BLUE_FROM = 1970;
export const METRO_CARS = 3;

// ============================================================================
// Vitesses — assumées non réalistes, et pourquoi
// ============================================================================
//
// À l'échelle 1 unité = 10 m, un train à 40 km/h avance de 1,1 unité/s et une
// voiture à 70 km/h de 1,9 unité/s. Sur un anneau de ~3 000 unités vu depuis la
// vue d'ensemble, cela ne *bouge pas* : un tour de périphérique prendrait une
// demi-heure de temps réel. Les vitesses ci-dessous sont donc multipliées par
// ~2,5 — assez pour qu'un enfant de 4 ans voie le train passer et le flux
// couler, assez lent pour que ça reste un mouvement de circulation et pas de
// téléportation. Un tour complet fait ~10 min pour un train, ~13 min pour une
// voiture.
const TRAIN_SPEED = 7.5; // unités/s (le long de la courbe)
const TRAIN_SPEED_SPREAD = 0.9; // les trains ne roulent pas exactement pareil
const CAR_SPEED = 4.0;
const CAR_SPEED_SPREAD = 1.1;
const METRO_SPEED = 4.5;

const SMOKE_POOL_SIZE = 48;
const SMOKE_LIFE = 2.6; // secondes
// Un panache toutes les 0,85 s par locomotive : avec 12 locomotives et une vie
// de 2,6 s, cela plafonne à ~37 bouffées simultanées, sous la taille du pool.
const SMOKE_INTERVAL = 0.85;

// ============================================================================
// Couleurs
// ============================================================================

const COLORS = {
  ballast: 0x7c7468, // remblai de la petite ceinture
  rail: 0x9aa3a8, // acier vif quand les trains roulent
  railRust: 0x6d5f4f, // rails ternis après 1934
  loco: 0x2b2b2f,
  wagonA: 0x6b4a3a,
  wagonB: 0x4a5560,
  smoke: 0xd8d4cc,
  bush: 0x4d7b3f,
  bushLight: 0x6b9450,
  // Correctif "on ne voit pas le périph" (post-v1 A) : l'ancien 0x5a5c60,
  // rendu sous l'éclairage de crépuscule (voir weather.js), tombait à peu
  // près à la même luminance que les toits alentour — un ruban gris parmi
  // des toits gris n'est pas un ruban. Un bitume nettement plus sombre reste
  // lisible quel que soit le moment de la frise (plein jour ou crépuscule),
  // parce qu'il n'a alors plus besoin de rivaliser d'exposition avec le sol :
  // il est simplement plus bas que tout le reste.
  asphalt: 0x2c2d31,
  // La glissière/bande de rive est posée en matériau non éclairé (Basic,
  // voir buildPeripherique) — comme une glissière réfléchissante réelle, sa
  // clarté ne dépend donc pas de l'heure de la frise : c'est elle qui trace
  // l'anneau à l'oeil, même de nuit ou sous un ciel couvert.
  asphaltEdge: 0xcdd0c8,
  median: 0x9aa08f, // terre-plein central (bordure béton + un peu de vert)
  metroGreen: 0x2f6b4a,
  metroBlue: 0x2b4f88,
  viaductIron: 0x6a6f74,
  viaductDeck: 0x8a8073,
  headlight: 0xfff3cf,
};

/**
 * Les 8 teintes de la circulation. Recentrées (post-v1 A) sur des tons
 * clairs/saturés plutôt que des gris moyens : avec le matériau Basic ci-dessus
 * la teinte se voit désormais pleine à l'écran, donc un gris moyen comme
 * l'ancien 0x8f9296 se serait retrouvé aussi clair que le bitume — un comble
 * pour une "pastille" censée s'en détacher.
 */
const CAR_COLORS = [0xd9dbd5, 0xece8dc, 0x2f3136, 0xc23f2c, 0x3568a8, 0xe4dcc8, 0x4f7a45, 0xe6b93a];

// ============================================================================
// Géométrie pure — points, tangentes, plans (testable sans WebGL)
// ============================================================================

/**
 * Point de l'ellipse à l'angle paramétrique `a`.
 * @param {{cx:number,cz:number,rx:number,rz:number}} ring
 * @param {number} a
 * @returns {{x:number, z:number}}
 */
export function ringPoint(ring, a) {
  return { x: ring.cx + Math.cos(a) * ring.rx, z: ring.cz + Math.sin(a) * ring.rz };
}

/**
 * Lacet (rotation autour de +Y) alignant l'axe local +X sur la tangente de
 * l'ellipse à l'angle `a`, dans le sens des `a` croissants. Même convention que
 * `wallRingPlan().segments[].angle` : `Quaternion.setFromAxisAngle(UP, angle)`
 * envoie +X sur (dx, dz), donc `angle = atan2(-dz, dx)`.
 * @param {{rx:number,rz:number}} ring
 * @param {number} a
 * @param {number} [dir=1] - +1 dans le sens des a croissants, -1 à contresens
 * @returns {number}
 */
export function ringYaw(ring, a, dir = 1) {
  const dx = -Math.sin(a) * ring.rx * dir;
  const dz = Math.cos(a) * ring.rz * dir;
  return Math.atan2(-dz, dx);
}

/**
 * Périmètre approché d'une ellipse (Ramanujan II — erreur < 1e-5 sur nos deux
 * anneaux). Sert à convertir une vitesse en unités/s en vitesse angulaire.
 * @param {{rx:number,rz:number}} ring
 * @returns {number}
 */
export function ringPerimeter(ring) {
  const { rx, rz } = ring;
  const h = ((rx - rz) * (rx - rz)) / ((rx + rz) * (rx + rz));
  return Math.PI * (rx + rz) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/**
 * Un point sur le viaduc, à l'abscisse `t` ∈ [0, 1] entre `a` et `b`.
 * @param {{a:{x:number,z:number}, b:{x:number,z:number}}} v
 * @param {number} t
 * @returns {{x:number, z:number}}
 */
export function viaductPoint(v, t) {
  return { x: lerp(v.a.x, v.b.x, t), z: lerp(v.a.z, v.b.z, t) };
}

/** Longueur du viaduc, en unités. */
export function viaductLength(v) {
  return Math.hypot(v.b.x - v.a.x, v.b.z - v.a.z);
}

/**
 * Navette : `t` ∈ [0, 1] en aller-retour (triangle) à partir d'une abscisse
 * linéaire `u` quelconque, plus le sens de marche. Pur, donc testable.
 * @param {number} u - abscisse cumulée (peut dépasser 1 sans limite)
 * @returns {{t:number, dir:number}}
 */
export function shuttleAt(u) {
  const cycle = ((u % 2) + 2) % 2; // [0, 2)
  return cycle <= 1 ? { t: cycle, dir: 1 } : { t: 2 - cycle, dir: -1 };
}

/**
 * L'état complet de la couche à une année donnée — la fonction pure que les
 * tests interrogent (et, plus tard, le narrateur de la tâche 15).
 *
 * @param {number} year
 * @returns {{
 *   petiteCeinture: {phase:string, presence:number},
 *   trains: {active:boolean, count:number},
 *   railsRust: number,
 *   vegetation: {presence:number},
 *   peripherique: {phase:string, presence:number, cars:number},
 *   viaduc: {phase:string, presence:number, metro:boolean}
 * }}
 */
export function railsStateAt(year) {
  const pc = lifecycle(year, PETITE_CEINTURE);
  const peri = lifecycle(year, PERIPHERIQUE);
  const via = lifecycle(year, VIADUC);
  // Les trains ne roulent que sur un anneau bouclé, et seulement dans leur
  // fenêtre historique.
  const trainsActive = pc.presence >= 1 && year >= TRAIN_WINDOW.from && year < TRAIN_WINDOW.to;
  // La rouille s'installe sur les vingt ans qui suivent le dernier train.
  const rust = clamp01((year - TRAIN_WINDOW.to) / 20);
  const veg = lifecycle(year, VEGETATION);
  // Une rame circule dès que le viaduc est praticable (dernier pilier posé).
  const metro = via.presence >= 1;
  return {
    petiteCeinture: { phase: pc.phase, presence: pc.presence },
    trains: { active: trainsActive, count: trainsActive ? TRAIN_COUNT : 0 },
    railsRust: rust,
    vegetation: { presence: veg.presence },
    peripherique: {
      phase: peri.phase,
      presence: peri.presence,
      cars: peri.presence >= 1 ? CAR_COUNT : Math.floor(CAR_COUNT * peri.presence),
    },
    viaduc: { phase: via.phase, presence: via.presence, metro },
  };
}

/**
 * Positions des broussailles le long de l'anneau : angle réparti régulièrement,
 * décalage latéral et taille déterministes, et un **ordre d'apparition** brassé
 * (`order` ∈ [0,1[) pour que la végétation s'installe par touffes dispersées et
 * non en balayant l'anneau du départ vers l'arrivée.
 * @param {number} count
 * @returns {Array<{a:number, offset:number, scale:number, order:number, light:boolean}>}
 */
export function vegetationPlan(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = ((i + hash01(i, 3, 17) * 0.7) / count) * Math.PI * 2;
    out.push({
      a,
      offset: (hash01(i, 1, 31) - 0.5) * 3.2,
      scale: 1.0 + hash01(i, 2, 53) * 1.3,
      order: hash01(i, 4, 71),
      light: hash01(i, 5, 89) > 0.55,
    });
  }
  return out;
}

// ============================================================================
// Scratch three.js — réutilisé, jamais alloué dans update
// ============================================================================

const UP = new THREE.Vector3(0, 1, 0);
const FWD_Z = new THREE.Vector3(0, 0, 1);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/** Compose une matrice « posée le long d'une courbe » : lacet + tangage. */
function composeAligned(x, y, z, yaw, pitch, sx, sy, sz) {
  _q.setFromAxisAngle(UP, yaw);
  if (pitch !== 0) {
    _qp.setFromAxisAngle(FWD_Z, pitch);
    _q.multiply(_qp);
  }
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  _m.compose(_p, _q, _s);
  return _m;
}

function instanced(ctx, geo, material, count, name) {
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(count, 1));
  mesh.count = count;
  mesh.frustumCulled = false;
  mesh.name = name;
  ctx.scene.add(mesh);
  return mesh;
}

// ============================================================================
// Petite ceinture — remblai, rails, trains, fumée, broussailles
// ============================================================================

const pc = {
  plan: null,
  embankment: null,
  rails: null,
  railMat: null,
  bushes: null,
  tufts: null,
  vegPlan: null,
  trainBodies: null,
  trainChimneys: null,
  perimeter: 0,
  // Correctif revue Tâche 11 ("updateTrains sans early-return reducedMotion") :
  // même schéma que `peri.carsWritten` — sous reducedMotion, une position
  // gelée réécrite identiquement à chaque frame n'est qu'un
  // recalcul+re-upload GPU gratuits (TRAIN_COUNT trains × CARS_PER_TRAIN
  // wagons). Remis à `false` à chaque rescan (voir `applyPetiteCeinture`).
  trainsWritten: false,
};

/** Teinte de rouille cible, allouée une fois (le lerp de couleur est en place). */
const RAIL_RUST_COLOR = new THREE.Color(COLORS.railRust);

function buildPetiteCeinture(ctx) {
  const cfg = PETITE_CEINTURE;
  const points = sampleEllipsePoints(cfg.ring.cx, cfg.ring.cz, cfg.ring.rx, cfg.ring.rz, cfg.segments);
  // Aucune porte, aucun franchissement : la petite ceinture est un anneau
  // continu (elle passe en tunnel sous la Seine et sous les buttes, ce que
  // notre vue aérienne n'a pas à raconter).
  pc.plan = wallRingPlan(points, { closed: true, towerEvery: 0, gates: [] });
  pc.perimeter = ringPerimeter(cfg.ring);

  const box = new THREE.BoxGeometry(1, 1, 1);
  const nSeg = pc.plan.segments.length;

  pc.embankment = instanced(
    ctx,
    box,
    new THREE.MeshLambertMaterial({ color: COLORS.ballast }),
    nSeg,
    "pc_embankment"
  );
  // Un seul InstancedMesh pour les deux files de rails : 2 instances par
  // segment (indices 2i et 2i+1).
  pc.railMat = new THREE.MeshLambertMaterial({ color: COLORS.rail });
  pc.rails = instanced(ctx, box, pc.railMat, nSeg * 2, "pc_rails");

  // --- les 12 trains (6 par sens) ------------------------------------------
  pc.trainBodies = instanced(
    ctx,
    box,
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    TRAIN_COUNT * CARS_PER_TRAIN,
    "pc_train_bodies"
  );
  // Couleur par instance : locomotive noire, wagons alternés.
  const colors = new Float32Array(TRAIN_COUNT * CARS_PER_TRAIN * 3);
  const c = new THREE.Color();
  for (let t = 0; t < TRAIN_COUNT; t++) {
    for (let k = 0; k < CARS_PER_TRAIN; k++) {
      const i = t * CARS_PER_TRAIN + k;
      c.setHex(k === 0 ? COLORS.loco : k % 2 === 1 ? COLORS.wagonA : COLORS.wagonB);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
  }
  pc.trainBodies.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  pc.trainChimneys = instanced(
    ctx,
    new THREE.CylinderGeometry(0.5, 0.62, 1, 8),
    new THREE.MeshLambertMaterial({ color: COLORS.loco }),
    TRAIN_COUNT,
    "pc_train_chimneys"
  );

  // --- la végétation qui colonise -----------------------------------------
  pc.vegPlan = vegetationPlan(VEGETATION_COUNT);
  pc.bushes = instanced(
    ctx,
    new THREE.IcosahedronGeometry(0.5, 0),
    new THREE.MeshLambertMaterial({ color: COLORS.bush, flatShading: true }),
    VEGETATION_COUNT,
    "pc_bushes"
  );
  pc.tufts = instanced(
    ctx,
    new THREE.ConeGeometry(0.5, 1, 5),
    new THREE.MeshLambertMaterial({ color: COLORS.bushLight, flatShading: true }),
    VEGETATION_COUNT,
    "pc_tufts"
  );
}

function applyPetiteCeinture(year) {
  const cfg = PETITE_CEINTURE;
  const { phase, presence } = lifecycle(year, cfg);
  const segs = pc.plan.segments;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const p = segmentPresence(seg.distStart, seg.distEnd, pc.plan.totalLength, presence);
    if (p <= 0) {
      pc.embankment.setMatrixAt(i, _zero);
      pc.rails.setMatrixAt(i * 2, _zero);
      pc.rails.setMatrixAt(i * 2 + 1, _zero);
      continue;
    }
    const groundY = groundHeightAt(seg.midX, seg.midZ);
    // Le remblai monte du sol (easeOutBack, comme une courtine) ; les rails ne
    // sont posés qu'une fois le remblai quasiment fini.
    const grow = easeOutBack(p, 0.4);
    const h = cfg.embankmentH * grow;
    pc.embankment.setMatrixAt(
      i,
      composeAligned(
        seg.midX,
        groundY + h / 2,
        seg.midZ,
        seg.angle,
        0,
        Math.max(seg.length, 0.05),
        Math.max(h, 0.02),
        cfg.embankmentW
      )
    );
    if (p < 0.75) {
      pc.rails.setMatrixAt(i * 2, _zero);
      pc.rails.setMatrixAt(i * 2 + 1, _zero);
      continue;
    }
    // Deux files : décalage *dans le repère local du segment* (axe local Z).
    const nx = -Math.sin(seg.angle);
    const nz = -Math.cos(seg.angle);
    for (let k = 0; k < 2; k++) {
      const off = (k === 0 ? -1 : 1) * (cfg.gauge / 2);
      pc.rails.setMatrixAt(
        i * 2 + k,
        composeAligned(
          seg.midX + nx * off,
          groundY + cfg.embankmentH + 0.06,
          seg.midZ + nz * off,
          seg.angle,
          0,
          Math.max(seg.length, 0.05),
          0.12,
          0.16
        )
      );
    }
  }
  pc.embankment.instanceMatrix.needsUpdate = true;
  pc.rails.instanceMatrix.needsUpdate = true;
  pc.trainsWritten = false;

  // Les rails ternissent après le dernier train.
  const rust = clamp01((year - TRAIN_WINDOW.to) / 20);
  pc.railMat.color.setHex(COLORS.rail).lerp(RAIL_RUST_COLOR, rust);

  // --- la végétation ------------------------------------------------------
  const veg = lifecycle(year, VEGETATION).presence;
  for (let i = 0; i < pc.vegPlan.length; i++) {
    const v = pc.vegPlan[i];
    // Elle ne pousse que là où la voie existe (donc nulle part avant 1852) et
    // seulement pour les touffes dont l'« ordre » est atteint.
    const onBuilt = presence >= 1 || segmentPresenceAtAngle(v.a, presence) > 0.5;
    if (veg <= 0 || !onBuilt || v.order > veg) {
      pc.bushes.setMatrixAt(i, _zero);
      pc.tufts.setMatrixAt(i, _zero);
      continue;
    }
    // Chaque touffe grandit encore un peu après son apparition.
    const local = clamp01((veg - v.order) / 0.35);
    const s = v.scale * (0.4 + 0.6 * easeOutBack(local, 0.3));
    const pt = ringPoint(cfg.ring, v.a);
    const yaw = ringYaw(cfg.ring, v.a);
    const nx = -Math.sin(yaw);
    const nz = -Math.cos(yaw);
    const x = pt.x + nx * v.offset;
    const z = pt.z + nz * v.offset;
    const groundY = groundHeightAt(x, z) + cfg.embankmentH * 0.6;
    if (v.light) {
      pc.tufts.setMatrixAt(i, composeAligned(x, groundY + s * 0.45, z, yaw, 0, s * 0.8, s * 0.9, s * 0.8));
      pc.bushes.setMatrixAt(i, _zero);
    } else {
      pc.bushes.setMatrixAt(i, composeAligned(x, groundY + s * 0.35, z, yaw, 0, s, s * 0.8, s));
      pc.tufts.setMatrixAt(i, _zero);
    }
  }
  pc.bushes.instanceMatrix.needsUpdate = true;
  pc.tufts.instanceMatrix.needsUpdate = true;
  return { phase, presence };
}

/** Présence locale de la voie à l'angle `a` (pour la végétation). */
function segmentPresenceAtAngle(a, presence) {
  if (presence >= 1) return 1;
  if (presence <= 0) return 0;
  // L'angle 0 correspond à la distance 0 du plan (les points sont échantillonnés
  // dans l'ordre trigonométrique depuis a = 0), donc la fraction de périmètre
  // parcourue est directement a / 2π à la précision de l'ellipse.
  const frac = (((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
  return presence > frac ? 1 : 0;
}

/** Les trains : positions paramétriques, fumée depuis la cheminée. */
function updateTrains(state, active) {
  if (!active) {
    if (pc.trainBodies.visible) {
      pc.trainBodies.visible = false;
      pc.trainChimneys.visible = false;
    }
    return;
  }
  pc.trainBodies.visible = true;
  pc.trainChimneys.visible = true;
  // Sous reducedMotion, la position (figée à time=0) ne change jamais entre
  // deux rescans : une seule écriture suffit (même schéma que updateCars).
  if (state.reducedMotion && pc.trainsWritten) return;
  const ring = PETITE_CEINTURE.ring;
  const time = state.reducedMotion ? 0 : state.time;

  for (let t = 0; t < TRAIN_COUNT; t++) {
    // Une voie par sens : les 6 premiers trains sur la file extérieure dans le
    // sens des `a` croissants, les 6 suivants sur la file intérieure à
    // contresens — ils se croisent, comme sur une vraie voie double.
    const dir = t < TRAINS_PER_DIRECTION ? 1 : -1;
    const track = (dir > 0 ? -1 : 1) * (PETITE_CEINTURE.gauge / 2);
    const slot = t % TRAINS_PER_DIRECTION;
    const speed = TRAIN_SPEED + (slot - TRAINS_PER_DIRECTION / 2) * TRAIN_SPEED_SPREAD;
    // Vitesse angulaire moyenne équivalente à `speed` unités/s.
    const omega = (speed / pc.perimeter) * Math.PI * 2 * dir;
    const head = (slot / TRAINS_PER_DIRECTION) * Math.PI * 2 + (dir < 0 ? 0.4 : 0) + time * omega;
    for (let k = 0; k < CARS_PER_TRAIN; k++) {
      // Les wagons suivent la locomotive, espacés d'une longueur de caisse.
      const a = head - dir * ((k * 1.5 * Math.PI * 2) / pc.perimeter);
      const p = ringPoint(ring, a);
      const yaw0 = ringYaw(ring, a, 1);
      const yaw = dir > 0 ? yaw0 : yaw0 + Math.PI;
      // Même règle que pour les voitures du périphérique : la *position* se
      // mesure sur la normale de référence, l'*orientation* suit la marche.
      const x = p.x + Math.sin(yaw0) * track;
      const z = p.z + Math.cos(yaw0) * track;
      const y = groundHeightAt(x, z) + PETITE_CEINTURE.embankmentH + 0.42;
      const long = k === 0 ? 1.3 : 1.15;
      pc.trainBodies.setMatrixAt(
        t * CARS_PER_TRAIN + k,
        composeAligned(x, y, z, yaw, 0, long, 0.62, 0.78)
      );
      if (k === 0) {
        pc.trainChimneys.setMatrixAt(
          t,
          composeAligned(
            x + Math.cos(yaw) * 0.45,
            y + 0.45,
            z - Math.sin(yaw) * 0.45,
            yaw,
            0,
            0.3,
            0.5,
            0.3
          )
        );
        if (!state.reducedMotion) {
          maybeSmoke(t, x, y + 0.75, z, state.time);
        }
      }
    }
  }
  pc.trainBodies.instanceMatrix.needsUpdate = true;
  pc.trainChimneys.instanceMatrix.needsUpdate = true;
  pc.trainsWritten = true;
}

// ============================================================================
// Fumée — pool fixe (même schéma que la poussière de démolition de walls.js)
// ============================================================================

const smoke = { slots: [], lastSpawn: [] };

function buildSmoke(ctx) {
  // Le pool est remis à zéro : `init` est appelé une fois dans l'application,
  // mais plusieurs fois dans les tests (une scène neuve par cas), et sans ce
  // reset les bouffées s'accumuleraient d'une init à l'autre.
  smoke.slots.length = 0;
  const geo = new THREE.IcosahedronGeometry(0.4, 0);
  for (let i = 0; i < SMOKE_POOL_SIZE; i++) {
    const material = new THREE.MeshBasicMaterial({
      color: COLORS.smoke,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
    smoke.slots.push({ mesh, material, active: false, spawnTime: 0, x: 0, y: 0, z: 0, drift: 0 });
  }
  smoke.lastSpawn = new Array(TRAIN_COUNT).fill(-Infinity);
}

function maybeSmoke(trainIndex, x, y, z, time) {
  if (time - smoke.lastSpawn[trainIndex] < SMOKE_INTERVAL) return;
  smoke.lastSpawn[trainIndex] = time;
  const slot = smoke.slots.find((s) => !s.active);
  if (!slot) return;
  slot.active = true;
  slot.mesh.visible = true;
  slot.spawnTime = time;
  slot.x = x;
  slot.y = y;
  slot.z = z;
  slot.drift = (hash01(trainIndex, Math.round(time * 10), 131) - 0.5) * 1.6;
}

function updateSmoke(time) {
  for (const s of smoke.slots) {
    if (!s.active) continue;
    const t = (time - s.spawnTime) / SMOKE_LIFE;
    if (t >= 1) {
      s.active = false;
      s.mesh.visible = false;
      s.material.opacity = 0;
      continue;
    }
    s.mesh.position.set(s.x + s.drift * t, s.y + t * 2.6, s.z + s.drift * t * 0.6);
    s.mesh.scale.setScalar(lerp(0.55, 2.4, t));
    s.material.opacity = (1 - t) * 0.5;
  }
}

function clearSmoke() {
  for (const s of smoke.slots) {
    s.active = false;
    s.mesh.visible = false;
    s.material.opacity = 0;
  }
}

// ============================================================================
// Périphérique — double ruban + flux de voitures
// ============================================================================

const peri = {
  plan: null,
  deck: null, // 2 instances par segment (les 2 chaussées)
  edges: null, // glissières : 2 instances par segment
  median: null,
  cars: null,
  headlights: null,
  perimeter: 0,
  carsWritten: false,
  headlightsWritten: false,
};

function buildPeripherique(ctx) {
  const cfg = PERIPHERIQUE;
  const points = sampleEllipsePoints(cfg.ring.cx, cfg.ring.cz, cfg.ring.rx, cfg.ring.rz, cfg.segments);
  peri.plan = wallRingPlan(points, { closed: true, towerEvery: 0, gates: [] });
  peri.perimeter = ringPerimeter(cfg.ring);
  const nSeg = peri.plan.segments.length;
  const box = new THREE.BoxGeometry(1, 1, 1);

  peri.deck = instanced(
    ctx,
    box,
    new THREE.MeshLambertMaterial({ color: COLORS.asphalt }),
    nSeg * 2,
    "peri_deck"
  );
  // Basic (non éclairé) et non Lambert : c'est le choix qui rend la bande
  // de rive lisible en toute circonstance — voir la note de COLORS.asphaltEdge.
  peri.edges = instanced(
    ctx,
    box,
    new THREE.MeshBasicMaterial({ color: COLORS.asphaltEdge }),
    nSeg * 2,
    "peri_edges"
  );
  // Terre-plein central : sans lui, les deux chaussées se lisaient comme une
  // seule dalle grise très large (constat de la capture task11-periph-2026).
  peri.median = instanced(
    ctx,
    box,
    new THREE.MeshLambertMaterial({ color: COLORS.median }),
    nSeg,
    "peri_median"
  );

  // Basic, pas Lambert : à cette échelle (une voiture couvre à peine un
  // pixel depuis la vue d'ensemble), une caisse ombrée s'assombrit au point
  // de se fondre dans le bitume — l'anti-aliasing moyenne alors sa couleur
  // avec ses voisins avant même que la lumière n'entre en jeu. Un matériau
  // non éclairé restitue sa teinte pleine quel que soit l'éclairage de la
  // frise, ce qui est *la* condition pour qu'elle se voie comme une pastille
  // mobile — voir aussi CAR_COLORS (post-v1 A), recentré sur des teintes
  // saturées plutôt que des gris qui se seraient fondus dans le bitume.
  peri.cars = instanced(ctx, box, new THREE.MeshBasicMaterial({ color: 0xffffff }), CAR_COUNT, "peri_cars");
  const colors = new Float32Array(CAR_COUNT * 3);
  const c = new THREE.Color();
  for (let i = 0; i < CAR_COUNT; i++) {
    c.setHex(CAR_COLORS[Math.floor(hash01(i, 7, 211) * CAR_COLORS.length) % CAR_COLORS.length]);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  peri.cars.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);

  peri.headlights = instanced(
    ctx,
    box,
    new THREE.MeshBasicMaterial({ color: COLORS.headlight }),
    CAR_COUNT,
    "peri_headlights"
  );
  peri.headlights.visible = false;
}

function applyPeripherique(year) {
  const cfg = PERIPHERIQUE;
  const { phase, presence } = lifecycle(year, cfg);
  const segs = peri.plan.segments;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const p = segmentPresence(seg.distStart, seg.distEnd, peri.plan.totalLength, presence);
    const nx = -Math.sin(seg.angle);
    const nz = -Math.cos(seg.angle);
    for (let k = 0; k < 2; k++) {
      const idx = i * 2 + k;
      if (p <= 0) {
        peri.deck.setMatrixAt(idx, _zero);
        peri.edges.setMatrixAt(idx, _zero);
        continue;
      }
      const off = (k === 0 ? -1 : 1) * (cfg.laneW / 2 + cfg.laneGap / 2);
      const x = seg.midX + nx * off;
      const z = seg.midZ + nz * off;
      const groundY = groundHeightAt(x, z);
      // Le ruban se « coule » : il s'élargit depuis son axe (scale sur la
      // largeur) au lieu de sortir du sol — c'est de l'asphalte, pas un mur.
      const w = cfg.laneW * clamp01(p);
      peri.deck.setMatrixAt(
        idx,
        composeAligned(x, groundY + cfg.deckH / 2, z, seg.angle, 0, Math.max(seg.length, 0.05), cfg.deckH, Math.max(w, 0.02))
      );
      // Glissière extérieure de chaque chaussée.
      const edgeOff = off + (k === 0 ? -1 : 1) * (cfg.laneW / 2 + 0.1);
      if (k === 0) {
        // Le terre-plein n'apparaît qu'une fois la chaussée coulée.
        peri.median.setMatrixAt(
          idx / 2,
          p < 0.9
            ? _zero
            : composeAligned(
                seg.midX,
                groundY + cfg.deckH + 0.06,
                seg.midZ,
                seg.angle,
                0,
                Math.max(seg.length, 0.05),
                0.14,
                cfg.laneGap
              )
        );
      }
      // Glissière élargie (post-v1 A, 0.12→0.2 de large et 0.22→0.28 de haut) :
      // en matériau Basic, c'est elle qui doit porter à elle seule la lecture
      // de l'anneau depuis la vue d'ensemble — une bande trop fine y disparaît
      // dans l'anti-aliasing avant même d'atteindre l'écran. Le décalage
      // vertical (0.14 = moitié de la nouvelle hauteur) garde sa face
      // inférieure exactement au niveau du dessus de la chaussée, sans écart
      // ni recouvrement.
      peri.edges.setMatrixAt(
        idx,
        p < 0.85
          ? _zero
          : composeAligned(
              seg.midX + nx * edgeOff,
              groundY + cfg.deckH + 0.14,
              seg.midZ + nz * edgeOff,
              seg.angle,
              0,
              Math.max(seg.length, 0.05),
              0.28,
              0.2
            )
      );
    }
  }
  peri.median.instanceMatrix.needsUpdate = true;
  peri.deck.instanceMatrix.needsUpdate = true;
  peri.edges.instanceMatrix.needsUpdate = true;
  peri.carsWritten = false;
  return { phase, presence };
}

/**
 * Le flux : 640 voitures réparties sur 4 files, deux dans chaque sens. La
 * position est purement paramétrique (angle + temps), donc aucune voiture n'a
 * besoin de connaître les autres.
 */
function updateCars(state, presence) {
  const activeCars = presence >= 1 ? CAR_COUNT : Math.floor(CAR_COUNT * presence);
  if (activeCars <= 0) {
    if (peri.cars.visible) {
      peri.cars.visible = false;
      peri.headlights.visible = false;
    }
    return;
  }
  const night = state.weather === "night";
  peri.cars.visible = true;
  peri.headlights.visible = night;
  // Sous reducedMotion, le flux est figé : une seule écriture suffit, sauf si
  // la nuit vient d'arriver (il faut alors poser les phares).
  if (state.reducedMotion && peri.carsWritten && peri.headlightsWritten === night) return;

  const ring = PERIPHERIQUE.ring;
  const time = state.reducedMotion ? 0 : state.time;
  for (let i = 0; i < CAR_COUNT; i++) {
    if (i >= activeCars) {
      peri.cars.setMatrixAt(i, _zero);
      peri.headlights.setMatrixAt(i, _zero);
      continue;
    }
    const lane = i % CAR_LANES.length;
    const dir = lane < 2 ? 1 : -1;
    const speed = CAR_SPEED + hash01(i, 1, 307) * CAR_SPEED_SPREAD;
    const omega = ((speed / peri.perimeter) * Math.PI * 2) * dir;
    // Position de départ étalée sur tout l'anneau, file par file.
    const a0 = ((Math.floor(i / CAR_LANES.length) + lane * 0.27) / (CAR_COUNT / CAR_LANES.length)) * Math.PI * 2;
    const a = a0 + time * omega;
    const p = ringPoint(ring, a);
    // Deux repères distincts, et c'est indispensable : la **position** se
    // mesure toujours depuis la normale de référence (sens des `a` croissants),
    // sinon les deux sens de circulation se retrouveraient du même côté du
    // terre-plein ; l'**orientation**, elle, suit le sens de marche.
    const yaw0 = ringYaw(ring, a, 1);
    const yaw = dir > 0 ? yaw0 : yaw0 + Math.PI;
    const nx = Math.sin(yaw0);
    const nz = Math.cos(yaw0);
    const off = CAR_LANES[lane];
    const x = p.x + nx * off;
    const z = p.z + nz * off;
    const groundY = groundHeightAt(x, z) + PERIPHERIQUE.deckH;
    // Caisse légèrement agrandie (post-v1 A, 0.42→0.55 de long) : à la distance
    // de la vue d'ensemble une voiture à l'échelle stricte couvre bien moins
    // d'un pixel, donc l'anti-aliasing la moyenne avec le bitume avant qu'elle
    // n'atteigne l'écran — elle ne "se voit" jamais, quelle que soit sa
    // couleur. Rester un peu au-dessus de l'échelle réelle (comme CAR_COUNT
    // et TRAIN_COUNT l'assument déjà pour la même raison, voir leurs notes)
    // est ici la condition pour qu'un flux existe visuellement.
    peri.cars.setMatrixAt(i, composeAligned(x, groundY + 0.17, z, yaw, 0, 0.55, 0.34, 0.3));
    if (night) {
      peri.headlights.setMatrixAt(
        i,
        composeAligned(
          x + Math.cos(yaw) * 0.3,
          groundY + 0.16,
          z - Math.sin(yaw) * 0.3,
          yaw,
          0,
          0.16,
          0.15,
          0.32
        )
      );
    }
  }
  peri.cars.instanceMatrix.needsUpdate = true;
  if (night) peri.headlights.instanceMatrix.needsUpdate = true;
  peri.carsWritten = true;
  peri.headlightsWritten = night;
}

// ============================================================================
// Viaduc de Barbès — piliers rivetés, tablier, une rame en navette
// ============================================================================

const via = {
  pillars: null,
  deck: null,
  beams: null,
  cars: null,
  carMat: null,
  length: 0,
  nodes: null, // altitudes du tablier, échantillonnées une fois
};

function buildViaduc(ctx) {
  const cfg = VIADUC;
  via.length = viaductLength(cfg);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const nPillar = cfg.spans + 1;

  // Le tablier suit le sol : on échantillonne l'altitude à chaque noeud une
  // fois pour toutes (le terrain ne change pas avec l'année ici).
  via.nodes = [];
  for (let i = 0; i <= cfg.spans; i++) {
    const t = i / cfg.spans;
    const p = viaductPoint(cfg, t);
    via.nodes.push({ x: p.x, z: p.z, ground: groundHeightAt(p.x, p.z) });
  }

  via.pillars = instanced(
    ctx,
    box,
    new THREE.MeshLambertMaterial({ color: COLORS.viaductIron }),
    nPillar * 2,
    "viaduc_pillars"
  );
  via.deck = instanced(
    ctx,
    box,
    new THREE.MeshLambertMaterial({ color: COLORS.viaductDeck }),
    cfg.spans,
    "viaduc_deck"
  );
  // Poutres latérales rivetées (le treillis du vrai viaduc) : 2 par travée.
  via.beams = instanced(
    ctx,
    box,
    new THREE.MeshLambertMaterial({ color: COLORS.viaductIron }),
    cfg.spans * 2,
    "viaduc_beams"
  );
  via.carMat = new THREE.MeshLambertMaterial({ color: COLORS.metroGreen });
  via.cars = instanced(ctx, box, via.carMat, METRO_CARS, "viaduc_metro");
}

/** Altitude du dessus du tablier à l'abscisse t ∈ [0,1]. */
function viaductDeckY(t) {
  const cfg = VIADUC;
  const f = clamp01(t) * cfg.spans;
  const i = Math.min(Math.floor(f), cfg.spans - 1);
  const u = f - i;
  const g = lerp(via.nodes[i].ground, via.nodes[i + 1].ground, u);
  return g + cfg.clearance + cfg.deckH;
}

function applyViaduc(year) {
  const cfg = VIADUC;
  const { phase, presence } = lifecycle(year, cfg);
  const spanLen = via.length / cfg.spans;
  const yaw = Math.atan2(-(cfg.b.z - cfg.a.z), cfg.b.x - cfg.a.x);

  for (let i = 0; i <= cfg.spans; i++) {
    // Le viaduc se construit d'ouest en est : la travée i n'existe qu'au-delà
    // de i / spans de la présence.
    const p = clamp01((presence - i / (cfg.spans + 1)) * (cfg.spans + 1));
    const node = via.nodes[i];
    const top = node.ground + cfg.clearance;
    for (let k = 0; k < 2; k++) {
      const idx = i * 2 + k;
      if (p <= 0) {
        via.pillars.setMatrixAt(idx, _zero);
        continue;
      }
      const off = (k === 0 ? -1 : 1) * (cfg.deckW / 2 - 0.12);
      const grow = easeOutBack(p, 0.4);
      const h = (top - node.ground) * grow;
      via.pillars.setMatrixAt(
        idx,
        composeAligned(
          node.x - Math.sin(yaw) * off,
          node.ground + h / 2,
          node.z - Math.cos(yaw) * off,
          yaw,
          0,
          cfg.pillarW,
          Math.max(h, 0.02),
          cfg.pillarW
        )
      );
    }
    if (i === cfg.spans) continue;
    // La travée i relie le noeud i au noeud i+1 : tablier incliné.
    const pDeck = clamp01((presence - (i + 0.5) / (cfg.spans + 1)) * (cfg.spans + 1));
    const yA = via.nodes[i].ground + cfg.clearance;
    const yB = via.nodes[i + 1].ground + cfg.clearance;
    if (pDeck <= 0) {
      via.deck.setMatrixAt(i, _zero);
      via.beams.setMatrixAt(i * 2, _zero);
      via.beams.setMatrixAt(i * 2 + 1, _zero);
      continue;
    }
    const midX = (via.nodes[i].x + via.nodes[i + 1].x) / 2;
    const midZ = (via.nodes[i].z + via.nodes[i + 1].z) / 2;
    const pitch = Math.atan2(yB - yA, spanLen);
    const len = Math.hypot(spanLen, yB - yA) * clamp01(pDeck);
    via.deck.setMatrixAt(
      i,
      composeAligned(midX, (yA + yB) / 2 + cfg.deckH / 2, midZ, yaw, pitch, len, cfg.deckH, cfg.deckW)
    );
    for (let k = 0; k < 2; k++) {
      const off = (k === 0 ? -1 : 1) * (cfg.deckW / 2);
      via.beams.setMatrixAt(
        i * 2 + k,
        composeAligned(
          midX - Math.sin(yaw) * off,
          (yA + yB) / 2 + cfg.deckH + 0.16,
          midZ - Math.cos(yaw) * off,
          yaw,
          pitch,
          len,
          0.3,
          0.1
        )
      );
    }
  }
  via.pillars.instanceMatrix.needsUpdate = true;
  via.deck.instanceMatrix.needsUpdate = true;
  via.beams.instanceMatrix.needsUpdate = true;

  // Vert « Sprague » jusqu'en 1970, bleu MF67 ensuite.
  via.carMat.color.setHex(year < METRO_BLUE_FROM ? COLORS.metroGreen : COLORS.metroBlue);
  return { phase, presence };
}

/** La rame : navette aller-retour sur le viaduc, en surplomb du boulevard. */
function updateMetro(state, running) {
  if (!running) {
    if (via.cars.visible) via.cars.visible = false;
    return;
  }
  via.cars.visible = true;
  const cfg = VIADUC;
  const time = state.reducedMotion ? 0 : state.time;
  const yaw0 = Math.atan2(-(cfg.b.z - cfg.a.z), cfg.b.x - cfg.a.x);
  // Une navette complète (aller + retour) dure 2·longueur / vitesse.
  const { t: head, dir } = shuttleAt((time * METRO_SPEED) / via.length);
  const yaw = dir > 0 ? yaw0 : yaw0 + Math.PI;
  for (let k = 0; k < METRO_CARS; k++) {
    // Les voitures se suivent, en arrière du sens de marche.
    const t = clamp01(head - (dir * k * 1.25) / via.length);
    const p = viaductPoint(cfg, t);
    via.cars.setMatrixAt(
      k,
      composeAligned(p.x, viaductDeckY(t) + 0.32, p.z, yaw, 0, 1.15, 0.55, 0.85)
    );
  }
  via.cars.instanceMatrix.needsUpdate = true;
}

// ============================================================================
// Contrat de layer
// ============================================================================

let lastAppliedYear = null;
let applied = null;

function rescanAll(year) {
  const a = applyPetiteCeinture(year);
  const b = applyPeripherique(year);
  const c = applyViaduc(year);
  applied = {
    year,
    pcPresence: a.presence,
    periPresence: b.presence,
    viaPresence: c.presence,
    trains: railsStateAt(year).trains.active,
  };
}

export function init(ctx) {
  buildPetiteCeinture(ctx);
  buildSmoke(ctx);
  buildPeripherique(ctx);
  buildViaduc(ctx);
  clearSmoke();
  lastAppliedYear = null;
  rescanAll(2026);
  lastAppliedYear = 2026;
}

export function update(dt, state) {
  if (state.year !== lastAppliedYear) {
    rescanAll(state.year);
    lastAppliedYear = state.year;
    clearSmoke();
  }
  updateTrains(state, applied.trains);
  updateCars(state, applied.periPresence);
  updateMetro(state, applied.viaPresence >= 1);
  if (state.reducedMotion) {
    clearSmoke();
  } else {
    updateSmoke(state.time);
  }
}

/** Même contrat que walls.forceRescan / monuments.forceRescan. */
export function forceRescan(year) {
  rescanAll(year);
  lastAppliedYear = year;
  clearSmoke();
}

/** Diagnostic pour la vérification automatisée. */
export function debugCounts(year) {
  const st = railsStateAt(year);
  let pcSegments = 0;
  for (const seg of pc.plan.segments) {
    if (segmentPresence(seg.distStart, seg.distEnd, pc.plan.totalLength, st.petiteCeinture.presence) > 0) {
      pcSegments++;
    }
  }
  let periSegments = 0;
  for (const seg of peri.plan.segments) {
    if (segmentPresence(seg.distStart, seg.distEnd, peri.plan.totalLength, st.peripherique.presence) > 0) {
      periSegments++;
    }
  }
  let vegVisible = 0;
  for (const v of pc.vegPlan) if (v.order <= st.vegetation.presence) vegVisible++;
  return {
    petiteCeinture: {
      phase: st.petiteCeinture.phase,
      presence: Math.round(st.petiteCeinture.presence * 1000) / 1000,
      segments: pcSegments,
      totalSegments: pc.plan.segments.length,
      rust: Math.round(st.railsRust * 100) / 100,
    },
    trains: { active: st.trains.active, visible: pc.trainBodies.visible, smoke: smoke.slots.filter((s) => s.active).length },
    vegetation: { presence: Math.round(st.vegetation.presence * 1000) / 1000, visible: vegVisible },
    peripherique: {
      phase: st.peripherique.phase,
      presence: Math.round(st.peripherique.presence * 1000) / 1000,
      segments: periSegments,
      cars: st.peripherique.cars,
      carsVisible: peri.cars.visible,
      headlights: peri.headlights.visible,
    },
    viaduc: {
      phase: st.viaduc.phase,
      presence: Math.round(st.viaduc.presence * 1000) / 1000,
      metro: st.viaduc.metro,
      metroVisible: via.cars.visible,
      metroColor: `#${via.carMat.color.getHexString()}`,
    },
  };
}

/** Nombre d'instances construites (coût de la couche). */
export function stats() {
  return {
    pcEmbankment: pc.embankment.count,
    pcRails: pc.rails.count,
    pcVegetation: pc.bushes.count + pc.tufts.count,
    trainCars: pc.trainBodies.count,
    smokePool: smoke.slots.length,
    periDeck: peri.deck.count + peri.edges.count + peri.median.count,
    cars: peri.cars.count,
    headlights: peri.headlights.count,
    viaduc: via.pillars.count + via.deck.count + via.beams.count,
    metroCars: via.cars.count,
  };
}
