import { test } from "node:test";
import assert from "node:assert/strict";
import { lifecycle, momentBlend, sliderToYear, yearToSlider, lerp, smoothstep } from "../src/timeEngine.js";
import { MOMENTS } from "../src/timeline.js";

// Extract anchors from MOMENTS
const anchors = MOMENTS.map(m => m.year);
// anchors = [-250, 200, 885, 1200, 1370, 1670, 1789, 1860, 1865, 1889, 1900, 1934, 1973, 2026]

// ============================================================================
// lerp and smoothstep helpers
// ============================================================================

test("timeEngine: lerp(a, b, 0) === a", () => {
  assert.strictEqual(lerp(10, 20, 0), 10);
});

test("timeEngine: lerp(a, b, 1) === b", () => {
  assert.strictEqual(lerp(10, 20, 1), 20);
});

test("timeEngine: lerp(10, 20, 0.5) === 15", () => {
  assert.strictEqual(lerp(10, 20, 0.5), 15);
});

test("timeEngine: smoothstep(0) === 0", () => {
  assert.strictEqual(smoothstep(0), 0);
});

test("timeEngine: smoothstep(1) === 1", () => {
  assert.strictEqual(smoothstep(1), 1);
});

test("timeEngine: smoothstep(0.5) === 0.5", () => {
  assert.strictEqual(smoothstep(0.5), 0.5);
});

// ============================================================================
// lifecycle tests
// ============================================================================

test("lifecycle: before birth is 'absent' with presence 0", () => {
  const result = lifecycle(1000, { born: 1190, buildYears: 30 });
  assert.deepStrictEqual(result, { phase: "absent", presence: 0 });
});

test("lifecycle: at exact birth is 'building' with presence 0", () => {
  const result = lifecycle(1190, { born: 1190, buildYears: 30 });
  assert.deepStrictEqual(result, { phase: "building", presence: 0 });
});

test("lifecycle: mid-construction is 'building' with presence 0.5", () => {
  const result = lifecycle(1205, { born: 1190, buildYears: 30 });
  assert.deepStrictEqual(result, { phase: "building", presence: 0.5 });
});

test("lifecycle: at end of construction is 'alive' with presence 1", () => {
  const result = lifecycle(1220, { born: 1190, buildYears: 30 });
  assert.deepStrictEqual(result, { phase: "alive", presence: 1 });
});

test("lifecycle: long after construction is 'alive' with presence 1", () => {
  const result = lifecycle(1500, { born: 1190, buildYears: 30 });
  assert.deepStrictEqual(result, { phase: "alive", presence: 1 });
});

test("lifecycle: at exact death (with razeYears) is 'razing' with presence 1", () => {
  const result = lifecycle(1670, { born: 1190, buildYears: 30, died: 1670, razeYears: 10 });
  assert.deepStrictEqual(result, { phase: "razing", presence: 1 });
});

test("lifecycle: mid-razing is 'razing' with presence 0.5", () => {
  const result = lifecycle(1675, { born: 1190, buildYears: 30, died: 1670, razeYears: 10 });
  assert.deepStrictEqual(result, { phase: "razing", presence: 0.5 });
});

test("lifecycle: at end of razing is 'gone' with presence 0", () => {
  const result = lifecycle(1680, { born: 1190, buildYears: 30, died: 1670, razeYears: 10 });
  assert.deepStrictEqual(result, { phase: "gone", presence: 0 });
});

test("lifecycle: after gone is 'gone' with presence 0", () => {
  const result = lifecycle(1700, { born: 1190, buildYears: 30, died: 1670, razeYears: 10 });
  assert.deepStrictEqual(result, { phase: "gone", presence: 0 });
});

test("lifecycle: default buildYears is 10", () => {
  const result1 = lifecycle(1195, { born: 1190 });
  const result2 = lifecycle(1195, { born: 1190, buildYears: 10 });
  assert.deepStrictEqual(result1, result2);
});

test("lifecycle: default died is Infinity", () => {
  const result = lifecycle(5000, { born: 1190, buildYears: 30 });
  assert.deepStrictEqual(result, { phase: "alive", presence: 1 });
});

test("lifecycle: default razeYears is 5", () => {
  const result1 = lifecycle(1680, { born: 1190, died: 1670 });
  const result2 = lifecycle(1680, { born: 1190, died: 1670, razeYears: 5 });
  assert.deepStrictEqual(result1, result2);
});

// ============================================================================
// momentBlend tests
// ============================================================================

test("momentBlend: before first anchor returns {i:0, j:0, t:0}", () => {
  const result = momentBlend(-500, anchors);
  assert.deepStrictEqual(result, { i: 0, j: 0, t: 0 });
});

test("momentBlend: at first anchor returns {i:0, j:0, t:0}", () => {
  const result = momentBlend(-250, anchors);
  assert.deepStrictEqual(result, { i: 0, j: 0, t: 0 });
});

