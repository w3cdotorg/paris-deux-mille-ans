/**
 * Terrain layer — sol relief + Seine animée + îles + forêts + marais.
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
  SEINE_POINTS,
  SEINE_ONMAP_COUNT,
  ISLANDS,
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

// Ground within this distance (world units) of the Seine centerline reads
// as underwater, fading to dry land by RIVER_WATER_FADE. Deliberately a
// *spatial* mask rather than a height threshold: heightAt()'s base terrain
// noise alone swings ±0.4, which would otherwise false-positive as "water"
// on ordinary dry land far from any river.
const RIVER_WATER_CORE = 6;
const RIVER_WATER_FADE = 10;

// Half-width, in years, of the forest<->urban color transition band. Wide on
// purpose: urbanYear() bakes in ±40-80y of organic noise for irregular growth
// fronts, and a narrow band would turn that into leopard-print speckling
// instead of a coherent (if slightly fuzzy) frontier. Trees still use a hard
// threshold (see rescanForest), so the retreat itself still reads crisply.
const TRANSITION_YEARS = 110;

const ISLAND_BUMP_AMPLITUDE = 2.4; // Cité, Saint-Louis: always raised
const LOUVIERS_BUMP_AMPLITUDE = 2.0;
const LOUVIERS_CHANNEL_DEPTH = 1.8; // "bras mort" separating it from the right bank

const FOREST_CELL = 12; // grid spacing (world units) for tree candidates
const FOREST_JITTER = 0.8; // fraction of cell used for jitter
const SEINE_TREE_MARGIN = 9; // keep trees off the river, incl. the off-map tail

const RESCAN_MIN_INTERVAL = 0.06; // seconds, debounce for year-driven rescans

const MARSH_SPOTS = [
  { x: 108, z: -22, r: 26 },
  { x: 58, z: 46, r: 20 },
  { x: -55, z: -18, r: 22 },
  { x: 205, z: 95, r: 24 },
];

const COLOR_FOREST = new THREE.Color(0x2f6b34);
const COLOR_URBAN = new THREE.Color(0xd8c6a0);
const COLOR_WATER = new THREE.Color(0x3d6d82);

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
 * water (river course, incl. the off-map tail, via a spatial margin — not
 * a height threshold, see RIVER_WATER_CORE's comment for why) and any cell
 * already urbanized by `year`. Deliberately a hard threshold (unlike the
 * ground colour blend above) — the retreat itself should read crisply.
 * @param {number} distSeineValue - distance from the candidate to the Seine centerline.
 * @param {number} urbanYearValue - urbanYear(x, z); may be Infinity.
 * @param {number} year
 * @param {number} [seineMargin]
 * @returns {boolean}
 */
export function isForestCandidate(distSeineValue, urbanYearValue, year, seineMargin = SEINE_TREE_MARGIN) {
  if (distSeineValue < seineMargin) return false;
  return urbanYearValue > year;
}

/** Constant bump for Cité + Saint-Louis: real geographic islands, always raised. */
function constantIslandDelta(x, z) {
  const cite = ISLANDS.cite;
  const stLouis = ISLANDS.saintLouis;
  return (
    ISLAND_BUMP_AMPLITUDE * ellipseFalloff(x, z, cite.x, cite.z, cite.rx * 1.3, cite.rz * 1.3) +
    ISLAND_BUMP_AMPLITUDE *
      ellipseFalloff(x, z, stLouis.x, stLouis.z, stLouis.rx * 1.3, stLouis.rz * 1.3)
  );
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
  louviersIndices: null, // Int32Array of vertex indices near Louviers/channel
};

const forestState = {
  candidates: [], // {x,z,y,uYear,archetype,rot,scale,hueShift}
  trunkMesh: null,
  crownMeshes: [],
};

let marshMeshes = [];
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

      const base = heightAt(vx, vz) + constantIslandDelta(vx, vz);
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
  ground.louviersIndices = Int32Array.from(louviersIdx);
}

