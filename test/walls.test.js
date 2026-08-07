import { test } from "node:test";
import assert from "node:assert/strict";
import { lifecycle } from "../src/timeEngine.js";
import {
  wallRingPlan,
  segmentPresence,
  perimeterLength,
  nearestDistanceToward,
  sampleEllipsePoints,
  compassTargets,
  ellipseBastionPositions,
  boulevardTreePositions,
  GALLO_ROMAIN,
  PHILIPPE_AUGUSTE,
  CHARLES_V,
  THIERS,
  BASTILLE,
  BOULEVARDS,
} from "../src/layers/walls.js";

// ============================================================================
// wallRingPlan — géométrie pure sur une polyligne connue (un carré 10x10)
// ============================================================================

const SQUARE = [
  { x: 0, z: 0 },
  { x: 10, z: 0 },
  { x: 10, z: 10 },
  { x: 0, z: 10 },
];

test("wallRingPlan: a closed square with no gates has 4 segments summing to the full perimeter", () => {
  const plan = wallRingPlan(SQUARE, { closed: true });
  assert.equal(plan.totalLength, 40);
  assert.equal(plan.segments.length, 4);
  const sum = plan.segments.reduce((s, seg) => s + seg.length, 0);
  assert.ok(Math.abs(sum - 40) < 1e-9);
  for (const seg of plan.segments) assert.ok(Math.abs(seg.length - 10) < 1e-9);
});

test("wallRingPlan: towerEvery=5 on a 40-unit perimeter places exactly 8 towers", () => {
  const plan = wallRingPlan(SQUARE, { closed: true, towerEvery: 5 });
  assert.equal(plan.towers.length, 8);
  // all towers strictly inside [0, totalLength)
  for (const t of plan.towers) {
    assert.ok(t.distAlong >= 0 && t.distAlong < 40);
  }
});

test("wallRingPlan: a gate strictly inside one edge splits it into 2 segments and removes gateWidth from the courtine", () => {
  const noGate = wallRingPlan(SQUARE, { closed: true });
  // aim a gate target far to the east: nearest point is the midpoint of the right edge (x=10, z=5)
  const withGate = wallRingPlan(SQUARE, {
    closed: true,
    gates: [{ x: 1000, z: 5 }],
    gateWidth: 2,
  });
  assert.equal(withGate.segments.length, noGate.segments.length + 1);
  const courtineSum = withGate.segments.reduce((s, seg) => s + seg.length, 0);
  assert.ok(Math.abs(courtineSum - (40 - 2)) < 1e-6, `expected ${40 - 2}, got ${courtineSum}`);
  // the gate opens exactly 2 flanking towers in addition to any regular ones
  const bare = wallRingPlan(SQUARE, { closed: true, towerEvery: 0 });
  const gated = wallRingPlan(SQUARE, { closed: true, towerEvery: 0, gates: [{ x: 1000, z: 5 }], gateWidth: 2 });
  assert.equal(gated.towers.length, bare.towers.length + 2);
});

test("wallRingPlan: a river-crossing edge produces no courtine at all across that edge", () => {
  // edge index 1 connects (10,0)->(10,10) — mark it as a river crossing
  const plan = wallRingPlan(SQUARE, { closed: true, riverCrossings: [1] });
  assert.equal(plan.segments.length, 3);
  const sum = plan.segments.reduce((s, seg) => s + seg.length, 0);
  assert.ok(Math.abs(sum - 30) < 1e-9);
});

test("wallRingPlan: an open polyline (closed:false) has one fewer edge than points, no wraparound segment", () => {
  const plan = wallRingPlan(SQUARE, { closed: false });
  assert.equal(plan.segments.length, 3);
  assert.ok(Math.abs(plan.totalLength - 30) < 1e-9);
});

test("perimeterLength matches wallRingPlan's totalLength for the same polyline/closed flag", () => {
  assert.equal(perimeterLength(SQUARE, true), 40);
  assert.equal(perimeterLength(SQUARE, false), 30);
});

test("nearestDistanceToward: the point closest to due east on the square is the midpoint of the right edge", () => {
  const d = nearestDistanceToward(SQUARE, true, 1000, 5);
  // right edge is points[1]->points[2] i.e. distance 10..20, midpoint at 15
  assert.ok(Math.abs(d - 15) < 1e-6);
});

// ============================================================================
// segmentPresence — la vague "pierre par pierre"
// ============================================================================

test("segmentPresence: overallPresence 0 or 1 give exact boundary values regardless of position", () => {
  assert.equal(segmentPresence(10, 20, 40, 0), 0);
  assert.equal(segmentPresence(10, 20, 40, 1), 1);
});

test("segmentPresence: at overallPresence=0.5 on a 4-equal-segment/40-unit wall, the first half is fully built and the second untouched", () => {
  assert.equal(segmentPresence(0, 10, 40, 0.5), 1);
  assert.equal(segmentPresence(10, 20, 40, 0.5), 1);
  assert.equal(segmentPresence(20, 30, 40, 0.5), 0);
  assert.equal(segmentPresence(30, 40, 40, 0.5), 0);
});

test("segmentPresence: the transition segment is a clean linear interpolation", () => {
  // builtLen = 0.55*40 = 22, segment [20,30] => t = (22-20)/10 = 0.2
  assert.ok(Math.abs(segmentPresence(20, 30, 40, 0.55) - 0.2) < 1e-9);
});

test("segmentPresence: monotonically non-decreasing in overallPresence for a fixed segment", () => {
  const seg = [15, 25];
  let prev = -1;
  for (let p = 0; p <= 1; p += 0.05) {
    const v = segmentPresence(seg[0], seg[1], 40, p);
    assert.ok(v >= prev - 1e-12);
    prev = v;
  }
});

