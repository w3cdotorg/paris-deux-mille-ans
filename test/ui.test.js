import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSpaceTogglePlayback, formatYear } from "../src/ui.js";

// ============================================================================
// shouldSpaceTogglePlayback — correctif revue tâche 16 (barre d'espace)
// ============================================================================

test("shouldSpaceTogglePlayback : le bouton ▶️/⏸ lui-même toggle toujours (pas de double activation native)", () => {
  assert.equal(shouldSpaceTogglePlayback("BUTTON", true), true);
});

test("shouldSpaceTogglePlayback : aucun bouton focus (body/document) → toggle la lecture", () => {
  assert.equal(shouldSpaceTogglePlayback("BODY", false), true);
  assert.equal(shouldSpaceTogglePlayback("", false), true);
});

test("shouldSpaceTogglePlayback : un AUTRE bouton focus (météo, voix, qualité, icône de la frise, popover...) → laisse son activation native, ne toggle pas", () => {
  assert.equal(shouldSpaceTogglePlayback("BUTTON", false), false);
});

// ============================================================================
// formatYear (déjà en usage — non testé jusqu'ici, couverture minimale)
// ============================================================================

test("formatYear : négatif -> 'av. J.-C.', positif -> tel quel", () => {
  assert.equal(formatYear(-250), "250 av. J.-C.");
  assert.equal(formatYear(2026), "2026");
});
