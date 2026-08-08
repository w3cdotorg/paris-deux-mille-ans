/**
 * Terrain layer — sol relief + Seine animée + îles + forêts + marais.
 *
 * Cette couche ne possède **plus** l'éclairage : le rig provisoire qu'elle
 * portait (hémisphérique + directionnelle, brouillard, dôme de ciel,
 * `scene.background`) a été extrait vers `layers/weather.js` à la tâche 14,
 * qui le remplace par 14 signatures d'époque × 4 modes météo. Terrain garde sa
 * géométrie, ses couleurs de sol et le miroitement de l'eau.
 *
 * Layer contract: init(ctx) builds the (mostly static) scene graph once;
 * update(dt, state) is called every frame and re-derives everything that
 * depends on state.year, but only actually recomputes when the (rounded)
 * year changes and a small time-based debounce has elapsed — never per
 * frame. Water shimmer is the only true per-frame cost (one uniform write).
 *
 * Conventions inherited from geography.js: 1 unit = 10 m, x = east, z =
 * south, y = up, water level y ≈ 0.
 */

import * as THREE from "three";
import {
  heightAt,
  urbanYear,
  distanceToSeine,
  seineHalfWidthAt,
  SEINE_POINTS,
  SEINE_ONMAP_COUNT,
  ISLANDS,
  ISLAND_PLATEAU_K,
  insideMonumentFootprint,
} from "../geography.js";
import { lifecycle, lerp, smoothstep } from "../timeEngine.js";

// ============================================================================
// Tunables
// ============================================================================

// Extended beyond the brief's minimum (x:[-1100,700] z:[-800,800]) so the
// finite plane's edge stays well outside the fixed aerial camera's frustum —
// otherwise the sky dome's underside peeks through past the corner at this
// oblique angle. Kept fairly large even after steepening the camera (fix for
// review Critical 2) as a safety margin against any residual grazing ray.
const GROUND_X_MIN = -2200;
const GROUND_X_MAX = 1800;
const GROUND_Z_MIN = -2200;
const GROUND_Z_MAX = 2200;
const GROUND_SEGMENTS_X = 256;
const GROUND_SEGMENTS_Z = 256;

// Trees are only generated within this smaller, brief-matching window (not
// across the padded GROUND_* extent above) — the padding exists purely to
// keep the horizon seamless from the fixed camera; seeding ~20k tree
// candidates over 2.7x more area than that would both blow past the
// brief's target count and waste density on countryside that's barely in
// frame.
const FOREST_X_MIN = -1100;
const FOREST_X_MAX = 700;
const FOREST_Z_MIN = -800;
const FOREST_Z_MAX = 800;

// Teinte d'eau du sol — post-v2, « berges nettes ».
//
// Avant : la teinte partait de 6 unités de l'axe et ne s'éteignait qu'à 16
// (RIVER_WATER_CORE=6 / RIVER_WATER_FADE=10), soit un halo bleu-vert de 9
// unités *au-delà* du bord de l'eau. Sur un maillage de sol dont les mailles
// font 15 à 17 unités, ce dégradé s'étalait encore plus : c'est lui — et pas
// l'eau — qui donnait le « gros bourrelet sombre » au milieu duquel plus rien
// ne se lisait.
//
// Désormais la teinte est calée sur le *bord de l'eau* réel
// (`seineHalfWidthAt`, qui s'élargit autour des îles) : pleine jusqu'à
// `SHORELINE_INSET` en deçà du bord, éteinte `SHORELINE_FADE` au-delà. Elle
// n'est plus qu'un fond sous le ruban d'eau ; la netteté du trait de côte vient
// du ruban lui-même et de la lisière de berge (`buildRiverBanks`), tous deux
// maillés assez fin pour porter une arête.
const SHORELINE_INSET = 1;
const SHORELINE_FADE = 3;

// Half-width, in years, of the forest<->urban color transition band. Wide on
// purpose: urbanYear() bakes in ±40-80y of organic noise for irregular growth
// fronts, and a narrow band would turn that into leopard-print speckling
// instead of a coherent (if slightly fuzzy) frontier. Trees still use a hard
// threshold (see rescanForest), so the retreat itself still reads crisply.
const TRANSITION_YEARS = 110;

// --- Îles : la Cité et Saint-Louis sont de la TERRE, pas des bosses ---------
//
// Post-v2. Avant : les deux îles n'étaient qu'une gaussienne (+2,4) ajoutée aux
// sommets du maillage de sol. Or ce maillage a des mailles de 15,6 × 17,2
// unités, et l'île de la Cité mesure 24 × 10 : **elle était plus petite qu'une
// maille**, donc littéralement irreprésentable — la bosse se réduisait à une
// tente grossière qui masquait tout juste l'eau sans jamais se lire comme une
// terre. Notre-Dame se dressait au milieu du fleuve.
//
// Les deux îles ont désormais leur propre maillage (`buildIslands`), radial et
// fin, dont la surface vaut exactement `groundHeightAt` : tout ce qui se pose au
// sol (huttes gauloises, Notre-Dame, Sainte-Chapelle, foule) reste donc d'aplomb
// sur l'île sans qu'aucun consommateur ne connaisse leur existence.
//
// 1,7 unité de franc-bord (17 m) : l'île réelle domine la Seine de 5 à 8 m, et
// tout le relief de la scène est exagéré ×2,6 (voir RELIEF_EXAGGERATION dans
// geography.js) — 1,7 est donc l'échelle cohérente, et c'est ce qu'il faut pour
// que l'île se lise comme une terre habitée et non comme un banc de sable.
const ISLAND_FREEBOARD = 1.7;
// Le rayon normalisé où commence le talus de berge (plateau plein en deçà,
// descente jusqu'au niveau du lit à k = 1) est ISLAND_PLATEAU_K, importé de
// geography.js : le bâti des cellules d'île s'y ancre aussi
// (`clampToIslandPlateau`), donc la constante vit avec la géométrie partagée.
// Pour la Cité, 0,82 → 1 vaut 0,9 unité en z : un talus franc, qui donne
// l'arête de rive demandée.
// Anneau immergé qui prolonge l'île sous l'eau : garantit qu'aucun interstice
// n'apparaît entre la rive et le ruban d'eau, quel que soit l'angle de vue.
const ISLAND_SKIRT_K = 1.06;
const ISLAND_SKIRT_DROP = 0.5;
const ISLAND_RADIAL_SEGMENTS = 56;
// Anneaux radiaux : resserrés autour du talus (0,82 → 1) pour porter l'arête.
const ISLAND_RINGS = [0, 0.4, 0.66, ISLAND_PLATEAU_K, 0.89, 0.95, 1, ISLAND_SKIRT_K];

