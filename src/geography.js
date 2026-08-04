/**
 * Pure geography for the Paris historical simulation.
 * No dependencies on three.js or the DOM — feeds terrain, buildings and walls.
 *
 * Conventions (shared with every layer): 1 scene unit = 10 m. Origin = parvis
 * de Notre-Dame (48.8530 N, 2.3499 E). x = east, z = south (north is -z).
 */

import { lerp, smoothstep } from "./timeEngine.js";

// ============================================================================
// Deterministic 2D value noise (no Math.random, no module-level state)
// ============================================================================

/**
 * Cheap deterministic hash of two integers into [0, 1).
 * Pure integer arithmetic (no Math.random) so the same (ix, iz) always
 * produces the same value, across calls and across page loads.
 * @param {number} ix
 * @param {number} iz
 * @returns {number} Pseudo-random value in [0, 1)
 */
function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  return ((h >>> 0) % 1000000) / 1000000;
}

/**
 * Smooth 2D value noise: bilinear interpolation of the lattice hash,
 * eased with smoothstep. Deterministic function of (x, z).
 * @param {number} x
 * @param {number} z
 * @returns {number} Noise value in [0, 1)
 */
function valueNoise2D(x, z) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const sx = smoothstep(x - x0);
  const sz = smoothstep(z - z0);

  const n00 = hash2(x0, z0);
  const n10 = hash2(x0 + 1, z0);
  const n01 = hash2(x0, z0 + 1);
  const n11 = hash2(x0 + 1, z0 + 1);

  const nx0 = lerp(n00, n10, sx);
  const nx1 = lerp(n01, n11, sx);
  return lerp(nx0, nx1, sz);
}

/**
 * Deterministic noise in [-amplitude, +amplitude], decorrelated per seed so
 * several noise fields (relief, growth years, ...) don't look identical.
 * @param {number} x
 * @param {number} z
 * @param {number} seed - Arbitrary offset decorrelating this field from others
 * @param {number} amplitude
 * @returns {number}
 */
