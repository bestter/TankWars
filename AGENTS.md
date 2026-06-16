# AGENTS.md — TankWars

Guidance for AI coding agents working in **Bestter's TankWars** (`bestters-tankwars`). Read this file first. Human-oriented overview: [README.md](./README.md). Overlapping rules also appear in [CLAUDE.md](./CLAUDE.md), [GROK.md](./GROK.md), [CURSOR.md](./CURSOR.md), and [.cursorrules](./.cursorrules).

## GOLDEN RULES

- You must always answer in French (FR). If you can speak in Canadian-French (fr-CA, québécois) it's even better!
-- If the user paste some code or text in english, answer in french (or québécois).
- IF ANY DOUBT, ASK THE DEVELOPER BEFORE DOING ANYTHING; NEVER GUESS!!!
- DO NOT MODIFY THE RULES OF THIS FILE, UNLESS YOU HAVE AN EXPLICIT INSTRUCTION FROM THE DEVELOPER TO DO SO.
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
| Run tests | `npm run test` (or `npx vitest`) |
| Preview build | `npm run preview` |
| React health scan | `npm run doctor` or `npx react-doctor@latest --verbose --diff` after React changes |

Verify changes with `npm run lint`, `npm run build`, and `npm run test` before finishing. Running all tests is mandatory on every modification. If tests are failing or need correction, they must be corrected immediately. Prefer fixing lint warnings you introduce; do not drive-by refactor unrelated warnings.

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
            ├── BallisticsSimulator.ts  # Shared trajectory simulation + two-phase ballistic search (v2–v4 aiming)
            ├── AIByProfileStrategy.ts  # Dispatcher per aiProfile (v1/v2/v3/v4); v2–v4 lazy-loaded via dynamic import()
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
- A single `AIByProfileStrategy` (registered in `GameCanvas.tsx`) dispatches per-player based on `aiProfile` (supports mixed Human + different AI types; falls back to v1). Advanced profiles (v2–v4) are **lazy-loaded** on first use; ballistic aiming for v2–v4 goes through shared `BallisticsSimulator.ts` (coarse-to-fine search, early exit).
- New strategies must be registered in `GameCanvas.tsx` (via the profile dispatcher); do not entangle AI logic inside `TankManager` or `GameEngine` internals.
- Supporting data: `aiProfile` on `Player`, `lastHitBy` on `Tank`, `windForce`/`gravity` on `GameState` snapshots for AI.

## Common tasks — where to edit

| Goal | Primary files |
|------|----------------|
| Menu / player setup | `MainMenu.tsx`, `types/player.ts` (supports all: IA SIMPLE/v1, IA OK/v2, IA SNIPER/v3, IA EXPERT/v4) + ColorPicker / TankPreview |
| New weapon | `types/weapon.ts`, GameEngine (sounds + VFX/particles for large weapons), PhysicsEngine/TankManager (special damage/projectile rules), HUD/shop, GameCanvas (AI buy lists) |
| Turn / round flow | `TurnManager.ts`, `GameCanvas.tsx` |
| Physics / explosions | `PhysicsEngine.ts`, `GameEngine.ts` |
| Terrain generation / craters / partial dirty redraw | `Terrain.ts` |
| Tank visual / procedural sprite + Step 4 polish | `game/rendering/tankSprite.ts`, `TankManager.ts` (recoil + draw), `GameEngine.ts` (render indicator + fire recoil trigger + color lookup), `PhysicsEngine.ts` (ownerColor on projectiles) |
| Smarter AI | New file under `game/entities/ai/`, implement `AIEngine`; reuse `BallisticsSimulator.ts` for aiming; register in `AIByProfileStrategy.ts` + `GameCanvas.tsx` |
| Global match phase | `App.tsx`, `types/game.ts` |

## What agents must not do

- Add external physics or game engines.
- Put canvas drawing or `getContext` mutations in React render paths.
- Store live `ImageData`, particle arrays, or projectile lists in React `useState` updated every frame.
- Expand scope with unrelated refactors, new markdown docs, or dependency churn unless asked.
- Weaken TypeScript strictness or introduce `any` for convenience.

## Verification checklist

After any modification or substantive change:

1. Run all tests: `npm run test` (or `vitest run`) — all tests must pass. If any tests fail or need correction, they must be corrected and updated.
2. `npm run lint` — no new errors.
3. `npm run build` — TypeScript + Vite succeed.
4. If React/UI touched: `npx react-doctor@latest --verbose --diff` — score should not regress (see `.agents/skills/react-doctor/SKILL.md`).
5. Manually sanity-check: menu → 2+ players → fire → terrain crater → shop round if relevant.

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

