# Bestter's TankWars Project Guide

**Agents:** read [AGENTS.md](./AGENTS.md) first for layout, commands, verification, and task routing. This file holds non-negotiable project rules. Operational detail and the file map live in AGENTS.md. Companions: [GROK.md](./GROK.md), [CURSOR.md](./CURSOR.md), [.cursorrules](./.cursorrules), [.antigravityrules](./.antigravityrules).

Do not turn this file into a changelog. Current facts only.

## Build & Development Commands

- Install dependencies: `npm install`
- Start dev server: `npm run dev` (http://localhost:5173)
- Build project: `npm run build`
- Preview production build: `npm run preview`
- Run linter: `npm run lint`
- Run tests: `npm run test` (or `vitest run`) — **589 tests** (66 files)
- Worker dev (online): `npm run worker:dev` (http://localhost:8787; run alongside `npm run dev`)
- Worker deploy: `npm run worker:deploy`
- React health scan: `npm run doctor` (or `npx react-doctor@latest --verbose --diff` after React changes)

Before finishing work: `npm run lint`, `npm run build`, and `npm run test` must pass on every modification. If tests fail, fix them. See [AGENTS.md § Verification](./AGENTS.md#verification-checklist).

## Architecture & Code Style

- **Tech Stack:** React (functional components, hooks) + TypeScript (strict, zero `any`) + HTML5 Canvas 2D. Types live in `src/types/`.
- **State Separation:** React owns `GamePhase`, players, money, shop, HUD. GameEngine owns the 120 Hz fixed-timestep loop (physics, terrain, projectiles, drawing, combat audio). Never mutate canvas context inside a React render. Never put live projectiles, particles, or `ImageData` in `useState`.
- **Phase ownership:** `App.tsx` + `appReducer.ts` — `MENU` vs a match session. `GameCanvas.tsx` — in-match phases: `COMBAT` → `RESOLUTION` → `CELEBRATION` → `SUMMARY` → `SHOP` → `GAME_OVER`. Types in `src/types/game.ts`.
- **Rendering:** `VGA_PALETTE` only. Tanks via `drawTankSprite` (24×15, slope tilt, independent turret). Active-player triangle, `ownerColor` shells, micro recoil — all Canvas2D in the engine.
- **Shields & Gauges:** 40 innate shield points per tank/round. Direct hits deal 2× damage to shield (absorbs via `Math.ceil(shield / 2)`; 1× overflow to health); indirect splash deals 1× damage. Fall damage directly reduces health, leaving shield intact. Visual gauge on Canvas (constants `TANK_GAUGE_*`): single dark cyan bar (`VGA_PALETTE.DARK_CYAN`) at $y-24$ when shield > 0 and health is full; stacked dual bars (dark cyan shield at $y-28$, green health at $y-23$, name at $y-36$) when shield > 0 and health < maxHealth; single green bar at $y-24$ when shield <= 0 (red if $\le 40\%$).
- **Terrain:** Custom heightmap in `Terrain.ts` (multi-octaves procedural relief with bumps and tactical hollows, circular craters). Materials (`types/terrain.ts`): `DIRT` (standard grass/earth), `ROCK` (indestructible stone, no deformation; side blast is stopped by the rock wall; exploding on top: +50% via `ROCK_EXPLOSION_DAMAGE_MULTIPLIER = 1.5`, radius unaffected), `SOFT` (soft ground, `SOFT_TERRAIN_DESTRUCTION_MULTIPLIER = 2.5`x destruction). DRILLER carves an oriented shaft (`destroyTerrainShaft`, depth `DRILLER_SHAFT_DEPTH`) and keeps the current splash. GRENADE bounces ~2× higher on ROCK; first contact on SOFT sticks, digs, and detonates (`grenadeBounceParams`). No third-party physics.
- **Spawns:** `spawnTanks` shuffles X, prefers tactical hollows (max canvas Y among minDist candidates), 100 px minimum gap, 13 % width margins, `Y = groundY`. Local humans skip 25 % of SOFT samples; AI skip 25 % of ROCK samples in every mode (`spawnAcceptsMaterial`).
- **Hits:** AABB 24×15 in `PhysicsEngine.updateProjectiles`, with launch-time owner hitbox ignore until the shell exits it.
- **Weapons & pricing:** `WEAPON_REGISTRY` in `src/types/weapon.ts` is the single source of truth. The Baby Nuke (`NUKE`) costs $420. BULLDOZER costs $150, deals 0 HP / 0 blast; a direct hit pushes the target (`sign(vx)`) and recoils the shooter (`min(|vx| × 0.25, 120 px)`). It does not call `applyExplosionDamage` (no `wasDirectHit`). Falls use existing gravity / lava; off-map is burial.
- **Economy:** `src/game/economy/fixedPoint.ts` + `shotRewards.ts` calculate exact per-shot rewards from actual damage, attributed falls, destructions, and round outcome. Base $X$ is $3 / $3.50 / $4 for 2 / 3 / 4 starting players; self-damage is excluded and rounding happens once at the end. `GameEngine` owns shot ledgers and round earnings. `ShotEarningsOverlay` floats `+amount$` for 3 seconds without blocking; `RoundSummary` shows round earnings and the shop shows total balance.
- **Éclair de Zeus / Zeus Lightning:** action spéciale anti-impasse dans `src/game/zeus/`, jamais une arme. Avec au moins deux IA et aucun humain vivant, `IA vivantes × 5` tirs sans touche payante (`hasEarnings`) nomment équitablement Zeus; gain/humain/<2 survivants/mort de Zeus/fin de manche remettent le compteur à zéro. Zeus consomme le dernier agresseur direct vivant (BULLDOZER exclu), sinon le RNG injecté, élimine seulement la cible et reçoit `25X`. Ne jamais ajouter `ZEUS_LIGHTNING` à `WeaponId`, `WEAPON_REGISTRY`, `FireCommand`, au shop ou à `AIEngine`.
- **Online:** In `main` (not a feature branch). Cloudflare Worker + `GameRoom` Durable Object (`worker/`) for lobby, turn relay, authoritative reward/balance application, server-owned round end, and transactional shop sync. Client: `OnlineLobby.tsx` + `useOnlineLobby.ts` + create/waiting views; combat in `useGameSession.ts` / `onlineSession.ts`. Shared files: `src/game/online/turnOrder.ts` and strict `protocol.ts`. The first connected human is reward authority; persistent failover promotes the next original human. MVP still uses local Canvas physics; full authoritative terrain/damage simulation is planned. `GAME_START` includes `materials` only when the server array matches `heights` length; `loadHeights` resets to `DIRT` otherwise.
- **Zeus en ligne:** `GameRoom` décide et persiste nomination, historique, vengeance, RNG, ordre, frappe et IDs avant diffusion. `ZEUS_APPOINTED` / `ZEUS_STRIKE` / `ZEUS_STRIKE_APPLIED` / `ZEUS_STATE` sont idempotents et restaurables; le changement d’autorité économique est sans effet. Les VFX utilisent `strikeId` + temps, jamais le RNG de salle.
- **RNG:** `secureRandom` from `src/utils/random.ts` — never `Math.random`.

## AI Strategy Pattern

Tank AI must implement **`AIEngine`** (`src/game/entities/ai/AIEngine.ts`). Wire through `AIByProfileStrategy` in `GameCanvas.tsx` via `engine.setAIEngine(...)`.

In the local menu, selecting an AI assigns its short localized profile name (`Simple`, `OK`, `Sniper`, `Expert`). The suffix is the count of all other configured players with that profile, including later slots (`Simple`, `Simple-1`, `Simple-2`). Existing names are not renumbered; manual edits remain allowed, and language changes do not translate an already assigned name.

| Profile | Class | Label | Notes |
|---------|--------|-------|-------|
| `v1-random` | `AISimpleStrategy` | IA SIMPLE | Deliberately naive. **No** `fallibleAim`. |
| `v2-heuristic` | `AIHeuristicStrategy` | IA OK | Heuristic + revenge + memory. First shot ≥ 36 px, lock at shot 5. |
| `v3-sniper` | `AISniperStrategy` | IA SNIPER | Ballistic search. First shot ≥ 36 px, lock at shot 4, 14 % slip after. |
| `v4-smart` | `AISmartStrategy` | IA EXPERT | Adaptive. First shot ≥ 36 px, lock at shot 3. |

v2–v4 share `fallibleAim.ts` (impact offset so splash cannot convert a near-miss into a hit), `terrainMaterialTactics.ts` (skip DRILLER on ROCK; prefer DRILLER on SOFT when the default pick is MISSILE), and `bulldozerTactics.ts` (pick BULLDOZER on map edge / drop ≥ 12 px, dist ≥ 80; shop: v1 none, v2 cap 1, v3 none, v4 cap 2). All AI share `hitReaction.ts` (Issue 174: direct hit +50%, fall 1–25% cumulative on shot 1; shot 2: Sniper 0%, Expert 12%, OK/Simple 25%; shot 3: 0%). Personality gaffes stay in each strategy. Mixed profiles in one match are supported. Do not put AI logic in `TankManager` or `GameEngine`. `AIStrategy` is a legacy contract and is not wired at runtime. Warmup ease-out: 15% on round 1, table spec at round 5; after that `roundSkill` climbs to 1.35 and `aimMissScale` falls to 0.55. First shot stays splash-safe (`FIRST_SHOT_FLOOR_PX` = 36). Before round 5 the lock shot can still miss. Simple P(alcoholic) = `1 − min(1, skill)`. `v1-random` stays off `fallibleAim`, off material tactics, and off `bulldozerTactics`.

New profile → new file under `game/entities/ai/`, register in `AIByProfileStrategy.ts` + `GameCanvas.tsx`.

## Error Prevention

- Never modify HTML5 canvas properties inside a React render; pass updates through refs or engine methods.
- Do not store per-frame simulation data in React state.
- Never remove `'unsafe-inline'` from `style-src` (`index.html`, `public/_headers`). `csp.test.ts` guards this.
- `tsc -b` typechecks `worker/` via project references. Durable Object code uses global platform types (`DurableObjectNamespace`), not platform imports.
- Local hotseat shop must stay usable for humans in round 2+ (`useGameSession.ts`).
- Long GRENADE bounces: `TurnManager` must not let the AI take another turn after the settlement safety net fires.
- `loadHeights` without `materials` (or a length mismatch) resets every column to `DIRT` — no hybrid leftover state.
- Do not edit rule files (`AGENTS.md`, `CLAUDE.md`, etc.) unless the user asked.

## Commit style

- Imperative mood.
- Sign with your name and exact model (`— Grok 4.6 (xAI)`).