const LOUVIERS_BUMP_AMPLITUDE = 2.0;
const LOUVIERS_CHANNEL_DEPTH = 1.8; // "bras mort" separating it from the right bank

const FOREST_CELL = 12; // grid spacing (world units) for tree candidates
const FOREST_JITTER = 0.8; // fraction of cell used for jitter
// Marge de berge des arbres, mesurée depuis le *bord de l'eau* (pas depuis
// l'axe) : 2 unités, soit exactement l'ancienne marge de 9 là où le lit fait 7
// de demi-largeur, mais qui suit l'évasement autour des îles.
const SEINE_TREE_BANK_MARGIN = 2;

const RESCAN_MIN_INTERVAL = 0.06; // seconds, debounce for year-driven rescans

const MARSH_SPOTS = [
  { x: 108, z: -22, r: 26 },
  { x: 58, z: 46, r: 20 },
  { x: -55, z: -18, r: 22 },
  { x: 205, z: 95, r: 24 },
];

// --- Plan d'eau ------------------------------------------------------------
//
// Post-v2, LE correctif de fond. Le ruban de Seine était posé à y = -0,04, une
// altitude *absolue*, en supposant que « 0 = niveau de l'eau ». Or la tâche
// post-v1 « relief » a multiplié les collines par 2,6 : la montagne
// Sainte-Geneviève culmine désormais assez haut pour que le sol *sous l'île de
// la Cité* soit à +4,05, et tout le centre de Paris entre +0,4 et +4. Le ruban
// d'eau était donc **enfoui sous le terrain** sur toute la traversée urbaine —
// le « fleuve » visible à l'écran n'était plus que la teinte des sommets du sol
// (le halo ci-dessus), sans arête, sans miroitement, sans île. Les bateaux
// (posés eux aussi à y = 0,02) étaient enterrés avec lui.
//
// Le plan d'eau suit donc maintenant le terrain : chaque sommet du ruban est
// posé `WATER_SURFACE_LIFT` au-dessus du sol *rendu* sous lui. C'est un décalque
// (le même idiome que les chaussées de roads.js, à +0,035) plutôt qu'un plan
// horizontal — cohérent avec une scène dont le relief est de toute façon exagéré
// ×2,6, et robuste : le fleuve ne peut plus jamais être avalé par une colline.
// 0,26 : mesuré, pas choisi au jugé. Le sol rendu est affine par morceaux
// (deux triangles par maille de 15,6 × 17,2) tandis que le plan d'eau est
// linéaire entre SES propres sommets ; l'écart résiduel dans une maille d'eau
// culmine à ~0,14 sur les flancs de la montagne Sainte-Geneviève. 0,26 le
// couvre avec le double de marge, houle du shader (0,03) comprise — voir le
// script de mesure décrit dans le rapport post-v2.
const WATER_SURFACE_LIFT = 0.26;
// La lisière de berge : une bande claire posée juste en dehors du bord de l'eau,
// 4 cm au-dessus du plan d'eau. C'est elle qui donne au fleuve un trait de côte
// à toutes les époques et sous tous les éclairages — le maillage du sol, avec
// ses mailles de 16 unités, en est incapable.
const BANK_LIFT = 0.34;
const BANK_WIDTH = 1.6;

const COLOR_FOREST = new THREE.Color(0x2f6b34);
const COLOR_URBAN = new THREE.Color(0xd8c6a0);
const COLOR_WATER = new THREE.Color(0x3d6d82);
// Berges et îles : une pierre chaude, distincte à la fois de l'eau (froide) et
// du sol alentour (vert forêt aux époques anciennes, sable urbain ensuite).
const COLOR_BANK = new THREE.Color(0xc9b791);
const COLOR_BANK_EDGE = new THREE.Color(0xe4d8b4); // le liseré, plus clair
const COLOR_ISLAND = new THREE.Color(0xcdbd96);
const COLOR_ISLAND_SLOPE = new THREE.Color(0xa08e6c); // le talus, dans l'ombre
const COLOR_ISLAND_WET = new THREE.Color(0x5c6b62); // la part immergée

const UP = new THREE.Vector3(0, 1, 0);

// ============================================================================
// Tiny deterministic hash — cosmetic variation only (mirrors geography.js's
// own hash2, duplicated locally so this module stays self-contained).
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

function ellipseFalloff(x, z, cx, cz, rx, rz) {
  const dx = (x - cx) / rx;
  const dz = (z - cz) / rz;
  return Math.exp(-(dx * dx + dz * dz));
}

// ============================================================================
// Pure decision functions — no THREE, no scene graph. Exported so they can
// be unit-tested directly (node --test) without a WebGL context.
// ============================================================================

/**
 * Forest<->urban blend factor for a ground cell: 0 = pure forest colour,
 * 1 = pure urban colour. Smooth over TRANSITION_YEARS on purpose — see the
 * constant's comment — but still resolves to (numerically) 0 or 1 far from
 * the frontier, e.g. a cell urbanized many centuries before `year`.
 * @param {number} urbanYearValue - urbanYear(x, z); may be Infinity.
 * @param {number} year
 * @param {number} [transitionYears]
 * @returns {number} in [0, 1]
 */
export function groundUrbanBlend(urbanYearValue, year, transitionYears = TRANSITION_YEARS) {
  const raw = clamp01((year - urbanYearValue) / transitionYears + 0.5);
  return smoothstep(raw);
}

/**
 * Whether a forest candidate should be a live tree at `year`: excludes
 * water (river course, via a spatial margin — not a height threshold, see
 * SHORELINE_INSET's comment for why) and any cell already urbanized by
 * `year`. Deliberately a hard threshold (unlike the ground colour blend
 * above) — the retreat itself should read crisply.
 *
 * `seineMargin` est la distance à l'axe en deçà de laquelle le candidat est
 * dans l'eau : `buildForestCandidates` la calcule par candidat
 * (`seineHalfWidthAt` + `SEINE_TREE_BANK_MARGIN`), de sorte qu'elle suive
 * l'évasement du fleuve autour des îles. La valeur par défaut (9) est celle du
 * lit standard (7 + 2), conservée pour les appels de test directs.
 * @param {number} distSeineValue - distance from the candidate to the Seine centerline.
 * @param {number} urbanYearValue - urbanYear(x, z); may be Infinity.
 * @param {number} year
 * @param {number} [seineMargin]
 * @returns {boolean}
 */
