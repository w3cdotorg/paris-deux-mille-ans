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

test("lifecycle: born===died (object built and destroyed instantly)", () => {
  // At exactly birth/death: razing with presence 0
  const result1 = lifecycle(1190, { born: 1190, died: 1190, buildYears: 10, razeYears: 5 });
  assert.strictEqual(result1.phase, "razing");
  assert.strictEqual(result1.presence, 0);

  // During razing window: razing with presence 0
  const result2 = lifecycle(1192, { born: 1190, died: 1190, buildYears: 10, razeYears: 5 });
  assert.strictEqual(result2.phase, "razing");
  assert.strictEqual(result2.presence, 0);

  // After razing: gone with presence 0
  const result3 = lifecycle(1195, { born: 1190, died: 1190, buildYears: 10, razeYears: 5 });
  assert.strictEqual(result3.phase, "gone");
  assert.strictEqual(result3.presence, 0);
});

test("lifecycle: death during build window (died < buildEnd)", () => {
  // born=1190, buildEnd=1200, died=1195, razeEnd=1200

  // Before death, during build: building phase
  const result1 = lifecycle(1192, { born: 1190, died: 1195, buildYears: 10, razeYears: 5 });
  assert.strictEqual(result1.phase, "building");
  assert.strictEqual(result1.presence, 0.2); // (1192-1190)/10 = 2/10

  // At death: razing with presence = build progress at death = 0.5
  const result2 = lifecycle(1195, { born: 1190, died: 1195, buildYears: 10, razeYears: 5 });
  assert.strictEqual(result2.phase, "razing");
  assert.strictEqual(result2.presence, 0.5); // 0.5 * (1 - 0/5)

  // Mid-razing: razing with presence decreasing
  const result3 = lifecycle(1197, { born: 1190, died: 1195, buildYears: 10, razeYears: 5 });
  assert.strictEqual(result3.phase, "razing");
  assert.strictEqual(result3.presence, 0.3); // 0.5 * (1 - 2/5)

  // After razing: gone
  const result4 = lifecycle(1200, { born: 1190, died: 1195, buildYears: 10, razeYears: 5 });
  assert.strictEqual(result4.phase, "gone");
  assert.strictEqual(result4.presence, 0);
});

test("lifecycle: death at exact birth boundary", () => {
  // born=1190, died=1190, razeEnd=1195 (death at birth)
  // Before birth: absent
  const result1 = lifecycle(1189, { born: 1190, died: 1190, buildYears: 10, razeYears: 5 });
  assert.strictEqual(result1.phase, "absent");
  assert.strictEqual(result1.presence, 0);

  // At/after birth: razing (died immediately at birth, never built)
  const result2 = lifecycle(1190, { born: 1190, died: 1190, buildYears: 10, razeYears: 5 });
  assert.strictEqual(result2.phase, "razing");
  assert.strictEqual(result2.presence, 0);
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

test("sliderToYear: single anchor returns that anchor for any u", () => {
  const singleAnchor = [1200];
  const result1 = sliderToYear(0, singleAnchor);
  const result2 = sliderToYear(0.5, singleAnchor);
  const result3 = sliderToYear(1, singleAnchor);
  assert.strictEqual(result1, 1200);
  assert.strictEqual(result2, 1200);
  assert.strictEqual(result3, 1200);
});

test("yearToSlider: single anchor returns 0 for any year", () => {
  const singleAnchor = [1200];
  const result1 = yearToSlider(1000, singleAnchor);
  const result2 = yearToSlider(1200, singleAnchor);
  const result3 = yearToSlider(1500, singleAnchor);
  assert.strictEqual(result1, 0);
  assert.strictEqual(result2, 0);
  assert.strictEqual(result3, 0);
});

test("sliderToYear and yearToSlider: single anchor roundtrip", () => {
  const singleAnchor = [1500];
  const u = 0.5;
  const year = sliderToYear(u, singleAnchor);
  const uBack = yearToSlider(year, singleAnchor);
  assert.strictEqual(year, 1500);
  assert.strictEqual(uBack, 0);
});
