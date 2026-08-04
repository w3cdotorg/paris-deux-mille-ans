# « Paris, deux mille ans » 🗼 — spec de design

**Date :** 2026-08-04
**Projet :** visualisation 3D navigable de l'évolution de Paris, de Lutèce à aujourd'hui,
à explorer ensemble (Raphaël aux commandes, un parent qui lit et commente).
**Références :**
- Vidéo « PARIS – 3D TIMELAPSE – 300 BCE to 2025 » (YouTube, IFhKB5zHWFg) — le souffle,
  mais il lui manque des points de repère.
- Prompt « One Riverbank, Two Thousand Years » (petergpt/3d-prompt-collection, #04) —
  le mécanisme : une seule scène vivante que le temps morphe, pilotée par un grand slider.
- `../raphael_volcan` et `../raphael_corps_humain` — l'ADN familial : français, narration
  à voix haute, gros boutons, science prise au sérieux.

## Objectif

Une expérience Three.js dans un dossier autonome (`index.html` + Three.js embarqué),
hors ligne, où l'on survole un Paris 3D dense et vivant et où un **grand slider
temporel** fait couler 2 300 ans d'histoire sur une géographie constante. L'ambition
visuelle est celle du prompt londonien (option « B » validée) ; si le résultat est trop
fouillé visuellement, on élaguera après un premier essai (garde-fou explicite).

## La scène et la géographie (les constantes)

- La **Seine** avec son méandre réel, l'**île de la Cité**, l'**île Saint-Louis**,
  et l'île Louviers qui se soude à la rive droite vers 1843.
- Relief honnête : **butte Montmartre** (avec le futur quartier de Raphaël à ses pieds,
  côté nord), **montagne Sainte-Geneviève**, Belleville, Chaillot.
- Emprise : le Paris intra-muros actuel jusqu'au périphérique, entouré de campagne —
  pour que l'expansion soit mesurable à l'œil : Lutèce est un point minuscule au
  centre d'un immense paysage de forêts et de marais.
- Orientation et proportions réelles (approximées de connaissance, aucune donnée
  téléchargée).

**Caméra :** vue orbitale « dieu » par défaut, zoom continu jusqu'au niveau des toits.
Un doigt = orbiter, deux doigts = zoom/pan ; souris classique. **Vues prédéfinies** :
vue d'ensemble, île de la Cité, chez nous, Tour Eiffel.

**Esthétique :** réaliste-dense — milliers de bâtiments instanciés, footprints crédibles
par quartier et par époque (chaume gaulois, colombages médiévaux, toits de zinc
haussmanniens), monuments modélisés à la main en version simplifiée mais reconnaissable.
Chaque époque a sa **signature de lumière** (brume verte gauloise, midi romain, nuit
orange du siège viking, gaslight haussmannien, Belle Époque scintillante, crépuscule
contemporain qui s'allume fenêtre par fenêtre).

## Météo

Sélecteur météo indépendant du temps historique : ☀️ ensoleillé, ☁️ couvert,
🌧️ pluvieux (particules + reflets mouillés sur toits et Seine), 🌙 nuit — une nuit
**lisible** : ciel bleu profond, fenêtres allumées, lune généreuse, jamais noir.
La signature lumineuse de l'époque est le réglage d'arrivée par défaut ; la météo la
module ensuite.

## Le slider temporel — 14 moments

Grande frise en bas d'écran, une icône par moment. Toucher une icône = voyage animé ;
glisser librement = interpolation continue entre les états.

1. **~250 av. J.-C.** — Lutèce gauloise : village des Parisii sur l'île, forêts partout.
2. **~200** — Lutèce gallo-romaine : forum, arènes, thermes sur la rive gauche.
3. **885** — Le siège des Vikings : drakkars, ville réfugiée sur son île fortifiée, feux.
4. **~1200** — Philippe Auguste : la muraille, le Louvre-forteresse, Notre-Dame en chantier.
5. **~1370** — Charles V : nouvelle enceinte rive droite, la Bastille.
6. **~1670** — Louis XIV abat les remparts : ville ouverte, Grands Boulevards.
7. **1789** — Révolution : prise puis démolition de la Bastille.
8. **1860** — Annexion des communes : **le quartier de Raphaël devient Paris** 🏠,
   enceinte de Thiers (achevée en 1844, elle dessine le nouveau périmètre),
   **la petite ceinture arrive** 🚂 (construite 1852-1869).
9. **~1865** — Haussmann : grandes percées, immeubles de pierre à toits de zinc.
10. **1889** — La Tour Eiffel : le fantôme devient réel, construction étage par étage.
11. **1900** — Le métro 🚇 (ligne 1) + Exposition universelle ; le viaduc aérien
    de Barbès suit en 1903.
12. **1934** — La petite ceinture ferme : les trains disparaissent, la nature commence
    à reprendre les rails.
13. **1973** — Le périphérique, coulé comme un ruban sur l'ancienne enceinte de Thiers.
14. **2026** — Aujourd'hui : petite ceinture en coulée verte, Grand Paris, La Défense
    à l'horizon.

## Bouton Lecture ▶️

Le temps s'écoule tout seul (~2 min pour l'ensemble), le slider avance, chaque moment
déclenche sa carte-récit au passage. Pause en touchant l'écran ou le bouton ; reprise
de la main sur le slider sans quitter le mode. Molette de vitesse (lent / normal /
rapide).

## Les transformations sont le spectacle

Pas de fondu-enchaîné : les bâtiments **poussent depuis leurs fondations**, les
murailles s'assemblent puis s'effondrent, la Bastille se démonte en 1789, la Tour
Eiffel se construit étage par étage, les rails se posent puis verdissent, le
périphérique coule en ruban. Scrubber d'avant en arrière rejoue les métamorphoses.

**Moteur des époques :** chaque bâtiment/muraille/rail appartient à un calque temporel
(année de naissance, année de mort, animation de construction/démolition). Le slider
pilote une seule valeur `annee` ; tout en découle — aucun état incohérent possible.

**Ancres persistantes** (la continuité fait la magie) :
- **Notre-Dame** : temple gallo-romain → basilique → cathédrale en chantier (grues
  médiévales) → flèche de Viollet-le-Duc → incendie 2019 → restauration 2024.
- **Le Louvre** : forteresse → palais → pyramide.
- La **Seine** coule toujours, bateaux de la bonne époque (pirogues, drakkars,
  gabarres, bateaux-lavoirs, péniches, bateaux-mouches).
- Les oiseaux traversent toutes les époques.

**Chaque moment est vivant** : foules en costume, signatures de mouvement (rames,
roues à eau des moulins du pont, fumées des locomotives, wagons du métro aérien,
circulation sur le périph), et 2-3 **vignettes à découvrir en zoomant** par époque.

## Les repères (le cœur de la demande)

- 🗼 **Tour Eiffel fantôme** : silhouette translucide scintillante à son emplacement
  exact dès Lutèce ; en 1889 le fantôme **devient réel** (célébration visuelle).
  Plus de fantôme ensuite.
- 🏠 **« Chez nous »** : balise lumineuse au croisement **rue Leibniz × rue Jean
  Dollfus** (18e, porte de Saint-Ouen), visible à toutes les époques — forêts, puis
  carrières et moulins de Montmartre, village hors-les-murs, entrée dans Paris en 1860
  (fanfare visuelle), la petite ceinture au bout de la rue, le périphérique à deux pas.
- Bouton « Repères » pour les masquer/afficher.

## Pédagogie et narration

- **Carte-récit** à chaque moment : grand titre, année en gros, 2-3 phrases en français
  simple (adapté 4-5 ans, sans niaiserie), bouton 🔊 lecture à voix haute
  (`speechSynthesis` française, **coupée par défaut**). Les cartes tissent le fil
  rouge du quartier : « Regarde, chez toi, c'est encore la campagne ! »
- **Monuments cliquables** : ~10 par époque → étiquette + une phrase + voix.
  Bouton « Montrer les zones » (tout ce qui est cliquable pulse).
- **Compteur d'habitants** discret qui évolue avec le slider (~8 000 → 2,1 millions).

## Sons d'ambiance (Web Audio, 100 % procédural)

Synthétisés en code, aucun fichier audio : oiseaux et rivière (Lutèce), cloches
médiévales, brouhaha de foule, sifflet et halètement des locomotives, crépitement de
pluie (si météo pluvieuse), rumeur de circulation moderne. Paysages sonores en
fondu-enchaîné avec le slider. **Coupés par défaut**, gros bouton 🔈.

## Technique

- Dossier `raphael_paris/` : `index.html` (app entière) + `vendor/three.module.js`
  et addons nécessaires, **version épinglée, embarquée localement** via import map —
  hors ligne pour toujours.
- Tout procédural : aucune image, aucun modèle externe, aucune donnée téléchargée.
- Google Fonts (Fredoka / Baloo 2) avec repli système, comme le volcan.

## Performance

Cible principale : **ordinateur portable, 60 fps**. Second appareil de référence :
**iPad M1** (~40 fps et plus). Les moyens :
- **Instancing massif** : bâtiments = instances de ~20 archétypes par époque
  (variations de teinte/hauteur par instance) ; foules, arbres, bateaux, fenêtres idem.
- **LOD** : quartiers fusionnés de loin, archétypes détaillés en zoomant, monuments
  toujours détaillés.
- **Streaming d'époques** : l'époque active en pleine fidélité, les voisines
  préchargées, les lointaines déchargées ; géologie, Seine et ancres toujours résidentes.
- `devicePixelRatio` plafonné à 2 ; **sélecteur de qualité** (auto par défaut) qui
  réduit foules et végétation avant les monuments ou la fluidité des transformations.
- `prefers-reduced-motion` : transitions instantanées, pas d'animations d'ambiance.

## Hors périmètre (YAGNI)

- Pas de sauvegarde d'état, pas de backend, pas de VR.
- Pas de recherche d'adresse générique : le repère « chez nous » est codé en dur —
  c'est un cadeau pour Raphaël, pas un produit.
- Pas de mode « comparaison côte à côte » de deux époques.
- Pas d'intérieurs de bâtiments.

## Critères de réussite

- S'ouvre en local (`open index.html`), fonctionne hors ligne, sur laptop et iPad M1.
- Le slider scrubbe sans à-coups ; aucune incohérence temporelle (bâtiment orphelin,
  muraille à moitié née) quelle que soit la position.
- Les 14 moments sont chacun un monde vivant et *distinct* (lumière, sons, foules,
  bateaux, signatures de mouvement).
- Les deux repères fantômes fonctionnent et racontent leur histoire (1889 pour la
  tour, 1860 pour le quartier).
- Le bouton Lecture déroule l'ensemble en ~2 min avec les cartes-récits.
- La météo (4 modes) se combine avec toutes les époques, la nuit reste lisible.
- Raphaël peut piloter seul : icônes de la frise, vues prédéfinies, gros boutons ;
  un parent lit ou active la voix.
- 60 fps laptop / ~40 fps iPad M1 en qualité auto.
