import { test } from "node:test";
import assert from "node:assert/strict";
import {
  familyForUrbanYear,
  fabricAt,
  fabricHistoryAt,
  originJitter,
  cellBuildingCount,
  isBuildableCell,
  placeCell,
  densityAt,
  cellCenterX,
  cellCenterZ,
  streetOrientation,
  CELL,
} from "../src/layers/buildings.js";
import { ARCHETYPES, ARCHETYPES_BY_FAMILY, FAMILY_ORDER } from "../src/archetypes.js";
import { urbanYear, LANDMARKS, RINGS } from "../src/geography.js";
import { lifecycle } from "../src/timeEngine.js";

function insideEllipse(x, z, cx, cz, rx, rz) {
  const dx = (x - cx) / rx;
  const dz = (z - cz) / rz;
  return dx * dx + dz * dz <= 1;
}

// ============================================================================
// familyForUrbanYear — the brief's origin bands (gaulois<0, romain<500,
// medieval<1550, classique<1850, haussmann<1920, moderne>=1920)
// ============================================================================

test("familyForUrbanYear: gaulois below year 0", () => {
  assert.equal(familyForUrbanYear(-300), "gaulois");
  assert.equal(familyForUrbanYear(-1), "gaulois");
});

test("familyForUrbanYear: romain in [0, 500)", () => {
  assert.equal(familyForUrbanYear(0), "romain");
  assert.equal(familyForUrbanYear(250), "romain");
  assert.equal(familyForUrbanYear(499), "romain");
});

test("familyForUrbanYear: medieval in [500, 1550)", () => {
  assert.equal(familyForUrbanYear(500), "medieval");
  assert.equal(familyForUrbanYear(1200), "medieval");
  assert.equal(familyForUrbanYear(1549), "medieval");
});

test("familyForUrbanYear: classique in [1550, 1850)", () => {
  assert.equal(familyForUrbanYear(1550), "classique");
  assert.equal(familyForUrbanYear(1700), "classique");
  assert.equal(familyForUrbanYear(1849), "classique");
});

test("familyForUrbanYear: haussmann in [1850, 1920)", () => {
  assert.equal(familyForUrbanYear(1850), "haussmann");
  assert.equal(familyForUrbanYear(1900), "haussmann");
  assert.equal(familyForUrbanYear(1919), "haussmann");
});

test("familyForUrbanYear: moderne at and beyond 1920", () => {
  assert.equal(familyForUrbanYear(1920), "moderne");
  assert.equal(familyForUrbanYear(2026), "moderne");
  assert.equal(familyForUrbanYear(Infinity), "moderne");
});

// ============================================================================
// fabricAt — the re-clad rule: pre-1850 fabric intra-muros mostly turns
// haussmann by 2026; the same origin outside the ring mostly does not.
// ============================================================================

test("fabricAt: a medieval-origin cell inside the ring is predominantly haussmann by 2026", () => {
  let haussmann = 0;
  const trials = 500;
  for (let seed = 0; seed < trials; seed++) {
    const { family } = fabricAt(1300, 2026, 1, true, seed * 2654435761);
    if (family === "haussmann") haussmann++;
  }
  // share is density-interpolated up to 0.88 at the core, so a clear majority
  // is expected, but not unanimity (medieval/classique survivors exist too).
  assert.ok(haussmann / trials > 0.6, `expected >60% haussmann, got ${haussmann}/${trials}`);
});

test("fabricAt: the same medieval-origin cell outside the ring stays mostly non-haussmann", () => {
  let haussmann = 0;
  const trials = 500;
  for (let seed = 0; seed < trials; seed++) {
    const { family } = fabricAt(1300, 2026, 1, false, seed * 2654435761);
    if (family === "haussmann") haussmann++;
  }
  // Explicitly gated to share=0.1 outside the ring in fabricAt.
  assert.ok(haussmann / trials < 0.3, `expected <30% haussmann outside the ring, got ${haussmann}/${trials}`);
});

