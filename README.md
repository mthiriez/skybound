# SKYBOUND — étape 1

Jeu de vol mobile-first au-dessus de la France réelle, jouable dans Safari sur iPhone.
Cette version est l'**étape 1** demandée : prouver la technologie sur Lille avec de vraies données IGN.

## Lancer en local

Le chargement des tuiles IGN passe par `fetch` : il faut donc servir le dossier en HTTP, un simple double-clic sur `index.html` ne suffit pas.

```
cd skybound
python3 -m http.server 8080
# puis ouvrir http://localhost:8080
```

Sur iPhone, dans le même réseau : `http://<ip-de-la-machine>:8080`.
En ligne : `https://mthiriez.github.io/skybound/`.

## Ce qui fonctionne réellement

- Terrain construit à partir des **photos aériennes BD ORTHO** de l'IGN (WMTS, zoom 14, 6×6 tuiles assemblées en une texture 1536 px, environ 6 m par pixel au sol).
- **Relief RGE ALTI** (WMTS `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES`, zoom 12, format BIL 32 bits) échantillonné sur une grille de 321×321 sommets, soit un point tous les 29 m.
- Zone couverte : environ 9,3 km × 9,3 km centrés sur la Grand-Place de Lille. Au-delà, rien n'est chargé.
- Un avion au design original, caméra de poursuite amortie, vol arcade (lacet, tangage, inclinaison, montée, décrochage léger, plancher de collision avec le relief).
- Commandes tactiles : glissement du pouce sur la moitié gauche (virtual stick), bouton BOOST à droite, pause, invite à tourner l'écran, respect des safe areas.
- Clavier en secours sur ordinateur : flèches ou ZQSD, Maj pour le boost.
- Compteur FPS affiché en permanence, avec réduction automatique de la résolution si le framerate passe sous 28 ips.
- Son synthétisé (moteur, vent) créé après la première interaction, conformément aux restrictions Safari.

## Ce qui n'est pas fait

- **Pas de bâtiments 3D** (BD TOPO) : le relief et la photo suffisent à reconnaître la métropole, mais les immeubles ne sont pas extrudés.
- **Pas de streaming** : la zone est chargée une fois au démarrage. Voler au-delà de la zone est bloqué par un mur invisible.
- Pas de missions, de score, de carnet de vol, de cockpit, de multijoueur : c'est l'étape 2 et suivantes.
- Pas de recherche de ville ni de lien partageable.
- Pas de mode hors ligne.

## Données et licences

| Donnée | Source | Licence |
| --- | --- | --- |
| Photos aériennes BD ORTHO | IGN Géoplateforme | Licence Ouverte Etalab 2.0 |
| Relief RGE ALTI | IGN Géoplateforme | Licence Ouverte Etalab 2.0 |
| Rendu | Three.js r170 | MIT |

Les données sont interrogées en direct sur `data.geopf.fr`, sans clé ni proxy. CORS vérifié : `access-control-allow-origin: *`.

## Architecture

- `index.html` : interface, HUD, overlays.
- `app.js` : chargement des tuiles, construction du maillage, modèle de vol, commandes, boucle de rendu.
- `vendor/three.module.min.js` : Three.js r170, auto-hébergé, aucun CDN.

Aucun serveur applicatif, aucune base, aucun compte.
