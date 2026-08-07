import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSpaceTogglePlayback, isFormControlTag, formatYear } from "../src/ui.js";

// ============================================================================
// isFormControlTag — correctif revue post-v1, important n°3 (prédicat
// partagé : ZQSD dans controls.js, flèches ± années dans main.js, Espace ici)
// ============================================================================

test("isFormControlTag : INPUT/TEXTAREA/SELECT sont des contrôles de formulaire", () => {
  assert.equal(isFormControlTag("INPUT"), true);
  assert.equal(isFormControlTag("TEXTAREA"), true);
  assert.equal(isFormControlTag("SELECT"), true);
});

test("isFormControlTag : BUTTON, BODY, autre, vide/undefined -> pas un contrôle de formulaire", () => {
  assert.equal(isFormControlTag("BUTTON"), false);
  assert.equal(isFormControlTag("BODY"), false);
  assert.equal(isFormControlTag(""), false);
  assert.equal(isFormControlTag(undefined), false);
});

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

// Post-v1 : curseurs de volume 🔈/🔊 (<input type="range">) — même garde que
// pour les boutons, sinon régler le volume au clavier (Tab jusqu'au curseur,
// Espace pour bouger la poignée) déclencherait AUSSI ▶️/⏸.
test("shouldSpaceTogglePlayback : focus sur un <input> (curseur de volume) → ne toggle pas la lecture", () => {
  assert.equal(shouldSpaceTogglePlayback("INPUT", false), false);
});

// ============================================================================
// formatYear (déjà en usage — non testé jusqu'ici, couverture minimale)
// ============================================================================

test("formatYear : négatif -> 'av. J.-C.', positif -> tel quel", () => {
  assert.equal(formatYear(-250), "250 av. J.-C.");
  assert.equal(formatYear(2026), "2026");
});
