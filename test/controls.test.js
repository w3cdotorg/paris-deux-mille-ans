import { test } from "node:test";
import assert from "node:assert/strict";
import { panVectorFromKeys, verticalOrbitDelta, horizontalOrbitDelta, elevateTargetY, PRESETS } from "../src/controls.js";

// ============================================================================
// panVectorFromKeys — ZQSD/WASD key-pan (post-v1)
// ============================================================================

const noKeys = { forward: false, back: false, left: false, right: false };

test("panVectorFromKeys: no key held -> {dx:0, dz:0}", () => {
  const { dx, dz } = panVectorFromKeys(noKeys, 0, 1 / 60, 100);
  assert.equal(dx, 0);
  assert.equal(dz, 0);
});

test("panVectorFromKeys: Z/W (forward) moves toward heading — heading=0 -> straight -Z", () => {
  const { dx, dz } = panVectorFromKeys({ ...noKeys, forward: true }, 0, 1, 100);
  assert.ok(Math.abs(dx) < 1e-9, `expected dx≈0, got ${dx}`);
  assert.ok(dz < 0, `expected dz<0 (forward at heading 0), got ${dz}`);
});

test("panVectorFromKeys: S (back) is the exact opposite of Z (forward)", () => {
  const fwd = panVectorFromKeys({ ...noKeys, forward: true }, 0.83, 1, 100);
  const back = panVectorFromKeys({ ...noKeys, back: true }, 0.83, 1, 100);
  assert.ok(Math.abs(fwd.dx + back.dx) < 1e-9);
  assert.ok(Math.abs(fwd.dz + back.dz) < 1e-9);
});

test("panVectorFromKeys: Q/A (left) is perpendicular to the forward heading", () => {
  const heading = 0.4;
  const fwd = panVectorFromKeys({ ...noKeys, forward: true }, heading, 1, 100);
  const left = panVectorFromKeys({ ...noKeys, left: true }, heading, 1, 100);
  const dot = fwd.dx * left.dx + fwd.dz * left.dz;
  assert.ok(Math.abs(dot) < 1e-9, `expected forward⊥left, dot=${dot}`);
});

test("panVectorFromKeys: D (right) is the exact opposite of Q (left)", () => {
  const right = panVectorFromKeys({ ...noKeys, right: true }, 1.2, 1, 100);
  const left = panVectorFromKeys({ ...noKeys, left: true }, 1.2, 1, 100);
  assert.ok(Math.abs(right.dx + left.dx) < 1e-9);
  assert.ok(Math.abs(right.dz + left.dz) < 1e-9);
});

test("panVectorFromKeys: diagonal input (forward+right) is normalized to the same magnitude as a single axis", () => {
  const heading = 0.55;
  const single = panVectorFromKeys({ ...noKeys, forward: true }, heading, 1, 100);
  const singleMag = Math.hypot(single.dx, single.dz);
  const diag = panVectorFromKeys({ ...noKeys, forward: true, right: true }, heading, 1, 100);
  const diagMag = Math.hypot(diag.dx, diag.dz);
  assert.ok(Math.abs(diagMag - singleMag) < 1e-9, `expected equal magnitude, got ${singleMag} vs ${diagMag}`);
});

test("panVectorFromKeys: opposite keys held together (forward+back) cancel out", () => {
  const { dx, dz } = panVectorFromKeys({ ...noKeys, forward: true, back: true }, 0.3, 1, 100);
  assert.equal(dx, 0);
  assert.equal(dz, 0);
});

test("panVectorFromKeys: speed scales linearly with distance", () => {
  const near = panVectorFromKeys({ ...noKeys, forward: true }, 0, 1, 50);
  const far = panVectorFromKeys({ ...noKeys, forward: true }, 0, 1, 200);
  const nearMag = Math.hypot(near.dx, near.dz);
  const farMag = Math.hypot(far.dx, far.dz);
  assert.ok(Math.abs(farMag / nearMag - 4) < 1e-9, `expected 4x (200/50), got ${farMag / nearMag}`);
});

test("panVectorFromKeys: speed scales linearly with dt", () => {
  const short = panVectorFromKeys({ ...noKeys, forward: true }, 0, 0.5, 100);
  const long = panVectorFromKeys({ ...noKeys, forward: true }, 0, 2, 100);
  const shortMag = Math.hypot(short.dx, short.dz);
  const longMag = Math.hypot(long.dx, long.dz);
  assert.ok(Math.abs(longMag / shortMag - 4) < 1e-9, `expected 4x (2/0.5), got ${longMag / shortMag}`);
});

