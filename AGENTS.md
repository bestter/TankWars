# AGENTS.md — TankWars

Guidance for AI coding agents working in **Bestter's TankWars** (`bestters-tankwars`). Read this file first. Human-oriented overview: [README.md](./README.md). Overlapping rules also appear in [CLAUDE.md](./CLAUDE.md), [GROK.md](./GROK.md), [CURSOR.md](./CURSOR.md), and [.cursorrules](./.cursorrules).

## GOLDEN RULES

- You must always answer in French (FR). If you can speak in Canadian-French (fr-CA, québécois) it's even better!
-- If the user paste some code or text in english, answer in french (or québécois).
- IF ANY DOUBT, ASK THE DEVELOPER BEFORE DOING ANYTHING; NEVER GUESS!!!
- DO NOT MODIFY THIS FILE, UNLESS YOU HAVE AN EXPLICIT INSTRUCTION FROM THE DEVELOPER TO DO SO.
-

## Project summary

Browser-based artillery game (Scorched Earth / Worms style): destructible terrain, turn-based combat, weapon shop economy, 2–4 players (human or AI). **React 19 + TypeScript (strict) + HTML5 Canvas 2D**. No game frameworks, no external physics engines.

## Commands

| Task | Command |
|------|---------|
| Install | `npm install` |
| Dev server | `npm run dev` → <http://localhost:5173> |
| Production build | `npm run build` |
| Lint | `npm run lint` |
| Preview build | `npm run preview` |
| React health scan | `npm run doctor` or `npx react-doctor@latest --verbose --diff` after React changes |

Verify changes with `npm run lint` and `npm run build` before finishing. Prefer fixing lint warnings you introduce; do not drive-by refactor unrelated warnings.

## Repository layout

```
src/
├── App.tsx                 # Top-level phase: MENU vs combat (mounts GameCanvas)
├── main.tsx
├── types/                  # Single source of truth (game, player, weapon) — zero `any`
├── components/
│   ├── MainMenu.tsx        # Player count, names, Human / IA Simple / IA OK / IA SNIPER / IA EXPERT (v1-v4 profiles)
│   ├── GameCanvas.tsx      # Canvas ref + GameEngine lifecycle + React phase overlays
│   ├── GameHUD.tsx
│   ├── WeaponShop.tsx
│   ├── RoundSummary.tsx
│   ├── ColorPicker.tsx     # Pre-game color selection (mutual exclusion)
│   ├── TankPreview.tsx     # Live tank sprite preview in lobby
│   └── WindBanner.tsx
└── game/
    ├── engine/
    │   ├── GameEngine.ts   # 120Hz loop: physics, render, terrain, projectiles, active indicator, recoil
    │   ├── PhysicsEngine.ts
    │   ├── Terrain.ts      # Heightmap + crater destruction
    │   └── TurnManager.ts
    ├── rendering/
    │   └── tankSprite.ts   # Pure `drawTankSprite()` (Canvas2D only) — chenilles, beveled chassis, dome turret, independent cannon (integrated visual tank redesign Step 1-4)
    └── entities/
        ├── TankManager.ts  # Tank state, draw (with recoil offsets), spawn, damage, gravity
        └── ai/
            ├── AIEngine.ts             # Strategy contract — implement this for new AI
            ├── AIByProfileStrategy.ts  # Dispatcher selecting per-player aiProfile (v1/v2/v3/v4)
            ├── AIHeuristicStrategy.ts  # Phase 2 "IA OK" (v2-heuristic) — wind/terrain aware, revenge, memory, precision
            ├── AISimpleStrategy.ts     # Phase 1 naive (v1-random) "IA SIMPLE" / "Mr. Simple"
            ├── AISniperStrategy.ts     # Phase 3 "IA SNIPER" (v3-sniper) — high precision
            ├── AISmartStrategy.ts      # Phase 4 "IA EXPERT" (v4-smart) — adaptive
            └── AIStrategy.ts
```

## Architecture (non-negotiable)

### React vs Canvas

| Layer | Owns | Must not |
|-------|------|----------|
| **React** (`App`, `GameCanvas`, components) | `GamePhase`, players, money, shop, HUD, turn UI, overlays | Touch canvas context or pixel data inside `render()` |
| **GameEngine** (canvas loop) | Physics, projectiles, wind integration, terrain mutation, drawing | Hold React state or call `setState` from the rAF loop |

- Mount `<canvas>` only when leaving `MENU` (`App.tsx` unmounts canvas on menu for resource savings).
- Pass input and config into the engine via **refs** and engine methods/callbacks registered in `useEffect` (see `GameCanvas.tsx`).
- Physics uses a **fixed timestep** decoupled from display refresh.

### Game phase machine

Types live in `src/types/game.ts`:

