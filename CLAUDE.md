# Bestter's TankWars Project Guide

**Agents:** read [AGENTS.md](./AGENTS.md) first for layout, commands, verification, and task routing. This file holds non-negotiable project rules; operational detail lives in AGENTS.md.

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
- **Phase ownership:** `App.tsx` — `MENU` vs combat; `GameCanvas.tsx` — in-match phases (`COMBAT` → `RESOLUTION` → `SUMMARY` → `SHOP` → `GAME_OVER`). Types in `src/types/game.ts`.
- **Type Safety:** Strict TypeScript. Zero `any`. Define structural types inside `src/types/`.
- **Canvas Rendering:** Use `VGA_PALETTE` from `src/types/game.ts` (classic 16-color VGA + extended high-contrast neon/arcade colors for tank redesign) for all game visuals. Pure procedural drawing helpers live in `src/game/rendering/` (e.g. `drawTankSprite` — geometric chenilles, beveled chassis, independent turret/cannon, strict save/translate/rotate/restore transforms).
- **Terrain Logic:** Custom destructible terrain (heightmap in `Terrain.ts`; optional `ImageData`-style mutations). No external physics engines.
- **Rendering helpers:** New pure Canvas-only routines (e.g. tank sprites) must be placed in `game/rendering/`, remain fully decoupled, and are only wired later into the engine render path (never called from React).

## AI Strategy Pattern (Crucial)

- Tank AI must implement **`AIEngine`** (`src/game/entities/ai/AIEngine.ts`). Wire strategies in `GameCanvas.tsx` via `engine.setAIEngine(...)` (uses `AIByProfileStrategy` router).
- **Phase 1:** `AISimpleStrategy` — deliberately naive ("IA SIMPLE" / "Mr. Simple"). Menu/profile label: `aiProfile: 'v1-random'`.
- **Phase 2 (implemented):** `AIHeuristicStrategy` ("IA OK"). Heuristic aiming (wind, terrain sampling, ballistic search), revenge targeting (`lastHitBy`), per-round memory + precision improvement on targets, smart weapon selection. Menu/profile label: `aiProfile: 'v2-heuristic'`. Supports mixed AI types.
- Do not entangle AI inside `TankManager` or `GameEngine`.
- **Legacy:** `AIStrategy` / `RandomAIStrategy` are an older contract and are not wired at runtime unless explicitly revived.

## Error Prevention

- Never modify HTML5 canvas properties directly inside a React render cycle; always pass updates through refs or dedicated game engine methods.
- Do not store per-frame simulation data (projectiles, particles, raw terrain pixels) in React state.

## Commit style

- Always sign your comments by your name, and your EXACT model name for each commit.
- Use IMPERATIVE mood for commit messages.