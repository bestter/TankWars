# Registre de suivi de l'audit — Problèmes non corrigés (Post-0.11.1)

Ce document consigne les constats **🟠 Importants (Court terme)** et **🟢 Améliorations (Moyen/Long terme)** identifiés lors de l'audit architectural, de sécurité, de performance et de tests (octobre 2026) et qui n'ont pas été inclus dans le correctif critique `0.11.1`.

Les 3 constats **🔴 Critiques** ont été corrigés dans la version `0.11.1` :
- [x] **CRIT-01** : Durcissement des routes Worker (`parts.length === 5` sur `/join` et `/ws`, `RATE_LIMITER` sur `POST /api/rooms/:roomId/join`, restriction de `fetchCreate` aux requêtes `POST` internes sur `/internal/create` ou `/create` hors WebSocket).
- [x] **CRIT-02** : Réutilisation directe du garde canonique `isFireRejectedReason` de `src/game/online/protocol.ts` dans `src/utils/onlineSession.ts` afin de préserver `'ZEUS_TURN'` lors de la restauration de session.
- [x] **CRIT-03** : Correction des notes non commentées dans `public/_headers` et retrait des jokers globaux `ws: wss:` de `connect-src` dans `public/_headers` et `index.html`.

---

## 🟠 Important (Court terme)

### IMP-01 — Exclusion complète de `worker/` dans ESLint et code mort serveur
- **Fichiers concernés** :
  - `eslint.config.js:L9`
  - `worker/src/game-room.ts:L200-L207` (`mulberry32`)
  - `worker/src/game-room.ts:L306-L310`, `L507`, `L1356`, `L1450`, `L1573`, `L1614` (`lastShot`)
