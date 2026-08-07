# Paris, deux mille ans 🗼

Une visualisation 3D à explorer ensemble : Paris, de Lutèce gauloise à aujourd'hui,
sur une seule carte qui ne bouge jamais — seul le temps change.

Fait avec amour (et Three.js) pour Raphaël.

## Lancer

```
./serve.sh
```

puis ouvrir **http://localhost:8123/** dans un navigateur (Chrome, Firefox, Safari…).

Une fois publié sur GitHub Pages, il suffit d'ouvrir l'adresse de la page — aucune
installation, aucun compte, aucun réseau nécessaire à part pour charger la page une
première fois (tout est ensuite embarqué, y compris Three.js).

Le seul cas où `npm` sert, c'est pour faire tourner les tests automatiques
(`npm test`) — jamais pour jouer avec Paris.

## Les contrôles

**Sur la carte (doigt ou souris) :**

- **Un doigt / clic-glisser** : tourner autour de la ville (orbite).
- **Deux doigts (pincer) / molette** : zoomer, jusqu'au niveau des toits.
- **Deux doigts qui glissent ensemble** : se déplacer sur la carte (pan).

**La grande frise en bas d'écran :**

- **Toucher une icône** : voyage animé jusqu'à ce moment de l'histoire.
- **Glisser le curseur** : remonter ou descendre le temps librement, en continu —
  2 300 ans coulent sous le doigt, rien ne « saute ».

**Les boutons ronds (en haut) :**

| Bouton | Effet |
| --- | --- |
| 🏠 | Changer de vue : vue d'ensemble, île de la Cité, chez nous, Tour Eiffel. |
| 🔊 | Voix : la carte-récit de chaque moment est lue à voix haute (coupée par défaut). |
| 🔈 | Sons d'ambiance : oiseaux, cloches, foule, trains, pluie, circulation… (coupés par défaut). |
| 📍 | Repères : affiche ou cache la Tour Eiffel fantôme et la balise « chez nous ». |
| ☀️ | Météo : fait tourner soleil ☀️ → couvert ☁️ → pluie 🌧️ → nuit 🌙. |
| ✨ | Montrer les zones : fait clignoter tout ce qu'on peut toucher (monuments). |
| ⚙️ | Qualité graphique : Auto (par défaut), ou un réglage manuel si l'appareil ralentit. |

**▶️ Lecture** (à gauche de la frise, ou barre d'**espace**) : le temps s'écoule
seul, environ deux minutes pour tout voir, avec une pause sur chaque moment pour
lire sa carte-récit. On peut choisir la vitesse (×0,5 / ×1 / ×2) et reprendre la
main à tout moment en touchant la frise ou l'écran.

**Clavier** (pratique avec une souris) :

- **← / →** : avancer ou reculer dans le temps.
- **1 / 2 / 3 / 4** : les quatre vues (ensemble / île de la Cité / chez nous / Tour Eiffel).
- **Espace** : lancer ou mettre en pause la Lecture ▶️.

## Ce qu'on peut chercher

- 🗼 **La Tour Eiffel fantôme** : une silhouette translucide et scintillante, à son
  emplacement exact, visible dès l'époque gauloise. En 1889, elle devient réelle —
  regarde bien ce moment-là !
- 🏠 **La balise « chez nous »** : une lumière au carrefour de la rue Leibniz et de la
  rue Jean Dollfus, visible à toutes les époques — d'abord une forêt, puis un
  village hors les murs, puis Paris à partir de 1860.
- 🚂 **Le train de la petite ceinture** : construit en 1852-1869, il s'endort en
  1934 et la nature reprend ses rails.
- ⚔️ **Les drakkars** des Vikings, en 885, remontant la Seine.
- 🏗️ **Notre-Dame qui se construit**, grues médiévales incluses — et plus tard,
  l'incendie de 2019 puis la flèche retrouvée en 2024.
- Les monuments cliquables (une étiquette, une phrase, la voix) — le bouton ✨ les
  fait tous clignoter d'un coup pour les repérer.
- Le compteur d'habitants, discret, qui grandit avec le temps : de quelques
  centaines d'habitants sur l'île à plus de deux millions aujourd'hui.

## Une petite mise en garde

**La géographie est fidèle, les dates sont vraies, les maisons sont inventées.**

## Crédits

Fait avec amour (et Three.js) pour Raphaël. 🗼
