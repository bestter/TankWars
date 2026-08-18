# Bestter's TankWars Project Guide

**Agents:** read [AGENTS.md](./AGENTS.md) first for layout, commands, verification, and task routing. This file holds non-negotiable project rules. Operational detail and the file map live in AGENTS.md. Companions: [GROK.md](./GROK.md), [CURSOR.md](./CURSOR.md), [.cursorrules](./.cursorrules).

Do not turn this file into a changelog. Current facts only.

## Build & Development Commands

- Install dependencies: `npm install`
- Start dev server: `npm run dev` (http://localhost:5173)
- Build project: `npm run build`
- Preview production build: `npm run preview`
- Run linter: `npm run lint`
- Run tests: `npm run test` (or `vitest run`) — **334 tests** (45 files)
- Worker dev (online): `npm run worker:dev` (http://localhost:8787; run alongside `npm run dev`)
- Worker deploy: `npm run worker:deploy`
- React health scan: `npm run doctor` (or `npx react-doctor@latest --verbose --diff` after React changes)

Before finishing work: `npm run lint`, `npm run build`, and `npm run test` must pass on every modification. If tests fail, fix them. See [AGENTS.md § Verification](./AGENTS.md#verification-checklist).

## Architecture & Code Style

- **Tech Stack:** React (functional components, hooks) + TypeScript (strict, zero `any`) + HTML5 Canvas 2D. Types live in `src/types/`.
- **State Separation:** React owns `GamePhase`, players, money, shop, HUD. GameEngine owns the 120 Hz fixed-timestep loop (physics, terrain, projectiles, drawing, combat audio). Never mutate canvas context inside a React render. Never put live projectiles, particles, or `ImageData` in `useState`.
- **Phase ownership:** `App.tsx` + `appReducer.ts` — `MENU` vs a match session. `GameCanvas.tsx` — in-match phases: `COMBAT` → `RESOLUTION` → `CELEBRATION` → `SUMMARY` → `SHOP` → `GAME_OVER`. Types in `src/types/game.ts`.
- **Rendering:** `VGA_PALETTE` only. Tanks via `drawTankSprite` (24×15, slope tilt, independent turret). Active-player triangle, `ownerColor` shells, micro recoil — all Canvas2D in the engine.
- **Terrain:** Custom heightmap in `Terrain.ts`. Circular craters with falloff. DRILLER carves an oriented shaft (`destroyTerrainShaft`, depth `DRILLER_SHAFT_DEPTH`) and keeps the current splash. No third-party physics.
- **Spawns:** `spawnTanks` shuffles X with 100 px minimum gap, 13 % width margins, `Y = groundY`.
- **Hits:** AABB 24×15 in `PhysicsEngine.updateProjectiles`, with launch-time owner hitbox ignore until the shell exits it.
- **Online:** In `main` (not a feature branch). Cloudflare Worker + `GameRoom` Durable Object (`worker/`) for lobby, turn relay, transactional shop sync. Client: `OnlineLobby.tsx` + `useOnlineLobby.ts` + create/waiting views; combat in `useGameSession.ts` / `onlineSession.ts`. Shared living-player index: `src/game/online/turnOrder.ts`. Deploy via `deploy-cloudflare.ps1` with `VITE_API_BASE`. MVP = local Canvas physics + server turn order; authoritative server sim is still planned.
- **RNG:** `secureRandom` from `src/utils/random.ts` — never `Math.random`.

## AI Strategy Pattern

Tank AI must implement **`AIEngine`** (`src/game/entities/ai/AIEngine.ts`). Wire through `AIByProfileStrategy` in `GameCanvas.tsx` via `engine.setAIEngine(...)`.

| Profile | Class | Label | Notes |
|---------|--------|-------|-------|
| `v1-random` | `AISimpleStrategy` | IA SIMPLE | Deliberately naive. **No** `fallibleAim`. |
| `v2-heuristic` | `AIHeuristicStrategy` | IA OK | Heuristic + revenge + memory. Miss curve 55–90 → 10 px. |
| `v3-sniper` | `AISniperStrategy` | IA SNIPER | Ballistic search. Miss 55–70 → lock at shot 4, 18 % mid-round slip. |
| `v4-smart` | `AISmartStrategy` | IA EXPERT | Adaptive. Miss 24–42 → lock at shot 3. |

v2–v4 share `fallibleAim.ts` (impact offset so splash cannot convert a near-miss into a hit). Personality gaffes stay in each strategy. Mixed profiles in one match are supported. Do not put AI logic in `TankManager` or `GameEngine`. `AIStrategy` is a legacy contract and is not wired at runtime.

New profile → new file under `game/entities/ai/`, register in `AIByProfileStrategy.ts` + `GameCanvas.tsx`.

## Error Prevention

- Never modify HTML5 canvas properties inside a React render; pass updates through refs or engine methods.
- Do not store per-frame simulation data in React state.
- Never remove `'unsafe-inline'` from `style-src` (`index.html`, `public/_headers`). `csp.test.ts` guards this.
- `tsc -b` typechecks `worker/` via project references. Durable Object code uses global platform types (`DurableObjectNamespace`), not platform imports.
- Local hotseat shop must stay usable for humans in round 2+ (`useGameSession.ts`).
- Long GRENADE bounces: `TurnManager` must not let the AI take another turn after the settlement safety net fires.
- Do not edit rule files (`AGENTS.md`, `CLAUDE.md`, etc.) unless the user asked.

## Commit style

- Imperative mood.
- Sign with your name and exact model (`— Grok 4.6 (xAI)`).