`MENU` → `COMBAT` → `RESOLUTION` → `CELEBRATION` (round winner fireworks) → `SUMMARY` → `SHOP` → … → `GAME_OVER`

- `App.tsx`: `MENU` vs everything else (starts match with `Player[]` from `MainMenu`).
- `GameCanvas.tsx`: in-match phases (incl. CELEBRATION), shop, round summary, game over.

### Visual & terrain rules

- Use **`VGA_PALETTE`** from `src/types/game.ts` for all game rendering (classic 16-color VGA + extended high-contrast arcade/neon colors: ELECTRIC_CYAN, FLASH_GREEN, NEON_PINK, CYBER_YELLOW, FLUO_ORANGE, VOLT_PURPLE, etc. for tank redesign).
- Tank rendering: pure procedural helper `drawTankSprite(ctx, x, y, width, height, angle, turretAngle, primaryColor)` in `src/game/rendering/tankSprite.ts` (geometric retro style, textured tracks/chenilles, beveled chassis using primaryColor, arc dome turret, thick cannon with independent turretAngle rotation via save/translate/rotate/restore). Fully integrated into the 120 Hz engine render loop (scaled up to 24x15 with matching hitboxes) with dynamic slope-aware chassis tilt.
- **Visual polish (Step 4 complete)**:
  - Active Player Indicator in `GameEngine.render`: small inverted floating triangle (flèche) above the current turn's tank (from `turnManager.getCurrentPlayer()`), bobbing with `Math.sin(Date.now() / 200) * 5`, filled with the active player's primary tank color.
  - Harmonized projectiles: shells (and cluster sub-munitions) in `PhysicsEngine.draw` inherit `ownerColor` (tank primary color) from the firing player instead of generic weapon/white. Color threaded via `Projectile.ownerColor` set at `fireProjectile` time.
  - Micro recoil (arcade feel): `TankManager` maintains transient `recoilState` (per tankId, world dx/dy + frame remaining). Triggered in `GameEngine.fireProjectile` (opposite barrel direction, ~2.8px). Decayed in `update()`. Applied only to chassis sprite position in `draw` (UI bars/names anchored); cleared on round transitions.
