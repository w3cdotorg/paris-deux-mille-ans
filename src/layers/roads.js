/**
 * Roads layer — les axes majeurs qui traversent Paris, tronçon léger posé sur
 * le relief (post-v1 B : "Rajouter les axes majeurs").
 *
 * Contrairement aux enceintes (walls.js) et aux deux anneaux (rails.js), un
 * axe n'est pas une fortification qui monte pierre par pierre ni un flux de
 * circulation animé : c'est un ruban plat, fin, immobile, qui apparaît sur son
 * tracé en une décennie environ puis ne change plus jusqu'à la fin de la
 * frise (aucune rue majeure de ce brief n'a jamais été "démolie"). D'où un
 * modèle de présence délibérément plus simple que `wallRingPlan` +
 * `segmentPresence` : pas de vague le long du périmètre, juste une largeur qui
 * croît uniformément sur toute la longueur du tracé — voir `applyRoads`.
 *
 * ============================================================================
 * Ce qui est réutilisé plutôt que réécrit
 *
 * `wallRingPlan` (walls.js) découpe déjà n'importe quelle polyligne (fermée ou
 * non) en segments alignés (angle, milieu, longueur) — exactement ce qu'il
 * faut pour poser des boîtes le long d'un tracé, tours et portes mises à part
 * (`towerEvery: 0, gates: []`). Le réutiliser ici évite de dupliquer la
 * trigonométrie de segmentation. Les Grands Boulevards réutilisent en plus le
 * tracé exact planté par `walls.js` (`BOULEVARDS.traces`) : la même polyligne
 * qui porte déjà les rangs d'arbres, pour que rue et arbres coïncident.
 *
 * ============================================================================
 * Douze axes, une seule InstancedMesh
 *
 * Douze entrées de `ROADS` (une réunissant deux tracés distincts, les Grands
 * Boulevards), chacune segmentée puis concaténée dans une unique
 * `InstancedMesh` de capacité fixe — pas d'aller-retour GPU par axe, un seul
 * matériau (pierre claire, cf. COLORS.road, volontairement froide et
 * *pas* beige : la note de rails.js post-v1 A documente pourquoi un ruban
 * trop proche de la teinte du sol (COLOR_URBAN, chaud) s'y noie visuellement).
 *
 * Coût : réécrit uniquement au changement d'année (comme walls.js/rails.js),
 * jamais par frame — ces axes ne portent aucune circulation ("le périph a les
 * voitures, on reste sobre ici", brief). Aucune allocation dans `update`.
 *
 * Conventions héritées de geography.js : 1 unité = 10 m, x = est, z = sud.
 */

import * as THREE from "three";
import { LANDMARKS, RINGS, isOverSeineWater } from "../geography.js";
import { lifecycle, easeOutBack } from "../timeEngine.js";
import { groundHeightAt, seineWaterHeightAt } from "./terrain.js";
import { wallRingPlan, sampleEllipsePoints, BOULEVARDS } from "./walls.js";

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ============================================================================
// Subdivision — pré-passe corrective (revue post-v1, critique n°1)
// ============================================================================
//
// Ces tracés sont hand-authored avec 3 à 6 points sur des centaines
// d'unités, et `wallRingPlan` (réutilisé pour la segmentation, cf. docstring
// d'en-tête) échantillonne le sol UNIQUEMENT au milieu de chaque segment —
// sur un flanc de colline (Montmartre, Sainte-Geneviève, Chaillot), la
// hauteur au milieu d'une corde de 140 unités peut différer de 10-15 unités
// de la hauteur à ses extrémités : le ruban flotte au-dessus du relief d'un
// côté, le tranche de l'autre. Subdiviser AVANT de segmenter (voir
// `buildRoads`) fait que chaque segment reste court, donc son échantillon au
// milieu reste proche de ses deux extrémités même sur une pente raide —
// exactement le même principe de densité que les 96-128 points des anneaux
// de rails.js / `boulevardsMarechaux` ci-dessous, qui eux n'ont jamais
// souffert de ce problème.

