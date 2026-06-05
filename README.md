# Bestter's TankWars

> A browser-based artillery tank battle game with fully destructible terrain and a retro DOS/VGA title screen. Built from scratch with React + TypeScript + HTML5 Canvas.

**Classic Scorched Earth / Worms-style gameplay** — no external physics engines, no game frameworks. Pure custom terrain algorithms, projectile simulation, and a strict decoupled architecture.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![React](https://img.shields.io/badge/React-19-61DAFB)
![Vite](https://img.shields.io/badge/Vite-8-646CFF)

---

## Features

- **Destructible Heightmap Terrain** — Procedurally generated rolling hills using layered sine waves + high-frequency noise. Circular crater destruction with smooth falloff.
- **Authentic 16-Color VGA Palette + Neon Extensions** — All rendering (tanks, explosions, UI, terrain) uses the classic high-contrast VGA 16-color palette, extended with high-contrast arcade/neon colors (ELECTRIC_CYAN, FLASH_GREEN, NEON_PINK, CYBER_YELLOW, FLUO_ORANGE, VOLT_PURPLE, ...) to support the upcoming tank visual redesign.
- **Realistic Projectile Physics** — Gravity, variable wind, different ballistic profiles (missiles, arcing grenades, clusters).
- **Multiple Weapons**
  - Missile (balanced, unlimited)
  - Grenade (arcing + bounces on terrain)
  - Cluster Bomb (sub-munitions)
  - Baby Nuke (massive blast)
  - Driller (penetrating)
  - Thermonuclear Bomb (devastating, destroys ~1/4 of the map with inner instant-kill zone; outer tanks fall into giant crater; huge red-orange explosion VFX and deep bomb sound)
- **Configurable Matches (2–4 Players)** — Dedicated retro Main Menu lets you set player count, names, and mix of Human / IA SIMPLE / IA OK / IA SNIPER / IA EXPERT before each battle. Unique VGA colors assigned automatically with live previews and mutual-exclusion picker.
- **Turn-Based Combat** — Full turn system with Human and AI players. Supports any combination up to 4 participants.
- **Pluggable AI System** — Clean `AIEngine` interface. `AIByProfileStrategy` router selects per player (mixed Human + AI supported):
  - Phase 1: `AISimpleStrategy` ("IA SIMPLE" / "Mr. Simple", `aiProfile: 'v1-random'`) — deliberately naive.
  - Phase 2: `AIHeuristicStrategy` ("IA OK", `aiProfile: 'v2-heuristic'`) — wind/terrain-aware, revenge (`lastHitBy`), memory/precision ramp, smart weapon choice.
  - Phase 3: `AISniperStrategy` ("IA SNIPER", `aiProfile: 'v3-sniper'`) — high precision.
  - Phase 4: `AISmartStrategy` ("IA EXPERT", `aiProfile: 'v4-smart'`) — adaptive/smart.
  All wired in MainMenu + GameCanvas. Not one-shot snipers by design (v2+).
- **Keyboard Controls** — Classic artillery feel: ← → angle, ↑ ↓ power, SPACE to fire. Full on-screen HUD.
- **Wind Simulation** — Adjustable wind affects every shot.
- **Shields + Health** — Tanks have both health and shield layers.
- **Ammo Inventory + Shop** — Limited shots per weapon (Missile is unlimited and removed from the shop). Full sequential weapon shop between rounds with money earned from damage and survival.

---

## Controls

| Key       | Action                          |
|-----------|---------------------------------|
| `←` `→`  | Adjust turret angle             |
| `↑` `↓`   | Adjust firing power             |
| `SPACE`   | Fire current weapon             |
| `A` / `E` | Switch weapon                   |
| Mouse     | Click weapon buttons in HUD     |

The game now starts on a full retro Main Menu (with color picking + tank previews) where you configure 2-4 players (Human or any of 4 AI profiles) before entering combat. During a match the in-game HUD + canvas overlays (active indicator, colored shells, recoil) provide feedback. Round winner CELEBRATION fireworks play before SUMMARY.

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
```

---

## Architecture Highlights

This project follows a strict separation of concerns:

- **React Layer** (`src/components/`, `src/App.tsx`): Owns high-level game state (`GamePhase` starting at `'MENU'`, players, money, shop). Never touches canvas properties directly. The Canvas is not mounted while on the menu screen.
- **In-match phases** (`GameCanvas.tsx`): `COMBAT` → `RESOLUTION` → `SUMMARY` → `SHOP` → … → `GAME_OVER` (types in `src/types/game.ts`).
- **Game Engine** (`src/game/engine/`): Owns the 120Hz fixed-timestep physics loop, terrain mutations, projectile simulation, and rendering. Communicates exclusively via callbacks.
- **Rendering helpers** (`src/game/rendering/`): Pure Canvas 2D procedures (e.g. `drawTankSprite`) kept separate for future engine integration. Strict React/Canvas decoupling.
- **AI** (`src/game/entities/ai/`): Runtime behavior via `AIEngine`. `AIByProfileStrategy` (wired in `GameCanvas`) dispatches based on `player.aiProfile`:
  - `v1-random`: `AISimpleStrategy` (Phase 1, "IA SIMPLE").
  - `v2-heuristic`: `AIHeuristicStrategy` (Phase 2 "IA OK" — heuristic + memory + revenge).
  Swap implementations without touching core engine.
- **Types** (`src/types/`): Single source of truth. Zero `any`. Structural types only.

**Design Rules (enforced):**
- Custom terrain algorithms only (heightmap + `ImageData`-style mutations).
- VGA palette for all visual assets.
- No React state inside the render loop.
- AI strategies must not block the core architecture.

**Developer docs:** [AGENTS.md](./AGENTS.md) (coding agents — layout, commands, checklists, Step 4 polish notes) · [CLAUDE.md](./CLAUDE.md) · [GROK.md](./GROK.md) · [CURSOR.md](./CURSOR.md) (project rules).

---

## Current Status

**Playable Prototype** — Full retro title screen + configurable 2–4 player matches (any mix of Human + IA SIMPLE / IA OK / IA SNIPER / IA EXPERT) on a fully interactive destructible battlefield with Step 4, 5, 6 & 7 gameplay, physics and AI polish.

Fully working:
- **Main Menu** (`MENU` phase): Retro DOS/VGA with player count (2-4), names, Human/IA profiles (v1-v4), ColorPicker (mutual exclusion) + live TankPreview, auto VGA colors.
- **Visual tank redesign, positioning & collision (Steps 1-6 complete)** — Complete: procedural `drawTankSprite`, slope tilt, lobby tools; **Step 4** active turn floating colored triangle indicator (sine bob), owner-colored projectiles, micro recoil on chassis; **Step 5** randomized tank spawn coordinates with safety margins and minimum distance constraints; **Step 6** direct AABB shell-to-tank collision detection with launch-time self-sabotage protection.
- Terrain generation + real-time cratering
- Projectile physics + wind + owner color inheritance
- Turn system + AI turns (v1-v4 via `AIByProfileStrategy`, Step 7 complete: Sniper v3 rewritten with exact trajectory equations, barrel tip launch origin aligned, terrain obstacle avoidance added, + noise error modulator)
- Keyboard + HUD (WindBanner)
- Multiple weapons + limited ammo + shop economy
- Round summaries (CELEBRATION fireworks) + Game Over + next round / restart

In progress / planned:
- Sound effects & particle polish
- Local hotseat multiplayer polish (already supports up to 4 players)
- More weapons and power-ups
- Persistent high scores / match history
- Further AI refinements (v1-v4 profiles implemented)

---

## Tech Stack

- **Runtime**: React 19 + TypeScript (strict)
- **Build**: Vite 8 + Rolldown
- **Rendering**: HTML5 Canvas 2D (no WebGL, no external libs)
- **Physics**: Hand-rolled fixed-timestep integrator (no Matter.js, Rapier, etc.)
- **Styling**: Inline styles + minimal CSS (monospace retro aesthetic)

---

## License

MIT © 2026 Martin Labelle

See [LICENSE](./LICENSE) for details.

---

## Development Notes

This is an early-stage project focused on solid foundational architecture before feature bloat. Contributions that respect the strict decoupling rules and TypeScript discipline are welcome.

To explore the codebase:

- Start with `src/App.tsx` (top-level phase management) and `src/components/MainMenu.tsx`
- Main game view + engine integration: `src/components/GameCanvas.tsx`
- Core simulation lives in `src/game/engine/GameEngine.ts` (also hosts active turn indicator + recoil trigger + celebration)
- Terrain destruction: `src/game/engine/Terrain.ts`
- AI contract: `src/game/entities/ai/AIEngine.ts` + `AIByProfileStrategy.ts` (v1 `AISimpleStrategy`, v2 `AIHeuristicStrategy`, v3 `AISniperStrategy`, v4 `AISmartStrategy`)
- Tank + recoil visuals: `src/game/entities/TankManager.ts` + `src/game/rendering/tankSprite.ts`
- Projectile color harmonization: `src/game/engine/PhysicsEngine.ts`
- Agent-oriented guide: [AGENTS.md](./AGENTS.md)

Enjoy blowing up the landscape!