test("momentBlend: after last anchor returns {i:13, j:13, t:0}", () => {
  const result = momentBlend(3000, anchors);
  assert.deepStrictEqual(result, { i: 13, j: 13, t: 0 });
});

test("momentBlend: at last anchor returns {i:13, j:13, t:0}", () => {
  const result = momentBlend(2026, anchors);
  assert.deepStrictEqual(result, { i: 13, j: 13, t: 0 });
});

test("momentBlend: between anchors 8 and 9 (1865 and 1889), at 1875", () => {
  // anchors[8] = 1865, anchors[9] = 1889
  // year = 1875, t = (1875 - 1865) / (1889 - 1865) = 10 / 24 ≈ 0.41666...
  const result = momentBlend(1875, anchors);
  assert.strictEqual(result.i, 8);
  assert.strictEqual(result.j, 9);
  assert.ok(Math.abs(result.t - 10/24) < 1e-6, `t should be ~0.4167, got ${result.t}`);
});

test("momentBlend: exactly at an anchor returns that anchor as i, next as j, t:0", () => {
  const result = momentBlend(1200, anchors);
  assert.strictEqual(result.i, 3);
  assert.strictEqual(result.j, 3);
  assert.strictEqual(result.t, 0);
});

test("momentBlend: in middle of segment", () => {
  // Between anchors[0]=-250 and anchors[1]=200
  // year = -25, t = (-25 - (-250)) / (200 - (-250)) = 225 / 450 = 0.5
  const result = momentBlend(-25, anchors);
  assert.strictEqual(result.i, 0);
  assert.strictEqual(result.j, 1);
  assert.strictEqual(result.t, 0.5);
});

// ============================================================================
// sliderToYear and yearToSlider tests
// ============================================================================

test("sliderToYear: u=0 returns first anchor", () => {
  const result = sliderToYear(0, anchors);
  assert.strictEqual(result, -250);
});

test("sliderToYear: u=1 returns last anchor", () => {
  const result = sliderToYear(1, anchors);
  assert.strictEqual(result, 2026);
});

test("sliderToYear: u=0.5 is roughly in the middle of timeline", () => {
  const result = sliderToYear(0.5, anchors);
  assert.ok(result > 0 && result < 2026);
});

test("sliderToYear: clamped below 0", () => {
  const result = sliderToYear(-0.5, anchors);
  assert.strictEqual(result, -250);
});

test("sliderToYear: clamped above 1", () => {
  const result = sliderToYear(1.5, anchors);
  assert.strictEqual(result, 2026);
});

test("yearToSlider: year=-250 returns 0", () => {
  const result = yearToSlider(-250, anchors);
  assert.strictEqual(result, 0);
});

test("yearToSlider: year=2026 returns 1", () => {
  const result = yearToSlider(2026, anchors);
  assert.strictEqual(result, 1);
});

test("yearToSlider: before first anchor clamps to 0", () => {
  const result = yearToSlider(-500, anchors);
  assert.strictEqual(result, 0);
});

test("yearToSlider: after last anchor clamps to 1", () => {
  const result = yearToSlider(3000, anchors);
  assert.strictEqual(result, 1);
});

test("sliderToYear and yearToSlider roundtrip at u=0.37", () => {
  const u = 0.37;
  const year = sliderToYear(u, anchors);
  const uBack = yearToSlider(year, anchors);
  assert.ok(Math.abs(uBack - u) < 1e-6, `Roundtrip failed: ${u} -> ${year} -> ${uBack}`);
});

test("sliderToYear and yearToSlider roundtrip at u=0.5", () => {
  const u = 0.5;
  const year = sliderToYear(u, anchors);
  const uBack = yearToSlider(year, anchors);
  assert.ok(Math.abs(uBack - u) < 1e-6, `Roundtrip failed: ${u} -> ${year} -> ${uBack}`);
});

test("sliderToYear and yearToSlider roundtrip at u=0.75", () => {
  const u = 0.75;
  const year = sliderToYear(u, anchors);
  const uBack = yearToSlider(year, anchors);
  assert.ok(Math.abs(uBack - u) < 1e-6, `Roundtrip failed: ${u} -> ${year} -> ${uBack}`);
});

test("yearToSlider: year at exact anchor returns exact position", () => {
  // anchors[4] = 1370, which is at position 4 / 13
  const expectedU = 4 / 13;
  const result = yearToSlider(1370, anchors);
  assert.ok(Math.abs(result - expectedU) < 1e-6);
});

test("sliderToYear: between two segments on equal timeline", () => {
  // At u=1/13 (first segment), year should be -250
  const result = sliderToYear(1 / 13, anchors);
  assert.ok(result >= anchors[0] && result <= anchors[1]);
});