/**
 * Altitude of the *rendered* ground surface at (x, z) — i.e. a bilinear
 * sample of the ground mesh's own vertices, not a fresh `heightAt()` call.
 *
 * The two differ: the mesh is a 256x256 grid over a 4000x4400 unit extent
 * (~15.6 units per quad), so features narrower than a quad — chiefly the
 * île de la Cité / Saint-Louis bumps, whose falloff spans ~16 units — are
 * rendered as a coarse tent well below their analytic height. Anything that
 * must *sit* on the ground (buildings, later monuments and crowds) has to
 * agree with what the eye sees, otherwise the Cité's buildings float a
 * metre above their own island. Callers must run after `init()`; before
 * that it degrades gracefully to the analytic height.
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
export function groundHeightAt(x, z) {
  if (!ground.geometry) return heightAt(x, z) + constantIslandDelta(x, z);
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
  return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
}

/** Patches just the Louviers/channel neighborhood's height for the given year. */
function patchLouviers(year) {
  const positions = ground.geometry.attributes.position.array;
  const { louviersIndices, x, z } = ground;
  for (let k = 0; k < louviersIndices.length; k++) {
    const idx = louviersIndices[k];
    const vx = x[idx];
    const vz = z[idx];
    const base = heightAt(vx, vz) + constantIslandDelta(vx, vz);
    positions[idx * 3 + 1] = base + louviersDelta(vx, vz, year);
  }
  ground.geometry.attributes.position.needsUpdate = true;
  ground.geometry.computeVertexNormals();
  ground.geometry.attributes.normal.needsUpdate = true;
}

