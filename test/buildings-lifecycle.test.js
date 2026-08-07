import { test } from "node:test";
import assert from "node:assert/strict";
import {
  init,
  update,
  rebuildForYear,
  debugCounts,
  stats,
} from "../src/layers/buildings.js";
import { YEAR_MIN, YEAR_MAX } from "../src/timeline.js";

// ============================================================================
// Stateful integration tests (review fix, Important 2 — continued):
// LOD/detail double-render after a full sweep at a close camera.
//
// `init()` only needs `ctx.scene.add(mesh)` (a no-op stub is enough — no
// WebGL context is required to build/mutate InstancedMesh CPU-side buffers)
// and `ctx.camera.position` (read every `update()` to decide which quartiers
// are "active" / detail-rendered). This lets the full generate -> init ->
// update -> debugCounts pipeline run headless in `node --test`, without a
// browser — the module-private `B`/`districts` state that `debugCounts`
// reads live is exercised for real, not re-derived independently.
// ============================================================================

function makeCtx(cameraPos = { x: 0, y: 0, z: 0 }) {
  return {
    scene: { add() {} },
    camera: { position: { ...cameraPos } },
  };
}

/** Drives `update()` enough times to clear the LOD_INTERVAL throttle at least once. */
function settleLod(state, times = 3) {
  for (let i = 0; i < times; i++) update(0.2, state);
}

test("debugCounts: steady state at a close camera (districts active) reports 0 mismatches at YEAR_MAX", () => {
  const ctx = makeCtx();
  init(ctx);
  const state = { year: YEAR_MAX };
  settleLod(state);
  const counts = debugCounts(YEAR_MAX);
  assert.ok(counts.activeDistricts > 0, "expected the close camera to activate at least one district");
  assert.equal(counts.visGrowMismatches, 0);
  assert.equal(counts.lodMatrixMismatches, 0);
  assert.equal(counts.detailMatrixMismatches, 0);
  assert.equal(counts.mismatches, 0);
});

test("debugCounts: steady state at a close camera reports 0 mismatches at YEAR_MIN too", () => {
  const ctx = makeCtx();
  init(ctx);
  rebuildForYear(YEAR_MIN);
  const state = { year: YEAR_MIN };
  settleLod(state);
  const counts = debugCounts(YEAR_MIN);
  assert.ok(counts.activeDistricts > 0);
  assert.equal(counts.mismatches, 0);
});

test("double-render regression: rebuildForYear at a close camera must not un-hide LOD for active districts", () => {
  // This is the exact scenario the reviewer's scoped re-review empirically
  // reproduced: districts already active (camera close, steady state), then
  // a forced full resync via `setYear`/`rebuildForYear` — which visits every
  // instance in B unconditionally through `sweep`/`touch`/`writeInstance`.
  // Before the fix, `writeInstance` always wrote the composed (non-zero)
  // matrix into the LOD mesh, ignoring `districts.active` — un-hiding LOD
  // entries for districts simultaneously drawn in detail (double-render).
  const ctx = makeCtx();
  init(ctx);
  const state = { year: YEAR_MAX };
  settleLod(state); // activate nearby districts once, at YEAR_MAX

  const before = debugCounts(YEAR_MAX);
  assert.ok(before.activeDistricts > 0);
  assert.equal(before.mismatches, 0, "expected a clean steady state before the jump");

  // The forced full resync: exactly `window.__paris.setYear` in production.
  rebuildForYear(2026);
  rebuildForYear(YEAR_MIN);

  const after = debugCounts(YEAR_MIN);
  assert.equal(
    after.lodMatrixMismatches,
    0,
    "LOD entries for active districts must stay zero-scaled after a forced full resync (no double-render)"
  );
  assert.equal(after.detailMatrixMismatches, 0);
  assert.equal(after.mismatches, 0);
});

test("x5 violent scrub at a close camera: mismatches stay 0 on every single pass", () => {
  const ctx = makeCtx();
  init(ctx);
  const state = { year: YEAR_MAX };
  settleLod(state); // establish active districts once

  for (let i = 0; i < 5; i++) {
    rebuildForYear(2026);
    const atMax = debugCounts(2026);
    assert.equal(atMax.mismatches, 0, `pass ${i} at 2026: ${JSON.stringify(atMax)}`);

    rebuildForYear(YEAR_MIN);
    const atMin = debugCounts(YEAR_MIN);
    assert.equal(atMin.mismatches, 0, `pass ${i} at ${YEAR_MIN}: ${JSON.stringify(atMin)}`);
  }
});

test("drag sweep at a close camera: the natural per-frame path (update/applyYear) keeps mismatches at 0 throughout", () => {
  const ctx = makeCtx();
  init(ctx);
  const state = { year: YEAR_MIN };
  settleLod(state); // activate districts near the camera once

  const span = YEAR_MAX - YEAR_MIN;
  const steps = 200;
  for (let s = 0; s <= steps; s++) {
    state.year = YEAR_MIN + (s / steps) * span;
    update(0.05, state); // below LOD_INTERVAL most ticks: exercises applyYear far more often than updateLod/repackDetail
    const counts = debugCounts(state.year);
    assert.equal(
      counts.mismatches,
      0,
      `mismatch at year ${state.year} (step ${s}): ${JSON.stringify(counts)}`
    );
  }
});

test("stats(): sanity — buildings count matches debugCounts' totalInstances", () => {
  const ctx = makeCtx();
  init(ctx);
  const s = stats();
  const counts = debugCounts(YEAR_MAX);
  assert.equal(s.buildings, counts.totalInstances);
});
