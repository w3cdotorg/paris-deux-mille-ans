import { test } from "node:test";
import assert from "node:assert/strict";
import { MOMENTS, YEAR_MIN, YEAR_MAX } from "../src/timeline.js";

test("timeline: YEAR_MIN et YEAR_MAX existent", () => {
  assert.strictEqual(YEAR_MIN, -250);
  assert.strictEqual(YEAR_MAX, 2026);
});

test("timeline: MOMENTS est un tableau de 14 moments", () => {
  assert.ok(Array.isArray(MOMENTS));
  assert.strictEqual(MOMENTS.length, 14);
});

test("timeline: années strictement croissantes de -250 à 2026", () => {
  assert.strictEqual(MOMENTS[0].year, -250);
  assert.strictEqual(MOMENTS[13].year, 2026);
  for (let i = 1; i < MOMENTS.length; i++) {
    assert.ok(
      MOMENTS[i].year > MOMENTS[i - 1].year,
      `Year at index ${i} should be greater than year at index ${i - 1}`
    );
  }
});

test("timeline: chaque moment a titre et recit non vides", () => {
  for (let i = 0; i < MOMENTS.length; i++) {
    const moment = MOMENTS[i];
    assert.ok(typeof moment.titre === "string" && moment.titre.length > 0,
      `Moment ${i} should have a non-empty titre`);
    assert.ok(typeof moment.recit === "string" && moment.recit.length > 0,
      `Moment ${i} should have a non-empty recit`);
  }
});

test("timeline: chaque moment a population > 0 et icon non vide", () => {
  for (let i = 0; i < MOMENTS.length; i++) {
    const moment = MOMENTS[i];
    assert.ok(moment.population > 0,
      `Moment ${i} should have population > 0`);
    assert.ok(typeof moment.icon === "string" && moment.icon.length > 0,
      `Moment ${i} should have a non-empty icon`);
  }
});

test("timeline: chaque moment a chezNous non vide", () => {
  for (let i = 0; i < MOMENTS.length; i++) {
    const moment = MOMENTS[i];
    assert.ok(typeof moment.chezNous === "string" && moment.chezNous.length > 0,
      `Moment ${i} should have a non-empty chezNous`);
  }
});

test("timeline: moment 1860 contient 'quartier' dans recit", () => {
  const moment1860 = MOMENTS.find(m => m.year === 1860);
  assert.ok(moment1860, "Should have a moment with year 1860");
  assert.ok(moment1860.recit.includes("quartier"),
    "Moment 1860 recit should contain 'quartier'");
});

test("timeline: moment 1889 contient 'Eiffel' dans recit", () => {
  const moment1889 = MOMENTS.find(m => m.year === 1889);
  assert.ok(moment1889, "Should have a moment with year 1889");
  assert.ok(moment1889.recit.includes("Eiffel"),
    "Moment 1889 recit should contain 'Eiffel'");
});