// ============================================================================
// verticalOrbitDelta — mouse-drag vertical-orbit inversion (post-v1)
// ============================================================================

test("verticalOrbitDelta: not inverted -> same sign as dy (pre-existing behaviour)", () => {
  assert.equal(verticalOrbitDelta(10, 0.005, false), 10 * 0.005);
  assert.equal(verticalOrbitDelta(-10, 0.005, false), -10 * 0.005);
});

test("verticalOrbitDelta: inverted -> opposite sign of dy (post-v1 mouse behaviour)", () => {
  assert.equal(verticalOrbitDelta(10, 0.005, true), -10 * 0.005);
  assert.equal(verticalOrbitDelta(-10, 0.005, true), 10 * 0.005);
});

test("verticalOrbitDelta: horizontal axis is untouched by this helper — only ever applied to dPhi, never dTheta (documented contract, not re-tested here beyond the sign check above)", () => {
  // Magnitude is preserved by the flip, only the sign changes.
  assert.equal(Math.abs(verticalOrbitDelta(7, 0.005, true)), Math.abs(verticalOrbitDelta(7, 0.005, false)));
});

// ============================================================================
// horizontalOrbitDelta — touch-drag horizontal-orbit inversion (post-v2,
// "navigation difficile" fix: touch inverts BOTH orbit axes, not just
// vertical). The non-inverted baseline is `-dx*speed` — the sign `orbitBy`
// always used for dTheta before this helper existed (mouse/pen, unchanged).
// ============================================================================

test("horizontalOrbitDelta: not inverted -> opposite sign of dx (pre-existing mouse/pen behaviour, unchanged)", () => {
  assert.equal(horizontalOrbitDelta(10, 0.0055, false), -10 * 0.0055);
  assert.equal(horizontalOrbitDelta(-10, 0.0055, false), 10 * 0.0055);
});

test("horizontalOrbitDelta: inverted -> same sign as dx (post-v2 touch behaviour — opposite of the non-inverted case above)", () => {
  assert.equal(horizontalOrbitDelta(10, 0.0055, true), 10 * 0.0055);
  assert.equal(horizontalOrbitDelta(-10, 0.0055, true), -10 * 0.0055);
});

test("horizontalOrbitDelta: inverted output is the exact opposite of the non-inverted output for the same dx (touch vs mouse/pen disagree on direction)", () => {
  assert.equal(horizontalOrbitDelta(12, 0.0055, true), -horizontalOrbitDelta(12, 0.0055, false));
});

test("horizontalOrbitDelta: magnitude is preserved by the flip, only the sign changes (mirrors verticalOrbitDelta's own contract)", () => {
  assert.equal(Math.abs(horizontalOrbitDelta(7, 0.0055, true)), Math.abs(horizontalOrbitDelta(7, 0.0055, false)));
});

// Post-v2: touch now inverts vertical too (previously only mouse did) — the
// combination the fix is really about is "both axes flip for touch, relative
// to touch's own pre-fix behaviour", which was the SAME formula mouse/pen use
// (non-inverted on both helpers). This test pins down that composite claim
// directly, independent of any wiring in controls.js's onPointerMove.
test("post-v2 touch orbit: BOTH axes end up inverted relative to touch's own previous (non-inverted) behaviour", () => {
  const dx = 50;
  const dy = 50;
  const speed = 0.0055;
  // Touch's behaviour *before* this fix, on both axes, was the non-inverted
  // formula (same as mouse/pen horizontal, and same as pre-post-v1 mouse
  // vertical): dTheta = -dx*speed, dPhi = +dy*speed.
  const thetaBefore = horizontalOrbitDelta(dx, speed, false);
  const phiBefore = verticalOrbitDelta(dy, speed, false);
  // Touch's behaviour *after* this fix (invertHorizontal=true, invertVertical=true).
  const thetaAfter = horizontalOrbitDelta(dx, speed, true);
  const phiAfter = verticalOrbitDelta(dy, speed, true);
  assert.equal(thetaAfter, -thetaBefore, "theta must have flipped sign vs touch's previous behaviour");
  assert.equal(phiAfter, -phiBefore, "phi must have flipped sign vs touch's previous behaviour");
  // Mouse is untouched by this fix: horizontal stays non-inverted, vertical
  // stays inverted (post-v1) — exactly the formulas `onPointerMove` passes
  // for pointerType "mouse".
  const thetaMouse = horizontalOrbitDelta(dx, speed, false);
  const phiMouse = verticalOrbitDelta(dy, speed, true);
  assert.equal(thetaMouse, thetaBefore, "mouse horizontal must be unchanged");
  assert.equal(thetaAfter, -thetaMouse, "touch horizontal ends up opposite of mouse's (mouse unchanged)");
  assert.equal(phiAfter, phiMouse, "touch vertical ends up matching mouse's post-v1 inverted formula");
});