- **Online Multiplayer Sync & Session Stability (AddMultiplayer branch):** Hardened cross-client coordination for full round flow (combat → celebration → summary → shop → round 2). `ROUND_END` WS relay + `GameEngine.syncRoundEndFromRemote()` keeps both screens on the same phase when local HP diverge. `TurnManager.executeRemoteFire()` fires from authoritative `fromSlot`/`ownerId` and bypasses falling-tank guard; late `STATE_UPDATE`/`SHOT` ignored after round end. Shop phase relay (`SHOP_BUY_SELL`, `SHOP_ADVANCE`, `SHOP_FINISH`) with `isLocalShopTurn` UI gating. `seedFromRoomRound(roomId, roundNumber)` re-seeds RNG before each online combat round. Lobby `REQUEST_GAME_START` catch-up when host misses `GAME_START` broadcast; server per-socket resend + `SHOP_FINISH` resets `roundEnded` for round 2. `onlineSession.ts` persists in-progress match in `sessionStorage` (phase/manche/roster); `App.tsx` blocks return to waiting-room lobby mid-match (`onlineMatchStarted`), confirms quit online, resumes on cold load. Combat WS auto-reconnect. `GameEngine.enterInterRoundPhase()` + `isRoundCombatActive()`. **139 unit tests** (TurnManager online gating + remote fire). — Grok 4.3 (xAI)

- **Basic Online Multiplayer Foundation (AddMultiplayer branch):** Added host-created rooms with selectable player count (2-4, mix of human slots via per-player shareable URLs + optional AI slots). New `OnlineLobby.tsx` component handles creation, URL generation (with tokens), live waiting room via WS to Cloudflare Durable Object (`worker/src/game-room.ts`), auto-start when all human players joined. Combat phase opens persistent game WS in `useGameSession` for FIRE commands to server + receive SHOT/STATE_UPDATE for turn coordination. Client-side: `localPlayerId` gating (only control your own tank on your turn via `isLocalHumanTurn` + forced re-eval in `syncTurn`), seeded RNG (`createSeededRNG` + `setRNG` before `setPlayers`) for identical initial spawns across clients, `loadHeights` from server initial state for consistent terrain. Worker setup (wrangler.toml + scripts, index.ts routing, DO with slot claiming, auto-start, basic executeFire + broadcast). Cross-tab demo sync via BroadcastChannel. CSP updated for localhost:8787 dev worker. All verifs: lint clean, build succeeds, 130/130 tests green. — Grok 4.3 (xAI)