test("segmentPresence: applied to a falling presence (demolition), later segments along the perimeter vanish first", () => {
  // presence falling 1 -> 0.5: the same wave formula un-builds from the end of
  // the perimeter backward — segment [30,40] (the far end) should already be
  // gone while segment [0,10] (the start) is still fully standing.
  assert.equal(segmentPresence(0, 10, 40, 0.5), 1);
  assert.equal(segmentPresence(30, 40, 40, 0.5), 0);
});

// ============================================================================
// Générateurs de points
// ============================================================================

test("sampleEllipsePoints: returns exactly `count` points, all on the ellipse", () => {
  const pts = sampleEllipsePoints(10, -5, 20, 8, 16);
  assert.equal(pts.length, 16);
  for (const p of pts) {
    const dx = (p.x - 10) / 20;
    const dz = (p.z - -5) / 8;
    assert.ok(Math.abs(dx * dx + dz * dz - 1) < 1e-9);
  }
});

test("compassTargets: returns `n` points all at `radius` distance from the center", () => {
  const targets = compassTargets(0, 0, 8, 100);
  assert.equal(targets.length, 8);
  for (const t of targets) {
    assert.ok(Math.abs(Math.hypot(t.x, t.z) - 100) < 1e-6);
  }
});

test("ellipseBastionPositions: returns `count` positions with unit outward direction vectors", () => {
  const bastions = ellipseBastionPositions(0, 0, 30, 20, 17);
  assert.equal(bastions.length, 17);
  for (const b of bastions) {
    const len = Math.hypot(b.dirX, b.dirZ);
    assert.ok(Math.abs(len - 1) < 1e-6);
  }
});

test("boulevardTreePositions: returns 2 trees (left/right) per spacing step along the trace", () => {
  const trace = [{ x: 0, z: 0 }, { x: 90, z: 0 }]; // 90-unit straight open trace
  const positions = boulevardTreePositions(trace, false, 9, 2);
  assert.equal(positions.length, 20); // 90/9 = 10 steps * 2 sides
  for (const p of positions) {
    assert.ok(Math.abs(Math.abs(p.z) - 2) < 1e-9); // offset perpendicular to a due-east trace is along z
  }
});

// ============================================================================
// Fenêtres de cycle de vie des 4 enceintes + Bastille + Boulevards (brief)
// ============================================================================

test("lifecycle: at 1200, Philippe Auguste is under construction (presence in (0,1))", () => {
  const { presence, phase } = lifecycle(1200, PHILIPPE_AUGUSTE);
  assert.equal(phase, "building");
  assert.ok(presence > 0 && presence < 1);
});

test("lifecycle: at 1200, the gallo-romain wall is still standing (razing but presence > 0)", () => {
  const { presence } = lifecycle(1200, GALLO_ROMAIN);
  assert.ok(presence > 0);
});

test("lifecycle: at 1500, Philippe Auguste and Charles V are both fully alive", () => {
  assert.equal(lifecycle(1500, PHILIPPE_AUGUSTE).presence, 1);
  assert.equal(lifecycle(1500, CHARLES_V).presence, 1);
});

test("lifecycle: at 1500, the Bastille is fully alive", () => {
  assert.equal(lifecycle(1500, BASTILLE).presence, 1);
});

test("lifecycle: at 1700, Philippe Auguste is razing and Charles V is fully gone", () => {
  const pa = lifecycle(1700, PHILIPPE_AUGUSTE);
  const cv = lifecycle(1700, CHARLES_V);
  assert.equal(pa.phase, "razing");
  assert.ok(pa.presence > 0 && pa.presence < 1);
  assert.equal(cv.phase, "gone");
  assert.equal(cv.presence, 0);
});

test("lifecycle: at 1700, the Grands Boulevards have already started growing", () => {
  const { presence } = lifecycle(1700, BOULEVARDS);
  assert.ok(presence > 0);
});

test("lifecycle: at 1850, Thiers is fully alive", () => {
  assert.equal(lifecycle(1850, THIERS).presence, 1);
});

test("lifecycle: Thiers is mid-razing well within its own [died, died+razeYears) window", () => {
  // died:1919, razeYears:10 => razeEnd 1929. The brief's own verification note
  // says "at 1930: Thiers razing", but 1930 is *after* razeEnd (1929) given
  // the brief's own numbers, i.e. mathematically 'gone', not 'razing' — see
  // the task report. 1925 is the closest round year that is unambiguously
  // inside the razing window and matches the intent.
  const { phase, presence } = lifecycle(1925, THIERS);
  assert.equal(phase, "razing");
  assert.ok(presence > 0 && presence < 1);
});

test("lifecycle: the Bastille is gone by 1795", () => {
  const { phase, presence } = lifecycle(1795, BASTILLE);
  assert.equal(phase, "gone");
  assert.equal(presence, 0);
});

test("lifecycle: the Bastille is at presence 1 exactly at its own death year (razing has not eaten into it yet)", () => {
  assert.equal(lifecycle(1789, BASTILLE).presence, 1);
});

test("lifecycle: the Bastille is at presence 0.5 exactly at the midpoint of its 2-year demolition (1790)", () => {
  // died:1789, razeYears:2 => razeEnd 1791; 1790 is exactly halfway.
  const { phase, presence } = lifecycle(1790, BASTILLE);
  assert.equal(phase, "razing");
  assert.ok(Math.abs(presence - 0.5) < 1e-9);
});
