# Bestter's TankWars — Grok Guide

**Grok agents (xAI):** read [AGENTS.md](./AGENTS.md) first for authoritative layout, commands, verification checklist, common tasks, "what not to do", and Step 4 polish details. This file provides Grok-specific context and quick rules. Overlaps exist with [CLAUDE.md](./CLAUDE.md), [CURSOR.md](./CURSOR.md), and [.cursorrules](./.cursorrules).

## Quick Start for Grok Sessions

- Always begin by reading AGENTS.md + the current file.
- Before any code change that affects visuals or engine: re-read `src/game/engine/GameEngine.ts` (render + fireProjectile), `TankManager.ts` (draw + recoil), `PhysicsEngine.ts` (draw + Projectile).
- After edits: run `npm run lint && npm run build && npm run test` (mandatory per AGENTS; **158 tests**).
- Online work: run `npm run dev` + `npm run worker:dev` together; restart worker after `worker/src/game-room.ts` changes.
- Use imperative commit style and sign with your exact model: e.g. `Add floating active indicator (Step 4) — Grok 4.3 (xAI)`.
- The system prompt identifies you as "Grok 4.3 released by xAI in April 2026".

## Worker folder (`worker/`)

- **Versioned:** `worker/src/index.ts`, `worker/src/game-room.ts`, `worker/wrangler.toml`
- **Gitignored:** `worker/.wrangler/` (local Wrangler SQLite/cache from `wrangler dev`)
- **Role:** REST `/api/rooms` + WS to `GameRoom` DO — lobby, turn relay, `ROUND_END`, shop sync
- **Deploy:** `npm run worker:deploy` (separate from Cloudflare Pages frontend)

## Recent Polish (Step 4, 5, 6 & 7)

- **Durable Object State Persistence:** Implemented transactional state persistence for the `GameRoom` Durable Object using the platform's `storage.get` / `storage.put` API. Asynchronously restores the state on cold starts (via `ctx.blockConcurrencyWhile`), and made the main WS handlers, lobby updates, auto-start, and turn execution asynchronous to safely persist changes after each state mutation. — Antigravity (Gemini 3.5 Flash (High))

- **Cloudflare Worker TypeScript & Type checking:** Integrated type checking for the Cloudflare Worker directory (`worker/`) using a dedicated `worker/tsconfig.json` configuration linked as a project reference in the root `tsconfig.json`. Resolved all typescript compilation errors inside the Durable Object and worker index files (using global types `DurableObjectNamespace` / `DurableObjectState` instead of platform imports, typing the lobby `roster` correctly, and typing the `assignColor` return signature to strict `Color`). — Antigravity (Gemini 3.5 Flash (High))

- **Production deploy option B:** `VITE_API_BASE` + `onlineApi.ts` for workers.dev API; CSP updated. 158 tests. — Grok 4.3 (xAI)

- **Copyright attribution:** Legal footer credits Martin Labelle (EN/FR). — Grok 4.3 (xAI)

- **Game Version Bump:** Bumped game version to `0.5.0` in `package.json` and `package-lock.json`. — Grok 4.3 (xAI)

- **Online Multiplayer Unit Tests:** +16 tests (155 total): onlineSession, GameEngine.online, TurnManager ownerId, Terrain loadHeights. — Grok 4.3 (xAI)

- **Documentation sync (v0.4.2):** All agent docs + README updated (worker/, online, 139 tests, v0.4.2). — Grok 4.3 (xAI)

- **Worker `.gitignore` cleanup:** `worker/.wrangler/` gitignored; removed tracked Wrangler local dev SQLite/cache from index. — Grok 4.3 (xAI)

- **Online Multiplayer Sync & Session Stability:** ROUND_END relay, remote fire by slot, shop WS sync, per-round RNG reseed, GAME_START catch-up, sessionStorage resume, no mid-match lobby return, combat WS reconnect, round 2 server reset. 139 tests. See AGENTS.md. — Grok 4.3 (xAI)
- **Service Worker and CSP Production Load Fix (v0.4.2):** Resolved critical production loading freeze at `tankwars.pages.dev` caused by aggressive Cache-First strategy on `/index.html` (which locked browsers into requests for stale and deleted Vite bundles like `index-CXsrA7Q7.js` that returned 404/HTML). Configured `sw.js` with a robust **Network-First** strategy for navigate requests, and restricted SW fetch interception strictly to local origin (`self.location.origin`) to bypass third-party requests. Fixed service worker crashes by properly propagating network errors (`throw err` instead of returning `undefined` which raised `TypeError`). Added `https://static.cloudflareinsights.com` to `connect-src` in both `public/_headers` and `index.html` to eliminate CSP beacon blocks. Reorganized SPA routing by creating `public/_redirects` and removing the stale `public/_redirects.txt`. Bumped cache version to `"tankwars-v2"`.
- **Basic Online Multiplayer Foundation:** Host creates room with per-player URLs (human slots + optional AI), WS lobby (roster, auto-start), game-phase persistent WS for FIRE → server coordination + SHOT/STATE_UPDATE. Client: localPlayerId gating (TurnManager.isLocalHumanTurn + syncTurn lock), seeded RNG for identical spawns, load server heights. Worker/DO for rooms. CSP for dev worker. Verifs green. See AGENTS.md for details. — Grok 4.3 (xAI)

