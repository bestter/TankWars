# TANKWARS

> A browser-based artillery tank battle game with fully destructible terrain, built from scratch with React + TypeScript + HTML5 Canvas.

**Classic Scorched Earth / Worms-style gameplay** — no external physics engines, no game frameworks. Pure custom terrain algorithms, projectile simulation, and a strict decoupled architecture.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![React](https://img.shields.io/badge/React-19-61DAFB)
![Vite](https://img.shields.io/badge/Vite-8-646CFF)

---

## Features

- **Destructible Heightmap Terrain** — Procedurally generated rolling hills using layered sine waves + high-frequency noise. Circular crater destruction with smooth falloff.
- **Authentic 16-Color VGA Palette** — All rendering (tanks, explosions, UI, terrain) uses the classic high-contrast VGA 16-color palette.
- **Realistic Projectile Physics** — Gravity, variable wind, different ballistic profiles (missiles, arcing grenades, clusters).
- **Multiple Weapons**
  - Missile (balanced)
  - Grenade (arcing)
  - Cluster Bomb (sub-munitions)
  - Baby Nuke (massive blast)
  - Driller (penetrating)
- **Turn-Based Combat** — Human vs AI with automatic turn management.
- **Pluggable AI System** — Clean `AIEngine` interface. Current Phase 1 implementation is deliberately naive/random for safe testing.
- **Keyboard Controls** — Classic artillery feel: ← → angle, ↑ ↓ power, SPACE to fire.
- **Wind Simulation** — Adjustable wind affects every shot.
- **Shields + Health** — Tanks have both health and shield layers.
- **Ammo Inventory** — Limited shots per weapon type (expandable in shop phase — planned).

---

## Controls (Prototype)

| Key       | Action                  |
|-----------|-------------------------|
| `←` `→`  | Adjust turret angle     |
| `↑` `↓`   | Adjust firing power     |
| `SPACE`   | Fire current weapon     |
| Mouse     | Click canvas (demo shots) |

Additional demo buttons in the UI allow direct firing of specific weapons.

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
```

---

## Architecture Highlights

This project follows a strict separation of concerns:

- **React Layer** (`src/components/`, `src/App.tsx`): Owns high-level game state (`GamePhase`, players, money, shop). Never touches canvas properties directly.
- **Game Engine** (`src/game/engine/`): Owns the 120Hz fixed-timestep physics loop, terrain mutations, projectile simulation, and rendering. Communicates exclusively via callbacks.
- **AI** (`src/game/entities/ai/`): All AI behavior injected through the `AIEngine` interface. Easy to swap "stupid random" Phase 1 AI with sophisticated trajectory solvers later.
- **Types** (`src/types/`): Single source of truth. Zero `any`. Structural types only.

**Design Rules (enforced):**
- Custom terrain algorithms only (heightmap + `ImageData`-style mutations).
- VGA palette for all visual assets.
- No React state inside the render loop.
- AI strategies must not block the core architecture.

See [CLAUDE.md](./CLAUDE.md) for the full developer guide.

---

## Current Status

**Playable Prototype** — 1v1 (Human vs AI) on a fully interactive destructible battlefield.

Fully working:
- Terrain generation + real-time cratering
- Projectile physics + wind
- Turn system + AI turns with delay
- Keyboard aiming & firing
- Multiple weapons
- Game over detection + restart

In progress / planned:
- Full shop & economy system between rounds
- More advanced AI (v2-heuristic, predictive aiming)
- Sound effects & particle polish
- Multiplayer (local hotseat / online)
- More weapons and power-ups

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

- Start with `src/App.tsx` and `src/components/GameCanvas.tsx`
- Core simulation lives in `src/game/engine/GameEngine.ts`
- Terrain destruction: `src/game/engine/Terrain.ts`
- AI contract: `src/game/entities/ai/AIEngine.ts`

Enjoy blowing up the landscape!
