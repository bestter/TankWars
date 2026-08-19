# Bestter's TankWars

> A browser-based artillery tank battle game with fully destructible terrain and a retro DOS/VGA title screen. Built from scratch with React + TypeScript + HTML5 Canvas.

**Classic Scorched Earth / Worms-style gameplay** — no external physics engines, no game frameworks. Pure custom terrain algorithms, projectile simulation, and a strict decoupled architecture.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![React](https://img.shields.io/badge/React-19-61DAFB)
![Vite](https://img.shields.io/badge/Vite-8-646CFF)

---

## Features

- **Destructible Heightmap Terrain & Diverse Topography** — Procedurally generated diverse terrain using multi-octaves layered sine waves, localized tactical hollows (shelters for tanks), and steep hills/ridges. Distinct terrain materials:
  - `DIRT` (Standard earth & grass with classic destruction)
  - `ROCK` (Indestructible stone wall: side blasts stop at the rock; exploding on top reflects the blast for +50% damage with unchanged radius)
  - `SOFT` (Loose sand/sediment: 2.5× more destructible for massive craters)
  - DRILLER also carves an oriented shaft along the impact velocity with unchanged splash.
- **Authentic 16-Color VGA Palette + Neon Extensions** — All rendering (tanks, explosions, UI, terrain) uses the classic high-contrast VGA 16-color palette, extended with arcade/neon colors (ELECTRIC_CYAN, FLASH_GREEN, NEON_PINK, CYBER_YELLOW, FLUO_ORANGE, VOLT_PURPLE, …) for the procedural tank sprites.
- **Realistic Projectile Physics** — Gravity, variable wind, different ballistic profiles (missiles, arcing grenades, clusters). Object pool recycles launches and cluster sub-munitions.
- **Multiple Weapons**
  - Missile (balanced, unlimited)
  - Grenade (arcing + bounces ~2× higher on rock; sticks, digs, and explodes in sand)
  - Cluster Bomb (sub-munitions)
  - Baby Nuke (massive blast; direct hit instakill)
  - Driller (oriented shaft + current splash; depth `DRILLER_SHAFT_DEPTH`)
  - Bullet (precision shot, ×3 direct hitbox damage)
  - Thermonuclear Bomb (destroys ~1/4 of the map with an inner instant-kill zone; outer tanks fall into the crater; large VFX + deep bomb sound)
- **Configurable Matches (2–4 Players)** — Retro Main Menu: player count, names, and mix of Human / IA SIMPLE / IA OK / IA SNIPER / IA EXPERT. Unique VGA colors with live previews and a mutual-exclusion picker.
- **Turn-Based Combat** — Full turn system with Human and AI players. Any combination up to 4 participants.
- **Pluggable AI System** — `AIEngine` interface. `AIByProfileStrategy` selects per player (mixed Human + AI supported):
  - `AISimpleStrategy` ("IA SIMPLE", `v1-random`) — deliberately naive, no `fallibleAim`. Early rounds: alcoholic shots (random 0°–180°, including self); sobers via `roundSkill`.
  - `AIHeuristicStrategy` ("IA OK", `v2-heuristic`) — wind/terrain-aware, revenge (`lastHitBy`), memory, smart weapon choice. First shot always ≥ 36 px; locks on shot 5 (`SHOTS_TO_HIT`).
  - `AISniperStrategy` ("IA SNIPER", `v3-sniper`) — ballistic search. First shot ≥ 36 px; locks on shot 4; occasional mid-round slip after lock.
  - `AISmartStrategy` ("IA EXPERT", `v4-smart`) — adaptive. First shot ≥ 36 px; locks on shot 3.
  v2–v4 share `fallibleAim.ts` + `roundSkill.ts` (ease-out warmup, then late tighten) and `terrainMaterialTactics.ts` (no DRILLER on ROCK; prefer DRILLER on SOFT when the default is MISSILE). Wired in MainMenu + GameCanvas.
- **Keyboard Controls** — ← → angle, ↑ ↓ power, SPACE to fire. Full on-screen HUD.
- **Wind Simulation** — Adjustable wind affects every shot.
- **Shields + Health** — Tanks have both health and shield layers.
- **Ammo Inventory + Shop** — Limited shots per weapon (Missile is unlimited and removed from the shop). Sequential shop between rounds. Money: $300 per destroy, $600 for the last tank standing, $500 survival.
- **Internationalization (i18n)** — French and English for UI, settings, weapon descriptions, and status. Retro LanguageSwitcher.
- **Mobile Playability & PWA** — Touch D-Pads (angle, power, fire, weapon cycle) with press-and-hold. `manifest.json` + `sw.js` (network-first navigations) for installable fullscreen landscape on iOS/Android.
- **Online Multiplayer** — Host creates a room (2–4 players: shareable human URLs + optional AI). Cloudflare Worker + Durable Object (`worker/`) coordinates lobby WS, turn order, and shop sync (`FIRE` / `SHOT` / `STATE_UPDATE` / `ROUND_END` / shop relay). Client: `localPlayerId` gating, seeded RNG per round (`seedFromRoomRound`), `sessionStorage` resume, combat WS reconnect. Physics stays local; server owns turn order (authoritative sim still planned).
- **Audio** — Chiptune explosions (spatialized), weapon hits, celebration fireworks, victory sting. All in `GameEngine` (Web Audio).

---

## Controls

| Key / Input  | Action                          |
|--------------|---------------------------------|
| `←` `→`      | Adjust turret angle             |
| `↑` `↓`      | Adjust firing power             |
| `SPACE`      | Fire current weapon             |
| `A` / `E`    | Switch weapon                   |
| Mouse        | Click weapon buttons in HUD     |
| Touch Screen | On-screen retro controls (mobile) |

The game starts on a retro Main Menu (color picking + tank previews) where you configure 2–4 players (Human or any of 4 AI profiles). During a match the HUD + canvas overlays (active indicator, colored shells, recoil) provide feedback. Round-winner CELEBRATION fireworks play before SUMMARY. Mobile touch controls appear on tactile devices.

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm (or pnpm/yarn)

### Install & Run

```bash
# Install dependencies
npm install

# Start development server (http://localhost:5173)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Lint
npm run lint

# React health scan (before/after UI changes)
npm run doctor

# Run tests (402 unit tests across 51 files)
npm run test

# Online multiplayer backend (run alongside npm run dev)
npm run worker:dev    # http://localhost:8787

# Deploy worker to Cloudflare
npm run worker:deploy
```

**Online dev:** start both `npm run dev` (frontend, port 5173) and `npm run worker:dev` (API, port 8787). Restart the worker after editing `worker/src/game-room.ts`.

**Production deploy (option B — Worker on workers.dev):** run `.\deploy-cloudflare.ps1`. It deploys the Worker first, injects `VITE_API_BASE` into the Vite build, then deploys Pages. The game on `tankwars.pages.dev` calls the API on `https://tankwars-api.<account>.workers.dev`. See `.env.production.example` for manual builds.

---

## Architecture Highlights

This project follows a strict separation of concerns:

- **React Layer** (`src/components/`, `src/App.tsx`, `src/appReducer.ts`): Owns high-level game state (`GamePhase` starting at `'MENU'`, players, money, shop) via `useReducer`. Never touches canvas properties directly. The Canvas is not mounted while on the menu screen.
- **In-match phases** (`GameCanvas.tsx`): `COMBAT` → `RESOLUTION` → `CELEBRATION` → `SUMMARY` → `SHOP` → … → `GAME_OVER` (types in `src/types/game.ts`).
- **Online layer** (`OnlineLobby.tsx` + `useOnlineLobby.ts` + create/waiting views, `useGameSession.ts`, `src/game/online/turnOrder.ts`, `worker/`): REST room creation + persistent WS to `GameRoom` Durable Object; server coordinates turns and relays state; each client runs local Canvas physics.
- **Game Engine** (`src/game/engine/`): Owns the 120 Hz fixed-timestep physics loop, terrain mutations, projectile simulation, rendering, and combat audio. Communicates exclusively via callbacks.
- **Rendering helpers** (`src/game/rendering/`): Pure Canvas 2D procedures (e.g. `drawTankSprite`) kept separate from React.
- **AI** (`src/game/entities/ai/`): Runtime behavior via `AIEngine`. `AIByProfileStrategy` (wired in `GameCanvas`) dispatches on `player.aiProfile`:
  - `v1-random` → `AISimpleStrategy` ("IA SIMPLE")
  - `v2-heuristic` → `AIHeuristicStrategy` ("IA OK")
  - `v3-sniper` → `AISniperStrategy` ("IA SNIPER")
  - `v4-smart` → `AISmartStrategy` ("IA EXPERT")
  v2–v4 share `fallibleAim.ts` + `roundSkill.ts` (per-attempt lock + per-round warmup) and `terrainMaterialTactics.ts`. Swap implementations without touching the core engine.
- **Types** (`src/types/`): Single source of truth. Zero `any`. Structural types only.

**Design Rules (enforced):**
- Custom terrain algorithms only (heightmap + `ImageData`-style mutations).
- VGA palette for all visual assets.
- No React state inside the render loop.
- AI strategies must not block the core architecture.

**Developer docs:** [AGENTS.md](./AGENTS.md) (coding agents — layout, commands, checklists) · [CLAUDE.md](./CLAUDE.md) · [GROK.md](./GROK.md) · [CURSOR.md](./CURSOR.md) · [.cursorrules](./.cursorrules) · [.antigravityrules](./.antigravityrules).

---

## Current Status

**v0.6.0** — Playable local (hotseat + AI) and online multiplayer. Version is imported from `package.json` and shown in the Main Menu footer next to the license (© Martin Labelle).

In the build today:

- Retro `MENU` with 2–4 players, Human + four AI profiles, ColorPicker + TankPreview
- Procedural tanks, slope tilt, active-player indicator, owner-colored shells, micro recoil
- Randomized / shuffled spawns each round (local humans −25 % on SOFT; AI −25 % on ROCK); AABB shell-to-tank hits with owner-exit guard
- Destructible heightmap, DRILLER oriented shaft, GRENADE bounce/stick by material, wind, `baseSpeed` 6.0 (full-width at POW 100)
- Four AI profiles; v2–v4 use `fallibleAim` + `roundSkill` + `terrainMaterialTactics` (first shot ≥ 36 px; OK/Sniper/Expert lock at shots 5/4/3; v1 stays naive / alcoholic early); shared `BallisticsSimulator`; lazy-loaded v2–v4 chunks
- Shop + ammo + $300 / $600 / $500 economy; local hotseat shop stays usable after round 1
- CELEBRATION fireworks (60 Hz, 250-particle cap) + Web Audio
- i18n FR/EN, PWA (network-first SW), mobile D-Pads
- Online lobby + combat WS, Durable Object persistence, shop relay, session resume, reconnect
- Terrain dirty-band redraw, HUD ~15 Hz + `React.memo`, projectile pooling
- **402 unit tests** across **51 files** (Vitest)

Still planned:

- Authoritative server simulation (terrain / damage / HP shot-by-shot)
- More weapons and power-ups
- Persistent high scores / match history
- Further audio and particle polish

---

## Tech Stack

- **Runtime**: React 19 + TypeScript (strict)
- **Build**: Vite 8 + Rolldown
- **Rendering**: HTML5 Canvas 2D (no WebGL, no external libs)
- **Physics**: Hand-rolled fixed-timestep integrator (no Matter.js, Rapier, etc.)
- **Online backend**: Cloudflare Workers + Durable Objects (`worker/`, deployed separately from Pages)
- **Hosting**: Cloudflare Pages (`tankwars.pages.dev`) + optional Worker API
- **Styling**: Minimal CSS + a few inline styles (monospace retro aesthetic)

---

## License

MIT © 2026 Martin Labelle

See [LICENSE](./LICENSE) for details.

---

## Development Notes

This project stays architecture-first. Contributions that respect the React/Canvas split and TypeScript discipline are welcome.

To explore the codebase:

- Start with `src/main.tsx` (entry; production console suppression), `src/App.tsx` + `src/appReducer.ts` (top-level phase), and `src/components/MainMenu.tsx`
- Main game view + engine integration: `src/components/GameCanvas.tsx` + `useGameSession.ts`
- Core simulation: `src/game/engine/GameEngine.ts` (indicator, recoil trigger, celebration, audio)
- Terrain: `src/game/engine/Terrain.ts` (craters + `destroyTerrainShaft`) + `src/types/terrain.ts` (materials, spawn, grenade bounce)
- AI: `src/game/entities/ai/AIEngine.ts` + `AIByProfileStrategy.ts` + `fallibleAim.ts` + `roundSkill.ts` + `terrainMaterialTactics.ts` (v1 `AISimpleStrategy`, v2 `AIHeuristicStrategy`, v3 `AISniperStrategy`, v4 `AISmartStrategy`)
- Tanks: `src/game/entities/TankManager.ts` + `src/game/rendering/tankSprite.ts`
- Projectiles: `src/game/engine/PhysicsEngine.ts`
- Online lobby + WS client: `src/components/OnlineLobby.tsx`, `useOnlineLobby.ts`, `OnlineLobbyCreate.tsx`, `OnlineLobbyWaiting.tsx`, `useGameSession.ts`
- Shared turn order: `src/game/online/turnOrder.ts`
- Online backend: `worker/src/index.ts`, `worker/src/game-room.ts`
- Agent guide: [AGENTS.md](./AGENTS.md)

Enjoy blowing up the landscape!
