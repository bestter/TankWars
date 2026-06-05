# Bestter's TankWars Project Guide

**Agents:** read [AGENTS.md](./AGENTS.md) first for layout, commands, verification, and task routing. This file holds non-negotiable project rules; operational detail lives in AGENTS.md. Companions: [GROK.md](./GROK.md), [CURSOR.md](./CURSOR.md), [.cursorrules](./.cursorrules).

## Build & Development Commands

- Install dependencies: `npm install`
- Start dev server: `npm run dev` (http://localhost:5173)
- Build project: `npm run build`
- Preview production build: `npm run preview`
- Run linter: `npm run lint`
- React health scan: `npm run doctor` (or `npx react-doctor@latest --verbose --diff` after React changes)

Before finishing substantive work: `npm run lint` and `npm run build` must pass. See [AGENTS.md § Verification](./AGENTS.md#verification-checklist).

## Architecture & Code Style Guidelines

- **Tech Stack:** React (functional components, hooks) + TypeScript + HTML5 Canvas.
- **State Separation:** Keep React state (turns, shop, money, `GamePhase`) strictly decoupled from the Canvas 2D high-frequency loop (physics, rendering).
- **Phase ownership:** `App.tsx` — `MENU` vs combat; `GameCanvas.tsx` — in-match phases (`COMBAT` → `RESOLUTION` → `CELEBRATION` (round fireworks) → `SUMMARY` → `SHOP` → `GAME_OVER`). Types in `src/types/game.ts`.
- **Type Safety:** Strict TypeScript. Zero `any`. Define structural types inside `src/types/`.
- **Canvas Rendering:** Use `VGA_PALETTE` from `src/types/game.ts` (classic 16-color VGA + extended high-contrast neon/arcade colors for tank redesign) for all game visuals. Pure procedural drawing helpers live in `src/game/rendering/` (e.g. `drawTankSprite` — geometric chenilles, beveled chassis, independent turret/cannon, strict save/translate/rotate/restore transforms) and are integrated into the 120Hz engine loop (scaled up to 24x15 with matching hitboxes) with slope-aware chassis tilt.
- **Step 4 Visual Polish (in engine):** Floating active-player indicator (colored inverted triangle, `Math.sin(Date.now()/200)*5` bob) drawn in `GameEngine.render`; projectiles use firer tank color via `ownerColor`; micro recoil (chassis offset opposite barrel) in `TankManager` + trigger from `GameEngine.fireProjectile`. All pure Canvas2D, cheap per-frame.
- **Step 5 Tank Positioning:** Randomized spawn coordinates at each new round via `spawnTanks` in `TankManager` (100px minimum distance safety, 13% width margins, snapped vertically to `Y = groundY` surface).
- **Step 6 Shell-Tank Collision:** Direct AABB shell-to-tank collision checking in `PhysicsEngine.updateProjectiles` (24x15 hitbox) with launch-time self-sabotage protection (ignores owner's hitbox until projectile exits it). Triggers explosions, damage, and projectile cleanup.
- **Terrain Logic:** Custom destructible terrain (heightmap in `Terrain.ts`; optional `ImageData`-style mutations). No external physics engines.

## AI Strategy Pattern (Crucial)

- Tank AI must implement **`AIEngine`** (`src/game/entities/ai/AIEngine.ts`). Wire strategies in `GameCanvas.tsx` via `engine.setAIEngine(...)` (uses `AIByProfileStrategy` router).
- **Phase 1:** `AISimpleStrategy` — deliberately naive ("IA SIMPLE" / "Mr. Simple"). Menu/profile label: `aiProfile: 'v1-random'`.
- **Phase 2:** `AIHeuristicStrategy` ("IA OK"). Heuristic aiming (wind, terrain sampling, ballistic search), revenge targeting (`lastHitBy`), per-round memory + precision improvement on targets, smart weapon selection. Menu/profile label: `aiProfile: 'v2-heuristic'`.
- **Phase 3:** `AISniperStrategy` ("IA SNIPER") — high-precision sniper using numerical trajectory search under drag and wind (Step 7 complete). First shot features deliberate coordinate-shifting miss; second shot targets tank directly with 0 noise. Menu/profile label: `aiProfile: 'v3-sniper'`.
- **Phase 4:** `AISmartStrategy` ("IA EXPERT"). Adaptive. `aiProfile: 'v4-smart'`.
- Full support for mixed profiles in one match. Do not entangle AI inside `TankManager` or `GameEngine`.
- **Legacy:** `AIStrategy` / `RandomAIStrategy` are an older contract and are not wired at runtime unless explicitly revived.

## Error Prevention

- Never modify HTML5 canvas properties directly inside a React render cycle; always pass updates through refs or dedicated game engine methods.
- Do not store per-frame simulation data (projectiles, particles, raw terrain pixels) in React state.

## Commit style

- Always sign your comments by your name, and your EXACT model name for each commit.
- Use IMPERATIVE mood for commit messages.