- **Problème** : `globalIgnores(['dist', 'worker', 'node_modules'])` désactive l'analyse statique ESLint sur tout le code du Worker Cloudflare. Du code mort s'y est accumulé (`mulberry32` n'est jamais appelée; `lastShot` est écrite et réinitialisée en 6 endroits mais jamais lue).
- **Plan d'action** :
  1. Retirer `'worker'` de `globalIgnores` dans `eslint.config.js` et ajouter une configuration adaptée aux globals Cloudflare Workers.
  2. Supprimer `mulberry32` et `lastShot` (ou documenter explicitement `lastShot` s'il fait partie d'une compatibilité de stockage persisté).

### IMP-02 — Polling à 100 ms avec `structuredClone` + `JSON.stringify` complet dans le conseiller de tir
- **Fichiers concernés** :
  - `src/components/advisor/useShotAdvisor.ts:L13-L31`
  - `src/components/advisor/AdvisorController.ts:L41-L55`
  - `src/game/engine/TurnManager.ts:L771-L788`
- **Problème** : Un `window.setInterval(..., 100)` s'exécute 10 fois par seconde sur le thread principal pendant toute la partie locale. À chaque tick, `capture()` appelle `TurnManager.captureAdvisorState()` (`structuredClone` des joueurs), copie les deux tableaux de 800 colonnes (`heightmap` et `materials`), puis `AdvisorController.refresh()` exécute `JSON.stringify(snapshot)` sur l'objet complet uniquement pour comparer `key !== this.key`.
- **Plan d'action** :
  1. Exposer un compteur de révision incrémental ou une empreinte légère dans `TurnManager` (incrémenté aux transitions de tour/manche, modifications de terrain, dégâts/chutes, achats ou changements d'inventaire).
  2. Ne construire le clone complet (`captureAdvisorState` + copie des 800 colonnes) que lorsque cette empreinte légère ou la politique choisie change.

### IMP-03 — Exposition prolongée du `token` de session dans `window.location.search` et comparaison non constante
- **Fichiers concernés** :
  - `src/App.tsx:L64-L82`, `L189`
  - `src/components/useOnlineLobby.ts:L165`
  - `src/components/online/attachOnlineCombat.ts:L757`
  - `worker/src/game-room.ts:L728`
- **Problème** : Le jeton de slot joueur (`?room=...&slot=...&token=...`) demeure dans `window.location.search` et l'historique du navigateur pendant toute la durée du lobby et de la partie (il n'est nettoyé qu'au retour au menu). Côté Worker, `this.state.tokens[slot] !== token` utilise une comparaison de chaînes standard plutôt qu'une comparaison en temps constant.
- **Plan d'action** :
  1. Nettoyer `token` de l'URL via `window.history.replaceState` dès qu'il a été capturé en mémoire / `sessionStorage` par le client (tout en conservant l'affichage du lien d'invitation dans le lobby).
  2. Utiliser une comparaison en temps constant (`crypto.subtle.timingSafeEqual` sur `TextEncoder().encode(...)` de même longueur) dans `GameRoom.fetch`.

### IMP-04 — Collision de casse Git (`Scripts/` vs `scripts/`) et scripts shell temporaires à la racine
- **Fichiers concernés** :
  - `package.json:L13` (`"postbuild": "node Scripts/ping-indexnow.js"`)
  - `Scripts/ping-indexnow.js:L1` (0 octet) et `scripts/ping-indexnow.js:L1` (0 octet)
  - `fix_script.sh:L1-L4`, `run_origin.sh:L1-L4`, `test-origin.sh:L1-L4`, `test-script.sh:L1-L2`
- **Problème** : Deux fichiers vides `Scripts/ping-indexnow.js` et `scripts/ping-indexnow.js` coexistent dans l'arbre Git, provoquant des collisions sur les systèmes de fichiers insensibles à la casse (Windows/macOS), et quatre scripts shell de débogage temporaires sont versionnés à la racine.
- **Plan d'action** :
  1. Supprimer les 4 scripts shell temporaires à la racine (`git rm fix_script.sh run_origin.sh test-origin.sh test-script.sh`).
  2. Unifier la casse du dossier `Scripts/` (ou retirer le hook `postbuild` vide de `package.json` et supprimer les deux fichiers vides `ping-indexnow.js`).

### IMP-05 — Coût $O(N)$ croissant de `GameRoom.saveState()` sur les manches longues
- **Fichiers concernés** :
  - `worker/src/game-room.ts:L441-L486`
- **Problème** : À chaque action réseau (tir, achat unitaire en boutique, `SHOP_READY`, transition de tour), `saveState()` sérialise toutes les entrées de la manche (`combatJournal`, `earningsResults`, `processedFireActionsBySlot`, `processedShopActions`) et appelle `await txn.list({ prefix: "combat:" })` pour calculer les clés obsolètes à purger.
- **Plan d'action** :
  1. Ne lister et purger le préfixe `"combat:"` que lors d'un changement de manche (`resetCombatV4RoundState`) ou d'un démarrage à froid (`ensureStateLoaded`).
  2. Suivre un ensemble d'entrées modifiées (`dirtyKeys`) entre deux `saveState()` pour éviter de re-sérialiser tout le journal à chaque action.

### IMP-06 — Scan SAST CI non bloquant (`njsscan.yml`) et workflows de déploiement sans tests préalables
- **Fichiers concernés** :
  - `.github/workflows/njsscan.yml:L43`
  - `.github/workflows/deploy.yml:L25-L50`
  - `.github/workflows/release-and-deploy.yml:L18-L33`
- **Problème** : `njsscan . --sarif --output results.sarif || true` masque les erreurs d'exécution du scanner, et les workflows de déploiement GitHub Pages / Release compilent sans exécuter `npm run lint` ni `npm run test`.
- **Plan d'action** :
  1. Retirer `|| true` ou utiliser `continue-on-error` contrôlé avec vérification de la génération effective de `results.sarif`.
  2. Ajouter les étapes `npm run lint` et `npm run test` avant `npm run build` dans `deploy.yml` et `release-and-deploy.yml`.

---

## 🟢 Améliorations (Moyen/Long terme)

### AMEL-01 — Découpage des classes monolithiques (`GameEngine.ts`, `game-room.ts`, `TurnManager.ts`, `useGameSession.ts`)
- **Fichiers concernés** :
  - `src/game/engine/GameEngine.ts:L145-L2724` (2 724 lignes)
  - `worker/src/game-room.ts:L283-L2202` (2 202 lignes)
  - `src/game/engine/TurnManager.ts:L55-L1474` (1 474 lignes)
  - `src/components/useGameSession.ts:L116-L876` (876 lignes)
- **Plan d'action** :
  1. Extraire la synthèse Web Audio (`L1443-L1614`, `L2327-L2724`) de `GameEngine.ts` dans un module dédié `src/game/engine/CombatAudio.ts`.
  2. Extraire les systèmes de particules (`celebration`, `thermoParticles`, `terrainImpactParticles`) de `GameEngine.ts` dans `src/game/engine/ParticleManager.ts`.
  3. Découper `worker/src/game-room.ts` en modules cohésifs (`roomStorage.ts`, `roomShop.ts`, `roomZeus.ts`, `roomCombat.ts`).

### AMEL-02 — Réutilisation des tampons dans `Terrain.destroyTerrainShaft` (DRILLER)
- **Fichiers concernés** :
  - `src/game/engine/Terrain.ts:L497-L530`
- **Problème** : `new Array<boolean>(this.width).fill(false)` est alloué à chaque itération de la boucle `for (let i = 0; i <= steps; i++)` (~56 fois par impact DRILLER).
- **Plan d'action** :
  1. Allouer un unique tampon `stampOccludedColumns` hors de la boucle `for` et le réinitialiser via `.fill(false)` à chaque pas.

### AMEL-03 — Nettoyage du contrat legacy `AIStrategy.ts` et des mocks constructeurs Vitest
- **Fichiers concernés** :
  - `src/game/entities/ai/AIStrategy.ts:L1-L43`
  - `src/game/engine/GameEngine.ts:L562-L572` (`requestAIShot`)
  - `src/components/__tests__/useOnlineLobby.test.ts:L32-L44`
- **Plan d'action** :
  1. Supprimer `AIStrategy.ts` et `GameEngine.requestAIShot` (non utilisés au runtime, remplacés par `AIEngine` et `AIByProfileStrategy`).
  2. Remplacer `vi.fn(() => mockWs)` par `vi.fn(function () { return mockWs; })` dans `useOnlineLobby.test.ts` pour éliminer l'avertissement Vitest sur les mocks constructeurs.

### AMEL-04 — Couverture de tests unitaires UI manquante et tests E2E navigateur
- **Fichiers concernés** :
  - `src/game/entities/ai/shotAdvisor.worker.ts:L1-L13`
  - `src/components/advisor/ShotAdvisorPanel.tsx`
  - `src/components/GameShopOverlay.tsx`
  - `src/components/PlayerConfigList.tsx`
  - `src/components/endurance/EnduranceConfigView.tsx`, `EnduranceLiveView.tsx`, `EnduranceResultsView.tsx`
- **Plan d'action** :
  1. Ajouter des tests unitaires dédiés pour `shotAdvisor.worker.ts`, `ShotAdvisorPanel.tsx`, `GameShopOverlay.tsx` et `PlayerConfigList.tsx`.
  2. Mettre en place un test fumée Playwright validant le cycle complet dans un vrai moteur Chromium (Menu → Partie locale → Conseiller Web Worker → Fin de manche → Boutique → Manche 2).

---

*Document généré et signé par : **Gemini 4 Argon***