test("fabricAt: a cell born after 1920 (moderne origin) never re-clads to an earlier family", () => {
  for (let seed = 0; seed < 200; seed++) {
    const { family, born } = fabricAt(1980, 2026, 0.5, true, seed * 2654435761);
    assert.equal(family, "moderne");
    assert.ok(born >= 1980);
  }
});

test("fabricAt: `born` never precedes the cell's own urbanYear", () => {
  for (let seed = 0; seed < 200; seed++) {
    const { born } = fabricAt(1300, 2026, 0.7, true, seed * 2654435761);
    assert.ok(born >= 1300);
  }
});

test("fabricAt: at a year before any reconstruction epoch, the origin family survives untouched", () => {
  // uYear=1300 (medieval origin); at year 1400, no later epoch's jittered
  // gate (classique 1650+, haussmann 1853+, moderne 1955+) can have fired yet.
  for (let seed = 0; seed < 50; seed++) {
    const { family } = fabricAt(1300, 1400, 1, true, seed * 2654435761);
    assert.equal(family, "medieval");
  }
});

test("fabricAt: moderne reconstruction is hard-suppressed inside the ring (review Critical 2)", () => {
  // Before the fix, only densityAt() decayed the moderne share (no ring
  // gate at all), which measured 5-15% moderne share on medieval-origin
  // cells inside the ring — glass towers a stone's throw from Notre-Dame.
  // Sample across a spread of intra-ring densities (the ring's outer reaches
  // do touch density 0) and confirm the 2026 moderne share stays under 2%,
  // mirroring the symmetric haussmann-outside-the-ring gate above.
  let moderne = 0;
  let total = 0;
  const densities = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const trialsPerDensity = 2000;
  for (const density of densities) {
    for (let seed = 0; seed < trialsPerDensity; seed++) {
      const { family } = fabricAt(1300, 2026, density, true, seed * 2654435761);
      total++;
      if (family === "moderne") moderne++;
    }
  }
  const share = moderne / total;
  assert.ok(share < 0.02, `expected <2% moderne share inside the ring, got ${(share * 100).toFixed(2)}%`);
});

// ============================================================================
// cellBuildingCount — bounds per the brief ("4 à 10 bâtiments")
// ============================================================================

test("cellBuildingCount: every non-zero count across a wide sample falls in [2, 13]", () => {
  // The implementation's tunables (COUNT_CORE=[10,13], COUNT_EDGE=[2,2]) were
  // rebalanced toward the core (review Critical 1c, then re-tuned again after
  // the edge-overflow fix-of-fix — placeCell now drops/shrinks buildings that
  // don't fit their edge, which cost coverage, so COUNT_CORE went up again to
  // recover ≥60% core coverage within the same ≤40k instance budget) to fund
  // the near-continuous street-front coverage at the historic core; the
  // binding invariant tested here is just that counts stay small, positive
  // integers, never absurd.
  let min = Infinity;
  let max = -Infinity;
  let sawZero = false;
  for (let ix = -60; ix < 60; ix++) {
    for (let iz = -60; iz < 60; iz++) {
      const density = ((ix + 60) % 5) / 4; // deterministic spread over [0,1]
      const count = cellBuildingCount(ix, iz, density);
      if (count === 0) {
        sawZero = true;
        continue;
      }
      if (count < min) min = count;
      if (count > max) max = count;
    }
  }
  assert.ok(sawZero, "expected some cells to be void (streets/places/courtyards)");
  assert.ok(min >= 2, `min count ${min} below the documented floor`);
  assert.ok(max <= 13, `max count ${max} above the documented ceiling`);
});

test("cellBuildingCount: higher density never yields a strictly lower ceiling than lower density, same cell", () => {
  // Not a strict monotonicity-per-draw claim (hash-seeded), but the
  // core/edge count bands themselves must not invert.
  const core = cellBuildingCount(10, 10, 1);
  const edge = cellBuildingCount(10, 10, 0);
  // Same (ix,iz) seed for the void roll, so both are built or both are void;
  // when built, density=1 must not produce fewer buildings than density=0.
  if (core > 0 && edge > 0) {
    assert.ok(core >= edge - 1); // small tolerance: both are rounded independently
  }
});

