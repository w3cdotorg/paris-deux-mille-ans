import { test } from "node:test";
import assert from "node:assert/strict";
import { panVectorFromKeys, verticalOrbitDelta, PRESETS } from "../src/controls.js";

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
// Sanity: PRESETS still exported/unchanged shape (ZQSD/invert must not touch these)
// ============================================================================

test("PRESETS: ensemble preset unchanged (arrows/1-4 rely on this, out of scope for this change)", () => {
  assert.deepEqual(PRESETS.ensemble.target, [-140, 0, -80]);
  assert.equal(PRESETS.ensemble.distance, 1105.66);
});
