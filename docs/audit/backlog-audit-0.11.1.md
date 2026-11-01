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
- **Résolution (#320)** : Décision documentée de non-intervention. Le constat initial est précisé : les captures complètes ne surviennent pas pendant toute la partie locale mais uniquement pendant le tour actif d'un joueur humain local sans projectile en vol, frappe Zeus, chute de tank ni verrou. Le coût réel mesuré par benchmark est négligeable (~0,020 ms par capture, soit ~0,20 ms/sec de CPU à 10 Hz ou ~0,02 % d'un seul cœur CPU) et la pression mémoire éphémère (~100 Ko/s) est absorbée en microsecondes par le GC mineur sans impact sur le rendu à 60/120 FPS. Le mécanisme actuel par comparaison `JSON.stringify` offre une garantie infaillible d'invalidation sur 11 dimensions d'état sensibles (terrain, positions, PV, boucliers, stocks, vent, gravité, contexte économique, tour, manche, verrous). Une révision incrémentale ou empreinte légère introduirait un couplage fort et un risque de régression critique (omission d'invalidation et tir périmé) sans gain de performance perceptible. Le constat initial et les pistes ci-dessous sont conservés comme historique.
- **Analyse et résolution** : Gemini 3.8 Flash.
- **Fichiers concernés** :
  - `src/components/advisor/useShotAdvisor.ts:L13-L31`
  - `src/components/advisor/AdvisorController.ts:L41-L55`
  - `src/game/engine/TurnManager.ts:L771-L788`
- **Problème** : Un `window.setInterval(..., 100)` s'exécute 10 fois par seconde sur le thread principal pendant toute la partie locale. À chaque tick, `capture()` appelle `TurnManager.captureAdvisorState()` (`structuredClone` des joueurs), copie les deux tableaux de 800 colonnes (`heightmap` et `materials`), puis `AdvisorController.refresh()` exécute `JSON.stringify(snapshot)` sur l'objet complet uniquement pour comparer `key !== this.key`.
- **Plan d'action** :
  1. Exposer un compteur de révision incrémental ou une empreinte légère dans `TurnManager` (incrémenté aux transitions de tour/manche, modifications de terrain, dégâts/chutes, achats ou changements d'inventaire).
  2. Ne construire le clone complet (`captureAdvisorState` + copie des 800 colonnes) que lorsque cette empreinte légère ou la politique choisie change.

### IMP-03 — Exposition prolongée du `token` de session dans `window.location.search` et comparaison non constante
- **Implémentation (#321)** : `onlineParticipation.ts` capture les invitations valides dans une sauvegarde de lobby distincte, versionnée et validée, puis nettoie leurs paramètres sans perdre les autres éléments de l’adresse. Restauration du formulaire ou reconnexion selon la jonction engagée, invitations hôte conservées, priorité explicite des invitations sur les combats incompatibles et purge au départ/à la fin de partie. Les erreurs de stockage et d’historique sont signalées; une invitation valide non sauvegardée demeure dans l’adresse comme repli. Aucun jeton hôte n’est ajouté à l’adresse. `tokenComparison.ts` utilise la primitive Cloudflare sur UTF-8 et son modèle documenté de refus des longueurs différentes. Le contrôle local `Scripts/test-online-token-comparison.mjs` couvre la primitive réelle workerd et les refus de la route sans remplacement de la connexion légitime. Les tests Node seuls utilisent un double et ne valident pas cette disponibilité.
- **Limites** : les liens copiés et les URL WebSocket contiennent toujours le jeton; le nettoyage ne révoque rien et n’efface pas les copies antérieures. Aucune fuite effective ni attaque temporelle exploitable n’a été démontrée. Les constats et références de lignes historiques ci-dessous décrivent l’état antérieur.
- **Implémentation et documentation** : GPT-6 — Codex.
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
- **Résolution (#322)** : Retrait des deux fichiers vides `ping-indexnow.js`, du hook `postbuild` sans effet et des quatre scripts shell ponctuels. Le constat initial ci-dessous est conservé comme historique. Le script documenté `Scripts/test-deploy-cloudflare.ps1` reste en place; aucun renommage global du dossier n'est requis. La collision est confirmée dans l'index Git, sans échec fonctionnel démontré; il s'agit d'un nettoyage de portabilité, sans urgence fonctionnelle. Aucun nouveau test automatisé n'est ajouté pour ces suppressions sans logique de jeu; vérifier l'arbre Git, les références et la batterie de validation du dépôt.
- **Analyse et résolution** : GPT-6 — Codex.
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
- **Résolution (#324)** : Les workflows GitHub Pages et Release exécutent lint, build, tests et React Doctor (`--verbose --scope full --blocking error`) sur le checkout publié avant toute publication d'artefacts. Le scan complet est explicite pour éviter le repli implicite en l'absence de diff sur main ou un tag détaché; les avertissements restent visibles et non bloquants en publication, mais demeurent bloquants en développement/CI. `npm run doctor` utilise obligatoirement `npx react-doctor@latest`, conformément au choix explicite du propriétaire et à la documentation officielle; le passage au seul binaire local est abandonné. AGENTS.md et le README documentent cette consigne, et l’Action GitHub utilise explicitement `version: latest`. Les Actions des trois workflows concernés sont alignées sur les versions compatibles Node 24, y compris la chaîne de publication Pages et Release. Le lanceur `Scripts/njsscan_runner.py` vérifie le code de sortie, la structure attendue du SARIF et la réussite explicite de l'analyse; les détections restent consultatives et un rapport disponible est téléversé même après un échec du contrôle. Les tests Python isolés couvrent les pannes et rapports incohérents. La validation complète du schéma SARIF reste assurée par l'action de téléversement GitHub. Les constats et pistes initiaux ci-dessous sont conservés comme historique; la présence d'une CI indépendante n'impose aucun ordre de publication et le workflow Release ne déploie pas sur Cloudflare.
- **Analyse et résolution** : GPT-6 — Codex.
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
- **Résolution (#327, v0.11.2)** : Résolu. Suppression du contrat mort `AIStrategy.ts` et de la méthode `GameEngine.requestAIShot`. Remplacement du mock fléché par une fonction constructible dans `useOnlineLobby.test.ts`, éliminant l'avertissement Vitest et l'erreur d'instanciation silencieuse `TypeError: () => mockWs is not a constructor`.
- **Analyse et résolution** : Gemini 3.8 Flash.
- **Fichiers concernés** :
  - `src/game/entities/ai/AIStrategy.ts:L1-L43`
  - `src/game/engine/GameEngine.ts:L562-L572` (`requestAIShot`)
  - `src/components/__tests__/useOnlineLobby.test.ts`
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
