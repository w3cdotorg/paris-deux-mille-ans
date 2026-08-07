# « Paris, deux mille ans » — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une expérience Three.js hors ligne où l'on survole un Paris 3D dense et vivant, et où un grand slider temporel fait couler 2 300 ans d'histoire (14 moments, de Lutèce à 2026) sur une géographie constante — avec Tour Eiffel fantôme, balise « chez nous » (Leibniz × Jean Dollfus), météo, bouton Lecture, narration française à voix haute et sons d'ambiance procéduraux.

**Architecture:** Sources modulaires dans `src/` (un module par couche : terrain, bâtiments, murailles, monuments, rails, vie, fantômes, météo, audio, UI), chargées **en modules ES natifs** par `index.html` via un import map pointant sur `vendor/three.module.js` (épinglé, vendorisé). **Pas de bundling** (décision utilisateur) : le JS reste séparé et lisible ; l'app est servie par `./serve.sh` en local ou par GitHub Pages. Un moteur temporel pur (`timeEngine.js`) pilote tout depuis une seule valeur `year` : chaque objet a un calque temporel (naissance, construction, mort, démolition) et chaque moment une signature d'ambiance interpolée.

**Tech Stack:** Three.js `0.180.0` (épinglé, vendorisé dans `vendor/`), `node --test` (logique pure), Playwright MCP (vérifs visuelles), Web Audio API (sons procéduraux), `speechSynthesis` (voix FR).

## Global Constraints

- `source ~/.zshrc` (ou `export PATH="/opt/homebrew/bin:$PATH"`) avant tout outil CLI (CLAUDE.md).
- Répertoire projet : `/Users/willow/Sites/_Claude_output/raphael_paris/` — dépôt git déjà initialisé (spec committée).
- **Aucun type-checker configuré** (JS pur) : la vérification = `npm test` (node --test) + `npm run build` sans erreur + console navigateur sans erreur. Le dire explicitement dans les rapports, ne jamais prétendre `tsc` a tourné.
- Tout procédural : aucune image, aucun modèle 3D externe, aucune donnée téléchargée à l'exécution. Google Fonts (Fredoka/Baloo 2) avec repli système = seule requête réseau, optionnelle.
- Français partout dans l'UI et les textes ; voix et sons **coupés par défaut**.
- Performance : 60 fps laptop (cible), iPad M1 second appareil ; `devicePixelRatio` ≤ 2 ; `prefers-reduced-motion` respecté.
- Ambition visuelle assumée (choix « B » du user) — en cas d'arbitrage, préférer la densité/le spectacle, on élaguera sur retour utilisateur.
- Après chaque tâche : commit (messages en français, co-authored Claude).

## Conventions partagées (référencées par toutes les tâches)

**Unités & repère :** 1 unité scène = 10 m. Origine = parvis de Notre-Dame (48.8530 N, 2.3499 E). `x` = est, `z` = sud (le nord est en −z). Conversion : `x = (lon − 2.3499) × 7325 ; z = −(lat − 48.8530) × 11113`.