function seededNoise(x, z, seed, amplitude) {
  const n = valueNoise2D((x + seed) * 0.1, (z + seed) * 0.1);
  return (n * 2 - 1) * amplitude;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function distance(x, z, cx, cz) {
  const dx = x - cx;
  const dz = z - cz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Whether (x, z) is inside the ellipse centered on (cx, cz) with radii (rx, rz).
 */
function insideEllipse(x, z, cx, cz, rx, rz) {
  const dx = (x - cx) / rx;
  const dz = (z - cz) / rz;
  return dx * dx + dz * dz <= 1;
}

// ============================================================================
// LANDMARKS — shared conventions table
// ============================================================================

export const LANDMARKS = {
  notreDame: { x: 0, z: 0 },
  louvre: { x: -90, z: -84 },
  bastille: { x: 141, z: 0 },
  tourEiffel: { x: -406, z: -60 },
  sacreCoeur: { x: -50, z: -375 },
  chezNous: { x: -131, z: -497 },
  arenes: { x: 22, z: 89 },
  thermes: { x: -43, z: 28 },
  pantheon: { x: -26, z: 76 },
  laDefense: { x: -834, z: -433 },
};

// ============================================================================
// RINGS — périphérique (Thiers) and petite ceinture ellipses
// ============================================================================
//
// Chosen rz values (430 / 415, i.e. only 15 units apart) were verified to
// already frame "chez nous" (-131, -497) as required: evaluating the two
// ellipses' northern arc at x = -131 gives z ~= -509.9 (périphérique) and
// z ~= -494.9 (petite ceinture). Chez nous' z = -497 falls strictly between
// them: south of (inside) the périphérique, north of (outside) the petite
// ceinture. See test/geography.test.js for the equivalent runtime check.

export const RINGS = {
  peripherique: { cx: -140, cz: -80, rx: 575, rz: 430 },
  petiteCeinture: { cx: -140, cz: -80, rx: 545, rz: 415 },
};

// ============================================================================
// SEINE_POINTS — river meander control points
// ============================================================================

export const SEINE_POINTS = [
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
];

// ============================================================================
// ISLANDS — Cité, Saint-Louis, Louviers (died 1843, merged into the right bank)
// ============================================================================

export const ISLANDS = {
  cite: { x: 0, z: 0, rx: 12, rz: 5 },
  saintLouis: { x: 35, z: 8, rx: 8, rz: 3 },
  louviers: { x: 120, z: 18, rx: 5, rz: 2, died: 1843 },
};

// ============================================================================
// heightAt — relief
// ============================================================================

const HILLS = [
  { x: -50, z: -375, height: 13, sigma: 60 }, // Montmartre
  { x: -26, z: 76, height: 6, sigma: 50 }, // Sainte-Geneviève
  { x: 180, z: -280, height: 10, sigma: 70 }, // Belleville
  { x: -300, z: -90, height: 6, sigma: 55 }, // Chaillot
];

const SEINE_TROUGH_DEPTH = 1.5;
const SEINE_TROUGH_SIGMA = 12.5; // ~half of the ~25-unit river width
const SEINE_BANK_HEIGHT = 0.25;
const SEINE_BANK_OFFSET = 16;
const SEINE_BANK_SIGMA = 6;

function gaussianHill(x, z, hill) {
  const d2 = (x - hill.x) * (x - hill.x) + (z - hill.z) * (z - hill.z);
  return hill.height * Math.exp(-d2 / (2 * hill.sigma * hill.sigma));
}

/** Distance from (x, z) to the closest segment of a polyline. */
function distanceToPolyline(x, z, points) {
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const abLen2 = abx * abx + abz * abz;
    let t = abLen2 === 0 ? 0 : ((x - a.x) * abx + (z - a.z) * abz) / abLen2;
    t = clamp(t, 0, 1);
    const cx = a.x + abx * t;
    const cz = a.z + abz * t;
    const d = distance(x, z, cx, cz);
    if (d < min) min = d;
  }
  return min;
}

/** Riverbed slightly below 0, banks slightly above, fading out with distance. */
function seineRelief(x, z) {
  const d = distanceToPolyline(x, z, SEINE_POINTS);
  const trough =
    -SEINE_TROUGH_DEPTH *
    Math.exp(-(d * d) / (2 * SEINE_TROUGH_SIGMA * SEINE_TROUGH_SIGMA));
  const bankD = d - SEINE_BANK_OFFSET;
  const bank =
    SEINE_BANK_HEIGHT *
    Math.exp(-(bankD * bankD) / (2 * SEINE_BANK_SIGMA * SEINE_BANK_SIGMA));
  return trough + bank;
}

/**
 * Scene altitude at (x, z). 0 = Seine water level. Gentle deterministic
 * noise on a base plain, gaussian hills added, Seine valley subtracted.
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
export function heightAt(x, z) {
  let h = seededNoise(x, z, 0, 0.4); // base plain, ±0.4
  for (const hill of HILLS) {
    h += gaussianHill(x, z, hill);
  }
  h += seineRelief(x, z);
  return h;
}

// ============================================================================
// urbanYear — urbanization field
// ============================================================================

const ROMAN_DISC = { x: 0, z: 60, r: 90 };
const MONTMARTRE_CORE = { x: -50, z: -340, r: 12 };
const CHEZ_NOUS_CORE = { x: -131, z: -497, r: 10 };
const CHEZ_NOUS_INFILL_R = 40; // comblement 1840-1900 around the village core
const LA_DEFENSE_CLUSTER = { x: -834, z: -433, r: 60 };

// Concentric growth bands (radius from the Roman core, biased by direction).
// Calibrated so Philippe-Auguste urbanizes 1100-1300, Charles V 1300-1500,
// Grands Boulevards 1600-1750 and the Thiers/faubourg belt 1750-1900.
const GROWTH_BANDS = [
  { rMin: 90, rMax: 100, yMin: 1100, yMax: 1300 }, // Philippe Auguste
  { rMin: 100, rMax: 180, yMin: 1300, yMax: 1500 }, // Charles V
  { rMin: 180, rMax: 260, yMin: 1500, yMax: 1600 }, // slow Renaissance growth
  { rMin: 260, rMax: 350, yMin: 1600, yMax: 1750 }, // Grands Boulevards
  { rMin: 350, rMax: 600, yMin: 1750, yMax: 1900 }, // Thiers / faubourgs
];

function bandYear(r) {
  const clamped = Math.max(r, GROWTH_BANDS[0].rMin);
  for (const band of GROWTH_BANDS) {
    if (clamped <= band.rMax) {
      const t = (clamped - band.rMin) / (band.rMax - band.rMin);
      return lerp(band.yMin, band.yMax, clamp(t, 0, 1));
    }
  }
  return GROWTH_BANDS[GROWTH_BANDS.length - 1].yMax;
}

/**
 * Deterministic, seeded urbanization year of the cell at (x, z).
 * Île de la Cité = -250 ; Roman rive gauche disc = ~100 ; medieval/modern
 * growth expands concentrically (with directional bias and noise) through
 * the historical wall belts ; satellite villages (Montmartre, Clignancourt/
 * chez nous) urbanize on their own clock ; beyond the périphérique nothing
 * urbanizes except the La Défense cluster (~1975).
 * @param {number} x
 * @param {number} z
 * @returns {number} Year (may be Infinity for land that never urbanizes)
 */
export function urbanYear(x, z) {
  const { peripherique } = RINGS;
  if (
    !insideEllipse(
      x,
      z,
      peripherique.cx,
      peripherique.cz,
      peripherique.rx,
      peripherique.rz
    )
  ) {
    const dDefense = distance(x, z, LA_DEFENSE_CLUSTER.x, LA_DEFENSE_CLUSTER.z);
    if (dDefense <= LA_DEFENSE_CLUSTER.r) {
      const year = 1975 + seededNoise(x, z, 2000.3, 15);
      return clamp(year, 1960, 2000);
    }
    return Infinity;
  }

  if (insideEllipse(x, z, ISLANDS.cite.x, ISLANDS.cite.z, ISLANDS.cite.rx, ISLANDS.cite.rz)) {
    return -250;
  }

  const dMontmartre = distance(x, z, MONTMARTRE_CORE.x, MONTMARTRE_CORE.z);
  if (dMontmartre <= MONTMARTRE_CORE.r) {
    const year = 1300 + seededNoise(x, z, 3000.9, 40);
    return clamp(year, 1250, 1350);
  }

  const dChezNous = distance(x, z, CHEZ_NOUS_CORE.x, CHEZ_NOUS_CORE.z);
  if (dChezNous <= CHEZ_NOUS_CORE.r) {
    const year = 1780 + seededNoise(x, z, 4000.5, 40);
    return clamp(year, 1750, 1900);
  }
  if (dChezNous <= CHEZ_NOUS_INFILL_R) {
    // Comblement: the fields between the village core and the surrounding
    // annexed neighborhood fill in progressively from 1840 to 1900.
    const t = (dChezNous - CHEZ_NOUS_CORE.r) / (CHEZ_NOUS_INFILL_R - CHEZ_NOUS_CORE.r);
    return Math.round(lerp(1840, 1900, t));
  }

  const dRoman = distance(x, z, ROMAN_DISC.x, ROMAN_DISC.z);
  if (dRoman <= ROMAN_DISC.r) {
    const year = 100 + seededNoise(x, z, 5000.1, 40);
    return Math.round(clamp(year, 50, 250));
  }

  // General medieval/modern growth: the west and the right bank push
  // outward faster (biais directionnel), so their effective radius shrinks.
  let bias = 1;
  if (x < 0) bias *= 1.15; // l'ouest
  if (z < 0) bias *= 1.1; // la rive droite (nord de la Seine)
  const effectiveRadius = dRoman / bias;

  const year = bandYear(effectiveRadius) + seededNoise(x, z, 1000.7, 80);
  return Math.round(year);
}