// Choisie par mesure (voir le rapport de tâche) : au-dessus de la pente la
// plus raide de la table (le flanc de Montmartre sous `routeSaintDenis`),
// 8u tient l'écart |échantillon au milieu − hauteur aux extrémités| sous
// ~1,44u (marge sous le seuil de vérification de ~1,5u) ; 9u dépasse déjà ce
// seuil (~1,59u). Coût négligeable : ~830 segments au total pour les 12 axes
// (contre ~560 à 12u), toujours plusieurs ordres de grandeur sous les
// InstancedMesh de buildings.js.
/** Distance maximale tolérée entre deux points consécutifs après subdivision. */
export const ROAD_MAX_CHORD = 8;

/**
 * Insère des points intermédiaires le long d'une polyligne pour qu'aucune
 * corde ne dépasse `maxChord` unités. Interpolation strictement linéaire
 * (pas de bruit) : la forme du tracé ne change pas, seulement sa densité —
 * pure et déterministe, donc testable sans three.js.
 * @param {Array<{x:number,z:number}>} points
 * @param {boolean} closed inclut la corde de fermeture (dernier -> premier point)
 * @param {number} maxChord
 * @returns {Array<{x:number,z:number}>}
 */
export function subdividePolyline(points, closed, maxChord) {
  const n = points.length;
  if (n < 2) return points.slice();
  const edgeCount = closed ? n : n - 1;
  const out = [points[0]];
  for (let i = 0; i < edgeCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(dist / maxChord));
    const isClosingEdge = closed && i === edgeCount - 1;
    for (let k = 1; k <= steps; k++) {
      // Corde de fermeture : le dernier point vaut `points[0]`, déjà en tête
      // de `out` — ne pas le dupliquer (polylineEdges le referme lui-même).
      if (isClosingEdge && k === steps) break;
      const t = k / steps;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

// ============================================================================
// Table des axes — exportée, testable sans three.js
// ============================================================================
//
// Chaque entrée porte soit `points` (un seul tracé), soit `traces` (plusieurs
// polylignes partageant le même cycle de vie — cas des Grands Boulevards, qui
// referment deux enceintes comblées distinctes). `closed: true` referme le
// tracé sur lui-même (seuls les Boulevards des Maréchaux, un anneau).
//
// Coordonnées approchées depuis `LANDMARKS` et les points donnés au brief ;
// "hand-tuned" pour ne traverser la Seine qu'aux endroits où un pont existe
// conceptuellement — le cardo (rue Saint-Jacques / Saint-Martin) franchit
// l'île de la Cité par le Petit-Pont puis le Pont au Change, exactement comme
// le vrai *cardo maximus* de Lutèce, ce qui est aussi l'unique franchissement
// de fleuve de toute la table (tous les autres axes restent sur une seule
// rive).

export const ROAD_WIDTH_DEFAULT = 1.5;

export const ROADS = [
  {
    id: "cardo",
    name: "Cardo maximus (rue Saint-Jacques)",
    born: 50,
    buildYears: 10,
    width: 1.4,
    // (0,+150) -> Panthéon (-26,+76) -> Petit-Pont -> à travers l'île -> rive
    // droite (le seul axe de la table qui franchit la Seine, deux fois).
    points: [
      { x: 0, z: 150 },
      { x: LANDMARKS.pantheon.x, z: LANDMARKS.pantheon.z },
      { x: -6, z: 15 },
      { x: 0, z: 8 },
      { x: 2, z: -10 },
    ],
  },
  {
    id: "decumanus",
    name: "Decumanus (rue Saint-Antoine)",
    born: 100,
    buildYears: 10,
    width: 1.4,
    // Part du même carrefour que le cardo sur la rive droite de l'île, vers
    // la Bastille (141,0) — le decumanus et le cardo de Lutèce se croisaient
    // au même point.
    points: [
      { x: 2, z: -10 },
      { x: 55, z: -28 },
      { x: 100, z: -14 },
      { x: LANDMARKS.bastille.x, z: LANDMARKS.bastille.z },
    ],
  },
  {
    id: "routeSaintDenis",
    name: "Route de Saint-Denis",
    born: 200,
    buildYears: 15,
    width: 1.3,
    points: [
      { x: 0, z: -8 },
      { x: -8, z: -160 },
      { x: -15, z: -310 },
      { x: -20, z: -450 },
    ],
  },
  {
    id: "saintHonore",
    name: "Rue Saint-Honoré",
    born: 1200,
    buildYears: 20,
    width: 1.4,
    points: [
      { x: -170, z: -95 },
      { x: LANDMARKS.louvre.x, z: LANDMARKS.louvre.z },
      { x: -20, z: -65 },
      { x: 40, z: -55 },
      { x: 95, z: -25 },
    ],
  },
  {
    id: "champsElysees",
    name: "Avenue des Champs-Élysées",
    born: 1670,
    buildYears: 20,
    width: 2.0,
    points: [
      { x: LANDMARKS.louvre.x, z: LANDMARKS.louvre.z },
      { x: -250, z: -115 },
      { x: -500, z: -170 },
    ],
  },
  {
    id: "grandsBoulevardsRoad",
    name: "Grands Boulevards",
    // Même cycle de vie que les rangs d'arbres de walls.js — c'est
    // volontaire : rue et plantation datent du même chantier (1670-1685).
    born: BOULEVARDS.born,
    buildYears: BOULEVARDS.buildYears,
    width: 2.0,
    // Le tracé exact planté par walls.js (rive droite de Philippe Auguste +
    // Charles V comblées), pas une resaisie approchée.
    traces: BOULEVARDS.traces.map((t) => t.points),
  },
  {
    id: "rueDeRivoli",
    name: "Rue de Rivoli",
    born: 1802,
    buildYears: 15,
    width: 1.6,
    points: [
      { x: LANDMARKS.louvre.x, z: LANDMARKS.louvre.z },
      { x: 0, z: -60 },
      { x: 70, z: -30 },
      { x: LANDMARKS.bastille.x, z: LANDMARKS.bastille.z },
    ],
  },
  {
    id: "sebastopolStrasbourg",
    name: "Boulevard de Sébastopol / Strasbourg",
    born: 1855,
    buildYears: 8,
    width: 1.6,
    // S'arrête au nord de l'île : la percée continue au sud sous le nom de
    // Saint-Michel (entrée suivante) — comme en vrai, c'est un seul axe
    // haussmannien coupé en deux noms par la traversée de l'île.
    points: [
      { x: 2, z: -160 },
      { x: 0, z: -60 },
      { x: -2, z: -8 },
    ],
  },
  {
    id: "boulevardSaintMichel",
    name: "Boulevard Saint-Michel",
    born: 1855,
    buildYears: 8,
    width: 1.6,
    points: [
      { x: 0, z: 8 },
      { x: -10, z: 60 },
      { x: -18, z: 120 },
    ],
  },
  {
    id: "avenueOpera",
    name: "Avenue de l'Opéra",
    born: 1864,
    buildYears: 6,
    width: 1.6,
    points: [
      { x: LANDMARKS.operaGarnier.x, z: LANDMARKS.operaGarnier.z },
      { x: -108, z: -108 },
      { x: LANDMARKS.louvre.x, z: LANDMARKS.louvre.z },
    ],
  },
  {
    id: "boulevardsMarechaux",
    name: "Boulevards des Maréchaux",
    born: 1861,
    buildYears: 10,
    width: 1.8,
    closed: true,
    // Juste à l'intérieur de l'ellipse de la petite ceinture (échelle 0,97) —
    // les Maréchaux longent la zone militaire non aedificandi, entre les rails
    // et l'ancien mur de Thiers.
    points: sampleEllipsePoints(
      RINGS.petiteCeinture.cx,
      RINGS.petiteCeinture.cz,
      RINGS.petiteCeinture.rx * 0.97,
      RINGS.petiteCeinture.rz * 0.97,
      96
    ),
  },
  {
    id: "axeHistoriqueDefense",
    name: "Axe historique — prolongement vers La Défense",
    born: 1958,
    buildYears: 15,
    width: 2.0,
    // Continue l'axe des Champs-Élysées (même azimut, cf. son dernier point)
    // jusqu'à La Défense.
    points: [
      { x: -500, z: -170 },
      { x: -650, z: -300 },
      { x: LANDMARKS.laDefense.x, z: LANDMARKS.laDefense.z },
    ],
  },
];

/**
 * Les polylignes portées par un axe — un tableau à un seul élément pour un
 * axe `points`, un de plus pour chaque tracé d'un axe `traces`. Point d'entrée
 * unique utilisé à la fois par le rendu et par les tests (géométrie, pas de
 * NaN) : aucun des deux ne doit relire `road.points`/`road.traces` séparément.
 * @param {object} road
 * @returns {Array<Array<{x:number,z:number}>>}
 */
export function roadPolylines(road) {
  if (Array.isArray(road.traces)) return road.traces;
  return [road.points];
}

/**
 * L'état de présence de chaque axe à une année donnée — fonction pure,
 * testable sans three.js (cf. `railsStateAt`/`debugCounts` de rails.js pour
 * le même besoin). Une seule présence par axe (pas de vague le long du
 * tracé) : brief §"Construction" — "fade/grow in over ~10 years via
 * lifecycle presence".
 * @param {number} year
 * @returns {Array<{id:string, name:string, born:number, phase:string, presence:number}>}
 */
export function roadsStateAt(year) {
  return ROADS.map((road) => {
    const { phase, presence } = lifecycle(year, road);
    return { id: road.id, name: road.name, born: road.born, phase, presence };
  });
}

// ============================================================================
// Couleurs — pierre claire et froide, délibérément distincte du sol urbain
// ============================================================================
//
// COLOR_URBAN (terrain.js) est un beige chaud (0xd8c6a0) : un gris tout aussi
// chaud s'y fondrait exactement comme l'ancien bitume du périphérique se
// fondait dans les toits (voir la note de rails.js, COLORS.asphalt). La
// teinte ci-dessous est donc choisie plus froide (verdâtre/taupe) que chaude,
// pour se détacher par la teinte autant que par la clarté.
const COLORS = {
  road: 0xafab9b,
};

// ============================================================================
// Tunables de rendu
// ============================================================================

const ROAD_THICKNESS = 0.05;
// "slight y offset +0.06 over ground to avoid z-fighting" (brief) : le centre
// de la boîte est posé 0,06 au-dessus du sol, donc sa face inférieure flotte
// à 0,06 - 0,025 = 0,035 au-dessus de `groundHeightAt` — jamais coïncidente
// avec le maillage de terrain, jamais assez haute pour paraître en lévitation.
const ROAD_Y_OFFSET = 0.06;
// Franchissement du fleuve (post-v2). Le cardo est le seul axe de la table qui
// traverse la Seine (deux fois, par le Petit-Pont puis le pont au Change). Tant
// que le plan d'eau était enfoui sous le terrain, la chaussée s'y peignait à plat
// sans que ça se voie ; maintenant que la Seine est rendue *au-dessus* du sol, un
// ruban posé à ROAD_Y_OFFSET passerait dessous et la rue s'interromprait au
// milieu du fleuve. Les tronçons au-dessus de l'eau sont donc portés en tablier,
// 0,55 au-dessus du plan d'eau : le pont que la table sous-entendait déjà.
const ROAD_DECK_LIFT = 0.55;

/**
 * Altitude du dessous d'un tronçon de chaussée : le sol rendu, ou un tablier
 * au-dessus du plan d'eau si le tronçon franchit la Seine.
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
function roadBaseY(x, z) {
  if (isOverSeineWater(x, z)) return seineWaterHeightAt(x, z) + ROAD_DECK_LIFT;
  return groundHeightAt(x, z);
}

// ============================================================================
// Scratch three.js — réutilisé, jamais alloué dans update
// ============================================================================

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

function composeFlat(x, y, z, yaw, sx, sy, sz) {
  _q.setFromAxisAngle(UP, yaw);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  _m.compose(_p, _q, _s);
  return _m;
}

// ============================================================================
// Construction — une InstancedMesh, capacité fixe = somme des segments
// ============================================================================

const state = {
  mesh: null,
  // Une entrée par polyligne (donc 2 pour les Grands Boulevards, 1 pour tout
  // le reste) : { road, plan, offset, count }. `offset`/`count` indexent la
  // plage de `mesh` que cette polyligne occupe.
  entries: [],
  total: 0,
};

function buildRoads(ctx) {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshLambertMaterial({ color: COLORS.road });

  const entries = [];
  let total = 0;
  for (const road of ROADS) {
    for (const points of roadPolylines(road)) {
      // Correctif critique n°1 (revue post-v1) : subdiviser avant de
      // segmenter, sinon les longues cordes hand-authored font flotter/
      // trancher le ruban dans le relief exagéré — voir le docstring de
      // `subdividePolyline` ci-dessus.
      const dense = subdividePolyline(points, !!road.closed, ROAD_MAX_CHORD);
      const plan = wallRingPlan(dense, { closed: !!road.closed, towerEvery: 0, gates: [] });
      entries.push({ road, plan, offset: total, count: plan.segments.length });
      total += plan.segments.length;
    }
  }

  const mesh = new THREE.InstancedMesh(box, material, Math.max(total, 1));
  mesh.count = total;
  mesh.frustumCulled = false;
  mesh.name = "roads_ribbon";
  ctx.scene.add(mesh);

  state.mesh = mesh;
  state.entries = entries;
  state.total = total;
}

/** Recalcule toutes les matrices pour l'année courante. */
function applyRoads(year) {
  const mesh = state.mesh;
  for (const entry of state.entries) {
    const { presence } = lifecycle(year, entry.road);
    // Croissance en largeur (idiome déjà utilisé par le ruban du périphérique
    // dans rails.js — "il s'élargit depuis son axe") : pas de vague le long
    // du tracé, toute la longueur grandit ensemble.
    const grow = presence > 0 ? easeOutBack(clamp01(presence), 0.4) : 0;
    const width = (entry.road.width ?? ROAD_WIDTH_DEFAULT) * grow;
    for (let i = 0; i < entry.plan.segments.length; i++) {
      const idx = entry.offset + i;
      if (grow <= 0) {
        mesh.setMatrixAt(idx, _zero);
        continue;
      }
      const seg = entry.plan.segments[i];
      const groundY = roadBaseY(seg.midX, seg.midZ);
      mesh.setMatrixAt(
        idx,
        composeFlat(
          seg.midX,
          groundY + ROAD_Y_OFFSET,
          seg.midZ,
          seg.angle,
          Math.max(seg.length, 0.05),
          ROAD_THICKNESS,
          Math.max(width, 0.02)
        )
      );
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
}

// ============================================================================
// Contrat de layer
// ============================================================================

let lastAppliedYear = null;

export function init(ctx) {
  buildRoads(ctx);
  lastAppliedYear = null;
  applyRoads(2026);
  lastAppliedYear = 2026;
}

export function update(dt, appState) {
  // Aucune circulation, aucune animation par frame — voir le docstring
  // d'en-tête ("le périph a les voitures"). Seul le changement d'année
  // déclenche une réécriture, exactement comme walls.js/rails.js.
  if (appState.year !== lastAppliedYear) {
    applyRoads(appState.year);
    lastAppliedYear = appState.year;
  }
}

/** Même contrat que walls.forceRescan / rails.forceRescan. */
export function forceRescan(year) {
  applyRoads(year);
  lastAppliedYear = year;
}

/** Diagnostic pour la vérification automatisée. */
export function debugCounts(year) {
  const out = {};
  for (const entry of state.entries) {
    const { phase, presence } = lifecycle(year, entry.road);
    const key = state.entries.filter((e) => e.road === entry.road).length > 1 ? `${entry.road.id}#${entry.offset}` : entry.road.id;
    out[key] = {
      name: entry.road.name,
      phase,
      presence: Math.round(presence * 1000) / 1000,
      segments: entry.count,
    };
  }
  return out;
}

/** Nombre d'instances construites (coût de la couche). */
export function stats() {
  return { totalSegments: state.total, roads: ROADS.length };
}