- **Service Worker and CSP Production Load Fix (v0.4.2):** Resolved a critical production loading freeze at `tankwars.pages.dev` caused by aggressive Cache-First strategy on the navigation route `/index.html` (which locked browsers into requests for stale and deleted Vite bundles like `index-CXsrA7Q7.js` that returned 404/HTML). Configured `sw.js` with a robust **Network-First** strategy for navigate requests, and restricted SW fetch interception strictly to local origin (`self.location.origin`) to bypass third-party requests. Fixed service worker crashes by properly propagating network errors (`throw err` instead of returning `undefined` which raised `TypeError`). Added `https://static.cloudflareinsights.com` to `connect-src` in both `public/_headers` and `index.html` to eliminate CSP beacon blocks. Reorganized SPA routing by creating `public/_redirects` and removing the stale `public/_redirects.txt`. Bumped cache version to `"tankwars-v2"`.
- **React Doctor GitHub Action Fix:** Removed the invalid `project` parameter from the `millionco/react-doctor@v2` GitHub Action step in `.github/workflows/react-doctor.yml` since it expects a directory path rather than file paths, resolving the directory path error on GitHub CI.
- **Complete Projectile Object Pooling (perf branch):** Wired the `getProjectile` helper (introduced by Jules in "perf: Implement object pooling for projectiles") into `launchProjectile` and `splitCluster` in `PhysicsEngine.ts`. Removed all duplicated inline `projectilePool.pop()` + new-object branches. All projectile creation and recycling (via `freeProjectile`) now centralizes through the pool to eliminate GC churn on shots and cluster sub-munitions. Fixed the TS unused-method error that blocked `npm run build`, a surfaced `@typescript-eslint/no-explicit-any` in ColorPicker test mock, and stabilized the fireworks compaction test (secureRandom mock to avoid spurious bottom-spawn side effects). Full mandatory verification: `npm run lint` clean, `npm run build` succeeds, `npm run test` (130/130) green. Preserves and activates the performance optimization on the object-pooling branch. — Grok 4.3 (xAI)
- **Terrain Partial Redraw Visual Fix (v0.4.1):** Fixed blue vertical lines, jagged/cut grass on curves, and fuzzy brown/green fringe after crater explosions from the partial offscreen optimization. `TerrainManager` uses opaque sky fill on an `alpha: false` offscreen buffer, per-column brown earth strictly below the grass ribbon, a smooth filled grass polygon on slopes, and `clipSkyAboveSurface` to remove antialiased fringe; wider dirty-band padding (±10/±8). Extended `Terrain.test.ts` (dirty band reset on `generate()`). **113 unit tests**.
- **Game Version Bump:** Bumped game version to `0.4.1` in `package.json` and `package-lock.json`.
- **Performance Optimizations (v0.4.1):** Major runtime and React churn reductions across four areas:
  - **Shared Ballistics Simulator:** New `BallisticsSimulator.ts` centralizes `simulateShot` / `simulateSmartShot` and a two-phase coarse-to-fine `searchBallisticSolution` (early exit on low error). `AIHeuristicStrategy`, `AISniperStrategy`, and `AISmartStrategy` delegate aiming to it (eliminates triplicate simulation loops). `AIByProfileStrategy` lazy-loads v2–v4 via dynamic `import()` — separate Rollup chunks, smaller initial bundle when only v1 AI is used.
  - **Terrain Partial Dirty Redraw:** `TerrainManager` tracks a horizontal dirty band per crater (`dirtyStartX`/`dirtyEndX`); `renderPartialOffscreen` redraws only the affected columns instead of the full 800×480 offscreen buffer (opaque sky → lava → brown columns below grass → grass ribbon → sky clip). `smoothHeights` uses a reusable `smoothScratch` buffer (no per-crater `.slice()`).
  - **HUD Update Throttling:** `TurnManager` throttles angle/power HUD callbacks to ~15 Hz (`HUD_THROTTLE_MS = 66`); structural changes (player, weapon, input lock, falling state, turn) dispatch immediately. `GameHUD` and `MobileControls` wrapped in `React.memo`. **Bug fix:** `removeInputListeners` now always clears the pending HUD throttle timer (previously skipped when keyboard listeners were never attached).
  - **Fireworks VFX Optimization:** Celebration particles tick at 60 Hz (decoupled from 120 Hz physics), in-place compaction (no per-frame `newFireworks` array), reusable spawn buffer, `MAX_FIREWORKS = 250` cap, hoisted `FESTIVE_COLORS` module constant.