- **React Doctor GitHub Action Fix:** Removed the invalid `project` parameter from the `millionco/react-doctor@v2` GitHub Action step in `.github/workflows/react-doctor.yml` since it expects a directory path rather than file paths, resolving the directory path error on GitHub CI.
- **Complete Projectile Object Pooling (perf branch):** Wired the `getProjectile` pooling helper (Jules) into launch + cluster split paths in PhysicsEngine; removed duplication. Pool now active for every projectile (prevents GC churn). Fixed build/lint/test issues for clean verification. — Grok 4.3 (xAI)
- **Terrain Partial Redraw Visual Fix (v0.4.1):** Fixed blue vertical lines, cut grass on slopes, and fuzzy fringe from partial offscreen updates (`Terrain.ts`: opaque sky, brown below grass, grass ribbon, sky clip). **113 unit tests**.
- **Game Version Bump:** Bumped game version to `0.4.1` in `package.json` and `package-lock.json`.
- **Performance Optimizations (v0.4.1):** `BallisticsSimulator.ts` shared aiming + lazy v2–v4 AI; terrain partial dirty redraw; HUD throttle + `React.memo`; fireworks 60 Hz / in-place compaction. **112 unit tests** (was 85).
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
- Active turn indicator: inverted triangle above current player tank (via `turnManager.getCurrentPlayer()`), colored with tank primary, vertical bob via the exact formula `Math.sin(Date.now() / 200) * 5`. Drawn late in `GameEngine.render`.
- Projectile harmonization: `ownerColor` added to `Projectile`, set from firer at launch time, used in `PhysicsEngine.draw` (falls back gracefully). Cluster subs inherit it.
- Recoil: lightweight `recoilState` Map in TankManager (dx/dy/remaining frames). `triggerRecoil` called from fire path (opposite angle vector). Decayed in physics `update`. Offset applied to sprite draw position only (chassis "kick").
- Tank positioning (Step 5): Randomized tank X positions with shuffled starting order on canvas with 100px minimum distance safety constraint to avoid overlaps and 13% width margin from left/right edges. Snapped vertically to the terrain heightmap (`Y = groundY`).
- Shell-Tank collision (Step 6): Direct AABB collision check in `PhysicsEngine.updateProjectiles` checking against active tank bounding boxes (24x15) with self-sabotage protection at launch (ignores owner's hitbox until it exits it).
- Sniper AI (Step 7): Highly accurate numerical trajectory search in `AISniperStrategy.ts` replacing the vacuum trajectory equations. Features deliberate coordinate-shifting miss for the first shot (landing safely ~36px away) and 0-noise perfect hits for the second shot onwards.
- React Doctor DevDependency Cleanup: Removed the unused `react-doctor` devDependency from `package.json` to resolve the `deslop/unused-dev-dependency` warning, achieving a perfect React Doctor score of `100/100`.
- Projectile Velocity and Range Increase (Option A): Increased the standard `baseSpeed` multiplier from `4.2` to `6.0` in `PhysicsEngine.ts` to allow projectiles at maximum power (POW = 100) to travel from one side of the screen to the other (width 800px) even under adverse wind conditions. Synchronized the constant `BASE_SPEED` to `6.0` in all AI strategy modules (`AISmartStrategy.ts`, `AIHeuristicStrategy.ts`, `AISniperStrategy.ts`) to maintain perfect AI aiming calibration.
- AI Aiming Correction (Left-side targeting): Fixed a major targeting bug in both `AISmartStrategy.ts` and `AIHeuristicStrategy.ts` where the binary search for power calculations did not account for left-facing shots. Corrected the dichotomy logic to conditionally adjust power boundaries based on the target direction (`isRight`), aligning with the proven logic in `AISniperStrategy.ts`. This restores high aiming accuracy for the Expert (v4) and Heuristic (v2) AIs when firing left, positioning the Expert profile firmly as the 2nd best AI behind the Sniper.
- React Doctor Performance & Styling Fixes: Fixed the top 3 React Doctor warning types in the project:
  - Caching `tank.position` to local references `pos` inside loops in `TankManager.ts` to prevent repeated prototype member access (`js-cache-property-access`).
  - Pre-building a Player `Map` once outside the projectile update loop in `PhysicsEngine.ts` to replace nested `.find()` searches with O(1) key lookups (`js-index-maps`).
  - Moving static inline style blocks in `TankPreview.tsx`, `WindBanner.tsx`, `RoundSummary.tsx`, `GameCanvas.tsx`, `LanguageSwitcher.tsx`, `ColorPicker.tsx`, and `MainMenu.tsx` into unified CSS classes in `src/App.css` to prevent unnecessary objects allocation on every render (`no-inline-exhaustive-style`).
  - Configured React Doctor in CI with a GitHub Actions workflow.
- Round Transition Hang: Fixed a deadlock where the game would freeze on round transitions if the starting player was an AI. The turn manager's `resumeForCombat` now properly locks input for AI players instead of unconditionally unlocking it, allowing the in-flight async AI turn to execute and fire successfully. Verbose console logs were also added to `TurnManager.ts` to trace AI execution flow.
- AI Aiming/Trajectory Simulation Origin: Fixed a bug where all AI strategies (Sniper, Heuristic, Smart) simulated their shots starting at the center of the tank `(sx, sy)` instead of the actual barrel tip `(launchX, launchY)`. This created a vertical/horizontal offset discrepancy that caused the Sniper AIs to overshoot and miss perpetually in mutual combat. The simulation coordinates in `AISniperStrategy.ts`, `AIHeuristicStrategy.ts`, and `AISmartStrategy.ts` have been aligned with the engine's launch formulas.
- AI Terrain Obstacle Avoidance: Implemented a new search penalty (10,000 points) in all ballistic trajectory search loops (`AISniperStrategy`, `AIHeuristicStrategy`, `AISmartStrategy`) when an early collision with the heightmap terrain is detected between the shooter and the target tank. This forces the AI to select high arcing trajectories to clear mountains and obstacles rather than blindly firing directly into intervening hills.
- New Weapon BULLET: Added the `BULLET` weapon ($150, 10px blast radius) which inflicts a 3x damage multiplier in case of a direct hit on a tank hitbox. Auto-buy is restricted to the `AISniperStrategy` (Sniper v3) profile only.
- **Merge Compilation Issue (isNewTarget):** Fixed a compilation error (`TS2304: Cannot find name 'isNewTarget'`) in `AISniperStrategy.ts` introduced by a recent merge. The variable `isNewTarget` is now properly defined before updating `mem.currentTargetId`, restoring clean builds and linting.
- **Internationalization (i18n):** Extracted all hardcoded user-visible strings from components (MainMenu, ColorPicker, TankPreview, GameCanvas, GameHUD, RoundSummary, WeaponShop, WindBanner, and GameEngine canvas text) into English and French translation JSON files. Replaced strings with i18n translation tokens using the useTranslation hook (or global i18n for Canvas engine). Created a retro-styled LanguageSwitcher component to dynamically toggle languages.
- **Post-Merge Fixes:** Resolved test failures and lint errors after the latest merge. Fixed duplicate test suites in `wind.test.ts` by merging them into a single suite that properly mocks `secureRandom` instead of `Math.random`, and cleaned up unused `afterEach` and `MockInstance` imports to satisfy ESLint. Also resolved unused `TerrainManager` import in `PhysicsEngine.test.ts` and resolved explicit `any` lint errors in `SEO.tsx`.
- **Terrain Test Lint Fix:** Fixed an ESLint error (`@typescript-eslint/no-explicit-any`) in `src/game/engine/__tests__/Terrain.test.ts` by replacing the `any` cast on the private `heights` property with a typed cast via `unknown as { heights: number[] }`, preserving TS strictness.
- **Terrain Test Restoration:** Restored checkCollision test suite and beforeEach configurations in Terrain.test.ts that were corrupted during a manual merge conflict resolution.
- Game Version Bump: Bumped game version to `0.3.0` in `package.json` and `package-lock.json`.
- React Doctor Clean Code Refactoring: Fixed all major React Doctor warning types in the project (lifting the score from 72 to 95/100):
  - Giant Components (`no-giant-component`): Refactored `MainMenu.tsx` by extracting the player row configuration into a dedicated `PlayerConfigRow.tsx` component. Refactored `GameCanvas.tsx` by extracting game overlays (`GameOverOverlay.tsx`, `GameControlsExplanation.tsx`), AI shop logic (`aiShopHelper.ts`), and the core loop/state handlers into a custom `useGameSession.ts` hook. Both components are now under the 300-line threshold.
  - State Consolidation (`prefer-useReducer`): Replaced 11 disparate `useState` calls in `GameCanvas.tsx` with a single unified `useReducer` state machine (`gameCanvasReducer.ts`), reducing unnecessary render churn and structuring game phase transitions.
  - Ref Cleanup Dependency (`exhaustive-deps`): Fixed a react-hooks warning by wrapping celebration timer cleanups into stable callbacks and listing them correctly in the hook dependency array, avoiding potential wrong-node reads at unmount time.
  - Button Types (`button-has-type`): Added explicit `type="button"` attribute to 7 interactive buttons across `GameCanvas.tsx`, `RoundSummary.tsx`, and `WeaponShop.tsx` to prevent default form submission behaviors.
  - Array Sorting (`js-tosorted-immutable`): Optimized sorting performance and syntax by replacing `[...array].sort()` with the native ES2023 `array.toSorted()` in `RoundSummary.tsx`, `AISniperStrategy.ts`, and `AIHeuristicStrategy.ts`.
  - Chained Array Iterations (`js-combine-iterations`): Combined a chained `.filter().map()` call inside `MainMenu.tsx` into a single, high-performance loop to collect unavailable colors in a single pass.
  - Font Size Accessibility (`no-tiny-text`): Increased compact font sizes (9px, 10px, 11px) to 12px in `PlayerConfigRow.tsx`, `GameCanvas.tsx`, and `MainMenu.tsx` to meet standard accessibility requirements.
- Enhanced Fireworks Celebration: Completely redesigned the end-of-round and match-winning celebrations to launch multicolored rockets from the bottom of the screen alongside the winning tank's barrel shots. Added circular, rainbow, cascade, and crackling willow explosion patterns, trailing smoke paths, and falling swaying confetti. Integrated spatialized chiptune explosion sound effects mapped to horizontal coordinates. Enabled celebration fireworks on every combat round completion.
- Tank Destruction Money Rewards: Added a real-time money reward of $300 immediately given to a player when they destroy another tank. Upon the destruction of the second-to-last tank (leaving exactly one survivor), the last tank standing receives a double reward of $600. The post-round earnings method is simplified to award base survival money only, and translations are updated accordingly.
- **Weapon Shop State Mutation Fix & Unit Tests:** Fixed a bug in the weapon shop overlay where clicking `+` (buy) or `-` (sell) did not update the stock or money display. The `MUTATE_SHOP_PLAYERS` action in `gameCanvasReducer.ts` was corrected to accept and assign the updated player payload, ensuring proper React state propagation and re-rendering. Added a comprehensive test suite in `src/components/__tests__/gameCanvasReducer.test.ts` to cover all reducer action transitions.
- **Security Headers & CSP Update:** Added standard HTTP security headers to Cloudflare Pages deployment via a new `public/_headers` file, configuring `Content-Security-Policy`, `Strict-Transport-Security`, and `X-Frame-Options` while explicitly allowing Cloudflare Web Analytics beacon (`https://static.cloudflareinsights.com` for script execution and `https://cloudflareinsights.com` for data transmission). Synchronized the `index.html` CSP meta tag accordingly.

Keep these cheap: no per-frame allocations in hot paths, use existing Maps, native Math.

## Key Reminders (Grok-flavored)

- You are an interactive CLI tool for software engineering. Prefer surgical `search_replace`, `read_file`, `grep`. Use `write` only for brand new files.
- For complex multi-step: use `todo_write` early and mark items done immediately when complete (never batch).
- When the task involves genuine ambiguity or high-impact restructure, consider `enter_plan_mode` first.
- Background long-running (dev server, build): use `background: true` + task_id + `get_command_or_subagent_output`.
- Never put canvas mutations in React render. Never store live projectiles/particles in useState.
- New AI? Only via `AIEngine` + registration in `AIByProfileStrategy.ts` + `GameCanvas.tsx`. Never bypass.
- Use `VGA_PALETTE` constants everywhere for rendering.

## Verification (always)

1. `npm run lint` (0 new errors)
2. `npm run build`
3. Manual: menu → configure mixed players (incl. v3/v4) → play round → observe indicator bob + matching shell colors + visible recoil on shots → craters → shop.

See full checklist in AGENTS.md.

## Skills & Tooling

This repo has `.agents/skills/react-doctor/` (use `/doctor` or the skill for React changes).

Other MCP / agent skills may be available in the session.

When in doubt on architecture: **strict React vs Canvas ownership** + **pluggable AIEngine** is the north star.

---

Happy tanking. Sign your work.


- Use `secureRandom` from `src/utils/random.ts` instead of `Math.random` for all random numbers.