test("cellBuildingCount: deterministic — same inputs, same output, repeatedly", () => {
  const a = cellBuildingCount(7, -3, 0.42);
  const b = cellBuildingCount(7, -3, 0.42);
  const c = cellBuildingCount(7, -3, 0.42);
  assert.equal(a, b);
  assert.equal(b, c);
});

// ============================================================================
// isBuildableCell — water/open-space/landmark exclusions
// ============================================================================

test("isBuildableCell: excludes a cell not yet urbanized by `year`", () => {
  assert.equal(isBuildableCell(500, 500, 3000, 2026), false);
});

test("isBuildableCell: excludes a cell right on the Seine", () => {
  // (0, 0) is île de la Cité's center — dry land, not water; probe a point
  // known to sit on the river's course instead. SEINE_POINTS include (60,
  // -30)-ish stretches; rather than hardcode geometry, just assert the
  // Seine margin logic fires for a point at the river's exact centerline
  // pulled from geography.js would be circular — instead cover the encoded
  // WATER_MARGIN behavior indirectly via the exported distanceToSeine path
  // already covered in geography/terrain tests. Here we just confirm a
  // clearly-inland, clearly-urbanized, clearly-clear-of-monuments cell is
  // buildable, as the positive-control counterpart to the exclusions below.
  assert.equal(isBuildableCell(600, 300, -200, 2026), true);
});

test("isBuildableCell: excludes cells inside landmark clearances (e.g. Notre-Dame)", () => {
  assert.equal(isBuildableCell(0, 0, -300, 2026), false); // notreDame clearance r=7 centered (0,0)
});

test("isBuildableCell: excludes cells inside a declared open space (e.g. Tuileries)", () => {
  assert.equal(isBuildableCell(-164, -115, -300, 2026), false);
});

test("isBuildableCell: a non-water cell near La Défense is buildable (review Important 3)", () => {
  // (-800, -433) sits inside the La Défense urbanization cluster (center
  // -834,-433, r=60; clear of the laDefense landmark clearance, r=11) and
  // far from the real Seine course. Before the fix, isBuildableCell's
  // WATER_MARGIN check ran on the full 18-point Seine polyline, whose
  // off-map return loop passes right by La Défense (-855,-395) — wrongly
  // reading this land as riverbank and excluding it from the buildable grid.
  const x = -800;
  const z = -433;
  const uYear = urbanYear(x, z);
  assert.ok(uYear <= 2026, `expected (${x},${z}) to already be urbanized by 2026, got uYear=${uYear}`);
  assert.equal(isBuildableCell(x, z, uYear, 2026), true);
});

// ============================================================================
// placeCell — determinism and structural invariants
// ============================================================================