**Landmarks (unités scène, à ajuster à l'œil contre une carte) :**

| Lieu | x | z |
|---|---:|---:|
| Notre-Dame (origine) | 0 | 0 |
| Louvre | −90 | −84 |
| Bastille | +141 | 0 |
| Tour Eiffel | −406 | −60 |
| Sacré-Cœur (butte Montmartre) | −50 | −375 |
| **Chez nous (Leibniz × J. Dollfus)** | **−131** | **−497** |
| Arènes de Lutèce | +22 | +89 |
| Thermes de Cluny | −43 | +28 |
| Panthéon (mont. Ste-Geneviève) | −26 | +76 |
| Viaduc de Barbès (segment) | (−20,−338)→(+120,−348) |
| La Défense (hors périph) | −834 | −433 |

**Anneaux (ellipses, centre (−140,−80)) :** périphérique/enceinte de Thiers rx=575 rz=430 ; petite ceinture rx=545 rz=415. **Contrainte visuelle clé : « chez nous » (−131,−497) doit être encadré — petite ceinture juste au sud, périphérique juste au nord.** Ajuster rz pour que ce soit vrai.

**Interface des couches :** chaque module de couche exporte `init(ctx)` et `update(dt, state)` où `ctx = { scene, renderer, camera, quality }` et `state = { year, weather, showLandmarks, reducedMotion, time }`. `main.js` possède `state` et boucle sur les couches.

**Moments (14) — années ancres du slider** (chaque moment occupe 1/13 de la frise, interpolation linéaire entre ancres) : `[-250, 200, 885, 1200, 1370, 1670, 1789, 1860, 1865, 1889, 1900, 1934, 1973, 2026]`.

---

### Task 1: Scaffolding — modules ES + Three.js vendorisé, cube qui tourne

**Files:**
- Create: `package.json`, `.gitignore`, `serve.sh`, `index.html`, `src/main.js`, `vendor/three.module.js` (copié)

**Interfaces:**
- Produces: `index.html` à la racine chargeant `src/main.js` en `<script type="module">` avec import map `{"three": "./vendor/three.module.js"}` ; `npm test` → node --test sur `test/` ; `./serve.sh` → serveur dev port 8123 ; `src/main.js` avec boucle `requestAnimationFrame`, resize, `dpr ≤ 2`. **Aucun build : les fichiers servis sont les sources.**

- [ ] **Step 1 : `package.json` + vendoring**

```json
{
  "name": "raphael-paris",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/",
    "vendor": "cp node_modules/three/build/three.module.js vendor/"
  },
  "dependencies": { "three": "0.180.0" }
}
```

`.gitignore` : `node_modules/`, `.DS_Store`. Puis `source ~/.zshrc && npm install && mkdir -p vendor && npm run vendor`. **`vendor/three.module.js` est committé** (c'est le point : l'app tourne sans npm, sur GitHub Pages ou n'importe quel serveur statique).

- [ ] **Step 2 : `serve.sh`** — `#!/bin/sh\ncd "$(dirname "$0")" && python3 -m http.server 8123` (chmod +x). Ouvrir `http://localhost:8123/`.

- [ ] **Step 3 : `index.html` + main.js « cube fumant »** — `index.html` : `<!doctype html>`, `lang="fr"`, viewport, fonts Fredoka/Baloo 2 avec repli système, `<canvas id="scene">`, CSS minimal (fond `#0d1020`, canvas plein écran), puis :

```html
<script type="importmap">{ "imports": { "three": "./vendor/three.module.js" } }</script>
<script type="module" src="./src/main.js"></script>
```

`src/main.js` : renderer WebGL sur `#scene`, `setPixelRatio(Math.min(devicePixelRatio, 2))`, caméra perspective, un cube vert en rotation, lumière directionnelle, resize handler, boucle rAF.

- [ ] **Step 4 : vérifier** — `./serve.sh &` ; Playwright MCP : `browser_navigate` → `http://localhost:8123/`, `browser_console_messages` (aucune erreur), `browser_take_screenshot` (cube visible).

- [ ] **Step 5 : commit** — `git add -A && git commit -m "Scaffolding : modules ES, Three.js vendorisé, scène de base"` (vérifier que `vendor/three.module.js` est bien dans le commit).

---

### Task 2: Données — `timeline.js` (14 moments, textes français) + tests

**Files:**
- Create: `src/timeline.js`, `test/timeline.test.js`

**Interfaces:**
- Produces: `export const MOMENTS` — tableau de 14 objets `{ year, icon, titre, recit, population, chezNous }` trié par année ; `export const YEAR_MIN = -250, YEAR_MAX = 2026`. Module **pur** (aucun import three) — testable en node.

- [ ] **Step 1 : test d'abord** — `test/timeline.test.js` : 14 moments ; années strictement croissantes de −250 à 2026 ; chaque moment a `titre` et `recit` non vides, `population > 0`, `icon` non vide ; le moment 1860 contient « quartier » dans son récit ; le moment 1889 contient « Eiffel ». `node --test` doit échouer (module absent).

- [ ] **Step 2 : implémenter `MOMENTS`** avec ces contenus exacts (récits validés en brainstorming, adaptés 4-5 ans ; `chezNous` = une phrase sur le quartier, affichée sous le récit) :

| # | year | icon | titre | population |
|---|---|---|---|---:|
| 1 | −250 | 🛖 | Lutèce des Parisii | 1 000 |
| 2 | 200 | 🏛️ | Lutèce la romaine | 10 000 |
| 3 | 885 | ⚔️ | Le siège des Vikings | 20 000 |
| 4 | 1200 | 🏰 | La muraille de Philippe Auguste | 50 000 |
| 5 | 1370 | 🛡️ | Charles V et la Bastille | 250 000 |
| 6 | 1670 | 🌳 | La ville ouverte | 500 000 |
| 7 | 1789 | 🔥 | La Révolution | 650 000 |
| 8 | 1860 | 🚂 | Ton quartier devient Paris | 1 700 000 |
| 9 | 1865 | 🏗️ | Haussmann transforme tout | 1 800 000 |
| 10 | 1889 | 🗼 | La Tour Eiffel | 2 300 000 |
| 11 | 1900 | 🚇 | Le métro | 2 700 000 |
| 12 | 1934 | 🌿 | La petite ceinture s'endort | 2 900 000 |
| 13 | 1973 | 🚗 | Le périphérique | 2 300 000 |
| 14 | 2026 | 🌍 | Ton Paris | 2 100 000 |

Récits (verbatim) :
1. « Il y a très très longtemps, Paris n'existe pas encore ! Une tribu gauloise, les Parisii, vit sur une petite île au milieu du fleuve. Autour, il n'y a que des forêts, des marais et des animaux sauvages. » / chezNous : « Chez toi ? Une grande forêt où courent les sangliers ! »
2. « Les Romains ont gagné la guerre et la ville s'appelle Lutèce. Ils construisent en pierre : un forum, des thermes pour se laver, et de grandes arènes pour les spectacles. » / « Chez toi, c'est toujours la pleine campagne. »
3. « Des Vikings remontent la Seine sur leurs drakkars pour attaquer Paris ! Les Parisiens se réfugient sur l'île, derrière les remparts, et résistent pendant des mois. La ville tiendra bon. » / « De chez toi, on verrait la fumée au loin… »
4. « Le roi Philippe Auguste construit une grande muraille tout autour de Paris, et un château fort : le Louvre. Sur l'île, on bâtit une cathédrale immense, Notre-Dame — le chantier durera presque 200 ans ! » / « Chez toi poussent des vignes et des moulins à vent. »
5. « Paris a tellement grandi qu'il déborde de la vieille muraille ! Le roi Charles V en construit une nouvelle, plus grande, gardée par une énorme forteresse à huit tours : la Bastille. » / « Ton quartier est un petit village, loin des remparts. »
6. « Louis XIV, le Roi-Soleil, se sent si fort qu'il fait démolir les remparts ! À leur place, on plante des arbres et on se promène : ce sont les Grands Boulevards. Paris devient une ville ouverte. » / « Ton village s'appelle Clignancourt, et on y cultive des champs. »
7. « C'est la Révolution ! Le peuple de Paris prend la Bastille, la prison du roi, puis la démonte pierre par pierre. Il n'en reste rien — aujourd'hui, c'est une place avec une colonne dorée. » / « Chez toi, on entend gronder Paris tout proche. »
8. « Paris avale d'un coup tous les villages qui l'entourent — et le tien aussi : ton quartier devient Paris ! Un petit train, la petite ceinture, fait le tour de la ville. Il passe tout près de chez toi. » / « Bienvenue à Paris, 18e arrondissement ! »
9. « Le baron Haussmann transforme tout : il perce de grandes avenues bien droites et construit des milliers d'immeubles en pierre claire, aux toits gris en zinc. C'est le Paris qu'on connaît aujourd'hui ! » / « Ta rue à toi sera percée quelques années plus tard. »
10. « Tu la vois depuis le début en fantôme… la voilà pour de vrai ! Gustave Eiffel construit la tour la plus haute du monde : 300 mètres ! Certains la trouvent affreuse — aujourd'hui, c'est la star de Paris. » / « De ta butte, on la voit briller à l'autre bout de la ville. »
11. « Paris creuse un train sous la terre : le métro ! La première ligne ouvre pour l'Exposition universelle. Bientôt, près de chez toi, il roulera même en l'air, sur un grand pont au-dessus du boulevard. » / « Ta station arrivera en 1912 : Porte de Saint-Ouen. »
12. « La petite ceinture s'arrête : plus personne ne prend le petit train, tout le monde préfère le métro. Les rails restent là, tout tranquilles, et petit à petit les herbes et les arbres poussent dessus. » / « Le petit train ne siffle plus au bout de ta rue. »
13. « Une rivière de voitures encercle Paris : le périphérique ! Il est construit pile là où se trouvait la dernière muraille. Il passe à deux pas de chez toi — écoute, on l'entend presque. » / « Ta maison est juste entre les rails endormis et le périph. »
14. « Voici ton Paris ! La petite ceinture est devenue un jardin sauvage, on replante des arbres partout, et au loin brillent les tours de La Défense. Deux mille ans d'histoire — et toi, tu habites dedans. » / « Et l'histoire continue avec toi. »

- [ ] **Step 3 : `npm test` → PASS**
- [ ] **Step 4 : commit** — `"Timeline : les 14 moments et leurs récits"`

---

### Task 3: Moteur temporel pur — `timeEngine.js` + tests (TDD complet)

**Files:**
- Create: `src/timeEngine.js`, `test/timeEngine.test.js`

**Interfaces:**
- Produces (module pur, sans three) :
  - `lifecycle(year, {born, buildYears=10, died=Infinity, razeYears=5})` → `{presence: 0..1, phase: 'absent'|'building'|'alive'|'razing'|'gone'}` — presence monte linéairement de 0→1 sur `[born, born+buildYears]`, redescend sur `[died, died+razeYears]`.
  - `momentBlend(year, anchors)` → `{i, j, t}` — indices des moments encadrants et fraction `t ∈ [0,1]` (clampé aux bornes).
  - `sliderToYear(u, anchors)` / `yearToSlider(year, anchors)` — chaque moment occupe une largeur égale de frise (1/(n−1)), interpolation linéaire par segment (échelle non linéaire du temps : indispensable, sinon 2 000 ans d'antiquité écrasent la frise).
  - `lerp(a,b,t)`, `smoothstep(t)`.

- [ ] **Step 1 : écrire les tests** — cas : `lifecycle(1000, {born:1190, buildYears:30})` → absent/0 ; `lifecycle(1205, …)` → building/0.5 ; `lifecycle(1500, …)` → alive/1 ; avec `died:1670, razeYears:10` : `lifecycle(1675,…)` → razing/0.5 ; `lifecycle(1700,…)` → gone/0. `momentBlend(1875, anchors)` → i=8 (1865), j=9 (1889), t≈0.4167. `sliderToYear(0)`→−250, `sliderToYear(1)`→2026, `yearToSlider(sliderToYear(0.37))`≈0.37 (aller-retour). Bornes clampées.
- [ ] **Step 2 : `npm test` → FAIL** (module absent)
- [ ] **Step 3 : implémenter** (≈50 lignes, fonctions pures)
- [ ] **Step 4 : `npm test` → PASS**
- [ ] **Step 5 : commit** — `"Moteur temporel : cycle de vie des objets et échelle non linéaire du slider"`

---

### Task 4: Géographie pure — `geography.js` + tests

**Files:**
- Create: `src/geography.js`, `test/geography.test.js`

**Interfaces:**
- Produces (module pur) :
  - `LANDMARKS` — la table des conventions (objet nommé → `{x,z}`).
  - `heightAt(x, z)` → altitude scène (0 = niveau Seine +1). Collines gaussiennes : Montmartre (centre (−50,−375), h=13, σ=60) — la plus haute ; Ste-Geneviève ((−26,+76), h=6, σ=50) ; Belleville ((+180,−280), h=10, σ=70) ; Chaillot ((−300,−90), h=6, σ=55) ; plaine légèrement bruitée (noise 2D maison, ±0.4), vallée de la Seine creusée le long du fleuve.
  - `SEINE_POINTS` — points de contrôle (x,z) du méandre : `(300,315),(215,170),(95,60),(30,15),(0,0),(−40,−15),(−95,−50),(−210,−140),(−361,−122),(−456,−31),(−520,33),(−586,292)` + boucle hors carte vers le NO (retour vers (−834,−433) La Défense, hors périph, atténué).
  - `ISLANDS` — Cité (ellipse centrée (0,0), 12×5), Saint-Louis ((+35,+8), 8×3), **Louviers ((+120,+18), 5×2, `died:1843`** — se soude à la rive droite : le bras nord se comble).
  - `urbanYear(x, z)` → année d'urbanisation de la cellule (déterministe, seedé) : île de la Cité = −250 ; rive gauche romaine (disque r=90 autour de (0,60)) = 100 ; croissance médiévale/moderne par distance au centre + bruit + biais directionnel (l'ouest et la rive droite poussent plus vite après 1600) ; les cellules entre les fortifs d'époque suivent les rayons des enceintes ; villages satellites (Montmartre (−50,−340)=1300, Clignancourt/chez nous=1780 pour le noyau villageois, comblement 1840-1900) ; au-delà du périph = jamais (Infinity), sauf le cluster La Défense (=1975).

- [ ] **Step 1 : tests** — `heightAt` à Montmartre > `heightAt` à Notre-Dame + 8 ; `urbanYear` à la Cité ≤ −250 ; aux Thermes ≤ 300 ; **chez nous ∈ [1750, 1900]** ; à (0, −900) (hors périph) = Infinity ; à La Défense ∈ [1960, 2000] ; déterminisme (deux appels = même valeur).
- [ ] **Step 2 : FAIL, Step 3 : implémenter, Step 4 : PASS**
- [ ] **Step 5 : commit** — `"Géographie : relief, Seine, îles, champ d'urbanisation"`

---

### Task 5: Terrain, Seine, forêts — première couche 3D

**Files:**
- Create: `src/layers/terrain.js`
- Modify: `src/main.js` (état + boucle de couches, cube supprimé)

**Interfaces:**
- Consumes: `geography.js`, `timeEngine.js`.
- Produces: `main.js` expose `state = { year: 2026, weather: 'sun', showLandmarks: true, reducedMotion: matchMedia(...).matches, time: 0 }` et le contrat `init(ctx)/update(dt,state)` ; couche terrain : sol (PlaneGeometry 256×256 segments, déplacé par `heightAt`, vertex colors vert forêt→beige urbain selon `urbanYear` vs `state.year`), ruban Seine (TubeGeometry aplati le long de CatmullRomCurve3(SEINE_POINTS), matériau animé — scroll de normales/opacité, reflets), îles (Louviers disparaît via `lifecycle` 1843), forêts = `InstancedMesh` de ~20 000 cônes/sphères low-poly semés là où `urbanYear > year` (re-échantillonnés par blocs quand l'année change — la déforestation qui recule est un des grands spectacles du zoom arrière), marais ponctuels près du fleuve avant l'an 1000.
- [ ] Step 1 : implémenter (boucle de couches dans main.js d'abord, slider clavier provisoire ←/→ pour tester l'année).
- [ ] Step 2 : build + Playwright : screenshots année −250 (tout forêt, île visible) vs 2026 (tapis urbain beige, plus de forêt intra-muros) ; console propre ; fps affiché en dev via compteur simple `console.log` toutes les 5 s > 55.
- [ ] Step 3 : commit — `"Terrain : relief, Seine animée, îles (Louviers 1843), forêts qui reculent"`

---

### Task 6: UI, caméra, frise — le squelette d'interface complet

**Files:**
- Create: `src/controls.js`, `src/ui.js`
- Modify: `src/index.template.html` (markup + CSS), `src/main.js`

**Interfaces:**
- Consumes: `timeline.js` (MOMENTS, icons), `timeEngine.js` (sliderToYear/yearToSlider).
- Produces:
  - `controls.js` : orbite maison (pas OrbitControls — on veut le tuning enfant) : 1 doigt/clic-gauche = orbiter, 2 doigts pinch = zoom, 2 doigts drag/clic-droit = pan, molette = zoom ; inertie douce ; limites (pas sous le sol, pas au-delà de 2× le périph) ; `flyTo(preset, durée)` avec easing. Presets : `ensemble` (haut SO, tout Paris), `cite`, `chezNous`, `eiffel`.
  - `ui.js` : la **frise** en bas (gradient de fond, 14 icônes cliquables → `flyToYear` animé sur ~2 s, poignée draggable, année courante en gros Fredoka), boutons ronds (🏠 vues, 🔊 voix, 🔈 sons, 📍 repères, ☀️ météo cycle, ⚙️ qualité), zone carte-récit (vide pour l'instant). Esthétique famille volcan : verre dépoli (`backdrop-filter`), gros touch targets ≥ 48 px, palette chaude sur fond nuit.
  - Événements : `ui.js` émet sur un petit event bus (`export const bus = new EventTarget()`) : `yearchange`, `weatherchange`, `preset`, etc. `main.js` écoute et mute `state`.
- [ ] Step 1 : implémenter markup+CSS+modules ; Step 2 : Playwright — drag de la poignée change l'année (screenshot avant/après), tap icône 🗼 anime vers 1889, presets volent ; tester au trackpad ET simuler tactile (`browser_run_code_unsafe` avec TouchEvents) ; Step 3 : commit — `"UI : frise temporelle, orbite tactile maison, vues prédéfinies"`

---

### Task 7: Bâtiments procéduraux (statique 2026) — archétypes + instancing + LOD

**Files:**
- Create: `src/layers/buildings.js`, `src/archetypes.js`

**Interfaces:**
- Consumes: `geography.urbanYear`, conventions.
- Produces: `archetypes.js` : ~22 géométries BufferGeometry low-poly construites en code, groupées par famille : `gaulois` (huttes rondes toit chaume ×2), `romain` (domus, insula, temple ×3), `medieval` (colombages pignon sur rue ×4, hauteurs 2-4), `classique` (hôtels 17-18e, toits mansardés ×4), `haussmann` (immeubles 6 étages, toit zinc 45°, balcons filants ×5), `moderne` (barres/tours 60-70s ×2, verre contemporain ×2). Chaque famille : palette de 4 teintes (variation par instance via `setColorAt`).
  `buildings.js` : grille de cellules 8×8 unités (80 m) ; chaque cellule urbanisée reçoit 4-10 bâtiments (position/rotation/échelle seedées) de la famille correspondant à `urbanYear` de la cellule ; **re-clad haussmannien** : cellules avec `urbanYear < 1850` et distance au centre < rayon Thiers passent en famille haussmann entre 1853 et 1880 (le « re-skinning » du prompt londonien). Un `InstancedMesh` par (famille×archétype), budget total ~40 000 instances. LOD : au-delà de 350 unités de caméra, cellules remplacées par des boîtes fusionnées teintées (une géométrie mergée par macro-quartier de 64×64) — bascule en fondu.
- [ ] Step 1 : implémenter pour `year=2026` fixe ; Step 2 : Playwright — vol d'ensemble (masses distinctes : centre haussmannien clair/zinc, faubourgs mixtes) + zoom toits (balcons visibles) ; perf : rester > 55 fps laptop en orbite ; Step 3 : commit — `"Bâtiments : 22 archétypes, instancing massif, LOD quartiers"`

---

### Task 8: Les bâtiments dans le temps — croissance, familles par époque, Haussmann

**Files:**
- Modify: `src/layers/buildings.js`

**Interfaces:**
- Consumes: `timeEngine.lifecycle`.
- Produces: chaque instance a `born = urbanYear(cellule) + jitter(0..40 ans)`, `buildYears = 8` ; `update` recalcule les matrices des instances dont la presence a changé (dirty-tracking par plage d'années : trier les instances par `born`, ne toucher que la fenêtre concernée) ; animation de croissance = scale Y 0→1 + léger overshoot (les bâtiments **poussent depuis leurs fondations**) ; le re-clad 1853-1880 fait pousser le haussmannien pendant que l'ancien rétrécit (crossgrow, pas crossfade) ; scrubbing arrière = démolition inverse. Villages satellites (Montmartre, Clignancourt) apparaissent dès leur `urbanYear` de noyau, isolés dans les champs — **crucial pour le récit « chez nous »**.
- [ ] Step 1 : implémenter ; Step 2 : Playwright — screenshots à −250/200/1200/1670/1865/2026 : l'emprise urbaine doit croître de façon spectaculaire et crédible ; scrub rapide aller-retour sans instance orpheline (vérifier visuellement + compter les instances visibles à year=−250 ≈ seulement la Cité) ; Step 3 : commit — `"Le temps fait pousser la ville : croissance, villages, re-clad Haussmann"`

---

### Task 9: Murailles — 4 enceintes qui s'assemblent et s'effondrent

**Files:**
- Create: `src/layers/walls.js`

**Interfaces:**
- Consumes: `timeEngine.lifecycle`, conventions (polygones ci-dessous).
- Produces: un builder `wallRing(points, {h, towerEvery, gates})` → segments de courtine + tours rondes instanciées + portes ; construction = segments qui montent un à un le long du périmètre (progression = presence × longueur totale, effet « pierre par pierre ») ; démolition = affaissement + poussière (petites particules).
  Les 4 enceintes :
  1. **Rempart gallo-romain de l'île** : ovale autour de la Cité, `born:308, buildYears:8, died:1190` (absorbé).
  2. **Philippe Auguste** : octogone irrégulier rive droite (−95,−55)(−60,−105)(20,−110)(75,−45) + rive gauche (55,45)(0,80)(−45,60)(−80,0), `born:1190, buildYears:30, died:1670, razeYears:40` (grignoté).
  3. **Charles V** (rive droite seulement) : (−110,−60)(−70,−160)(95,−150)(141,−5), avec la **Bastille** à (141,−5) : forteresse 8 tours modélisée à part dans ce module, `born:1370, buildYears:12, died:1789, razeYears:2` (démontage rapide et théâtral, gravats) ; le mur : `born:1356, buildYears:27, died:1670, razeYears:30` → remplacé par une double rangée d'arbres (Grands Boulevards, instancing) `born:1670`.
  4. **Thiers** : l'ellipse périph, `born:1841, buildYears:4, died:1919, razeYears:10` — le périphérique (Task 11) prendra sa place.
- [ ] Step 1 : implémenter ; Step 2 : Playwright — 1200 : muraille PA complète, Louvre-coin ; 1400 : les deux enceintes + Bastille ; 1700 : boulevards plantés à la place ; 1789 : scrub sur la démolition de la Bastille ; 1850 : anneau de Thiers complet ; Step 3 : commit — `"Murailles : quatre enceintes, la Bastille, les Grands Boulevards"`

---

### Task 10: Monuments — les ancres persistantes (partie 1 : antiquité → 1789)

**Files:**
- Create: `src/layers/monuments.js`, `src/monumentModels.js`

**Interfaces:**
- Consumes: `timeEngine.lifecycle`, LANDMARKS.
- Produces: `monumentModels.js` : constructeurs de géométries à la main (Group de primitives, ~80-200 triangles chacun, silhouette avant tout) ; `monuments.js` : registre `{ id, x, z, états: [{model, born, buildYears, died, razeYears}], label, phrase }` (label/phrase = pour le clic, Task 15). Monuments avec **états successifs au même emplacement** (la continuité du prompt londonien) :
  - **Notre-Dame** (0,0) : temple gallo-romain (`born:150, died:540`) → basilique St-Étienne (`born:540, died:1163`) → cathédrale gothique en chantier avec 2 grues médiévales en bois qui tournent (`born:1163, buildYears:180` — les tours émergent en dernier) → flèche Viollet-le-Duc ajoutée (`born:1859`) → flèche retirée (`died:2019, razeYears:0.2`) + échafaudage → flèche restaurée (`born:2024, buildYears:1`).
  - **Louvre** (−90,−84) : forteresse donjon (`born:1190, died:1546, razeYears:20`) → palais ailes Renaissance/classique (`born:1546, buildYears:120`) → pyramide de verre (`born:1988, buildYears:2`).
  - **Arènes de Lutèce** (+22,+89) : `born:80, buildYears:20, died:300, razeYears:80` (ensevelies) → réapparaissent en square (`born:1896`).
  - **Thermes de Cluny** (−43,+28) : `born:200, died:300` (ruine partielle qui reste, teinte sombre).
  - **Forum romain** (−30,+55) : `born:100, died:500`.
  - **Pont au Change + moulins à eau** : pont couvert de maisons entre Cité et rive droite, 4 roues à aubes qui tournent dans le courant, `born:1100, died:1786, razeYears:5` (maisons retirées) — signature de mouvement médiévale.
  - **Sainte-Chapelle** (−5,−3) : flèche fine dorée, `born:1242, buildYears:6`.
  - **Panthéon** (−26,+76) : `born:1758, buildYears:32`.
  - **Invalides** (−230,−20) : dôme doré, `born:1671, buildYears:35`.
- [ ] Step 1 : modèles + registre ; Step 2 : Playwright — zooms sur chaque monument à son apogée + scrub Notre-Dame 1150→1350 (chantier + grues) ; silhouettes reconnaissables au premier regard ; Step 3 : commit — `"Monuments 1 : Notre-Dame en chantier, Louvre, arènes, pont aux moulins"`

---

### Task 11: Monuments 2 (Eiffel étage par étage, Sacré-Cœur, La Défense) + rails (petite ceinture, métro, périph)

**Files:**
- Create: `src/layers/rails.js`
- Modify: `src/monumentModels.js`, `src/layers/monuments.js`

**Interfaces:**
- Consumes: conventions (ellipses, viaduc), `timeEngine`.
- Produces:
  - **Tour Eiffel** (−406,−60) : modèle 4 états empilés (piliers+arche / 1er étage / 2e étage / flèche+antenne), `born:1887, buildYears:2.3` avec progression **par étage** (presence 0-0.25-0.5-0.75-1 → étages qui apparaissent successivement, pas un scale global) ; scintillement doré la nuit après 2000 (points lumineux instanciés, 5 s par minute de `state.time`).
  - **Sacré-Cœur** (−50,−375) : dômes blancs, `born:1875, buildYears:39` — pousse sous les yeux du quartier de Raphaël.
  - **Opéra Garnier** (−135,−135) : `born:1861, buildYears:14`. **Tour Montparnasse** (−120,+95) : `born:1969, buildYears:4`. **La Défense** (−834,−433) : cluster de 8 tours, `born:1970..2010` étalés, + Grande Arche `born:1985, buildYears:4`.
  - `rails.js` : **petite ceinture** = anneau (ellipse conventions) : remblai + rails, `born:1852, buildYears:17` (l'anneau se referme segment par segment) ; **3 trains à vapeur** (loco + 3 wagons, panache de fumée = sprites) circulant sur la courbe de 1869 à 1934 ; après 1934 : trains disparus, rails ternis, végétation instanciée qui colonise progressivement (density = lifecycle(year,{born:1940,buildYears:60})) → coulée verte. **Viaduc de Barbès** : segment aérien (−20,−338)→(+120,−348) sur piliers riveté, `born:1903, buildYears:2`, rames vertes puis bleues qui passent. **Périphérique** : ruban gris double sur l'ellipse Thiers, `born:1958, buildYears:15` (se coule tronçon par tronçon), flux de ~300 voitures instanciées bicolores, phares la nuit.
- [ ] Step 1 : implémenter ; Step 2 : Playwright — scrub 1887→1890 (la tour pousse étage par étage) ; 1900 vue chezNous : la petite ceinture fume au bout de la rue ; 1950 : rails verdis ; 1980 : périph coule autour, **chez nous bien encadré PC/périph** ; Step 3 : commit — `"Monuments 2 et rails : la Tour étage par étage, la petite ceinture vit et s'endort, le périph"`

---

### Task 12: Les repères fantômes — Tour Eiffel translucide et balise « chez nous »

**Files:**
- Create: `src/layers/ghosts.js`

**Interfaces:**
- Consumes: modèle Eiffel (état final) de `monumentModels.js`, LANDMARKS, `bus`.
- Produces: **Eiffel fantôme** : le modèle complet en matériau `transparent, opacity 0.18, additive`, teinte or pâle, shimmer (opacité oscillante douce), visible de −250 à 1887 ; à 1887-1889, le fantôme s'éteint pendant que la vraie pousse ; **célébration 1889** : gerbe de particules dorées + la carte-récit du moment 10. **Balise chez nous** : colonne de lumière verticale fine (cylindre additive, hauteur 40) + icône 🏠 en sprite au sommet, pulsation douce, halo au sol ; **célébration 1860** : anneau de lumière qui se propage depuis la balise quand on franchit 1860 (dans les deux sens du scrub, throttlé). Bouton 📍 (`bus` event `landmarks`) montre/masque les deux. `reducedMotion` : pas de shimmer ni de célébrations, repères statiques.
- [ ] Step 1 : implémenter ; Step 2 : Playwright — année 300 : silhouette dorée au-dessus des champs + colonne chez nous au-dessus de la forêt (screenshot déjà magique — c'est LE plan signature du projet) ; scrub 1888 : bascule fantôme→réel ; toggle 📍 ; Step 3 : commit — `"Repères fantômes : la promesse de la Tour, la balise chez nous"`

---

### Task 13: La vie — bateaux, foules, oiseaux, vignettes

**Files:**
- Create: `src/layers/life.js`

**Interfaces:**
- Consumes: courbe Seine, `momentBlend`, quality.
- Produces: **Bateaux** sur la Seine (suivent la courbe, `t` animé, orientés tangente), flotte par période : pirogues (−250..0), galères/gabarres romaines (0..500), drakkars (860..920 **uniquement** — signature du siège), barques+moulins flottants (900..1700), coches d'eau et bateaux-lavoirs (1700..1900), péniches (1850..), bateaux-mouches vitrés (1950..). Crossfade de flottes par `momentBlend`. **Foules** : InstancedMesh de silhouettes low-poly (2 triangles + tête) sur les berges/places/marchés, palette costume par époque (bure médiévale, redingotes, jeans), densité ∝ population du moment × quality ; marche lente en boucle sur mini-chemins. **Oiseaux** : 3 vols en Lissajous au-dessus de la ville, toutes époques (la continuité). **Vignettes** (2 par moment, découvrables en zoomant, simple mise en scène d'instances) — liste exacte : 1: sanglier près des huttes / pêcheur sur pirogue ; 2: file au forum / gladiateurs aux arènes ; 3: drakkars alignés bras nord / défenseurs sur le rempart ; 4: grues de Notre-Dame qui tournent / marché sur le pont ; 5: garde à la Bastille / moutons hors les murs ; 6: promeneurs sur les boulevards / carrosse au Louvre ; 7: foule dense autour de la Bastille / fumées ; 8: premier train qui inaugure la PC (fanions) / famille qui regarde passer ; 9: chantiers haussmanniens (échafaudages) / omnibus à chevaux ; 10: foule au pied de la Tour / photographe à trépied ; 11: file à la bouche de métro Art nouveau / rame sur le viaduc ; 12: enfants qui jouent sur les rails morts / chat sur le remblai ; 13: bouchon sur le périph (phares) / déménagement en camion ; 14: joggeurs sur la coulée verte / famille qui montre la Tour (= vous).
- [ ] Step 1 : implémenter ; Step 2 : Playwright — 885 : drakkars devant l'île ; 1865 : berges peuplées ; zooms sur 3 vignettes ; fps > 55 laptop ; Step 3 : commit — `"La vie : flottes d'époque, foules, oiseaux, 28 vignettes"`

---

### Task 14: Lumière — signatures d'époque × météo (4 modes)

**Files:**
- Create: `src/layers/weather.js`

**Interfaces:**
- Consumes: `momentBlend`, `bus` (`weatherchange`).
- Produces: rig lumière unique (hemi + directionnelle + fog + fond dégradé ciel en shader ou grand dôme vertex-color) piloté par `blend(signatureMoment, météo)`. **Signatures par moment** (fond ciel haut/bas, brouillard, direction/couleur soleil, ton) : 1 brume verte matinale ; 2 midi clair ; 3 **nuit orange** (feux du siège : point-lights ambrées sur les berges, ciel brun-rouge — lisible) ; 4 aube dorée ; 5 après-midi bleu ; 6 fin d'après-midi dorée ; 7 ciel dramatique gris-rouge ; 8 matin clair ; 9 **gaslight** : crépuscule + becs de gaz ambrés le long des percées ; 10 grand beau + drapeaux ; 11 Belle Époque scintillante (guirlandes de l'Expo) ; 12 automne brumeux doux ; 13 gris 70s légèrement smoggy ; 14 crépuscule contemporain, la ville s'allume fenêtre par fenêtre (instances émissives progressives). **Météo** (modulateur choisi par l'utilisateur, défaut `auto` = signature pure) : ☀️ force un soleil franc ; ☁️ désature, ciel bas, ombres douces ; 🌧️ + **pluie** : 8 000 streaks instanciés dans un cylindre suivant la caméra, sol/toits assombris-brillants (roughness down), Seine piquetée ; 🌙 nuit **lisible** : ciel `#1a2550`, lune, fenêtres allumées à toutes les époques post-médiévales (bougies→gaz→électrique selon l'année), jamais < 25 % de luminosité perçue. Transitions météo en 1,5 s ; signature suit le scrub en continu.
- [ ] Step 1 : implémenter ; Step 2 : Playwright — grille de screenshots : (moments 3, 9, 14) × (sun, rain, night) = 9 images, toutes lisibles ; le 885-nuit doit être le plus spectaculaire ; Step 3 : commit — `"Lumière : 14 signatures d'époque, météo soleil/couvert/pluie/nuit"`

---

### Task 15: Narration — cartes-récits, voix, monuments cliquables, compteur d'habitants

**Files:**
- Create: `src/narration.js`
- Modify: `src/ui.js` (zone carte), `src/layers/monuments.js` (raycast targets)

**Interfaces:**
- Consumes: `MOMENTS`, `bus`, registre monuments (`label`, `phrase`).
- Produces: **Carte-récit** : quand `year` entre dans ±8 ans d'une ancre (et une fois par franchissement), la carte glisse en bas-gauche : année géante Fredoka, titre, `recit`, ligne `chezNous` avec 🏠, bouton 🔊 ; se replie en pastille après 12 s ou au tap. **Voix** : `speechSynthesis`, `lang='fr-FR'` (préférer une voix `fr` locale), débit 0.95 ; bouton global 🔊 (off par défaut) : quand actif, lecture auto des cartes ; toujours dispo carte par carte. **Monuments cliquables** : raycast sur tap court (< 200 ms, pas un drag) → étiquette flottante (nom + 1 phrase du registre) + lecture si voix active ; bouton « ✨ Montrer les zones » fait pulser 3 s des halos sur tous les monuments présents à l'année courante. **Compteur d'habitants** : pastille discrète haut-droite « ≈ 1 700 000 habitants », interpolé log entre ancres, formaté français (`toLocaleString('fr-FR')`), petit tick d'animation quand l'ordre de grandeur change.
- [ ] Step 1 : implémenter ; Step 2 : Playwright — arrivée sur 1860 → carte avec la ligne chezNous ; clic Notre-Dame → étiquette ; « Montrer les zones » → halos (screenshot) ; compteur à 1370 ≈ 250 000 ; TTS : vérifier `speechSynthesis.getVoices()` non vide et pas d'erreur console (le son lui-même = test manuel utilisateur) ; Step 3 : commit — `"Narration : cartes-récits, voix française, monuments cliquables, compteur"`

---

### Task 16: Bouton Lecture ▶️ — le voyage automatique

**Files:**
- Modify: `src/ui.js`, `src/main.js`

**Interfaces:**
- Consumes: `sliderToYear`, cartes (Task 15), `bus`.
- Produces: bouton ▶️ proéminent à gauche de la frise. En lecture : `u` (position slider 0→1) avance à vitesse constante (≈ 105 s au total en « normal » ; molette ×0.5 / ×1 / ×2 affichée autour du bouton) ; **pause de 4 s à chaque ancre** pendant que la carte-récit s'affiche (avec voix si active) ; la caméra, si l'utilisateur n'y a pas touché depuis 10 s, dérive lentement en orbite cinématique (sinon elle lui obéit — reprendre la main ne quitte PAS la lecture) ; tap sur ▶️/⏸ ou drag du slider = pause ; fin → petit bouquet sur 2026 puis retour au bouton ▶️. `reducedMotion` : pas de dérive caméra.
- [ ] Step 1 : implémenter ; Step 2 : Playwright — lancer, vérifier passage de 3 ancres avec cartes (attentes temporisées), pause au tap, vitesse ×2 ; Step 3 : commit — `"Lecture : 2 300 ans en deux minutes, caméra cinématique"`

---

### Task 17: Sons d'ambiance procéduraux (Web Audio)

**Files:**
- Create: `src/audio.js`

**Interfaces:**
- Consumes: `momentBlend`, `state.weather`, `bus` (`soundtoggle`).
- Produces: AudioContext créé **au premier geste** (contrainte autoplay), master gain 0 par défaut, bouton 🔈 → fade 0.8 s. Bus par « nappe », crossfadées par `momentBlend` comme la lumière. Recettes 100 % synthèse (aucun fichier) :
  - **Nature** (forte aux moments 1-2, résiduelle ensuite) : oiseaux = blips sinus 2-4 kHz, enveloppes 60 ms, motifs aléatoires espacés ; rivière = bruit blanc → lowpass 400 Hz + modulation lente du gain.
  - **Cloches** (4-9, apogée médiévale) : sinus + partiels inharmoniques (f×2.76, ×5.4), decay 4 s, une volée aléatoire toutes les 20-40 s.
  - **Foule** (proportionnelle à la population) : bruit rose → bandpass 300-800 Hz, murmures modulés.
  - **Siège 885** : crépitement de feu = bruit → highpass + bursts d'enveloppe rapides, tambour sourd lointain (sinus 60 Hz, coups espacés).
  - **Vapeur PC (1869-1934)** : chuff rythmé = bursts de bruit filtré passe-bande 200-600 Hz à 2 Hz qui accélèrent, sifflet = deux sinus 620+930 Hz, 1×/45 s, gain lié à la distance caméra↔anneau PC.
  - **Circulation (1950+)** : bruit brun → lowpass 250 Hz, rumeur continue, klaxon rare (sawtooth 400 Hz, 150 ms) ; + intensité près du périph après 1973.
  - **Pluie** (si météo 🌧️) : bruit blanc → shelf, crépitement par grains.
  - Le tout plafonné, doux, jamais agressif ; `reducedMotion` n'affecte pas le son (choix : le son reste).
- [ ] Step 1 : implémenter ; Step 2 : vérif — console sans erreur, `ctx.state === 'running'` après geste, analyser node confirme un signal non nul à 885 et 2026 (assertions via `browser_run_code_unsafe`) ; écoute réelle = validation utilisateur ; Step 3 : commit — `"Sons : paysages sonores synthétisés par époque, pluie, vapeur de la petite ceinture"`

---

### Task 18: Qualité, LOD final, perf iPad, reduced-motion

**Files:**
- Create: `src/quality.js`
- Modify: `src/main.js`, couches concernées (budgets)

**Interfaces:**
- Produces: 3 tiers (`haut`/`moyen`/`léger`) exposés dans `ctx.quality` = multiplicateurs `{ crowds, trees, rain, boats, shadows }` ; **auto par défaut** : moyenne glissante du frame time sur 4 s → downgrade si > 22 ms, upgrade prudent si < 12 ms pendant 30 s ; sélecteur manuel dans ⚙️. Ordre de sacrifice (spec) : foules → végétation → pluie/reflets → ombres ; **jamais** les monuments, murailles, repères ni la fluidité du scrub. Ombres : une seule directionnelle shadow-map 2048 (tier haut), 1024 (moyen), off (léger). Vérifier le streaming d'époques : les InstancedMesh des familles hors fenêtre `[year−400, year+400]` passent `visible=false` et libèrent leurs updates. `prefers-reduced-motion` : déjà branché par couche — audit final ici.
- [ ] Step 1 : implémenter + audit ; Step 2 : mesures — laptop : orbite à 1865 et scrub complet, frame time moyen < 16 ms (log console) ; simuler tier léger et vérifier la dégradation propre (screenshot) ; noter dans le rapport que le test iPad M1 réel revient à l'utilisateur ; Step 3 : commit — `"Qualité auto : trois tiers, sacrifices dans l'ordre, monuments intouchables"`

---

### Task 19: Passe finale — vérification complète, README, livraison

**Files:**
- Create: `README.md`
- Modify: au fil des corrections

- [ ] **Step 1 : la grande traversée** — Playwright sur `http://localhost:8123/` : screenshot de **chacun des 14 moments** (vue ensemble) + 4 presets + 4 météos + une lecture ▶️ complète en ×2 ; console **zéro erreur** sur tout le parcours ; scrub violent aller-retour ×5 : aucun objet orphelin, aucune fuite (heap stable via `browser_run_code_unsafe` → `performance.memory` avant/après).
- [ ] **Step 2 : revue fraîcheur spec** — relire la spec section par section et cocher chaque exigence contre l'implémentation (les 14 moments distincts, repères, météo×époque, lecture, sons, narration, compteur, YAGNI respecté). Corriger ce qui manque.
- [ ] **Step 3 : README.md** — en français, pour la famille : lancer `./serve.sh` puis ouvrir `http://localhost:8123/` (ou visiter la page GitHub Pages), les contrôles (doigts/souris), les boutons, « aucune installation nécessaire, npm seulement pour les tests ». Une ligne d'avertissement charmante : « La géographie est fidèle, les dates sont vraies, les maisons sont inventées. »
- [ ] **Step 4 : commit final** — `"Paris, deux mille ans — v1 pour Raphaël 🗼"` — et message à l'utilisateur : rappeler le garde-fou (« dis-moi si c'est trop fouillé, on élague »), demander le test iPad M1 réel et l'écoute des sons/voix.

---

## Self-review du plan (fait à l'écriture)

- **Couverture spec :** 14 moments ✓ (T2) ; scène/géographie/relief/îles dont Louviers ✓ (T4-T5) ; caméra+presets+tactile ✓ (T6) ; densité bâtie + re-clad ✓ (T7-T8) ; enceintes+Bastille+boulevards ✓ (T9) ; ancres Notre-Dame/Louvre + monuments ✓ (T10-T11) ; PC/métro/périph ✓ (T11) ; repères fantômes + célébrations 1860/1889 + toggle ✓ (T12) ; flottes/foules/oiseaux/vignettes ✓ (T13) ; signatures lumière + météo 4 modes nuit lisible ✓ (T14) ; cartes/TTS off par défaut/clic monuments/« montrer les zones »/compteur ✓ (T15) ; Lecture + vitesses ✓ (T16) ; sons procéduraux off par défaut ✓ (T17) ; instancing/LOD/streaming/dpr/qualité/reduced-motion/60fps ✓ (T7, T18) ; servi via serveur local/GitHub Pages, modules séparés sans bundling, three vendorisé ✓ (T1, amendement utilisateur du 2026-08-04) ; YAGNI ✓.
- **Placeholders :** aucun TBD ; les contenus (textes, coordonnées, années, recettes audio, vignettes) sont dans le plan.
- **Cohérence des noms :** `init(ctx)/update(dt,state)`, `state{year,weather,showLandmarks,reducedMotion,time}`, `bus`, `lifecycle/momentBlend/sliderToYear/yearToSlider`, `heightAt/urbanYear/SEINE_POINTS/LANDMARKS/ISLANDS`, `MOMENTS` — utilisés uniformément dans toutes les tâches.
