/**
 * Pure time engine for the Paris historical simulation.
 * No dependencies on three.js, DOM, or external libraries.
 */

/**
 * Linear interpolation between two values.
 * @param {number} a - Start value
 * @param {number} b - End value
 * @param {number} t - Interpolation factor [0, 1]
 * @returns {number} Interpolated value
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Smooth Hermite interpolation (smoothstep).
 * Provides smooth easing from 0 to 1.
 * @param {number} t - Input value [0, 1]
 * @returns {number} Smoothly interpolated value [0, 1]
 */
export function smoothstep(t) {
  // Clamp to [0, 1]
  t = Math.max(0, Math.min(1, t));
  // Hermite interpolation: 3t² - 2t³
  return t * t * (3 - 2 * t);
}

/**
 * Determine the lifecycle phase and presence of an object.
 * An object can be absent, building (presence 0→1), alive, razing (presence 1→0), or gone.
 * @param {number} year - The year to evaluate
 * @param {Object} config - Configuration object
 * @param {number} config.born - Birth year of the object
 * @param {number} [config.buildYears=10] - Years spent in building phase
 * @param {number} [config.died=Infinity] - Death year (when razing begins)
 * @param {number} [config.razeYears=5] - Years spent in razing phase
 * @returns {{phase: string, presence: number}} Object lifecycle state
 */
export function lifecycle(
  year,
  { born, buildYears = 10, died = Infinity, razeYears = 5 }
) {
  const buildEnd = born + buildYears;
  const razeEnd = died + razeYears;

  if (year < born) {
    return { phase: "absent", presence: 0 };
  }

  if (year < buildEnd) {
    // Building phase: presence increases from 0 to 1
    const presence = (year - born) / buildYears;
    return { phase: "building", presence };
  }

  if (year < died) {
    // Alive phase: fully present
    return { phase: "alive", presence: 1 };
  }

  if (year < razeEnd) {
    // Razing phase: presence decreases from 1 to 0
    const presence = 1 - (year - died) / razeYears;
    return { phase: "razing", presence };
  }

  // Gone phase: no longer present
  return { phase: "gone", presence: 0 };
}

/**
 * Find the moments that bracket a given year and the blend factor.
 * Used for interpolating between timeline moments.
 * @param {number} year - The year to evaluate
 * @param {number[]} anchors - Array of anchor years (timeline moments)
 * @returns {{i: number, j: number, t: number}} Surrounding moment indices and blend factor
 */
export function momentBlend(year, anchors) {
  const n = anchors.length;

  // Before first anchor: stay at first anchor
  if (year <= anchors[0]) {
    return { i: 0, j: 0, t: 0 };
  }

  // After last anchor: stay at last anchor
  if (year >= anchors[n - 1]) {
    return { i: n - 1, j: n - 1, t: 0 };
  }

  // Find the segment containing the year
  for (let i = 0; i < n - 1; i++) {
    if (year >= anchors[i] && year <= anchors[i + 1]) {
      // If exactly at the left anchor, don't blend
      if (year === anchors[i]) {
        return { i, j: i, t: 0 };
      }
      // If exactly at the right anchor, return it as its own index
      if (year === anchors[i + 1]) {
        return { i: i + 1, j: i + 1, t: 0 };
      }
      // Otherwise, blend between this anchor and the next
      const t = (year - anchors[i]) / (anchors[i + 1] - anchors[i]);
      return { i, j: i + 1, t };
    }
  }

  // Fallback (should not reach here)
  return { i: 0, j: 0, t: 0 };
}

/**
 * Convert a slider position to a year.
 * The slider position u ∈ [0,1] maps linearly across each segment of the timeline.
 * @param {number} u - Slider position [0, 1], clamped
 * @param {number[]} anchors - Array of anchor years (timeline moments)
 * @returns {number} The corresponding year
 */
export function sliderToYear(u, anchors) {
  const n = anchors.length;

  // Clamp u to [0, 1]
  u = Math.max(0, Math.min(1, u));

  // Calculate position in terms of segment index and local fraction
  const pos = u * (n - 1);
  const k = Math.min(Math.floor(pos), n - 2);
  const f = pos - k;

  return lerp(anchors[k], anchors[k + 1], f);
}

/**
 * Convert a year to a slider position.
 * The inverse of sliderToYear: maps years to [0,1] with clamping.
 * @param {number} year - The year to convert
 * @param {number[]} anchors - Array of anchor years (timeline moments)
 * @returns {number} The slider position [0, 1], clamped
 */
export function yearToSlider(year, anchors) {
  const n = anchors.length;

  // Clamp year to valid range
  year = Math.max(anchors[0], Math.min(anchors[n - 1], year));

  // Find the segment containing the year
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    if (year >= anchors[i] && year <= anchors[i + 1]) {
      k = i;
      break;
    }
  }

  // Calculate local fraction within the segment
  const f = (year - anchors[k]) / (anchors[k + 1] - anchors[k]);

  // Convert to global position and normalize to [0, 1]
  const pos = k + f;
  const u = pos / (n - 1);

  return u;
}
