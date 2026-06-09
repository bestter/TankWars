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
- Step 4, 5, 6 & 7 Polish (recent): 
  - **Version Display on Main Menu:** Imported game version from `package.json` and added it to the footer of `MainMenu.tsx` beside the license notice (e.g. `v0.2.0`).
  - **Content Security Policy (CSP) Update:** Allowed Cloudflare Web Analytics script (`https://static.cloudflareinsights.com`) inside the `script-src` directive in `index.html` to resolve console security violations.
  - Active Player floating indicator (inverted triangle, player color, sine bob `Math.sin(Date.now() / 200) * 5`) drawn in `GameEngine.render` for the tank returned by `turnManager.getCurrentPlayer()`.
  - Projectiles inherit tank color (`ownerColor`).
  - Recoil: small temporary chassis displacement opposite firing angle on every shot.
  - Step 5 Tank Spawn Positioning: Randomized X coordinates at each round via `spawnTanks` (100px minimum separation safety, 13% width margins, snapped vertically to `Y = groundY`).
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
  - **Game Version Bump:** Bumped game version to `0.2.0` in `package.json` and `package-lock.json`.
  - **React Doctor Clean Code Refactoring:** Fixed all major React Doctor warning types in the project (lifting the score from 72 to 95/100):
    - **Giant Components (`no-giant-component`):** Refactored `MainMenu.tsx` by extracting the player row configuration into a dedicated `PlayerConfigRow.tsx` component. Refactored `GameCanvas.tsx` by extracting game overlays (`GameOverOverlay.tsx`, `GameControlsExplanation.tsx`), AI shop logic (`aiShopHelper.ts`), and the core loop/state handlers into a custom `useGameSession.ts` hook. Both components are now under the 300-line threshold.
    - **State Consolidation (`prefer-useReducer`):** Replaced 11 disparate `useState` calls in `GameCanvas.tsx` with a single unified `useReducer` state machine (`gameCanvasReducer.ts`), reducing unnecessary render churn and structuring game phase transitions.
    - **Ref Cleanup Dependency (`exhaustive-deps`):** Fixed a react-hooks warning by wrapping celebration timer cleanups into stable callbacks and listing them correctly in the hook dependency array, avoiding potential wrong-node reads at unmount time.
    - **Button Types (`button-has-type`):** Added explicit `type="button"` attribute to 7 interactive buttons across `GameCanvas.tsx`, `RoundSummary.tsx`, and `WeaponShop.tsx` to prevent default form submission behaviors.
    - **Array Sorting (`js-tosorted-immutable`):** Optimized sorting performance and syntax by replacing `[...array].sort()` with the native ES2023 `array.toSorted()` in `RoundSummary.tsx`, `AISniperStrategy.ts`, and `AIHeuristicStrategy.ts`.
    - **Chained Array Iterations (`js-combine-iterations`):** Combined a chained `.filter().map()` call inside `MainMenu.tsx` into a single, high-performance loop to collect unavailable colors in a single pass.
    - **Font Size Accessibility (`no-tiny-text`):** Increased compact font sizes (9px, 10px, 11px) to 12px in `PlayerConfigRow.tsx`, `GameCanvas.tsx`, and `MainMenu.tsx` to meet standard accessibility requirements.
  - **Enhanced Fireworks Celebration:** Completely redesigned the end-of-round and match-winning celebrations to launch multicolored rockets from the bottom of the screen alongside the winning tank's barrel shots. Added circular, rainbow, cascade, and crackling willow explosion patterns, trailing smoke paths, and falling swaying confetti. Integrated spatialized chiptune explosion sound effects mapped to horizontal coordinates. Enabled celebration fireworks on every combat round completion.

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