export function isForestCandidate(distSeineValue, urbanYearValue, year, seineMargin = 9) {
  if (distSeineValue < seineMargin) return false;
  return urbanYearValue > year;
}

/** Rayon normalisé d'un point dans l'ellipse d'une île (0 = centre, 1 = rive). */
function islandK(x, z, isl) {
  const dx = (x - isl.x) / isl.rx;
  const dz = (z - isl.z) / isl.rz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Profil vertical d'une île, en fraction de `ISLAND_FREEBOARD` : 1 sur le
 * plateau (k ≤ `ISLAND_PLATEAU_K`), descente `smoothstep` jusqu'à 0 au trait de
 * rive (k = 1), 0 au-delà. Exportée pour les tests : c'est la fonction dont
 * dépendent à la fois la surface rendue de l'île et l'assise de tout ce qui s'y
 * pose (`groundHeightAt`), donc la garantie que rien n'y flotte ni ne s'y noie.
 * @param {number} k rayon normalisé dans l'ellipse de l'île
 * @returns {number} dans [0, 1]
 */
export function islandProfile(k) {
  if (k <= ISLAND_PLATEAU_K) return 1;
  if (k >= 1) return 0;
  return smoothstep((1 - k) / (1 - ISLAND_PLATEAU_K));
}

/**
 * Franc-bord de l'île (Cité ou Saint-Louis) en (x, z) : 0 partout ailleurs.
 * S'ajoute au sol *rendu* dans `groundHeightAt`, et c'est exactement ce que
 * `buildIslands` maille — une seule source de vérité pour « à quelle altitude
 * est le dessus de l'île ».
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
export function islandFreeboardAt(x, z) {
  let best = 0;
  for (const isl of [ISLANDS.cite, ISLANDS.saintLouis]) {
    const p = islandProfile(islandK(x, z, isl));
    if (p > best) best = p;
  }
  return best * ISLAND_FREEBOARD;
}

/**
 * Louviers: raised while alive, plus a "bras mort" (dead arm) trough that
 * separates it from the right bank. Both fade out with `presence`, so as the
 * island dies (1843+) it flattens back to ordinary land — the north branch
 * filling in, exactly as the brief describes.
 */
function louviersDelta(x, z, year) {
  const louviers = ISLANDS.louviers;
  const presence = lifecycle(year, { born: -10000, died: louviers.died, razeYears: 10 }).presence;
  if (presence <= 0) return 0;
  const bump =
    LOUVIERS_BUMP_AMPLITUDE *
    presence *
    ellipseFalloff(x, z, louviers.x, louviers.z, louviers.rx * 1.3, louviers.rz * 1.3);
  const channelZ = louviers.z - (louviers.rz + 3);
  const channel =
    LOUVIERS_CHANNEL_DEPTH *
    presence *
    ellipseFalloff(x, z, louviers.x, channelZ, louviers.rx + 2, 2.5);
  return bump - channel;
}

// ============================================================================
// Module state (populated by init, consumed by update)
// ============================================================================

const ground = {
  geometry: null,
  mesh: null,
  vertsX: 0,
  vertsZ: 0,
  x: null, // Float32Array world x per vertex
  z: null, // Float32Array world z per vertex
  uYear: null, // Float32Array urbanYear(x,z) per vertex, cached (year-independent)
  variation: null, // Float32Array cosmetic noise per vertex, [-1, 1]
  distSeine: null, // Float32Array distanceToSeine(x,z) per vertex, cached
  riverHalfWidth: null, // Float32Array seineHalfWidthAt(x,z) per vertex, cached
  louviersIndices: null, // Int32Array of vertex indices near Louviers/channel
};

const forestState = {
  candidates: [], // {x,z,y,uYear,archetype,rot,scale,hueShift}
  trunkMesh: null,
  crownMeshes: [],
};

let marshMeshes = [];
let islandMeshes = [];
let waterMaterial = null;

let lastScanYear = null;
let lastScanTime = -Infinity;

// ============================================================================
// Ground
// ============================================================================

function buildGround(ctx) {
  const segX = GROUND_SEGMENTS_X;
  const segZ = GROUND_SEGMENTS_Z;
  const vertsX = segX + 1;
  const vertsZ = segZ + 1;
  const vertexCount = vertsX * vertsZ;

  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const x = new Float32Array(vertexCount);
  const z = new Float32Array(vertexCount);
  const uYear = new Float32Array(vertexCount);
  const variation = new Float32Array(vertexCount);
  const distSeine = new Float32Array(vertexCount);
  const riverHalfWidth = new Float32Array(vertexCount);
  const louviersIdx = [];

  const louviers = ISLANDS.louviers;
  const louviersBoxXMin = louviers.x - (louviers.rx * 1.3 + 6);
  const louviersBoxXMax = louviers.x + (louviers.rx * 1.3 + 6);
  const louviersBoxZMin = louviers.z - (louviers.rz + 3) - 6;
  const louviersBoxZMax = louviers.z + (louviers.rz * 1.3 + 6);

  for (let iz = 0; iz < vertsZ; iz++) {
    const vz = lerp(GROUND_Z_MIN, GROUND_Z_MAX, iz / segZ);
    for (let ix = 0; ix < vertsX; ix++) {
      const vx = lerp(GROUND_X_MIN, GROUND_X_MAX, ix / segX);
      const idx = iz * vertsX + ix;

      x[idx] = vx;
      z[idx] = vz;
      uYear[idx] = urbanYear(vx, vz);
      variation[idx] = hash01(ix, iz, 777) * 2 - 1;
      distSeine[idx] = distanceToSeine(vx, vz);
      riverHalfWidth[idx] = seineHalfWidthAt(vx, vz);

      // Le franc-bord des îles n'est PLUS ajouté ici : à 15,6 × 17,2 unités par
      // maille, ce maillage est trop grossier pour porter une île de 24 × 10 (il
      // en faisait une tente informe). Les îles ont leur propre maillage radial,
      // et `groundHeightAt` rajoute analytiquement leur franc-bord.
      const base = heightAt(vx, vz);
      positions[idx * 3 + 0] = vx;
      positions[idx * 3 + 1] = base;
      positions[idx * 3 + 2] = vz;

      if (
        vx >= louviersBoxXMin &&
        vx <= louviersBoxXMax &&
        vz >= louviersBoxZMin &&
        vz <= louviersBoxZMax
      ) {
        louviersIdx.push(idx);
      }
    }
  }

  const indices = [];
  for (let iz = 0; iz < segZ; iz++) {
    for (let ix = 0; ix < segX; ix++) {
      const a = iz * vertsX + ix;
      const b = a + 1;
      const c = a + vertsX;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  ctx.scene.add(mesh);

  ground.geometry = geometry;
  ground.mesh = mesh;
  ground.vertsX = vertsX;
  ground.vertsZ = vertsZ;
  ground.x = x;
  ground.z = z;
  ground.uYear = uYear;
  ground.variation = variation;
  ground.distSeine = distSeine;
  ground.riverHalfWidth = riverHalfWidth;
  ground.louviersIndices = Int32Array.from(louviersIdx);
}

/**
 * Altitude de la nappe de terrain *hors îles*, échantillonnée sur le **plan du
 * triangle réellement rasterisé**, et non par interpolation bilinéaire.
 *
 * Cette distinction n'est pas cosmétique. Le maillage est une grille 256×256 sur
 * 4000×4400 unités (~15,6 × 17,2 par maille), et chaque maille est découpée en
 * DEUX triangles le long de l'anti-diagonale (voir `indices.push(a, c, b, b, c,
 * d)` dans `buildGround`). La surface rendue est donc affine par morceaux, pas
 * bilinéaire : sur une maille gauche les deux surfaces s'écartent de la moitié du
 * gauchissement, ce qui, sur les flancs de la montagne Sainte-Geneviève, atteint
 * plusieurs dixièmes d'unité. Un plan d'eau posé 0,12 au-dessus de
 * l'échantillon *bilinéaire* laissait donc ressortir des triangles de sol au
 * milieu du fleuve — de grands losanges couleur berge, constatés sur la première
 * capture post-correctif. Sur le plan du triangle, l'accord est exact.
 *
 * Les appelants doivent tourner après `init()` ; avant, la fonction se dégrade
 * proprement en hauteur analytique.
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
function groundBaseHeightAt(x, z) {
  if (!ground.geometry) return heightAt(x, z);
  const positions = ground.geometry.attributes.position.array;
  const fx = clamp01((x - GROUND_X_MIN) / (GROUND_X_MAX - GROUND_X_MIN)) * GROUND_SEGMENTS_X;
  const fz = clamp01((z - GROUND_Z_MIN) / (GROUND_Z_MAX - GROUND_Z_MIN)) * GROUND_SEGMENTS_Z;
  const ix0 = Math.min(Math.floor(fx), GROUND_SEGMENTS_X - 1);
  const iz0 = Math.min(Math.floor(fz), GROUND_SEGMENTS_Z - 1);
  const tx = fx - ix0;
  const tz = fz - iz0;
  const row0 = iz0 * ground.vertsX;
  const row1 = row0 + ground.vertsX;
  const h00 = positions[(row0 + ix0) * 3 + 1];
  const h10 = positions[(row0 + ix0 + 1) * 3 + 1];
  const h01 = positions[(row1 + ix0) * 3 + 1];
  const h11 = positions[(row1 + ix0 + 1) * 3 + 1];
  // Triangle bas-gauche (h00, h10, h01) puis triangle haut-droit (h10, h01, h11) :
  // l'arête partagée va de (1,0) à (0,1), exactement le découpage de buildGround.
  if (tx + tz <= 1) return h00 + tx * (h10 - h00) + tz * (h01 - h00);
  return h11 + (1 - tx) * (h01 - h11) + (1 - tz) * (h10 - h11);
}

/**
 * Altitude de la **surface au sol telle qu'elle est rendue** en (x, z) : la
 * nappe de terrain, plus le franc-bord des îles de la Cité et de Saint-Louis.
 * Source unique partagée par tout ce qui doit se poser au sol — bâtiments,
 * monuments, foule, chaussées, rails, brasiers, vignettes de récit. C'est ce qui
 * garantit que les huttes gauloises et Notre-Dame sont *sur* l'île, à sec, et
 * non un mètre au-dessous de sa surface (voir `islandFreeboardAt`).
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
export function groundHeightAt(x, z) {
  return groundBaseHeightAt(x, z) + islandFreeboardAt(x, z);
}

/**
 * Altitude du **plan d'eau** de la Seine en (x, z) : la nappe de terrain (donc
 * SANS le franc-bord des îles — l'eau passe autour d'elles, pas dessus) plus
 * `WATER_SURFACE_LIFT`. Exportée parce que trois autres couches en ont besoin
 * pour ne pas s'enterrer : les bateaux de `life.js`, le tablier du pont au
 * Change (`monuments.js`) et les chaussées de `roads.js` qui franchissent le
 * fleuve. Voir le commentaire de `WATER_SURFACE_LIFT` pour le pourquoi.
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
export function seineWaterHeightAt(x, z) {
  return groundBaseHeightAt(x, z) + WATER_SURFACE_LIFT;
}

/** Patches just the Louviers/channel neighborhood's height for the given year. */
function patchLouviers(year) {
  const positions = ground.geometry.attributes.position.array;
  const { louviersIndices, x, z } = ground;
  for (let k = 0; k < louviersIndices.length; k++) {
    const idx = louviersIndices[k];
    const vx = x[idx];
    const vz = z[idx];
    positions[idx * 3 + 1] = heightAt(vx, vz) + louviersDelta(vx, vz, year);
  }
  ground.geometry.attributes.position.needsUpdate = true;
  ground.geometry.computeVertexNormals();
  ground.geometry.attributes.normal.needsUpdate = true;
}

/** Recomputes every vertex color for the given year (cheap: pure scalar math). */
function recolorGround(year) {
  const colors = ground.geometry.attributes.color.array;
  const { x, z, uYear, variation, distSeine, riverHalfWidth } = ground;
  const vertexCount = uYear.length;

  const fr = COLOR_FOREST.r, fg = COLOR_FOREST.g, fb = COLOR_FOREST.b;
  const ur = COLOR_URBAN.r, ug = COLOR_URBAN.g, ub = COLOR_URBAN.b;
  const wr = COLOR_WATER.r, wg = COLOR_WATER.g, wb = COLOR_WATER.b;

  const louviers = ISLANDS.louviers;
  const louviersPresence = lifecycle(year, { born: -10000, died: louviers.died, razeYears: 10 }).presence;
  const channelZ = louviers.z - (louviers.rz + 3);

  for (let i = 0; i < vertexCount; i++) {
    const urbanT = groundUrbanBlend(uYear[i], year);
    const variationFactor = 1 + variation[i] * 0.08;

    let r = (fr + (ur - fr) * urbanT) * variationFactor;
    let g = (fg + (ug - fg) * urbanT) * variationFactor;
    let b = (fb + (ub - fb) * urbanT) * variationFactor;

    // La teinte d'eau est un masque *spatial* (distance à l'axe de la Seine /
    // au bras mort de Louviers), pas un seuil d'altitude — le bruit de base de
    // heightAt() suffirait sinon à faire passer de la terre ferme pour de l'eau.
    // Post-v2 : le masque est calé sur le bord de l'eau *local*
    // (`riverHalfWidth`, élargi autour des îles) et ne dépasse plus que de
    // SHORELINE_FADE - SHORELINE_INSET = 2 unités, au lieu de 9.
    const riverT = clamp01(
      (distSeine[i] - (riverHalfWidth[i] - SHORELINE_INSET)) / SHORELINE_FADE
    );
    let waterFactor = 1 - smoothstep(riverT);
    if (louviersPresence > 0) {
      const channelFalloff = ellipseFalloff(x[i], z[i], louviers.x, channelZ, louviers.rx + 2, 2.5);
      waterFactor = Math.max(waterFactor, louviersPresence * channelFalloff);
    }

    r += (wr - r) * waterFactor;
    g += (wg - g) * waterFactor;
    b += (wb - b) * waterFactor;

    colors[i * 3 + 0] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  ground.geometry.attributes.color.needsUpdate = true;
}

// ============================================================================
// Seine ribbon
// ============================================================================

const WATER_VERTEX_SHADER = `
  attribute float aFade;
  varying vec2 vUv;
  varying float vFade;
  uniform float uTime;
  void main() {
    vUv = uv;
    vFade = aFade;
    vec3 pos = position;
    // Houle de 0,03 : le plan d'eau n'est qu'à WATER_SURFACE_LIFT (0,12) au-dessus
    // du sol, une ondulation plus ample le ferait plonger dedans par intermittence.
    pos.y += sin(uTime * 0.6 + uv.y * 30.0) * 0.03 * aFade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const WATER_FRAGMENT_SHADER = `
  varying vec2 vUv;
  varying float vFade;
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  void main() {
    float s1 = sin(vUv.y * 50.0 - uTime * 1.4) * 0.5 + 0.5;
    float s2 = sin(vUv.y * 17.0 + vUv.x * 6.0 + uTime * 0.8) * 0.5 + 0.5;
    float shimmer = mix(0.86, 1.24, s1 * 0.6 + s2 * 0.4);
    vec3 color = mix(uColorA, uColorB, vUv.x) * shimmer;
    float alpha = 0.94 * vFade;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

// Échantillonnage du fleuve : 700 sections le long de la courbe (~3,5 unités,
// assez fin pour porter l'évasement autour des îles) et 5 colonnes en travers.
//
// Les colonnes intermédiaires ne sont pas décoratives : chaque sommet est posé
// sur le sol *rendu* sous lui (`seineWaterHeightAt`), et deux colonnes seules
// relieraient les deux rives par une corde droite de 24 unités près des îles —
// le terrain, bombé par la montagne Sainte-Geneviève, ressortirait au milieu du
// fleuve (erreur mesurée ~0,45 unité, soit 4× le décalage de surface). À 5
// colonnes la corde tombe à 6 unités et l'erreur à ~0,03.
const RIVER_SAMPLES = 1000;
const RIVER_COLUMNS = 7;

/**
 * Parcourt la courbe de la Seine et appelle `visit` pour chaque section, avec le
 * point de l'axe, la normale unitaire, la demi-largeur locale du lit et le
 * facteur d'estompe de la boucle hors carte. Factorisé parce que trois
 * maillages en ont besoin exactement au même endroit : le plan d'eau, les deux
 * lisières de berge et (indirectement) le fondu de la queue hors carte.
 * @param {(u:number, i:number, p:THREE.Vector3, perp:THREE.Vector3, hw:number, fade:number) => void} visit
 */
function walkRiver(visit) {
  const curvePoints = SEINE_POINTS.map((p) => new THREE.Vector3(p.x, 0, p.z));
  const curve = new THREE.CatmullRomCurve3(curvePoints, false, "catmullrom", 0.4);
  const uOnMap = (SEINE_ONMAP_COUNT - 1) / (SEINE_POINTS.length - 1);
  const tangent = new THREE.Vector3();
  const perp = new THREE.Vector3();

  for (let i = 0; i < RIVER_SAMPLES; i++) {
    const u = i / (RIVER_SAMPLES - 1);
    const p = curve.getPointAt(u);
    curve.getTangentAt(u, tangent);
    perp.set(-tangent.z, 0, tangent.x);
    if (perp.lengthSq() < 1e-8) perp.set(1, 0, 0);
    else perp.normalize();

    // La demi-largeur suit `seineHalfWidthAt` : identique (7) partout, élargie
    // (12) autour de la Cité et de Saint-Louis — c'est ce qui dégage un bras
    // d'eau visible de chaque côté des deux îles.
    let hw = seineHalfWidthAt(p.x, p.z);
    let fade = 1;
    if (u > uOnMap) {
      const s = smoothstep((u - uOnMap) / (1 - uOnMap));
      hw *= lerp(1, 0.3, s);
      fade = 1 - s;
    }
    visit(u, i, p, perp, hw, fade);
  }
}

/** Le plan d'eau : un décalque qui épouse le terrain, élargi autour des îles. */
function buildRiverGeometry() {
  const vertsPerSection = RIVER_COLUMNS;
  const total = RIVER_SAMPLES * vertsPerSection;
  const positions = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  const fades = new Float32Array(total);
  const indices = [];

  walkRiver((u, i, p, perp, hw, fade) => {
    for (let c = 0; c < vertsPerSection; c++) {
      const v = c / (vertsPerSection - 1); // 0 = rive gauche du ruban, 1 = droite
      const off = lerp(hw, -hw, v);
      const px = p.x + perp.x * off;
      const pz = p.z + perp.z * off;
      const idx = i * vertsPerSection + c;
      positions[idx * 3 + 0] = px;
      positions[idx * 3 + 1] = seineWaterHeightAt(px, pz);
      positions[idx * 3 + 2] = pz;
      uvs[idx * 2 + 0] = v;
      uvs[idx * 2 + 1] = u;
      fades[idx] = fade;
    }
    if (i < RIVER_SAMPLES - 1) {
      for (let c = 0; c < vertsPerSection - 1; c++) {
        const a = i * vertsPerSection + c;
        const b = a + 1;
        const d = a + vertsPerSection;
        const e = d + 1;
        indices.push(a, b, d, b, e, d);
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("aFade", new THREE.BufferAttribute(fades, 1));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Les deux lisières de berge : une bande claire de `BANK_WIDTH` posée juste en
 * dehors du bord de l'eau, sur chaque rive. C'est le trait de côte du fleuve —
 * le maillage du sol (mailles de 16 unités) est incapable d'en porter un, et
 * sans lui l'eau se fondait dans la berge à toutes les époques sombres.
 * S'estompe avec le ruban sur la boucle hors carte.
 */
function buildRiverBanksGeometry() {
  // 2 rives × 2 colonnes (bord de l'eau, bord extérieur) par section.
  const perSection = 4;
  const total = RIVER_SAMPLES * perSection;
  const positions = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const indices = [];

  walkRiver((u, i, p, perp, hw, fade) => {
    const width = BANK_WIDTH * fade;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1;
      for (let c = 0; c < 2; c++) {
        const off = side * (hw + width * c);
        const px = p.x + perp.x * off;
        const pz = p.z + perp.z * off;
        const idx = i * perSection + s * 2 + c;
        positions[idx * 3 + 0] = px;
        positions[idx * 3 + 1] = groundBaseHeightAt(px, pz) + BANK_LIFT;
        positions[idx * 3 + 2] = pz;
        // Liseré clair au contact de l'eau, pierre plus sourde vers la ville.
        const col = c === 0 ? COLOR_BANK_EDGE : COLOR_BANK;
        const varia = 1 + (hash01(i, s * 2 + c, 313) * 2 - 1) * 0.05;
        colors[idx * 3 + 0] = col.r * varia;
        colors[idx * 3 + 1] = col.g * varia;
        colors[idx * 3 + 2] = col.b * varia;
      }
    }
    if (i < RIVER_SAMPLES - 1) {
      for (let s = 0; s < 2; s++) {
        const a = i * perSection + s * 2;
        const b = a + 1;
        const d = a + perSection;
        const e = d + 1;
        indices.push(a, b, d, b, e, d);
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Une île : un maillage radial (`ISLAND_RINGS` × `ISLAND_RADIAL_SEGMENTS`) dont
 * la surface vaut **exactement** `groundHeightAt`, donc parfaitement d'accord
 * avec tout ce qui s'y pose. Le dernier anneau plonge sous le plan d'eau pour
 * qu'aucun interstice n'apparaisse au trait de rive.
 * @param {{x:number,z:number,rx:number,rz:number}} isl
 * @param {number} seed
 */
function buildIslandGeometry(isl, seed) {
  const rings = ISLAND_RINGS;
  const segs = ISLAND_RADIAL_SEGMENTS;
  // Anneau 0 = un seul sommet central, puis `segs` sommets par anneau suivant.
  const total = 1 + (rings.length - 1) * segs;
  const positions = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const indices = [];

  const put = (idx, k, ang) => {
    const px = isl.x + isl.rx * k * Math.cos(ang);
    const pz = isl.z + isl.rz * k * Math.sin(ang);
    let py = groundHeightAt(px, pz);
    if (k > 1) py = groundBaseHeightAt(px, pz) - ISLAND_SKIRT_DROP;
    positions[idx * 3 + 0] = px;
    positions[idx * 3 + 1] = py;
    positions[idx * 3 + 2] = pz;

    let col = COLOR_ISLAND;
    if (k >= 0.97) col = COLOR_ISLAND_WET;
    else if (k > ISLAND_PLATEAU_K) col = COLOR_ISLAND_SLOPE;
    const varia = 1 + (hash01(Math.round(k * 100), Math.round(ang * 40), seed) * 2 - 1) * 0.07;
    colors[idx * 3 + 0] = col.r * varia;
    colors[idx * 3 + 1] = col.g * varia;
    colors[idx * 3 + 2] = col.b * varia;
  };

  put(0, 0, 0);
  for (let r = 1; r < rings.length; r++) {
    for (let a = 0; a < segs; a++) {
      put(1 + (r - 1) * segs + a, rings[r], (a / segs) * Math.PI * 2);
    }
  }

  // Éventail central
  for (let a = 0; a < segs; a++) {
    indices.push(0, 1 + a, 1 + ((a + 1) % segs));
  }
  // Couronnes
  for (let r = 1; r < rings.length - 1; r++) {
    const base = 1 + (r - 1) * segs;
    const next = base + segs;
    for (let a = 0; a < segs; a++) {
      const a1 = (a + 1) % segs;
      indices.push(base + a, next + a, base + a1);
      indices.push(base + a1, next + a, next + a1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildIslands(ctx) {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const meshes = [];
  const islands = [
    { isl: ISLANDS.cite, seed: 4211 },
    { isl: ISLANDS.saintLouis, seed: 8177 },
  ];
  for (const { isl, seed } of islands) {
    const mesh = new THREE.Mesh(buildIslandGeometry(isl, seed), material);
    mesh.frustumCulled = false;
    // renderOrder 1 : après le sol (0), avant le plan d'eau (2). L'île est
    // opaque et plus haute que l'eau : la profondeur suffirait, mais l'ordre
    // explicite documente l'empilement sol → île → eau.
    mesh.renderOrder = 1;
    ctx.scene.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

function buildRiver(ctx) {
  const geometry = buildRiverGeometry();
  waterMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      // Post-v2 « contraste » : l'ancien couple (0x2c5a72, 0x6fb3c9) tombait
      // dans le quasi-noir sous les signatures anciennes et nocturnes, sur un
      // sol vert forêt lui aussi très sombre. Remontés en clarté ET en
      // saturation ; le shader n'étant pas éclairé (voir weather.js : « la Seine
      // ressort d'elle-même »), ces valeurs sont le contraste final.
      uColorA: { value: new THREE.Color(0x35708f) },
      uColorB: { value: new THREE.Color(0x7cc3db) },
    },
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    // Le plan d'eau n'est qu'à 0,12 au-dessus du sol : ce décalage de profondeur
    // évite tout scintillement de z-fighting aux distances de caméra élevées.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geometry, waterMaterial);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  ctx.scene.add(mesh);

  const bankMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const banks = new THREE.Mesh(buildRiverBanksGeometry(), bankMaterial);
  banks.frustumCulled = false;
  banks.renderOrder = 1;
  ctx.scene.add(banks);
}

// ============================================================================
// Forests
// ============================================================================

function buildForestCandidates(quality) {
  const density = quality && quality.trees ? quality.trees : 1;
  const cell = FOREST_CELL / Math.sqrt(Math.max(0.1, Math.min(2, density)));
  const cellsX = Math.round((FOREST_X_MAX - FOREST_X_MIN) / cell);
  const cellsZ = Math.round((FOREST_Z_MAX - FOREST_Z_MIN) / cell);
  const candidates = [];

  for (let gz = 0; gz < cellsZ; gz++) {
    for (let gx = 0; gx < cellsX; gx++) {
      const jx = (hash01(gx, gz, 11) - 0.5) * cell * FOREST_JITTER;
      const jz = (hash01(gx, gz, 22) - 0.5) * cell * FOREST_JITTER;
      const x = FOREST_X_MIN + (gx + 0.5) * cell + jx;
      const z = FOREST_Z_MIN + (gz + 0.5) * cell + jz;

      const distSeine = distanceToSeine(x, z);
      // Post-v2 : la marge suit le bord de l'eau *local* (élargi autour des
      // îles) au lieu d'une constante calée sur la demi-largeur de 7. Loin des
      // îles, `seineHalfWidthAt` vaut 7 : `seineMargin` retombe donc exactement
      // sur l'ancien SEINE_TREE_MARGIN de 9, et rien ne change hors de l'île.
      const seineMargin = seineHalfWidthAt(x, z) + SEINE_TREE_BANK_MARGIN;
      if (distSeine < seineMargin) continue;
      // Emprise d'un monument (tâche 10) : la forêt recule pour de bon devant
      // les arènes, le Panthéon ou la forteresse du Louvre — sans ce filtre, un
      // sapin poussait au milieu de la cour du donjon aux années où le quartier
      // n'est pas encore urbanisé (constaté sur la capture task10-louvre-1300).
      if (insideMonumentFootprint(x, z)) continue;

      const uYear = urbanYear(x, z);
      const archetype = Math.floor(hash01(gx, gz, 33) * 3);
      const rot = hash01(gx, gz, 44) * Math.PI * 2;
      const scale = 0.75 + hash01(gx, gz, 55) * 0.6;
      const hueShift = hash01(gx, gz, 66) * 2 - 1;
      const y = heightAt(x, z);

      candidates.push({ x, z, y, uYear, distSeine, seineMargin, archetype, rot, scale, hueShift });
    }
  }
  return candidates;
}

function buildForestMeshes(ctx, candidates) {
  const counts = [0, 0, 0];
  for (const c of candidates) counts[c.archetype]++;

  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 1, 5);
  const crownGeos = [
    new THREE.ConeGeometry(1, 1.7, 6),
    new THREE.IcosahedronGeometry(0.85, 0),
    new THREE.DodecahedronGeometry(0.8, 0),
  ];
  const matTrunk = new THREE.MeshLambertMaterial({ color: 0x5b4632 });
  const matCrowns = [
    new THREE.MeshLambertMaterial({ color: 0x2f6b34 }),
    new THREE.MeshLambertMaterial({ color: 0x3a7d3d }),
    new THREE.MeshLambertMaterial({ color: 0x356e39 }),
  ];

  const trunkMesh = new THREE.InstancedMesh(trunkGeo, matTrunk, Math.max(candidates.length, 1));
  trunkMesh.count = 0;
  trunkMesh.frustumCulled = false;
  ctx.scene.add(trunkMesh);

  const crownMeshes = crownGeos.map((geo, i) => {
    const mesh = new THREE.InstancedMesh(geo, matCrowns[i], Math.max(counts[i], 1));
    mesh.count = 0;
    mesh.frustumCulled = false;
    ctx.scene.add(mesh);
    return mesh;
  });

  return { trunkMesh, crownMeshes };
}

/**
 * Retire et libère le tronc + les 3 archétypes de couronne actuellement dans
 * la scène — préalable indispensable à `setQuality` : changer la densité de
 * la forêt change le nombre de candidats, donc la capacité des InstancedMesh
 * (fixée à la construction, voir `buildForestMeshes`), donc il faut en
 * reconstruire des neufs plutôt que de réécrire les anciens.
 * @param {object} ctx
 */
function disposeForest(ctx) {
  const { trunkMesh, crownMeshes } = forestState;
  if (trunkMesh) {
    ctx.scene.remove(trunkMesh);
    trunkMesh.geometry.dispose();
    trunkMesh.material.dispose();
  }
  for (const mesh of crownMeshes) {
    ctx.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}

const _reuseMatrix = new THREE.Matrix4();
const _reuseQuat = new THREE.Quaternion();
const _reusePos = new THREE.Vector3();
const _reuseScale = new THREE.Vector3();
const _reuseColor = new THREE.Color();

function rescanForest(year) {
  const { trunkMesh, crownMeshes, candidates } = forestState;
  if (!trunkMesh) return;

  let trunkCount = 0;
  const crownCounts = [0, 0, 0];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!isForestCandidate(c.distSeine, c.uYear, year, c.seineMargin)) continue;

    _reuseQuat.setFromAxisAngle(UP, c.rot);

    // Trunk: base sits on the ground, half-height offset upward.
    _reusePos.set(c.x, c.y + c.scale * 0.5, c.z);
    _reuseScale.set(c.scale * 0.55, c.scale * 1.1, c.scale * 0.55);
    _reuseMatrix.compose(_reusePos, _reuseQuat, _reuseScale);
    trunkMesh.setMatrixAt(trunkCount, _reuseMatrix);
    _reuseColor.setHSL(0.08, 0.35, 0.28 + c.hueShift * 0.03);
    trunkMesh.setColorAt(trunkCount, _reuseColor);
    trunkCount++;

    // Crown: sits atop the trunk, archetype-dependent vertical offset.
    const k = c.archetype;
    const crownY = c.y + c.scale * (0.95 + k * 0.05);
    _reusePos.set(c.x, crownY, c.z);
    _reuseScale.set(c.scale, c.scale * (k === 0 ? 1.15 : 1), c.scale);
    _reuseMatrix.compose(_reusePos, _reuseQuat, _reuseScale);
    const mesh = crownMeshes[k];
    const idx = crownCounts[k];
    mesh.setMatrixAt(idx, _reuseMatrix);
    _reuseColor.setHSL(0.32 + c.hueShift * 0.04, 0.45, 0.32 + c.hueShift * 0.05);
    mesh.setColorAt(idx, _reuseColor);
    crownCounts[k]++;
  }

  trunkMesh.count = trunkCount;
  trunkMesh.instanceMatrix.needsUpdate = true;
  if (trunkMesh.instanceColor) trunkMesh.instanceColor.needsUpdate = true;

  for (let k = 0; k < 3; k++) {
    const mesh = crownMeshes[k];
    mesh.count = crownCounts[k];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

// ============================================================================
// Marshes
// ============================================================================

function buildMarshes(ctx) {
  const geo = new THREE.CircleGeometry(1, 24);
  return MARSH_SPOTS.map((spot) => {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x3a4a2a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.set(spot.r, spot.r, 1);
    // `groundHeightAt` et non `heightAt` : le maillage rendu s'écarte de la
    // formule analytique de près d'une unité au centre de Paris (relief exagéré
    // ×2,6), et les disques de marais restaient enterrés dessous.
    mesh.position.set(spot.x, groundHeightAt(spot.x, spot.z) + 0.05, spot.z);
    mesh.renderOrder = 1;
    ctx.scene.add(mesh);
    return mesh;
  });
}

function updateMarshes(year) {
  const presence = lifecycle(year, { born: -10000, died: 1000, razeYears: 250 }).presence;
  const opacity = presence * 0.5;
  for (const mesh of marshMeshes) mesh.material.opacity = opacity;
}

// ============================================================================
// Rescan orchestration
// ============================================================================

function rescanAll(year) {
  patchLouviers(year);
  recolorGround(year);
  rescanForest(year);
  updateMarshes(year);
}

function maybeRescan(state) {
  const year = Math.round(state.year);
  if (year === lastScanYear) return;
  if (state.time - lastScanTime < RESCAN_MIN_INTERVAL) return;
  lastScanYear = year;
  lastScanTime = state.time;
  rescanAll(year);
}

/**
 * Forces an immediate full rescan for `year`, bypassing the normal
 * once-per-changed-year debounce. Used by main.js's window.__paris debug
 * hook so automation/verification can set a year and see the result on the
 * very next render, without depending on requestAnimationFrame timing.
 * @param {number} year
 */
export function forceRescan(year) {
  const rounded = Math.round(year);
  lastScanYear = rounded;
  // Ne pas dater avec performance.now() : maybeRescan() compare state.time,
  // une horloge différente (narrative, pas wall-clock). -Infinity laisse le
  // prochain rescan throttlé se redébouncer naturellement.
  lastScanTime = -Infinity;
  rescanAll(rounded);
}

/**
 * Tâche 18 — qualité graphique : `ctx.quality.trees` n'est échantillonné
 * qu'à l'init (`buildForestCandidates(ctx.quality)`, même convention que
 * `life.js`), donc changer de tier en cours de session ne se voit pas sans
 * cet appel explicite. Reconstruit entièrement les candidats + les
 * InstancedMesh (la capacité de ces derniers dépend du nombre de candidats,
 * donc pas de simple réécriture possible) puis rescanne l'année courante —
 * coûteux (quelques ms), mais appelé seulement au changement de tier, jamais
 * par frame. `ctx.quality` doit déjà porter la nouvelle valeur (voir
 * `quality.js`'s `applyTier`, appelé avant celui-ci).
 * @param {object} ctx
 */
export function setQuality(ctx) {
  disposeForest(ctx);
  forestState.candidates = buildForestCandidates(ctx.quality);
  const built = buildForestMeshes(ctx, forestState.candidates);
  forestState.trunkMesh = built.trunkMesh;
  forestState.crownMeshes = built.crownMeshes;
  rescanForest(lastScanYear ?? 2026);
}

/** Diagnostic — budget réellement construit, pour la vérification qualité (window.__paris). */
export function stats() {
  return {
    forestCandidates: forestState.candidates.length,
    treesActive: forestState.trunkMesh ? forestState.trunkMesh.count : 0,
    // Post-v2 — vérification « l'île est une terre au milieu du fleuve » :
    // nombre de maillages d'île construits, et franc-bord réellement rendu au
    // centre de la Cité (le sol sous l'île, plus ISLAND_FREEBOARD) comparé au
    // plan d'eau juste à côté. Lu par window.__paris.terrainStats().
    islandMeshes: islandMeshes.length,
    citeTopY: groundHeightAt(ISLANDS.cite.x, ISLANDS.cite.z),
    citeWaterY: seineWaterHeightAt(ISLANDS.cite.x, ISLANDS.cite.z),
    saintLouisTopY: groundHeightAt(ISLANDS.saintLouis.x, ISLANDS.saintLouis.z),
  };
}

// ============================================================================
// Public layer contract
// ============================================================================

export function init(ctx) {
  buildGround(ctx);
  // Les îles avant le fleuve : `buildRiverGeometry` échantillonne le sol sous
  // chacun de ses sommets, et l'ordre de construction ne change rien à ce
  // calcul — mais l'ordre d'ajout à la scène documente l'empilement voulu
  // (sol → île → eau, cf. `renderOrder`).
  islandMeshes = buildIslands(ctx);
  buildRiver(ctx);

  forestState.candidates = buildForestCandidates(ctx.quality);
  const built = buildForestMeshes(ctx, forestState.candidates);
  forestState.trunkMesh = built.trunkMesh;
  forestState.crownMeshes = built.crownMeshes;

  marshMeshes = buildMarshes(ctx);

  lastScanYear = null;
  lastScanTime = -Infinity;
}

export function update(dt, state) {
  maybeRescan(state);
  if (waterMaterial && !state.reducedMotion) {
    waterMaterial.uniforms.uTime.value = state.time;
  }
}