// ============================================================================
// Sanity: PRESETS still exported/unchanged shape (ZQSD/invert must not touch these)
// ============================================================================

test("PRESETS: ensemble preset unchanged (arrows/1-4 rely on this, out of scope for this change)", () => {
  assert.deepEqual(PRESETS.ensemble.target, [-140, 0, -80]);
  assert.equal(PRESETS.ensemble.distance, 1105.66);
});

// ============================================================================
// elevateTargetY — correctif revue post-v1, critique n°2 (target terrain-aware)
// ============================================================================

test("elevateTargetY: dt <= 0 snaps immediately to desiredY (instant placements)", () => {
  assert.equal(elevateTargetY(0, 33.8, 0, 6), 33.8);
  assert.equal(elevateTargetY(100, -2, -1, 6), -2);
});

test("elevateTargetY: dt > 0 moves toward desiredY without ever overshooting it", () => {
  const next = elevateTargetY(0, 10, 1 / 60, 6);
  assert.ok(next > 0 && next < 10, `expected 0 < next < 10, got ${next}`);
});

test("elevateTargetY: already at desiredY stays put", () => {
  assert.equal(elevateTargetY(5, 5, 1 / 60, 6), 5);
});

test("elevateTargetY: a larger dt converges closer to desiredY than a smaller one (monotonic approach)", () => {
  const near = elevateTargetY(0, 10, 1 / 60, 6);
  const far = elevateTargetY(0, 10, 1, 6);
  assert.ok(far > near, `expected larger dt to get closer to target, got near=${near} far=${far}`);
  assert.ok(far < 10);
});

test("elevateTargetY: a very large dt converges arbitrarily close to desiredY (never reaches it exactly, but the residual becomes negligible)", () => {
  const next = elevateTargetY(0, 10, 100, 6);
  assert.ok(Math.abs(next - 10) < 1e-6, `expected ~10, got ${next}`);
});

test("elevateTargetY: symmetric for descending toward a lower desiredY (no special-casing of sign)", () => {
  const next = elevateTargetY(10, 0, 1 / 60, 6);
  assert.ok(next < 10 && next > 0, `expected 0 < next < 10, got ${next}`);
});

// ============================================================================
// Camera-above-ground clearance (critique n°2) — reachable at MIN_DISTANCE
// ============================================================================
//
// Motivating scenario from the review: panning the target onto Montmartre
// (~33.7u peak after relief exaggeration) and zooming to MIN_DISTANCE (18)
// used to be able to put the camera inside the hill, because clampAboveGround
// only ever compared against target.y, which stayed permanently 0. With
// elevateTargetY gluing target.y to the terrain, the camera's own height
// (target.y + radius*cos(phi)) inherits the elevation — checked end-to-end
// (against the real DOM/camera factory) by the Playwright verification in
// this task's report; this test only re-confirms the pure math in isolation:
// once target.y has converged to the hill's height, the *minimum* camera
// height achievable at MIN_DISTANCE (phi at its shallowest, PHI_MIN) already
// clears the hill's own peak by construction (radius*cos(PHI_MIN) > 0).
test("elevateTargetY: once converged onto a hilltop, the target itself sits near the hill height (camera inherits it, not just 0)", () => {
  const hillHeight = 33.8; // Montmartre peak, post-exaggeration (see geography.js HILLS)
  let y = 0;
  for (let i = 0; i < 300; i++) y = elevateTargetY(y, hillHeight, 1 / 60, 6); // ~5s of frames
  assert.ok(y > hillHeight - 0.5, `expected target.y to have converged near ${hillHeight}, got ${y}`);
});
