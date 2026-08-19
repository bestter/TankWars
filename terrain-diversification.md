# Diversification du Terrain (Relief Varié, Roche Indestructible & Terrain Mou)

## Goal
Enrichir la génération procédurale du terrain pour offrir un relief dynamique et varié (bosses, creux tactiques pour abriter les tanks, sans tunnels), introduire des zones de roche indestructibles bloquant la déformation sans annuler le souffle d'explosion, et ajouter un type de terrain mou 2 à 3 fois plus destructible.

## Tasks
- [x] Task 1: Créer les types de matériaux et constantes de destruction (`src/types/terrain.ts` & `src/types/game.ts`) → Verify: `npm run build`
- [x] Task 2: Étendre `TerrainManager` pour gérer le tableau de matériaux par colonne (`src/game/engine/Terrain.ts`) → Verify: `npm run test`
- [x] Task 3: Implémenter la génération procédurale aléatoire avec relief riche (bosses, creux, multi-octaves) et distribution de zones (`Terrain.ts`) → Verify: Tests unitaires de variance et bornage
- [x] Task 4: Implémenter la mécanique de destruction différentielle (roche indestructible, terrain mou multiplié par `SOFT_TERRAIN_DESTRUCTION_MULTIPLIER`) dans `carveCircle` et `destroyTerrainShaft` (`Terrain.ts`) → Verify: Tests de creusement comparatif normal vs roche vs mou
- [x] Task 5: Adapter le rendu Canvas2D / OffscreenCanvas avec palette VGA dédiée pour chaque matériau (`Terrain.ts`) → Verify: Rendu sans glitch lors des redessins partiels
- [x] Task 6: Optimiser le spawn des tanks dans `TankManager.ts` : tirage aléatoire biaisé vers le Y canvas max (creux tactiques) parmi les candidats qui respectent `minDist` 100 px → Verify: Tests de `spawnTanks`
- [x] Task 7: Ajouter la suite de tests unitaires complète pour la génération variée, la roche et le terrain mou (`src/game/engine/__tests__/Terrain.test.ts`, `PhysicsEngine.test.ts`) → Verify: `npm test`
- [x] Task 8: Validation finale du pipeline de qualité (`npm run lint` → `npm run build` → `npm run test`) → Verify: Zéro erreur, zéro `any`, tous les tests au vert
- [x] Task 9: Mise à jour de la documentation globale et IA (`README.md`, `AGENTS.md`, `CLAUDE.md`, `GROK.md`, `CURSOR.md`, `.cursorrules`) → Verify: Cohérence et synchronisation des guides d'architecture

## Done When
- [x] Le relief du terrain est varié et aléatoire à chaque partie/manche avec bosses et creux tactiques sans formation de tunnels.
- [x] Les zones en roche (`ROCK`) ne subissent aucune déformation sous les tirs, mais les explosions à proximité blessent normalement les tanks.
- [x] Les zones de terrain mou (`SOFT`) sont 2 à 3 fois plus destructibles selon la constante `SOFT_TERRAIN_DESTRUCTION_MULTIPLIER`.
- [x] Les différents types de terrain sont visuellement identifiables selon la palette VGA (`VGA_PALETTE`).
- [x] Tous les tests passent (`npm run lint` → `npm run build` → `npm run test`).
- [x] La documentation projet et les instructions IA sont parfaitement à jour.

## Notes
- Respect absolu de la règle d'or : zéro `any`, palette `VGA_PALETTE`, français québécois dans les messages.
- Le souffle de l'explosion dans `PhysicsEngine` appelle déjà `tankManager.applyExplosionDamage` indépendamment de la hauteur modifiée par `TerrainManager` : la roche n'empêche donc pas les dégâts de souffle aux tanks proches.
- Le modèle de heightmap garantit par conception l'absence de surplombs et de tunnels (une seule hauteur $y$ par colonne $x$).