/** Recomputes every vertex color for the given year (cheap: pure scalar math). */
function recolorGround(year) {
  const colors = ground.geometry.attributes.color.array;
  const { x, z, uYear, variation, distSeine } = ground;
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

    // Water tint is a spatial mask (distance to the Seine / island channel),
    // not a height threshold — heightAt()'s base noise alone swings enough
    // to false-positive as "water" on ordinary dry land otherwise.
    const riverT = clamp01((distSeine[i] - RIVER_WATER_CORE) / RIVER_WATER_FADE);
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
    pos.y += sin(uTime * 0.6 + uv.y * 30.0) * 0.05 * aFade;
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
    float shimmer = mix(0.82, 1.28, s1 * 0.6 + s2 * 0.4);
    vec3 color = mix(uColorA, uColorB, vUv.x) * shimmer;
    float alpha = 0.82 * vFade;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

function buildRiverGeometry() {
  const curvePoints = SEINE_POINTS.map((p) => new THREE.Vector3(p.x, 0, p.z));
  const curve = new THREE.CatmullRomCurve3(curvePoints, false, "catmullrom", 0.4);
  const SAMPLES = 400;
  const halfWidthBase = 7; // width ~14
  const uOnMap = (SEINE_ONMAP_COUNT - 1) / (SEINE_POINTS.length - 1);

  const positions = new Float32Array(SAMPLES * 2 * 3);
  const uvs = new Float32Array(SAMPLES * 2 * 2);
  const fades = new Float32Array(SAMPLES * 2);
  const indices = [];

  const tangent = new THREE.Vector3();
  const perp = new THREE.Vector3();

  for (let i = 0; i < SAMPLES; i++) {
    const u = i / (SAMPLES - 1);
    const p = curve.getPointAt(u);
    curve.getTangentAt(u, tangent);
    perp.set(-tangent.z, 0, tangent.x);
    if (perp.lengthSq() < 1e-8) perp.set(1, 0, 0);
    else perp.normalize();

    let widthFactor = 1;
    let fadeFactor = 1;
    if (u > uOnMap) {
      const t = (u - uOnMap) / (1 - uOnMap);
      const s = smoothstep(t);
      widthFactor = lerp(1, 0.3, s);
      fadeFactor = 1 - s;
    }
    const hw = halfWidthBase * widthFactor;

    const li = i * 2;
    const ri = i * 2 + 1;
    positions[li * 3 + 0] = p.x + perp.x * hw;
    positions[li * 3 + 1] = -0.04;
    positions[li * 3 + 2] = p.z + perp.z * hw;
    positions[ri * 3 + 0] = p.x - perp.x * hw;
    positions[ri * 3 + 1] = -0.04;
    positions[ri * 3 + 2] = p.z - perp.z * hw;

    uvs[li * 2 + 0] = 0;
    uvs[li * 2 + 1] = u;
    uvs[ri * 2 + 0] = 1;
    uvs[ri * 2 + 1] = u;
    fades[li] = fadeFactor;
    fades[ri] = fadeFactor;

    if (i < SAMPLES - 1) {
      const a = li, bIdx = ri, c = li + 2, d = ri + 2;
      indices.push(a, bIdx, c, bIdx, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("aFade", new THREE.BufferAttribute(fades, 1));
  geometry.setIndex(indices);
  return geometry;
}

function buildRiver(ctx) {
  const geometry = buildRiverGeometry();
  waterMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: new THREE.Color(0x2c5a72) },
      uColorB: { value: new THREE.Color(0x6fb3c9) },
    },
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, waterMaterial);
  mesh.renderOrder = 2;
  ctx.scene.add(mesh);
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
      if (distSeine < SEINE_TREE_MARGIN) continue;

      const uYear = urbanYear(x, z);
      const archetype = Math.floor(hash01(gx, gz, 33) * 3);
      const rot = hash01(gx, gz, 44) * Math.PI * 2;
      const scale = 0.75 + hash01(gx, gz, 55) * 0.6;
      const hueShift = hash01(gx, gz, 66) * 2 - 1;
      const y = heightAt(x, z);

      candidates.push({ x, z, y, uYear, distSeine, archetype, rot, scale, hueShift });
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
    if (!isForestCandidate(c.distSeine, c.uYear, year)) continue;

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
    mesh.position.set(spot.x, heightAt(spot.x, spot.z) + 0.05, spot.z);
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
// Sky + lighting
// ============================================================================

const SKY_VERTEX_SHADER = `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT_SHADER = `
  varying vec3 vWorldPos;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  void main() {
    // Tuned so a steeply-pitched aerial camera (looking mostly downward)
    // still sees real sky blue near the top of frame, fading to the pale
    // horizon tone only where the view ray dips well below level.
    float h = clamp(normalize(vWorldPos).y * 1.2 + 0.92, 0.0, 1.0);
    gl_FragColor = vec4(mix(uHorizon, uTop, h), 1.0);
  }
`;

function buildSky(ctx) {
  const geometry = new THREE.SphereGeometry(3200, 32, 16);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(0x6fa8d0) },
      // Warm atmospheric tint, deliberately a different hue from the fog
      // color below — with the camera steepened (review Critical 2) the
      // two should barely ever meet, but keeping them distinct means any
      // residual sliver still reads as a proper (if hazy) horizon line
      // rather than dome and fog melting into one shapeless pale mass.
      uHorizon: { value: new THREE.Color(0xf3e6cf) },
    },
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  ctx.scene.add(mesh);

  // Distinct from the dome's uHorizon (see above) and much tighter than a
  // first pass — dense enough to soften the far countryside, starting well
  // past the framed Paris core so the urban carpet/forest read crisply.
  ctx.scene.background = new THREE.Color(0x9fb8c4);
  ctx.scene.fog = new THREE.Fog(0x9fb8c4, 1800, 3200);
}

function addLights(ctx) {
  const hemi = new THREE.HemisphereLight(0xbfe0f0, 0x5b4a35, 0.85);
  ctx.scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2df, 0.9);
  sun.position.set(650, 780, 420);
  sun.castShadow = false;
  ctx.scene.add(sun);
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
  lastScanTime = performance.now() / 1000;
  rescanAll(rounded);
}

// ============================================================================
// Public layer contract
// ============================================================================

export function init(ctx) {
  buildSky(ctx);
  addLights(ctx);
  buildGround(ctx);
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
