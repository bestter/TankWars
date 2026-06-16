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
  - Bullet (precision shot, x3 direct hit damage multiplier)
  - Thermonuclear Bomb (devastating, destroys ~1/4 of the map with inner instant-kill zone; outer tanks fall into giant crater; huge red-orange explosion VFX and deep bomb sound)
- **Configurable Matches (2–4 Players)** — Dedicated retro Main Menu lets you set player count, names, and mix of Human / IA SIMPLE / IA OK / IA SNIPER / IA EXPERT before each battle. Unique VGA colors assigned automatically with live previews and mutual-exclusion picker.
- **Turn-Based Combat** — Full turn system with Human and AI players. Supports any combination up to 4 participants.
- **Pluggable AI System** — Clean `AIEngine` interface. `AIByProfileStrategy` router selects per player (mixed Human + AI supported):
  - Phase 1: `AISimpleStrategy` ("IA SIMPLE" / "Mr. Simple", `aiProfile: 'v1-random'`) — deliberately naive.
  - Phase 2: `AIHeuristicStrategy` ("IA OK", `aiProfile: 'v2-heuristic'`) — wind/terrain-aware, revenge (`lastHitBy`), memory/precision ramp, smart weapon choice.
  - Phase 3: `AISniperStrategy` ("IA SNIPER", `aiProfile: 'v3-sniper'`) — high precision.
  - Phase 4: `AISmartStrategy` ("IA EXPERT", `aiProfile: 'v4-smart'`) — adaptive/smart.
  All wired in MainMenu + GameCanvas. Not one-shot snipers by design (v2+).
- **Performance:** Object pooling for projectiles fully activated in PhysicsEngine (recycles instances for launches and cluster sub-munitions to cut GC pressure). Part of ongoing perf work on the dedicated branch.
- **Keyboard Controls** — Classic artillery feel: ← → angle, ↑ ↓ power, SPACE to fire. Full on-screen HUD.
- **Wind Simulation** — Adjustable wind affects every shot.
- **Shields + Health** — Tanks have both health and shield layers.
- **Ammo Inventory + Shop** — Limited shots per weapon (Missile is unlimited and removed from the shop). Full sequential weapon shop between rounds with money earned instantly from tank destructions ($300 standard, $600 for the last standing tank) and base survival ($500).
- **Internationalization (i18n)** — Complete French (FR) and English (EN) translations for all UI text, settings, weapon descriptions, and game status messages. Features a retro-styled LanguageSwitcher component to toggle language on the fly.
- **Mobile Playability & PWA Support** — Full touch controls (D-Pad for angle and power, fire, weapon cycling) with press & hold support. Progressive Web App (PWA) configuration (`manifest.json` + Service Worker `sw.js` for offline cache) enabling installability on iOS and Android home screens in fullscreen landscape mode.

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

The game now starts on a full retro Main Menu (with color picking + tank previews) where you configure 2-4 players (Human or any of 4 AI profiles) before entering combat. During a match the in-game HUD + canvas overlays (active indicator, colored shells, recoil) provide feedback. Round winner CELEBRATION fireworks (featuring multicolored trails, circular/rainbow patterns, falling confetti, and chiptune spatialized pops) play before SUMMARY. Plus, mobile touch controls display automatically on tactile devices.

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
- **Visual tank redesign, positioning & collision (Steps 1-6 complete)** — Complete: procedural `drawTankSprite`, slope tilt, lobby tools; **Step 4** active turn floating colored triangle indicator (sine bob), owner-colored projectiles, micro recoil on chassis; **Step 5** randomized tank spawn coordinates with safety margins, minimum distance constraints and shuffled starting order; **Step 6** direct AABB shell-to-tank collision detection with launch-time self-sabotage protection.
- Terrain generation + real-time cratering
- Projectile physics + wind + owner color inheritance + range scaling (baseSpeed increased from 4.2 to 6.0 for full screen coverage at POW=100)
- Turn system + AI turns (v1-v4 via `AIByProfileStrategy`, Step 7 complete: Sniper v3 rewritten with exact trajectory equations, barrel tip launch origin aligned, terrain obstacle avoidance added, + noise error modulator; aiming corrected for left-side shots in Heuristic v2 and Expert v4; AI Nuke and Thermonuclear weapon usage restricted by target health requirements and randomized selection probabilities, with lower automatic shop buy priorities; **v0.4.1:** shared `BallisticsSimulator.ts` two-phase search, lazy-loaded v2–v4 strategy chunks)
- **Performance (v0.4.1):** Terrain partial dirty-band offscreen redraw (opaque sky → brown below grass → grass ribbon → sky clip; fixes blue-line and fuzzy-edge artifacts); HUD updates throttled to ~15 Hz with `React.memo` on `GameHUD`/`MobileControls`; celebration fireworks at 60 Hz with in-place particle compaction and 250-particle cap
- React Doctor Clean Code Refactoring: Fixed all React Doctor issues and cleaned up dependencies, achieving a perfect score of 100/100.
  - **Giant Components (`no-giant-component`):** Refactored `MainMenu.tsx` by extracting the player row configuration into a dedicated `PlayerConfigRow.tsx` component. Refactored `GameCanvas.tsx` by extracting game overlays (`GameOverOverlay.tsx`, `GameControlsExplanation.tsx`), AI shop logic (`aiShopHelper.ts`), and the core loop/state handlers into a custom `useGameSession.ts` hook. Both components are now under the 300-line threshold.
  - **State Consolidation (`prefer-useReducer`):** Replaced 11 disparate `useState` calls in `GameCanvas.tsx` with a single unified `useReducer` state machine (`gameCanvasReducer.ts`), reducing unnecessary render churn and structuring game phase transitions.
  - **Ref Cleanup Dependency (`exhaustive-deps`):** Fixed a react-hooks warning by wrapping celebration timer cleanups into stable callbacks and listing them correctly in the hook dependency array, avoiding potential wrong-node reads at unmount time.
  - **Button Types (`button-has-type`):** Added explicit `type="button"` attribute to 7 interactive buttons across `GameCanvas.tsx`, `RoundSummary.tsx`, and `WeaponShop.tsx` to prevent default form submission behaviors.
  - **Array Sorting (`js-tosorted-immutable`):** Optimized sorting performance and syntax by replacing `[...array].sort()` with the native ES2023 `array.toSorted()` in `RoundSummary.tsx`, `AISniperStrategy.ts`, and `AIHeuristicStrategy.ts`.
  - **Chained Array Iterations (`js-combine-iterations`):** Combined a chained `.filter().map()` call inside `MainMenu.tsx` into a single, high-performance loop to collect unavailable colors in a single pass.
  - **Unused Files Removal (`unused-file`):** Removed orphaned legacy files `run_benchmark.js` and `RandomAIStrategy.ts` to clean the codebase graph.
  - **Font Size Accessibility (`no-tiny-text`):** Increased compact font sizes (9px, 10px, 11px) to 12px in `PlayerConfigRow.tsx`, `GameCanvas.tsx`, and `MainMenu.tsx` to meet standard accessibility requirements.
  - Caching `tank.position` to local references `pos` inside loops in `TankManager.ts` to prevent repeated prototype member access (`js-cache-property-access`).
  - Pre-building a Player `Map` once outside the projectile update loop in `PhysicsEngine.ts` to replace nested `.find()` searches with O(1) key lookups (`js-index-maps`).
  - Moving static inline style blocks in `TankPreview.tsx`, `WindBanner.tsx`, `RoundSummary.tsx`, `GameCanvas.tsx`, `LanguageSwitcher.tsx`, `ColorPicker.tsx`, and `MainMenu.tsx` into unified CSS classes in `src/App.css` to prevent unnecessary objects allocation on every render (`no-inline-exhaustive-style`).
  - Configured React Doctor in CI with a GitHub Actions workflow.
