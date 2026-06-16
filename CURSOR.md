# Bestter's TankWars — Cursor Rules (CURSOR.md)

**Cursor users:** read [AGENTS.md](./AGENTS.md) first. It is the single source of truth for project layout, build commands, verification, "what agents must not do", AI contract, and visual polish details (including Step 4). This CURSOR.md is a Cursor-friendly companion that mirrors key rules from [.cursorrules](./.cursorrules) while pointing back to the canonical docs.

## Role & Stack (for Cursor Composer / Agent)

- Role: Senior Software Architect & Expert Game Developer (retro artillery focus)
- Stack: TypeScript (strict), React 19 (hooks, no class components for new code), HTML5 Canvas 2D (pure, no WebGL, no external game libs)
- Styling: monospace retro aesthetic; inline styles + `App.css` / `index.css` (no UI kit, no Tailwind, no external component libraries)

## Core Principles (non-negotiable in Cursor edits)

1. Never mix React state with the Canvas high-frequency render loop. React owns `GamePhase`, players, money, shop, HUD state. Canvas + GameEngine own physics, terrain mutation, projectiles, and all drawing.
2. Write modular, strongly-typed TypeScript. **Zero `any`**. New shared types go in `src/types/`.
3. Keep physics updates (fixed 120 Hz timestep in GameEngine) decoupled from display raf.
4. All rendering uses `VGA_PALETTE` from `src/types/game.ts` (classic + neon extensions for tanks).

## TankWars Game Specifications (keep in mind when editing)

- Game loop: `requestAnimationFrame` + fixed `PHYSICS_DT = 1/120` accumulator in `GameEngine`.
- Terrain: fully custom heightmap in `Terrain.ts`; crater destruction with falloff. No third-party physics.
- Players: 2–4 (any mix Human / AI). Configured in `MainMenu.tsx`.
- Tank visuals: exclusively `drawTankSprite(...)` (see `src/game/rendering/tankSprite.ts`). Supports hull angle (slope) + independent turretAngle. Now includes Step 4: active indicator (GameEngine), owner-colored shells (PhysicsEngine), recoil (TankManager).
- State machine (see `src/types/game.ts`): `MENU` → `COMBAT` → `RESOLUTION` → `CELEBRATION` → `SUMMARY` → `SHOP` → `GAME_OVER`.
- Weapons & Economy: `WEAPON_REGISTRY` in `src/types/weapon.ts`. Missile unlimited (never in shop). Others limited, decrement on use. Shop between rounds. Advanced weapons (Thermonuclear etc.) have special VFX/sounds in GameEngine.
- **Worker `.gitignore` cleanup :** `worker/.wrangler/` exclu de Git ; retrait des fichiers SQLite/cache Wrangler locaux de l'index. Le code source du worker reste versionné. — Grok 4.3 (xAI)
- **Online Multiplayer Sync & Session Stability :** Relay `ROUND_END`, tir distant par slot, sync boutique WS, re-seed RNG par manche, rattrapage `GAME_START`, persistance `sessionStorage`, plus de retour au lobby en cours de partie, reconnexion WS combat, reset serveur manche 2. 139 tests. Voir AGENTS.md. — Grok 4.3 (xAI)
- **Service Worker and CSP Production Load Fix (v0.4.2) :** Résolution d'un gel critique du chargement en production sur `tankwars.pages.dev` lié à la stratégie Cache-First agressive sur `/index.html` (qui bloquait le navigateur sur d'anciens bundles JS supprimés du serveur comme `index-CXsrA7Q7.js` renvoyant un 404/HTML). Configuration de `sw.js` avec une stratégie **Network-First** pour les navigations et limitation de l'interception aux requêtes de même origine (`self.location.origin`). Correction des plantages du Service Worker par propagation des erreurs (`throw err` au lieu de `undefined` générant une TypeError). Ajout de `https://static.cloudflareinsights.com` dans la directive `connect-src` de la CSP de `index.html` et `public/_headers`. Création de `public/_redirects` pour la réécriture SPA et suppression de `public/_redirects.txt` obsolète. Cache incrémenté en `"tankwars-v2"`.
- **Basic Online Multiplayer Foundation :** Hôte crée une salle avec URLs par joueur (slots humains + IA optionnelles), lobby WS (roster live, auto-start), WS jeu persistant pour FIRE vers serveur (coordination tours + SHOT/STATE_UPDATE). Côté client : gating localPlayerId (isLocalHumanTurn + lock forcé dans syncTurn), RNG seedé pour spawns identiques, load des heights serveur. Worker/DO pour rooms. CSP pour worker dev. Vérifs verts (lint/build/tests 130/130). Voir AGENTS.md. — Grok 4.3 (xAI)