- **Tank positioning (Step 5 complete)**: Tank positions are fully randomized at each new round via `spawnTanks` using rejection sampling (`generateRandomPositions` with 100px minimum distance and 13% width safety margins from the screen edges). Vertical positions are snapped exactly to the heightmap terrain surface (`Y = groundY`), maintaining correct physical alignment at spawn.
- **Shell-Tank Collision (Step 6 complete)**: Implemented direct AABB (Axis-Aligned Bounding Box) shell-to-tank collision detection in `PhysicsEngine.updateProjectiles` checking against active tank bounding boxes (`24x15` scaled, offset by `height` from terrain ground pivot). Features launch-time self-sabotage protection (projectile ignores own tank's hitbox until it exits it). Triggers terrain cratering, damage application, and projectile removal.
- Terrain: custom **heightmap** algorithms in `Terrain.ts`; circular craters with falloff. No Matter.js, Rapier, Phaser, etc.
- Styling: monospace retro aesthetic; inline styles + `App.css` / `index.css` (no UI kit dependency in repo).

### TypeScript

- Strict mode. **No `any`.**
- New shared types → `src/types/`.
- Prefer `readonly` on command/snapshot interfaces where already used (`FireCommand`, etc.).

## AI system

All tank AI must implement `AIEngine` (`src/game/entities/ai/AIEngine.ts`):

```ts
executeTurn(tankId, gameState, terrainManager): Promise<{ angle: number; power: number; weaponId?: WeaponId }>
getResolutionFallback?(): { angle: number; power: number } | null  // sync bailout
```

- **Phase 1:** `AISimpleStrategy` (menu `aiProfile: 'v1-random'`, "IA SIMPLE" / "Mr. Simple") — deliberately naive random-within-safe-ranges for architecture testing.
- **Phase 2:** `AIHeuristicStrategy` (menu `aiProfile: 'v2-heuristic'`, "IA OK") — wind/terrain-aware heuristic aiming, revenge targeting (`lastHitBy`), per-round memory + precision ramp, smart weapon selection (e.g. GRENADE on rough, CLUSTER vs groups). Not a one-shot sniper (kills typically take 3+ shots).
- **Phase 3:** `AISniperStrategy` (menu `aiProfile: 'v3-sniper'`, "IA SNIPER") — high-precision aiming using numerical trajectory search under drag/wind, with a deliberate coordinate-shifting first-shot miss and perfect subsequent shots.
- **Phase 4:** `AISmartStrategy` (menu `aiProfile: 'v4-smart'`, "IA EXPERT") — adaptive / improved heuristic with bias learning.
- A single `AIByProfileStrategy` (registered in `GameCanvas.tsx`) dispatches per-player based on `aiProfile` (supports mixed Human + different AI types; falls back to v1).
- New strategies must be registered in `GameCanvas.tsx` (via the profile dispatcher); do not entangle AI logic inside `TankManager` or `GameEngine` internals.
- Supporting data: `aiProfile` on `Player`, `lastHitBy` on `Tank`, `windForce`/`gravity` on `GameState` snapshots for AI.

## Common tasks — where to edit

| Goal | Primary files |
|------|----------------|
| Menu / player setup | `MainMenu.tsx`, `types/player.ts` (supports all: IA SIMPLE/v1, IA OK/v2, IA SNIPER/v3, IA EXPERT/v4) + ColorPicker / TankPreview |
| New weapon | `types/weapon.ts`, GameEngine (sounds + VFX/particles for large weapons), PhysicsEngine/TankManager (special damage/projectile rules), HUD/shop, GameCanvas (AI buy lists) |
| Turn / round flow | `TurnManager.ts`, `GameCanvas.tsx` |
| Physics / explosions | `PhysicsEngine.ts`, `GameEngine.ts` |
| Terrain generation / craters | `Terrain.ts` |
| Tank visual / procedural sprite + Step 4 polish | `game/rendering/tankSprite.ts`, `TankManager.ts` (recoil + draw), `GameEngine.ts` (render indicator + fire recoil trigger + color lookup), `PhysicsEngine.ts` (ownerColor on projectiles) |
| Smarter AI | New file under `game/entities/ai/`, implement `AIEngine`; register in `AIByProfileStrategy.ts` + `GameCanvas.tsx` |
| Global match phase | `App.tsx`, `types/game.ts` |

## What agents must not do

- Add external physics or game engines.
- Put canvas drawing or `getContext` mutations in React render paths.
- Store live `ImageData`, particle arrays, or projectile lists in React `useState` updated every frame.
- Expand scope with unrelated refactors, new markdown docs, or dependency churn unless asked.
- Weaken TypeScript strictness or introduce `any` for convenience.

## Verification checklist

After substantive changes:

1. `npm run lint` — no new errors.
2. `npm run build` — TypeScript + Vite succeed.
3. If React/UI touched: `npx react-doctor@latest --verbose --diff` — score should not regress (see `.agents/skills/react-doctor/SKILL.md`).
4. Manually sanity-check: menu → 2+ players → fire → terrain crater → shop round if relevant.

## Commit Rules and Documentation Update

- **Imperative mood** commit messages (e.g. `Add cluster spread to PhysicsEngine`).
- Per project convention: sign commit messages with agent name and **exact model name** when committing on behalf of the user.

### At every commit, you MUST update the following documentation files

- `AGENTS.md` (description of agents and project rules)
- `readme.md` (overall project overview)
- `CLAUDE.md`, `GROK.md`, `CURSOR.md` (depending on the AI tools being used)
- `.cursorrules` (Cursor / AI rules)
- `public/sitemap.xml` (last modification date)

Before each git commit:

Analyze the changes made to the code and files.
Update the relevant sections in the documentation files above so they remain consistent and up-to-date.
Provide a clear and concise summary of the modifications in both the commit message and the documentation.

Goal: Keep the project documentation alive, accurate, and always synchronized with the codebase.

## Skills in this repo

| Skill | When to use |
|-------|-------------|
| `.agents/skills/react-doctor/` | Before/after React changes; `/doctor` full triage |

## Planned work (context only)

Do not block current architecture for these; implement incrementally when asked:

- Visual tank redesign (Complete: Steps 1-6: procedural canvas drawing + lobby color picker + live preview + slope tilt + **Step 4 polish**: floating active-player colored triangle indicator, owner-colored projectiles, micro chassis recoil on fire; **Step 5**: random position with minimum distance and safety margin constraints on terrain; **Step 6**: direct AABB shell-to-tank collision with self-sabotage protection at launch)
- Sound, particles, more weapons
- Persistent scores / match history
- Further AI improvements (v3-sniper optimized with highly accurate numerical trajectory search that handles drag and wind, and coordinate-shifting deliberate first-shot miss (Step 7 complete); v4-smart implemented)

## Recent Updates & Bug Fixes

- **Game Version Bump:** Bumped game version to `0.3.1` in `package.json` and `package-lock.json`.
- **Version Display on Main Menu:** Imported game version from `package.json` and added it to the footer of `MainMenu.tsx` beside the license notice (e.g. `v0.3.1`).
- **Content Security Policy (CSP) Update:** Allowed Cloudflare Web Analytics script (`https://static.cloudflareinsights.com`) within the `script-src` directive in `index.html` to resolve console security violations.
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
- **Post-Merge Fixes:** Fixed test failures and lint errors introduced by the last git merge. Mocked `secureRandom` in `wind.test.ts` instead of `Math.random` to align with secure random number generation, resolved unused `TerrainManager` import in `PhysicsEngine.test.ts`, and resolved explicit `any` lint errors in `SEO.tsx` by removing redundant type casts.
- **Wind Test Mock Fix:** Fixed a test failure in `wind.test.ts` where a duplicate `describe('rollRoundWind')` block (introduced by a merge conflict) was still spying on `Math.random` instead of `secureRandom`. Merged it into a single clean suite using `secureRandom` mock, and removed unused vitest imports to resolve ESLint errors.
- **Terrain Test Lint Fix:** Fixed an ESLint error (`@typescript-eslint/no-explicit-any`) in `src/game/engine/__tests__/Terrain.test.ts` by replacing the `any` cast on the private `heights` property with a typed cast via `unknown as { heights: number[] }`, preserving TS strictness.
- **Terrain Test Restoration:** Restored checkCollision test suite and beforeEach configurations in Terrain.test.ts that were corrupted during a manual merge conflict resolution.
- **Game Version Bump:** Bumped game version to `0.3.0` in `package.json` and `package-lock.json`.
- **React Doctor Clean Code Refactoring:** Fixed all major React Doctor warning types in the project (lifting the score from 72 to 95/100):
  - **Giant Components (`no-giant-component`):** Refactored `MainMenu.tsx` by extracting the player row configuration into a dedicated `PlayerConfigRow.tsx` component. Refactored `GameCanvas.tsx` by extracting game overlays (`GameOverOverlay.tsx`, `GameControlsExplanation.tsx`), AI shop logic (`aiShopHelper.ts`), and the core loop/state handlers into a custom `useGameSession.ts` hook. Both components are now under the 300-line threshold.
  - **State Consolidation (`prefer-useReducer`):** Replaced 11 disparate `useState` calls in `GameCanvas.tsx` with a single unified `useReducer` state machine (`gameCanvasReducer.ts`), reducing unnecessary render churn and structuring game phase transitions.
  - **Ref Cleanup Dependency (`exhaustive-deps`):** Fixed a react-hooks warning by wrapping celebration timer cleanups into stable callbacks and listing them correctly in the hook dependency array, avoiding potential wrong-node reads at unmount time.
  - **Button Types (`button-has-type`):** Added explicit `type="button"` attribute to 7 interactive buttons across `GameCanvas.tsx`, [RoundSummary.tsx](file:///D:/projects/Repos/TankWars/src/components/RoundSummary.tsx), and [WeaponShop.tsx](file:///D:/projects/Repos/TankWars/src/components/WeaponShop.tsx) to prevent default form submission behaviors.
  - **Array Sorting (`js-tosorted-immutable`):** Optimized sorting performance and syntax by replacing `[...array].sort()` with the native ES2023 `array.toSorted()` in `RoundSummary.tsx`, `AISniperStrategy.ts`, and `AIHeuristicStrategy.ts`.
  - **Chained Array Iterations (`js-combine-iterations`):** Combined a chained `.filter().map()` call inside `MainMenu.tsx` into a single, high-performance loop to collect unavailable colors in a single pass.
  - **Font Size Accessibility (`no-tiny-text`):** Increased compact font sizes (9px, 10px, 11px) to 12px in `PlayerConfigRow.tsx`, `GameCanvas.tsx`, and `MainMenu.tsx` to meet standard accessibility requirements.
- **Enhanced Fireworks Celebration:** Completely redesigned the end-of-round and match-winning celebrations to launch multicolored rockets from the bottom of the screen alongside the winning tank's barrel shots. Added circular, rainbow, cascade, and crackling willow explosion patterns, trailing smoke paths, and falling swaying confetti. Integrated spatialized chiptune explosion sound effects mapped to horizontal coordinates. Enabled celebration fireworks on every combat round completion.
- Tank Destruction Money Rewards: Added a real-time money reward of $300 immediately given to a player when they destroy another tank. Upon the destruction of the second-to-last tank (leaving exactly one survivor), the last tank standing receives a double reward of $600. The post-round earnings method is simplified to award base survival money only, and translations are updated accordingly.
- **Weapon Shop State Mutation Fix & Unit Tests:** Fixed a bug in the weapon shop overlay where clicking `+` (buy) or `-` (sell) did not update the stock or money display. The `MUTATE_SHOP_PLAYERS` action in `gameCanvasReducer.ts` was corrected to accept and assign the updated player payload, ensuring proper React state propagation and re-rendering. Added a comprehensive test suite in `src/components/__tests__/gameCanvasReducer.test.ts` to cover all reducer action transitions.

---

When unsure about a design constraint, prefer **strict React/Canvas separation** and **pluggable AI via `AIEngine`** over shortcuts.

- Use `secureRandom` from `src/utils/random.ts` instead of `Math.random` for all random numbers.