- **Content Security Policy (CSP) Update**: Allowed Cloudflare Web Analytics script (`https://static.cloudflareinsights.com`) inside the `script-src` directive in `index.html` to resolve browser console violations.
- **Version Display on Main Menu**: Automatically imports and displays the current game version (`v0.4.1`) in the footer of the retro Main Menu next to the license statement.
- **Basic Online Multiplayer (lobby foundation)**: Host creates room (2-4 players, mix human via per-player shareable URLs + optional AI), live WS waiting room, auto-start when humans joined. Initial game WS sync for turns (FIRE to server, SHOT/STATE_UPDATE broadcast), client localPlayerId gating + seeded RNG + server heights for consistent initial state across clients (dev testing via same-browser tabs or real WS). Full authoritative sim + real-time craters/damage sync in progress.
- **Test Suite (v0.4.1)**: **113 unit tests** across 11 files (Vitest), including ballistic simulation, AI profile dispatcher, terrain dirty-band redraw, HUD throttle, and fireworks optimization coverage.
- **Bullet and Nuke Direct Hit Damage Fix**: Fixed a bug where direct hits with `BULLET` and `NUKE` were often ignored or severely penalized. Bypassed the splash `distance > radius` check and linear falloff for direct hits on the target tank's bounding box, ensuring `BULLET` deals its intended 3x damage multiplier (75 dmg) and `NUKE` instantly destroys the target.
- **Custom Analytics Events via Cloudflare Zaraz**: Created an analytics utility to send custom events (`game_start`, `round_end`, `game_over`) to Cloudflare Zaraz (`window.zaraz.track`) for rich metrics tracking (game counts, player profiles, win ratios, and most used AIs).
- **Randomized Tank Starting Order**: Tank starting positions are shuffled at the beginning of each round using a secure Fisher-Yates shuffle, so players spawn in different relative horizontal orders instead of a fixed layout.
- Keyboard + HUD (WindBanner)
- Multiple weapons + limited ammo + shop economy (including **Weapon Shop State Mutation Fix & Unit Tests**: resolved a React state propagation bug where stock/money +/- button changes did not trigger re-rendering, corrected `MUTATE_SHOP_PLAYERS` reducer action, and added `gameCanvasReducer.test.ts` coverage).
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

- Start with `src/main.tsx` (app entry point, handles production console suppression), `src/App.tsx` (top-level phase management), and `src/components/MainMenu.tsx`
- Main game view + engine integration: `src/components/GameCanvas.tsx`
- Core simulation lives in `src/game/engine/GameEngine.ts` (also hosts active turn indicator + recoil trigger + celebration)
- Terrain destruction: `src/game/engine/Terrain.ts`
- AI contract: `src/game/entities/ai/AIEngine.ts` + `AIByProfileStrategy.ts` (v1 `AISimpleStrategy`, v2 `AIHeuristicStrategy`, v3 `AISniperStrategy`, v4 `AISmartStrategy`)
- Tank + recoil visuals: `src/game/entities/TankManager.ts` + `src/game/rendering/tankSprite.ts`
- Projectile color harmonization: `src/game/engine/PhysicsEngine.ts`
- Agent-oriented guide: [AGENTS.md](./AGENTS.md)

Enjoy blowing up the landscape!