- **Expanded Test Coverage (112 tests):** Added 27 unit tests across `BallisticsSimulator.test.ts`, `AIByProfileStrategy.test.ts`, `AIStrategies.test.ts`, `GameEngine.fireworks.test.ts`, extended `Terrain.test.ts` (partial dirty band) and `TurnManager.test.ts` (HUD throttle); shared fixtures in `src/game/__tests__/helpers.ts`.
- **Game Version Bump:** Bumped game version to `0.4.0` in `package.json` and `package-lock.json`.
- **Support Mobile et PWA :** Ajout de contrôles tactiles virtuels réactifs (D-Pad pour l'angle, D-Pad pour la puissance, tir direct, changement d'arme) avec support du maintien prolongé (press & hold) pour le défilement rapide sous le canvas de combat. Intégration PWA complète avec un manifeste (`manifest.json`) configuré pour le mode plein écran paysage (`standalone` + `landscape`) et un Service Worker (`sw.js`) gérant le cache hors-ligne et l'installabilité sur l'écran d'accueil mobile. Métadonnées Apple iOS intégrées dans `index.html` pour masquer les barres du navigateur Safari.
- **AI Baby Nuke & Thermonuclear Usage Restriction:** Reduced the frequency and overuse of `NUKE` (Baby Nuke) and `THERMONUCLEAR` weapons by AI players. Lowered their purchase priorities in the automatic shop by moving them to the end of the preference list in [aiShopHelper.ts](file:///D:/projects/Repos/TankWars/src/game/entities/ai/aiShopHelper.ts). Restricted their combat selection in [AISmartStrategy.ts](file:///D:/projects/Repos/TankWars/src/game/entities/ai/AISmartStrategy.ts) and [AIHeuristicStrategy.ts](file:///D:/projects/Repos/TankWars/src/game/entities/ai/AIHeuristicStrategy.ts) by requiring a minimum health threshold on targets (40 HP for Nuke, 50 HP for Thermonuclear) to prevent waste on near-dead tanks, and introducing a random probability hurdle (35% selection chance for Nuke, 30% for Thermonuclear).
- **Production Console Log Suppression:** Disabled all non-error console outputs (`console.log`, `warn`, `info`, `debug`, `trace`, `group`, etc.) in production builds by overriding them at the [main.tsx](file:///D:/projects/Repos/TankWars/src/main.tsx) entry point when `import.meta.env.PROD` is true, ensuring clean production console environments.
- **Custom Analytics Events via Cloudflare Zaraz:** Created [analytics.ts](file:///D:/projects/Repos/TankWars/src/utils/analytics.ts) utility to send custom events to Cloudflare Zaraz (`window.zaraz.track`). Integrated tracking for `game_start` (tracking players, human/AI count, and chosen AI profiles), `round_end` (tracking round number, winner type, and winner AI profile), and `game_over` (tracking overall winner, winner type/profile, and total rounds). Added comprehensive unit tests in [analytics.test.ts](file:///D:/projects/Repos/TankWars/src/utils/__tests__/analytics.test.ts).
- **Randomized Tank Starting Order:** Modified `spawnTanks` in `TankManager.ts` to shuffle the generated X positions using a secure Fisher-Yates shuffle algorithm. This ensures that the horizontal starting order of the tanks varies randomly on every round, preventing players (e.g. Player 1) from always spawning in the same relative horizontal order (e.g. always on the far left). Added comprehensive unit tests in `TankManager.test.ts`.
- **Game Version Bump:** Bumped game version to `0.3.4` in `package.json` and `package-lock.json`.
- **Version Display on Main Menu:** Imported game version from `package.json` and added it to the footer of `MainMenu.tsx` beside the license notice (e.g. `v0.3.4`).
- **Bullet and Nuke Direct Hit Damage Fix:** Fixed a major bug where direct hits with the `BULLET` and `NUKE` weapons were often ignored or severely penalized. Bypassed the splash `distance > radius` check and linear falloff for direct hits on the target tank's bounding box, ensuring `BULLET` deals its intended 3x damage multiplier (75 dmg) and `NUKE` instantly destroys the target.
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
  - **Button Types (`button-has-type`):** Added explicit `type="button"` attribute to 7 interactive buttons across `GameCanvas.tsx`, `RoundSummary.tsx`, and `WeaponShop.tsx` to prevent default form submission behaviors.
  - **Array Sorting (`js-tosorted-immutable`):** Optimized sorting performance and syntax by replacing `[...array].sort()` with the native ES2023 `array.toSorted()` in `RoundSummary.tsx`, `AISniperStrategy.ts`, and `AIHeuristicStrategy.ts`.
  - **Chained Array Iterations (`js-combine-iterations`):** Combined a chained `.filter().map()` call inside `MainMenu.tsx` into a single, high-performance loop to collect unavailable colors in a single pass.
  - **Font Size Accessibility (`no-tiny-text`):** Increased compact font sizes (9px, 10px, 11px) to 12px in `PlayerConfigRow.tsx`, `GameCanvas.tsx`, and `MainMenu.tsx` to meet standard accessibility requirements.
- **Enhanced Fireworks Celebration:** Completely redesigned the end-of-round and match-winning celebrations to launch multicolored rockets from the bottom of the screen alongside the winning tank's barrel shots. Added circular, rainbow, cascade, and crackling willow explosion patterns, trailing smoke paths, and falling swaying confetti. Integrated spatialized chiptune explosion sound effects mapped to horizontal coordinates. Enabled celebration fireworks on every combat round completion.
- Tank Destruction Money Rewards: Added a real-time money reward of $300 immediately given to a player when they destroy another tank. Upon the destruction of the second-to-last tank (leaving exactly one survivor), the last tank standing receives a double reward of $600. The post-round earnings method is simplified to award base survival money only, and translations are updated accordingly.
- **Weapon Shop State Mutation Fix & Unit Tests:** Fixed a bug in the weapon shop overlay where clicking `+` (buy) or `-` (sell) did not update the stock or money display. The `MUTATE_SHOP_PLAYERS` action in `gameCanvasReducer.ts` was corrected to accept and assign the updated player payload, ensuring proper React state propagation and re-rendering. Added a comprehensive test suite in `src/components/__tests__/gameCanvasReducer.test.ts` to cover all reducer action transitions.
- **Security Headers & CSP Update:** Added standard HTTP security headers to Cloudflare Pages deployment via a new `public/_headers` file, configuring `Content-Security-Policy`, `Strict-Transport-Security`, and `X-Frame-Options` while explicitly allowing Cloudflare Web Analytics beacon (`https://static.cloudflareinsights.com` for script execution and `https://cloudflareinsights.com` for data transmission). Synchronized the `index.html` CSP meta tag accordingly.

---

When unsure about a design constraint, prefer **strict React/Canvas separation** and **pluggable AI via `AIEngine`** over shortcuts.

- Use `secureRandom` from `src/utils/random.ts` instead of `Math.random` for all random numbers.
