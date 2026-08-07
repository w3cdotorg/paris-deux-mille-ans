import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("smoke: vendor/three.module.js est présent et non trivial (pas un stub vide)", () => {
  const stats = statSync(new URL("../vendor/three.module.js", import.meta.url));
  assert.ok(stats.isFile(), "vendor/three.module.js devrait être un fichier");
  // three.js entier fait plusieurs centaines de Ko — un stub/placeholder ne
  // dépasserait jamais ce seuil, ce qui suffit à distinguer les deux sans
  // dépendre d'une taille exacte fragile aux mises à jour de version.
  assert.ok(
    stats.size > 500_000,
    `vendor/three.module.js trop petit (${stats.size} octets) pour être le module three.js complet`
  );
});

test("smoke: src/main.js est un JavaScript syntaxiquement valide", () => {
  const result = spawnSync(process.execPath, ["--check", `${ROOT}src/main.js`], { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `node --check src/main.js a échoué : ${result.stderr || result.stdout}`
  );
});
