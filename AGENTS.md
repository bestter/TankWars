# AGENTS.md — TankWars

Guidance for AI coding agents working in **Bestter's TankWars** (`bestters-tankwars`). Read this file first. Human-oriented overview: [README.md](./README.md). Overlapping rules also appear in [CLAUDE.md](./CLAUDE.md) and [.cursorrules](./.cursorrules).

## Project summary

Browser-based artillery game (Scorched Earth / Worms style): destructible terrain, turn-based combat, weapon shop economy, 2–4 players (human or AI). **React 19 + TypeScript (strict) + HTML5 Canvas 2D**. No game frameworks, no external physics engines.

## Commands

| Task | Command |
|------|---------|
| Install | `npm install` |
| Dev server | `npm run dev` → http://localhost:5173 |
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
│   ├── MainMenu.tsx        # Player count, names, Human / IA Simple / IA OK
│   ├── GameCanvas.tsx      # Canvas ref + GameEngine lifecycle + React phase overlays
│   ├── GameHUD.tsx
│   ├── WeaponShop.tsx
│   └── RoundSummary.tsx
└── game/
    ├── engine/
    │   ├── GameEngine.ts   # 120Hz loop: physics, render, terrain, projectiles
    │   ├── PhysicsEngine.ts
    │   ├── Terrain.ts      # Heightmap + crater destruction
    │   └── TurnManager.ts
    ├── rendering/
    │   └── tankSprite.ts   # Pure `drawTankSprite()` (Canvas2D only) — chenilles, beveled chassis, dome turret, independent cannon (integrated visual tank redesign)
    └── entities/
        ├── TankManager.ts
        └── ai/
            ├── AIEngine.ts             # Strategy contract — implement this for new AI
            ├── AIByProfileStrategy.ts  # Dispatcher selecting per-player aiProfile (v1/v2)
            ├── AIHeuristicStrategy.ts  # Phase 2 "IA OK" (v2-heuristic) — wind/terrain aware, revenge, memory, precision
            ├── AISimpleStrategy.ts     # Phase 1 naive (v1-random)
            ├── AIStrategy.ts
            └── RandomAIStrategy.ts
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

`MENU` → `COMBAT` → `RESOLUTION` → `SUMMARY` → `SHOP` → … → `GAME_OVER`

- `App.tsx`: `MENU` vs everything else (starts match with `Player[]` from `MainMenu`).
- `GameCanvas.tsx`: in-match phases, shop, round summary, game over.

### Visual & terrain rules

- Use **`VGA_PALETTE`** from `src/types/game.ts` for all game rendering (classic 16-color VGA + extended high-contrast arcade/neon colors: ELECTRIC_CYAN, FLASH_GREEN, NEON_PINK, CYBER_YELLOW, FLUO_ORANGE, VOLT_PURPLE, etc. for tank redesign).
- Tank rendering: pure procedural helper `drawTankSprite(ctx, x, y, width, height, angle, turretAngle, primaryColor)` in `src/game/rendering/tankSprite.ts` (geometric retro style, textured tracks/chenilles, beveled chassis using primaryColor, arc dome turret, thick cannon with independent turretAngle rotation via save/translate/rotate/restore). Fully integrated into the 120 Hz engine render loop with dynamic slope-aware chassis tilt.
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
- **Phase 2 (implemented):** `AIHeuristicStrategy` (menu `aiProfile: 'v2-heuristic'`, "IA OK") as a new strategy class. Heuristic/predictive aiming using wind + gravity + terrain sampling. Key behaviours:
  - Revenge: if damaged (`lastHitBy`), switch to attacker as next target; otherwise stick to previous target.
  - New target: prefer weakest (lowest health), slight human bias.
  - Per-turn precision ramp on the same target + per-round memory of successes/fails (health drop detection) to improve/adjust.
  - Weapon selection (GRENADE on rough terrain, CLUSTER vs groups, etc.).
  - Not a sniper: residual noise + coarse simulation so kills typically take 3+ shots.
- A single `AIByProfileStrategy` (registered in `GameCanvas.tsx`) dispatches per-player based on `aiProfile` (supports mixed Human + different AI types).
- New strategies must be registered in `GameCanvas.tsx`; do not entangle AI logic inside `TankManager` or `GameEngine` internals.
- Supporting data: `aiProfile` on `Player`, `lastHitBy` on `Tank`, `windForce`/`gravity` on `GameState` snapshots for AI.

## Common tasks — where to edit

| Goal | Primary files |
|------|----------------|
| Menu / player setup | `MainMenu.tsx`, `types/player.ts` (now supports IA SIMPLE + IA OK profile choice) |
| New weapon | `types/weapon.ts`, GameEngine (sounds + VFX/particles for large weapons), PhysicsEngine/TankManager (special damage/projectile rules), HUD/shop, GameCanvas (AI buy lists) |
| Turn / round flow | `TurnManager.ts`, `GameCanvas.tsx` |
| Physics / explosions | `PhysicsEngine.ts`, `GameEngine.ts` |
| Terrain generation / craters | `Terrain.ts` |
| Tank visual / procedural sprite (Step 1) | `game/rendering/tankSprite.ts` (pure `drawTankSprite`), `types/game.ts` (VGA_PALETTE neon extensions) |
| Smarter AI | New file under `game/entities/ai/`, implement `AIEngine` |
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

## Commits

- **Imperative mood** commit messages (e.g. `Add cluster spread to PhysicsEngine`).
- Per project convention: sign commit messages with agent name and **exact model name** when committing on behalf of the user.

## Skills in this repo

| Skill | When to use |
|-------|-------------|
| `.agents/skills/react-doctor/` | Before/after React changes; `/doctor` full triage |

## Planned work (context only)

Do not block current architecture for these; implement incrementally when asked:

- Visual tank redesign (Complete: Steps 1, 2, and 3 landed with procedural canvas drawing, pre-game color selection with mutual exclusion, live tank preview, and dynamic slope-aware chassis tilt)
- Sound, particles, more weapons
- Persistent scores / match history
- Further AI improvements (beyond v2-heuristic "IA OK")

---

When unsure about a design constraint, prefer **strict React/Canvas separation** and **pluggable AI via `AIEngine`** over shortcuts.