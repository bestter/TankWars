# Bestter's TankWars Project Guide

**Agents:** read [AGENTS.md](./AGENTS.md) first for layout, commands, verification, and task routing. This file holds non-negotiable project rules; operational detail lives in AGENTS.md. Companions: [GROK.md](./GROK.md), [CURSOR.md](./CURSOR.md), [.cursorrules](./.cursorrules).

## Build & Development Commands

- Install dependencies: `npm install`
- Start dev server: `npm run dev` (http://localhost:5173)
- Build project: `npm run build`
- Preview production build: `npm run preview`
- Run linter: `npm run lint`
- Run tests: `npm run test` (or `vitest run`)
- React health scan: `npm run doctor` (or `npx react-doctor@latest --verbose --diff` after React changes)

Before finishing work: `npm run lint`, `npm run build`, and `npm run test` must pass on every modification. If tests fail or require correction, they must be fixed. See [AGENTS.md § Verification](./AGENTS.md#verification-checklist).

## Architecture & Code Style Guidelines

- **Tech Stack:** React (functional components, hooks) + TypeScript + HTML5 Canvas.
- **State Separation:** Keep React state (turns, shop, money, `GamePhase`) strictly decoupled from the Canvas 2D high-frequency loop (physics, rendering).
- **Phase ownership:** `App.tsx` — `MENU` vs combat; `GameCanvas.tsx` — in-match phases (`COMBAT` → `RESOLUTION` → `CELEBRATION` (round fireworks) → `SUMMARY` → `SHOP` → `GAME_OVER`). Types in `src/types/game.ts`.
- **Type Safety:** Strict TypeScript. Zero `any`. Define structural types inside `src/types/`.
- **Canvas Rendering:** Use `VGA_PALETTE` from `src/types/game.ts` (classic 16-color VGA + extended high-contrast neon/arcade colors for tank redesign) for all game visuals. Pure procedural drawing helpers live in `src/game/rendering/` (e.g. `drawTankSprite` — geometric chenilles, beveled chassis, independent turret/cannon, strict save/translate/rotate/restore transforms) and are integrated into the 120Hz engine loop (scaled up to 24x15 with matching hitboxes) with slope-aware chassis tilt.
- **Step 4 Visual Polish (in engine):** Floating active-player indicator (colored inverted triangle, `Math.sin(Date.now()/200)*5` bob) drawn in `GameEngine.render`; projectiles use firer tank color via `ownerColor`; micro recoil (chassis offset opposite barrel) in `TankManager` + trigger from `GameEngine.fireProjectile`. All pure Canvas2D, cheap per-frame.
- **Step 5 Tank Positioning:** Randomized spawn coordinates with shuffled starting order at each new round via `spawnTanks` in `TankManager` (100px minimum distance safety, 13% width margins, snapped vertically to `Y = groundY` surface).
- **Step 6 Shell-Tank Collision:** Direct AABB shell-to-tank collision checking in `PhysicsEngine.updateProjectiles` (24x15 hitbox) with launch-time self-sabotage protection (ignores owner's hitbox until projectile exits it). Triggers explosions, damage, and projectile cleanup.
- **Terrain Logic:** Custom destructible terrain (heightmap in `Terrain.ts`; optional `ImageData`-style mutations). No external physics engines.

## AI Strategy Pattern (Crucial)

- Tank AI must implement **`AIEngine`** (`src/game/entities/ai/AIEngine.ts`). Wire strategies in `GameCanvas.tsx` via `engine.setAIEngine(...)` (uses `AIByProfileStrategy` router).
- **Phase 1:** `AISimpleStrategy` — deliberately naive ("IA SIMPLE" / "Mr. Simple"). Menu/profile label: `aiProfile: 'v1-random'`.
- **Phase 2:** `AIHeuristicStrategy` ("IA OK"). Heuristic aiming (wind, terrain sampling, ballistic search), revenge targeting (`lastHitBy`), per-round memory + precision improvement on targets, smart weapon selection. Menu/profile label: `aiProfile: 'v2-heuristic'`.
- **Phase 3:** `AISniperStrategy` ("IA SNIPER") — high-precision sniper using numerical trajectory search under drag and wind (Step 7 complete). First shot features deliberate coordinate-shifting miss; second shot targets tank directly with 0 noise. Menu/profile label: `aiProfile: 'v3-sniper'`.
- **Phase 4:** `AISmartStrategy` ("IA EXPERT"). Adaptive. `aiProfile: 'v4-smart'`.
- Full support for mixed profiles in one match. Do not entangle AI inside `TankManager` or `GameEngine`.
- **Legacy:** `AIStrategy` is an older contract and is not wired at runtime unless explicitly revived.

## Error Prevention

- Never modify HTML5 canvas properties directly inside a React render cycle; always pass updates through refs or dedicated game engine methods.
- Do not store per-frame simulation data (projectiles, particles, raw terrain pixels) in React state.

## Recent Updates & Bug Fixes

- **React Doctor GitHub Action Fix:** Removed the invalid `project` parameter from the `millionco/react-doctor@v2` GitHub Action step in `.github/workflows/react-doctor.yml` since it expects a directory path rather than file paths, resolving the directory path error on GitHub CI.
- **Complete Projectile Object Pooling (perf branch):** Wired Jules' `getProjectile` helper into `launchProjectile` + `splitCluster` (PhysicsEngine.ts), removing duplicated pool logic. All shots and clusters now recycle via the pool (GC reduction). Fixed build TS error, lint `any`, and fireworks test flakiness. lint+build+test (130) all green. — Grok 4.3 (xAI)
- **Terrain Partial Redraw Visual Fix (v0.4.1):** Fixed blue vertical lines, jagged grass on curves, and fuzzy brown/green fringe after partial offscreen crater redraws. Layered offscreen paint: opaque sky, brown columns below grass ribbon, smooth grass polygon, `clipSkyAboveSurface`. **113 unit tests**.
- **Game Version Bump:** Bumped game version to `0.4.1` in `package.json` and `package-lock.json`.
- **Performance Optimizations (v0.4.1):** Shared `BallisticsSimulator.ts` (two-phase search, early exit, lazy-loaded v2–v4 AI chunks); terrain partial dirty-band offscreen redraw; HUD throttle (~15 Hz) + `React.memo` on `GameHUD`/`MobileControls` (fixed throttle timer cleanup in `removeInputListeners`); fireworks 60 Hz tick with in-place compaction and 250-particle cap.
- **Expanded Test Coverage (112 tests):** Added ballistic, AI dispatcher, strategy smoke, fireworks, terrain dirty-band, and HUD throttle unit tests; shared helpers in `src/game/__tests__/helpers.ts`.
- **Game Version Bump:** Bumped game version to `0.4.0` in `package.json` and `package-lock.json`.
- **Support Mobile et PWA :** Ajout de contrôles tactiles virtuels réactifs (D-Pad pour l'angle, D-Pad pour la puissance, tir direct, changement d'arme) avec support du maintien prolongé (press & hold) pour le défilement rapide sous le canvas de combat. Intégration PWA complète avec un manifeste (`manifest.json`) configuré pour le mode plein écran paysage (`standalone` + `landscape`) et un Service Worker (`sw.js`) gérant le cache hors-ligne et l'installabilité sur l'écran d'accueil mobile. Métadonnées Apple iOS intégrées dans `index.html` pour masquer les barres du navigateur Safari.
- **AI Baby Nuke & Thermonuclear Usage Restriction:** Reduced the frequency and overuse of `NUKE` (Baby Nuke) and `THERMONUCLEAR` weapons by AI players. Lowered their purchase priorities in the automatic shop by moving them to the end of the preference list in [aiShopHelper.ts](file:///D:/projects/Repos/TankWars/src/game/entities/ai/aiShopHelper.ts). Restricted their combat selection in [AISmartStrategy.ts](file:///D:/projects/Repos/TankWars/src/game/entities/ai/AISmartStrategy.ts) and [AIHeuristicStrategy.ts](file:///D:/projects/Repos/TankWars/src/game/entities/ai/AIHeuristicStrategy.ts) by requiring a minimum health threshold on targets (40 HP for Nuke, 50 HP for Thermonuclear) to prevent waste on near-dead tanks, and introducing a random probability hurdle (35% selection chance for Nuke, 30% for Thermonuclear).
- **Production Console Log Suppression:** Disabled all non-error console outputs (`console.log`, `warn`, `info`, `debug`, `trace`, `group`, etc.) in production builds by overriding them at the `src/main.tsx` entry point when `import.meta.env.PROD` is true, ensuring clean production console environments.
- **Custom Analytics Events via Cloudflare Zaraz:** Created `analytics.ts` utility to send custom events to Cloudflare Zaraz (`window.zaraz.track`). Integrated tracking for `game_start` (tracking players, human/AI count, and chosen AI profiles), `round_end` (tracking round number, winner type, and winner AI profile), and `game_over` (tracking overall winner, winner type/profile, and total rounds). Added comprehensive unit tests in `analytics.test.ts`.
- **Randomized Tank Starting Order:** Modified `spawnTanks` in `TankManager.ts` to shuffle the generated X positions using a secure Fisher-Yates shuffle algorithm. This ensures that the horizontal starting order of the tanks varies randomly on every round, preventing players (e.g. Player 1) from always spawning in the same relative horizontal order (e.g. always on the far left). Added comprehensive unit tests in `TankManager.test.ts`.
- **Game Version Bump:** Bumped game version to `0.3.4` in `package.json` and `package-lock.json`.
- **Version Display on Main Menu:** Imported game version from `package.json` and added it to the footer of `MainMenu.tsx` beside the license notice (e.g. `v0.3.4`).
- **Bullet and Nuke Direct Hit Damage Fix:** Fixed a major bug where direct hits with the `BULLET` and `NUKE` weapons were often ignored or severely penalized. Bypassed the splash `distance > radius` check and linear falloff for direct hits on the target tank's bounding box, ensuring `BULLET` deals its intended 3x damage multiplier (75 dmg) and `NUKE` instantly destroys the target.
- **Content Security Policy (CSP) Update:** Allowed Cloudflare Web Analytics script (`https://static.cloudflareinsights.com`) inside the `script-src` directive in `index.html` to resolve console security violations.
- **React Doctor DevDependency Cleanup:** Removed the unused `react-doctor` devDependency from `package.json` to resolve the `deslop/unused-dev-dependency` warning, achieving a perfect React Doctor score of `100/100`.
- **Projectile Velocity and Range Increase (Option A):** Increased the standard `baseSpeed` multiplier from `4.2` to `6.0` in `PhysicsEngine.ts` to allow projectiles at maximum power (POW = 100) to travel from one side of the screen to the other (width 800px) even under adverse wind conditions. Synchronized the constant `BASE_SPEED` to `6.0` in all AI strategy modules (`AISmartStrategy.ts`, `AIHeuristicStrategy.ts`, `AISniperStrategy.ts`) to maintain perfect AI aiming calibration.
- **AI Aiming Correction (Left-side targeting):** Fixed a major targeting bug in both `AISmartStrategy.ts` and `AIHeuristicStrategy.ts` where the binary search for power calculations did not account for left-facing shots. Corrected the dichotomy logic to conditionally adjust power boundaries based on the target direction (`isRight`), aligning with the proven logic in `AISniperStrategy.ts`. This restores high aiming accuracy for the Expert (v4) and Heuristic (v2) AIs when firing left, positioning the Expert profile firmly as the 2nd best AI behind the Sniper.
- **React Doctor Performance & Styling Fixes:** Fixed the top 3 React Doctor warning types in the project:
  - Caching `tank.position` to local references `pos` inside loops in `TankManager.ts` to prevent repeated prototype member access (`js-cache-property-access`).
  - Pre-building a Player `Map` once outside the projectile update loop in `PhysicsEngine.ts` to replace nested `.find()` searches with O(1) key lookups (`js-index-maps`).
  - Moving static inline style blocks in `TankPreview.tsx`, `WindBanner.tsx`, `RoundSummary.tsx`, `GameCanvas.tsx`, `LanguageSwitcher.tsx`, `ColorPicker.tsx`, and `MainMenu.tsx` into unified CSS classes in `src/App.css` to prevent unnecessary objects allocation on every render (`no-inline-exhaustive-style`).
  - Configured React Doctor in CI with a GitHub Actions workflow.
- **New Weapon BULLET:** Added the `BULLET` weapon ($150, 10px blast radius) which inflicts a 3x damage multiplier in case of a direct hit on a tank hitbox. Auto-buy is restricted to the `AISniperStrategy` (Sniper v3) profile only.
- **Round Transition Hang:** Fixed a deadlock where the game would freeze on round transitions if the starting player was an AI. The turn manager's `resumeForCombat` now properly locks input for AI players instead of unconditionally unlocking it, allowing the in-flight async AI turn to execute and fire successfully. Verbose console logs were also added to `TurnManager.ts` to trace AI execution flow.
- **AI Aiming/Trajectory Simulation Origin:** Fixed a bug where all AI strategies (Sniper, Heuristic, Smart) simulated their shots starting at the center of the tank `(sx, sy)` instead of the actual barrel tip `(launchX, launchY)`. This created a vertical/horizontal offset discrepancy that caused the Sniper AIs to overshoot and miss perpetually in mutual combat. The simulation coordinates in `AISniperStrategy.ts`, `AIHeuristicStrategy.ts`, and `AISmartStrategy.ts` have been aligned with the engine's launch formulas.
- **AI Terrain Obstacle Avoidance:** Implemented a new search penalty (10,000 points) in all ballistic trajectory search loops (`AISniperStrategy`, `AIHeuristicStrategy`, `AISmartStrategy`) when an early collision with the heightmap terrain is detected between the shooter and the target tank. This forces the AI to select high arcing trajectories to clear mountains and obstacles rather than blindly firing directly into intervening hills.
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

## Commit style

- Always sign your comments by your name, and your EXACT model name for each commit.
- Use IMPERATIVE mood for commit messages.

- Use `secureRandom` from `src/utils/random.ts` instead of `Math.random` for all random numbers.