- **React Doctor GitHub Action Fix :** Retrait du paramètre invalide `project` dans l'action GitHub `millionco/react-doctor@v2` dans `.github/workflows/react-doctor.yml`, car il s'attend à un chemin de répertoire plutôt qu'à une liste de fichiers tsconfig, résolvant l'erreur de chemin sur GitHub CI.
- **Complete Projectile Object Pooling (perf branch) :** Intégration du helper `getProjectile` (Jules) dans launchProjectile et splitCluster (PhysicsEngine). Suppression de la duplication d'allocation. Pooling maintenant actif pour tous les tirs et clusters (réduction GC). Corrections build/lint/test pour vérif complète. — Grok 4.3 (xAI)
- **Terrain Partial Redraw Visual Fix (v0.4.1) :** Corrige les lignes bleues, le gazon coupé sur les courbes et l'effet flou brun/vert après les cratères (redraw partiel offscreen à calques opaques dans `Terrain.ts`). **113 tests**.
- **Game Version Bump :** Bumped game version to `0.4.1` in `package.json` and `package-lock.json`.
- **Performance Optimizations (v0.4.1) :** `BallisticsSimulator.ts` (recherche balistique partagée, lazy-load v2–v4), redraw partiel du terrain, throttle HUD ~15 Hz + `React.memo`, feux d'artifice 60 Hz. Suite de tests portée à **112** tests.
- **Game Version Bump :** Bumped game version to `0.4.0` in `package.json` and `package-lock.json`.
- **Support Mobile et PWA :** Ajout de contrôles tactiles virtuels réactifs (D-Pad pour l'angle, D-Pad pour la puissance, tir direct, changement d'arme) avec support du maintien prolongé (press & hold) pour le défilement rapide sous le canvas de combat. Intégration PWA complète avec un manifeste (`manifest.json`) configuré pour le mode plein écran paysage (`standalone` + `landscape`) et un Service Worker (`sw.js`) gérant le cache hors-ligne et l'installabilité sur l'écran d'accueil mobile. Métadonnées Apple iOS intégrées dans `index.html` pour masquer les barres du navigateur Safari.
  - **AI Baby Nuke & Thermonuclear Usage Restriction:** Reduced the frequency and overuse of `NUKE` (Baby Nuke) and `THERMONUCLEAR` weapons by AI players. Lowered their purchase priorities in the automatic shop by moving them to the end of the preference list in [aiShopHelper.ts](file:///D:/projects/Repos/TankWars/src/game/entities/ai/aiShopHelper.ts). Restricted their combat selection in [AISmartStrategy.ts](file:///D:/projects/Repos/TankWars/src/game/entities/ai/AISmartStrategy.ts) and [AIHeuristicStrategy.ts](file:///D:/projects/Repos/TankWars/src/game/entities/ai/AIHeuristicStrategy.ts) by requiring a minimum health threshold on targets (40 HP for Nuke, 50 HP for Thermonuclear) to prevent waste on near-dead tanks, and introducing a random probability hurdle (35% selection chance for Nuke, 30% for Thermonuclear).
  - **Production Console Log Suppression:** Disabled all non-error console outputs (`console.log`, `warn`, `info`, `debug`, `trace`, `group`, etc.) in production builds by overriding them at the `src/main.tsx` entry point when `import.meta.env.PROD` is true, ensuring clean production console environments.
  - **Custom Analytics Events via Cloudflare Zaraz:** Created `analytics.ts` utility to send custom events to Cloudflare Zaraz (`window.zaraz.track`). Integrated tracking for `game_start` (tracking players, human/AI count, and chosen AI profiles), `round_end` (tracking round number, winner type, and winner AI profile), and `game_over` (tracking overall winner, winner type/profile, and total rounds). Added comprehensive unit tests in `analytics.test.ts`.
  - **Randomized Tank Starting Order:** Modified `spawnTanks` in `TankManager.ts` to shuffle the generated X positions using a secure Fisher-Yates shuffle algorithm. This ensures that the horizontal starting order of the tanks varies randomly on every round, preventing players (e.g. Player 1) from always spawning in the same relative horizontal order (e.g. always on the far left). Added comprehensive unit tests in `TankManager.test.ts`.
  - **Game Version Bump:** Bumped game version to `0.3.4` in `package.json` and `package-lock.json`.
  - **Version Display on Main Menu:** Imported game version from `package.json` and added it to the footer of `MainMenu.tsx` beside the license notice (e.g. `v0.3.4`).
  - **Bullet and Nuke Direct Hit Damage Fix:** Fixed a major bug where direct hits with the `BULLET` and `NUKE` weapons were often ignored or severely penalized. Bypassed the splash `distance > radius` check and linear falloff for direct hits on the target tank's bounding box, ensuring `BULLET` deals its intended 3x damage multiplier (75 dmg) and `NUKE` instantly destroys the target.
  - **Content Security Policy (CSP) Update:** Allowed Cloudflare Web Analytics script (`https://static.cloudflareinsights.com`) inside the `script-src` directive in `index.html` to resolve console security violations.
  - Active Player floating indicator (inverted triangle, player color, sine bob `Math.sin(Date.now() / 200) * 5`) drawn in `GameEngine.render` for the tank returned by `turnManager.getCurrentPlayer()`.
  - Projectiles inherit tank color (`ownerColor`).
  - Recoil: small temporary chassis displacement opposite firing angle on every shot.
  - Step 5 Tank Spawn Positioning: Randomized X coordinates with shuffled starting order at each round via `spawnTanks` (100px minimum separation safety, 13% width margins, snapped vertically to `Y = groundY`).
  - Step 6 Shell-Tank Collision: Direct AABB collision check in `PhysicsEngine.updateProjectiles` checking against active tank bounding boxes (24x15) with self-sabotage protection at launch (ignores owner's hitbox until it exits it).
  - Step 7 Sniper AI Optimization: Uses a highly accurate numerical trajectory search in `AISniperStrategy.ts` replacing the vacuum trajectory equations. Features deliberate coordinate-shifting miss for the first shot (landing safely ~36px away) and 0-noise perfect hits for subsequent shots.
  - React Doctor DevDependency Cleanup: Removed the unused `react-doctor` devDependency from `package.json` to resolve the `deslop/unused-dev-dependency` warning, achieving a perfect React Doctor score of `100/100`.
  - Projectile Velocity and Range Increase (Option A): Increased the standard `baseSpeed` multiplier from `4.2` to `6.0` in `PhysicsEngine.ts` to allow projectiles at maximum power (POW = 100) to travel from one side of the screen to the other (width 800px) even under adverse wind conditions. Synchronized the constant `BASE_SPEED` to `6.0` in all AI strategy modules (`AISmartStrategy.ts`, `AIHeuristicStrategy.ts`, `AISniperStrategy.ts`) to maintain perfect AI aiming calibration.
  - AI Aiming Correction (Left-side targeting): Fixed a major targeting bug in both `AISmartStrategy.ts` and `AIHeuristicStrategy.ts` where the binary search for power calculations did not account for left-facing shots. Corrected the dichotomy logic to conditionally adjust power boundaries based on the target direction (`isRight`), aligning with the proven logic in `AISniperStrategy.ts`. This restores high aiming accuracy for the Expert (v4) and Heuristic (v2) AIs when firing left, positioning the Expert profile firmly as the 2nd best AI behind the Sniper.
  - Round Transition Hang Fix: Fixed a deadlock where the game would freeze on round transitions if the starting player was an AI. The turn manager's `resumeForCombat` now properly locks input for AI players instead of unconditionally unlocking it, allowing the in-flight async AI turn to execute and fire successfully. Verbose console logs were also added to `TurnManager.ts` to trace AI execution flow.
  - AI Aiming/Trajectory Simulation Origin: Fixed a bug where all AI strategies (Sniper, Heuristic, Smart) simulated their shots starting at the center of the tank `(sx, sy)` instead of the actual barrel tip `(launchX, launchY)`. This created a vertical/horizontal offset discrepancy that caused the Sniper AIs to overshoot and miss perpetually in mutual combat. The simulation coordinates in `AISniperStrategy.ts`, `AIHeuristicStrategy.ts`, and `AISmartStrategy.ts` have been aligned with the engine's launch formulas.
  - AI Terrain Obstacle Avoidance: Implemented a new search penalty (10,000 points) in all ballistic trajectory search loops (`AISniperStrategy`, `AIHeuristicStrategy`, `AISmartStrategy`) when an early collision with the heightmap terrain is detected between the shooter and the target tank. This forces the AI to select high arcing trajectories to clear mountains and obstacles rather than blindly firing directly into intervening hills.
  - New Weapon BULLET: Added the `BULLET` weapon ($150, 10px blast radius) which inflicts a 3x damage multiplier in case of a direct hit on a tank hitbox. Auto-buy is restricted to the `AISniperStrategy` (Sniper v3) profile only.
  - **Merge Compilation Issue (isNewTarget):** Fixed a compilation error (`TS2304: Cannot find name 'isNewTarget'`) in `AISniperStrategy.ts` introduced by a recent merge. The variable `isNewTarget` is now properly defined before updating `mem.currentTargetId`, restoring clean builds and linting.
  - **Internationalization (i18n):** Extracted all hardcoded user-visible strings from components (MainMenu, ColorPicker, TankPreview, GameCanvas, GameHUD, RoundSummary, WeaponShop, WindBanner, and GameEngine canvas text) into English and French translation JSON files. Replaced strings with i18n translation tokens using the useTranslation hook (or global i18n for Canvas engine). Created a retro-styled LanguageSwitcher component to dynamically toggle languages.
  - **Post-Merge Fixes:** Resolved test failures and lint errors after the latest merge. Fixed duplicate test suites in `wind.test.ts` by merging them into a single suite that properly mocks `secureRandom` instead of `Math.random`, and cleaned up unused `afterEach` and `MockInstance` imports to satisfy ESLint. Also resolved unused `TerrainManager` import in `PhysicsEngine.test.ts` and resolved explicit `any` lint errors in `SEO.tsx`.
  - **Terrain Test Lint Fix:** Fixed an ESLint error (`@typescript-eslint/no-explicit-any`) in `src/game/engine/__tests__/Terrain.test.ts` by replacing the `any` cast on the private `heights` property with a typed cast via `unknown as { heights: number[] }`, preserving TS strictness.
  - **Terrain Test Restoration:** Restored checkCollision test suite and beforeEach configurations in Terrain.test.ts that were corrupted during a manual merge conflict resolution.
  - **Game Version Bump:** Bumped game version to `0.3.0` in `package.json` and `package-lock.json`.
  - **React Doctor Clean Code Refactoring:** Fixed all major React Doctor warning types in the project (lifting the score from 72 to 95/100):
    - **Giant Components (`no-giant-component`):** Refactored `MainMenu.tsx` by extracting the player row configuration into a dedicated `PlayerConfigRow.tsx` component. Refactored `GameCanvas.tsx` by extracting game overlays (`GameOverOverlay.tsx`, `GameControlsExplanation.tsx`), AI shop logic (`aiShopHelper.ts`), and the core loop/state handlers into a custom `useGameSession.ts` hook. Both components are now under the 300-line threshold.
    - **State Consolidation (`prefer-useReducer`):** Replaced 11 disparate `useState` calls in `GameCanvas.tsx` with a single unified `useReducer` state machine (`gameCanvasReducer.ts`), reducing unnecessary render churn and structuring game phase transitions.
    - **Ref Cleanup Dependency (`exhaustive-deps`):** Fixed a react-hooks warning by wrapping celebration timer cleanups into stable callbacks and listing them correctly in the hook dependency array, avoiding potential wrong-node reads at unmount time.
    - **Button Types (`button-has-type`):** Added explicit `type="button"` attribute to 7 interactive buttons across `GameCanvas.tsx`, `RoundSummary.tsx`, and `WeaponShop.tsx` to prevent default form submission behaviors.
    - **Array Sorting (`js-tosorted-immutable`):** Optimized sorting performance and syntax by replacing `[...array].sort()` with the native ES2023 `array.toSorted()` in `RoundSummary.tsx`, `AISniperStrategy.ts`, and `AIHeuristicStrategy.ts`.
    - **Chained Array Iterations (`js-combine-iterations`):** Combined a chained `.filter().map()` call inside `MainMenu.tsx` into a single, high-performance loop to collect unavailable colors in a single pass.
    - **Font Size Accessibility (`no-tiny-text`):** Increased compact font sizes (9px, 10px, 11px) to 12px in `PlayerConfigRow.tsx`, `GameCanvas.tsx`, and `MainMenu.tsx` to meet standard accessibility requirements.
  - **Enhanced Fireworks Celebration:** Completely redesigned the end-of-round and match-winning celebrations to launch multicolored rockets from the bottom of the screen alongside the winning tank's barrel shots. Added circular, rainbow, cascade, and crackling willow explosion patterns, trailing smoke paths, and falling swaying confetti. Integrated spatialized chiptune explosion sound effects mapped to horizontal coordinates. Enabled celebration fireworks on every combat round completion.
  - **Tank Destruction Money Rewards:** Added a real-time money reward of $300 immediately given to a player when they destroy another tank. Upon the destruction of the second-to-last tank (leaving exactly one survivor), the last tank standing receives a double reward of $600. The post-round earnings method is simplified to award base survival money only, and translations are updated accordingly.
  - **Weapon Shop State Mutation Fix & Unit Tests:** Fixed a bug in the weapon shop overlay where clicking `+` (buy) or `-` (sell) did not update the stock or money display. The `MUTATE_SHOP_PLAYERS` action in `gameCanvasReducer.ts` was corrected to accept and assign the updated player payload, ensuring proper React state propagation and re-rendering. Added a comprehensive test suite in `src/components/__tests__/gameCanvasReducer.test.ts` to cover all reducer action transitions.
  - **Security Headers & CSP Update:** Added standard HTTP security headers to Cloudflare Pages deployment via a new `public/_headers` file, configuring `Content-Security-Policy`, `Strict-Transport-Security`, and `X-Frame-Options` while explicitly allowing Cloudflare Web Analytics beacon (`https://static.cloudflareinsights.com` for script execution and `https://cloudflareinsights.com` for data transmission). Synchronized the `index.html` CSP meta tag accordingly.

## AI Implementation Rule (Cursor must respect)

- All tank AI **must** implement the `AIEngine` interface (`src/game/entities/ai/AIEngine.ts`).
- The single router is `AIByProfileStrategy` (instantiated in `GameCanvas.tsx` and passed via `engine.setAIEngine`).
- It dispatches based on `player.aiProfile`:
  - `'v1-random'`: `AISimpleStrategy` ("IA SIMPLE" / "Mr. Simple")
  - `'v2-heuristic'`: `AIHeuristicStrategy` ("IA OK")
  - `'v3-sniper'`: `AISniperStrategy` ("IA SNIPER")
  - `'v4-smart'`: `AISmartStrategy` ("IA EXPERT")
- New strategies → new file in `game/entities/ai/`, add to the dispatcher, update MainMenu labels if exposing in UI. Never put AI logic in TankManager/GameEngine.

## Response & Edit Strategy in Cursor

- Be concise and production-ready. Lead with file paths and diffs.
- Prefer small, targeted edits. Use Cursor's apply / search-replace style.
- When the user asks for a feature or bugfix, first explore with project symbols / grep before writing code.
- Always ensure `npm run lint` and `npm run build` would pass after your change.
- For React-heavy work, suggest or run the react-doctor skill.
- Document architectural decisions inline only when they are non-obvious and not already covered in AGENTS.md.

## Commit Style (when Cursor helps generate commits)

- Imperative mood: `Add ownerColor to projectiles for Step 4 harmonization`
- Sign with your agent identity + exact model if applicable.

## Quick Links

- Full agent guidance: [AGENTS.md](./AGENTS.md)
- Grok-specific: [GROK.md](./GROK.md)
- Claude-style: [CLAUDE.md](./CLAUDE.md)
- Original dotfile (may be used by some tools): [.cursorrules](./.cursorrules)

---

Follow AGENTS.md strictly. When in doubt, prefer the strictest interpretation of React/Canvas separation and pluggable AI.


- Use `secureRandom` from `src/utils/random.ts` instead of `Math.random` for all random numbers.