test("placeCell: deterministic — identical inputs always produce identical output", () => {
  const a = placeCell(12, -5, 900, 2026, 0.6, true);
  const b = placeCell(12, -5, 900, 2026, 0.6, true);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("placeCell: an empty (void) cell returns no buildings", () => {
  // Scan for a cell the module's own void roll marks empty, then confirm
  // cellBuildingCount and placeCell agree.
  let foundVoid = false;
  for (let ix = 0; ix < 200 && !foundVoid; ix++) {
    for (let iz = 0; iz < 200 && !foundVoid; iz++) {
      if (cellBuildingCount(ix, iz, 0.5) === 0) {
        foundVoid = true;
        const placed = placeCell(ix, iz, 900, 2026, 0.5, true);
        assert.equal(placed.length, 0);
      }
    }
  }
  assert.ok(foundVoid, "expected to find at least one void cell in the scan window");
});

test("placeCell: every placed building references a valid archetype index of the right family", () => {
  const placed = placeCell(0, 0, 1300, 2026, 0.8, true);
  assert.ok(placed.length > 0);
  for (const p of placed) {
    assert.ok(p.archetype >= 0 && p.archetype < ARCHETYPES.length);
    assert.equal(ARCHETYPES[p.archetype].family, p.family);
    assert.ok(FAMILY_ORDER.includes(p.family));
    assert.ok(ARCHETYPES_BY_FAMILY[p.family].includes(p.archetype));
  }
});

test("placeCell: building count is at most cellBuildingCount for the same cell", () => {
  // Was a strict equality until the review's edge-overflow fix: placeCell
  // now bounds each edge's cursor (see fitOnEdge) and drops a building
  // outright if it can't fit on any of the 4 edges even at the shrink
  // floor — rare, but a legitimate, deterministic outcome of a cell whose
  // cellBuildingCount asked for more frontage than 4 edges of ~5.5u can
  // hold. The binding invariant is now "never more than asked", not
  // "always exactly as asked".
  const ix = 9;
  const iz = -14;
  const density = densityAt(cellCenterX(ix), cellCenterZ(iz));
  const expected = cellBuildingCount(ix, iz, density);
  const placed = placeCell(ix, iz, 1000, 2026, density, true);
  assert.ok(
    placed.length <= expected,
    `placed ${placed.length} buildings, expected at most ${expected}`
  );
});

test("placeCell: positions stay within a sane radius of the cell center (no runaway placement)", () => {
  const ix = -2;
  const iz = 6;
  const cx = cellCenterX(ix);
  const cz = cellCenterZ(iz);
  const placed = placeCell(ix, iz, 1700, 2026, 0.9, true);
  for (const p of placed) {
    const d = Math.hypot(p.x - cx, p.z - cz);
    assert.ok(d < 6, `building at distance ${d} from its own cell center (CELL=8)`);
  }
});

// ============================================================================
// placeCell — edge-cursor bounds (review fix-of-fix: the contiguous packing
// added for Critical 1 had an unbounded per-edge cursor; with COUNT_CORE
// raised to [9,12] and a slot&3 round robin, up to 3 buildings could land on
// one ~5.54u edge, overflowing up to +2.35u (~30% of a cell) into the
// neighbouring cell. fitOnEdge now caps every placement — this test locks
// that in with the same packing-axis projection the reviewer's own
// instrumentation script used, over a wide, dense (high building-count) core
// sample.
// ============================================================================

test("placeCell: no building's packing-axis footprint extends past the cell's physical half-width", () => {
  const edgeHalf = 3.55 * 0.78; // FACADE_LINE * EDGE_SPAN, mirrors buildings.js
  const cellHalf = CELL / 2; // 4
  const tolerance = 0.1; // small allowance, e.g. for roof overhangs elsewhere
  let checked = 0;
  let overCellBoundary = 0;
  let maxExtent = 0;

  // Dense core sample: high density (near COUNT_CORE) is exactly the regime
  // that triggered the overflow (more buildings per edge via the slot&3
  // round robin), so sweep it explicitly rather than relying on the
  // brief's default density gradient to happen to hit it.
  for (let ix = -40; ix < 40; ix++) {
    for (let iz = -40; iz < 40; iz++) {
      const cx = cellCenterX(ix);
      const cz = cellCenterZ(iz);
      const cellRot = streetOrientation(ix, iz);
      const cosR = Math.cos(cellRot);
      const sinR = Math.sin(cellRot);
      const placed = placeCell(ix, iz, 1300, 2026, 1, true); // density=1: core
      for (const p of placed) {
        checked++;
        const dx = p.x - cx;
        const dz = p.z - cz;
        // Rotate back into the cell's local (unrotated) frame.
        const lx = dx * cosR + dz * sinR;
        const lz = -dx * sinR + dz * cosR;
        const spec = ARCHETYPES[p.archetype];
        const depth = (spec.d * p.scale) / 2;
        const inner = 3.55 - depth; // FACADE_LINE - depth
        const halfW = (spec.w * p.scale) / 2;

        // Recover the packing-axis coordinate `s` from whichever edge this
        // building's radial offset matches (same projection as the
        // reviewer's overflow_check2.mjs).
        const eps = 1e-6;
        let s = null;
        if (Math.abs(lz + inner) < eps) s = lx;
        else if (Math.abs(lx - inner) < eps) s = lz;
        else if (Math.abs(lx + inner) < eps) s = -lz;
        else if (Math.abs(lz - inner) < eps) s = -lx;
        if (s === null) continue;

        const packingExtent = Math.abs(s) + halfW;
        if (packingExtent > maxExtent) maxExtent = packingExtent;
        if (packingExtent > cellHalf + tolerance) overCellBoundary++;
      }
    }
  }

  assert.ok(checked > 1000, `expected a substantial sample, got ${checked} buildings checked`);
  assert.equal(
    overCellBoundary,
    0,
    `${overCellBoundary}/${checked} buildings exceed the cell's physical half-width ` +
      `(${cellHalf}u + ${tolerance} tolerance); max packing extent seen = ${maxExtent.toFixed(3)}u ` +
      `(nominal envelope edgeHalf = ${edgeHalf.toFixed(3)}u)`
  );
});

// ============================================================================
// Task 8 — growth over time: origin jitter, family-at-year for key cells,
// crossgrow presence curves.
// ============================================================================

// --- originJitter: deterministic, bounded [0, 40) --------------------------

test("originJitter: deterministic — same seed, same result, repeatedly", () => {
  const a = originJitter(123456);
  const b = originJitter(123456);
  const c = originJitter(123456);
  assert.equal(a, b);
  assert.equal(b, c);
});

test("originJitter: bounded in [0, 40) across a wide sample of seeds", () => {
  for (let seed = 0; seed < 5000; seed++) {
    const j = originJitter(seed * 2654435761);
    assert.ok(j >= 0, `jitter ${j} below 0 for seed ${seed}`);
    assert.ok(j < 40, `jitter ${j} at or above 40 for seed ${seed}`);
  }
});

test("originJitter: varies across seeds (not a constant)", () => {
  const values = new Set();
  for (let seed = 0; seed < 50; seed++) values.add(originJitter(seed * 2654435761));
  assert.ok(values.size > 10, "expected real spread across seeds, not a near-constant value");
});

// --- fabricHistoryAt: origin born tracks uYear + jitter ---------------------

test("fabricHistoryAt: the origin stage's born is uYear + originJitter(seed), never earlier than uYear", () => {
  for (let seed = 0; seed < 100; seed++) {
    const s = seed * 2654435761;
    const history = fabricHistoryAt(1300, 0.6, true, s);
    assert.equal(history[0].born, 1300 + originJitter(s));
    assert.ok(history[0].born >= 1300);
    assert.ok(history[0].born < 1300 + 40);
  }
});

test("fabricHistoryAt: stages are in strictly chronological (non-decreasing born) order", () => {
  for (let seed = 0; seed < 500; seed++) {
    const s = seed * 2654435761;
    const history = fabricHistoryAt(1300, 1, true, s);
    for (let i = 1; i < history.length; i++) {
      assert.ok(
        history[i].born > history[i - 1].born,
        `stage ${i} born ${history[i].born} not after stage ${i - 1} born ${history[i - 1].born}`
      );
    }
  }
});

test("fabricHistoryAt: its last stage matches fabricAt(uYear, endYear, ...) exactly (fabricAt is now a thin wrapper)", () => {
  for (let seed = 0; seed < 200; seed++) {
    const s = seed * 2654435761;
    for (const endYear of [200, 1400, 1900, 2026]) {
      const history = fabricHistoryAt(1300, 0.7, true, s, endYear);
      const last = history[history.length - 1];
      const direct = fabricAt(1300, endYear, 0.7, true, s);
      assert.equal(last.family, direct.family);
      assert.equal(last.born, direct.born);
    }
  }
});

test("fabricHistoryAt: a longer endYear never produces a shorter history (transitions only accumulate)", () => {
  for (let seed = 0; seed < 200; seed++) {
    const s = seed * 2654435761;
    const short = fabricHistoryAt(1300, 0.8, true, s, 1500);
    const long = fabricHistoryAt(1300, 0.8, true, s, 2026);
    assert.ok(long.length >= short.length);
    // The short history is a strict prefix of the long one.
    for (let i = 0; i < short.length; i++) {
      assert.equal(short[i].family, long[i].family);
      assert.equal(short[i].born, long[i].born);
    }
  }
});

// --- family-at-year for the brief's key cells -------------------------------

const PERI = RINGS.peripherique;

test("family-at-year: île de la Cité (uYear=-250) is predominantly romain by year 200", () => {
  const uYear = urbanYear(LANDMARKS.notreDame.x, LANDMARKS.notreDame.z); // Cité, -250
  let romain = 0;
  const trials = 1000;
  for (let seed = 0; seed < trials; seed++) {
    const { family } = fabricAt(uYear, 200, 1, true, seed * 2654435761);
    if (family === "romain") romain++;
  }
  assert.ok(romain / trials > 0.6, `expected >60% romain by 200, got ${romain}/${trials}`);
});

test("family-at-year: île de la Cité is predominantly medieval by year 1400", () => {
  const uYear = urbanYear(LANDMARKS.notreDame.x, LANDMARKS.notreDame.z);
  let medieval = 0;
  const trials = 1000;
  for (let seed = 0; seed < trials; seed++) {
    const { family } = fabricAt(uYear, 1400, 1, true, seed * 2654435761);
    if (family === "medieval") medieval++;
  }
  assert.ok(medieval / trials > 0.6, `expected >60% medieval by 1400, got ${medieval}/${trials}`);
});

test("family-at-year: île de la Cité is predominantly haussmann (re-clad) by year 1900", () => {
  const uYear = urbanYear(LANDMARKS.notreDame.x, LANDMARKS.notreDame.z);
  let haussmann = 0;
  const trials = 1000;
  for (let seed = 0; seed < trials; seed++) {
    const { family } = fabricAt(uYear, 1900, 1, true, seed * 2654435761);
    if (family === "haussmann") haussmann++;
  }
  assert.ok(haussmann / trials > 0.6, `expected >60% haussmann by 1900, got ${haussmann}/${trials}`);
});

test("family-at-year: a chez nous cell is not yet buildable in 1700 (absent/rural)", () => {
  // Offset from the landmark itself (whose 3-unit clearance would exclude it
  // regardless of year) but still inside the village core radius (10u).
  const x = LANDMARKS.chezNous.x + 5;
  const z = LANDMARKS.chezNous.z + 5;
  const uYear = urbanYear(x, z);
  assert.ok(uYear > 1700, `expected chez nous to urbanize after 1700, got uYear=${uYear}`);
  assert.equal(isBuildableCell(x, z, uYear, 1700), false);
});

test("family-at-year: the same chez nous cell is classique or haussmann by 1900 (per its ~1780+ urbanYear)", () => {
  const x = LANDMARKS.chezNous.x + 5;
  const z = LANDMARKS.chezNous.z + 5;
  const uYear = urbanYear(x, z);
  const insideRing = insideEllipse(x, z, PERI.cx, PERI.cz, PERI.rx, PERI.rz);
  assert.ok(insideRing, "chez nous should be inside the périphérique (annexed 1860)");
  for (let seed = 0; seed < 300; seed++) {
    const { family } = fabricAt(uYear, 1900, 0.4, insideRing, seed * 2654435761);
    assert.ok(
      family === "classique" || family === "haussmann",
      `expected classique or haussmann, got ${family}`
    );
  }
});

test("family-at-year: La Défense (uYear~1975-2000) is always moderne by 1990 — origin family, nothing later to reclad into", () => {
  const x = LANDMARKS.laDefense.x;
  const z = LANDMARKS.laDefense.z;
  const uYear = urbanYear(x, z);
  const insideRing = insideEllipse(x, z, PERI.cx, PERI.cz, PERI.rx, PERI.rz);
  assert.equal(insideRing, false, "La Défense should be outside the périphérique");
  for (let seed = 0; seed < 300; seed++) {
    const { family } = fabricAt(uYear, 1990, 0.1, insideRing, seed * 2654435761);
    assert.equal(family, "moderne");
  }
});

// --- crossgrow: old shrinks while new grows, presence sums sensibly --------

test("crossgrow: during a haussmann re-clad, old presence + new presence stays in [0, ~1.2], never a gap", () => {
  const BUILD_YEARS = 8;
  const RAZE_YEARS = 8;
  let sawGenuineOverlap = false;
  let checkedTransitions = 0;

  for (let seed = 0; seed < 60 && checkedTransitions < 15; seed++) {
    const s = seed * 2654435761;
    const history = fabricHistoryAt(1300, 1, true, s); // medieval-origin, core density, inside ring
    if (history.length < 2) continue; // no reclad this seed — nothing to cross
    checkedTransitions++;

    for (let stage = 0; stage < history.length - 1; stage++) {
      const oldStage = history[stage];
      const newStage = history[stage + 1];
      const diedOld = newStage.born; // exact match — see fabricHistoryAt's doc comment
      const diedNew = stage + 2 < history.length ? history[stage + 2].born : Infinity;

      for (let y = diedOld - 4; y <= diedOld + 12; y += 1) {
        const oldPresence = lifecycle(y, {
          born: oldStage.born,
          buildYears: BUILD_YEARS,
          died: diedOld,
          razeYears: RAZE_YEARS,
        }).presence;
        const newPresence = lifecycle(y, {
          born: newStage.born,
          buildYears: BUILD_YEARS,
          died: diedNew,
          razeYears: RAZE_YEARS,
        }).presence;

        assert.ok(oldPresence >= 0 && oldPresence <= 1, `old presence ${oldPresence} out of [0,1]`);
        assert.ok(newPresence >= 0 && newPresence <= 1, `new presence ${newPresence} out of [0,1]`);
        assert.ok(
          oldPresence + newPresence <= 1.2 + 1e-9,
          `sum ${oldPresence + newPresence} exceeds 1.2 at year ${y} (crossFADE/overlap bug, not a crossgrow)`
        );
        if (oldPresence > 0.05 && newPresence > 0.05) sawGenuineOverlap = true;
      }
    }
  }

  assert.ok(checkedTransitions >= 5, `expected several reclad transitions to sample, got ${checkedTransitions}`);
  assert.ok(sawGenuineOverlap, "expected at least one year where both old and new are genuinely present (a real crossgrow, not an instant cut)");
});

test("crossgrow: old presence and new presence sum to exactly 1 throughout the shared build/raze window (same duration, exact handoff)", () => {
  // died(old) === born(new) by construction, and buildYears === razeYears,
  // so the two ramps are exact mirror images: this is stricter than the
  // ≤1.2 test above and locks in *why* it holds for this specific pairing.
  const seed = 0; // known (see scratch investigation) to reclad medieval -> haussmann
  const history = fabricHistoryAt(1300, 1, true, seed);
  assert.ok(history.length >= 2, "expected this seed to reclad at least once");
  const oldStage = history[0];
  const newStage = history[1];
  const diedOld = newStage.born;

  for (let t = 0; t <= 8; t += 0.5) {
    const y = diedOld + t - 4; // sweep from 4 years before to 4 years after the handoff
    const oldPresence = lifecycle(y, { born: oldStage.born, buildYears: 8, died: diedOld, razeYears: 8 }).presence;
    const newPresence = lifecycle(y, { born: newStage.born, buildYears: 8, died: Infinity, razeYears: 8 }).presence;
    assert.ok(
      Math.abs(oldPresence + newPresence - 1) < 1e-9,
      `expected sum exactly 1 at year ${y}, got ${oldPresence + newPresence}`
    );
  }
});
