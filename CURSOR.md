# Bestter's TankWars — Cursor Rules (CURSOR.md)

**Cursor users:** read [AGENTS.md](./AGENTS.md) first. It is the single source of truth for layout, commands, verification, pitfalls, and the file map. This file is a Cursor-friendly companion. It is not a changelog. Also see [.cursorrules](./.cursorrules), [CLAUDE.md](./CLAUDE.md), [GROK.md](./GROK.md).

## Role & Stack

- Role: Senior Software Architect & Expert Game Developer (retro artillery)
- Stack: TypeScript (strict, zero `any`), React 19 (hooks), HTML5 Canvas 2D (no WebGL, no game libs)
- Styling: monospace retro; `App.css` / `index.css` only (no Tailwind, no UI kit)
- Language: reply in French (Québécois preferred), even if the user writes in English

## Core Principles

1. Never mix React state with the Canvas high-frequency loop. React owns `GamePhase`, players, money, shop, HUD. GameEngine owns physics, terrain, projectiles, drawing, combat audio.
2. Modular, strongly-typed TypeScript. Shared types go in `src/types/`.
3. Physics at fixed `PHYSICS_DT = 1/120` in `GameEngine`, decoupled from display raf.
4. All rendering uses `VGA_PALETTE` from `src/types/game.ts`.
5. RNG: `secureRandom` from `src/utils/random.ts` — never `Math.random`.

## Game Specs (current)

- Players: 2–4, any mix Human / IA SIMPLE / IA OK / IA SNIPER / IA EXPERT (`MainMenu.tsx`).
- Tanks: `drawTankSprite` only (`src/game/rendering/tankSprite.ts`), 24×15, hull tilt + independent `turretAngle`. Active triangle, `ownerColor` shells, micro recoil.
- Terrain: heightmap custom dans `Terrain.ts` (relief diversifié multi-octaves avec bosses et creux tactiques). Matériaux (`src/types/terrain.ts`) : `DIRT` (normal), `ROCK` (roche indestructible, +50% dégâts de souffle, portée inchangée), `SOFT` (terrain meuble, multiplicateur 2.5x).
- Weapons (`WEAPON_REGISTRY` in `src/types/weapon.ts`): Missile unlimited (not in shop). Others decrement. DRILLER carves an oriented shaft of depth `DRILLER_SHAFT_DEPTH` (53 px); splash stays as registered. BULLET ×3 on direct hitbox hit. NUKE / THERMONUCLEAR have special VFX/audio in `GameEngine`.
- Economy: $300 per destroy, $600 when only one tank remains, $500 survival after the round.
- Spawns: shuffled X, 100 px gap, 13 % margins, `Y = groundY`.
- Hits: AABB 24×15, owner hitbox ignored until the shell exits it.
- Online (in `main`): `OnlineLobby.tsx` + `useGameSession.ts` + `onlineSession.ts` + `worker/` (`GameRoom` DO). Shared living-player index: `src/game/online/turnOrder.ts`. Dev: `npm run dev` + `npm run worker:dev`. `worker/.wrangler/` gitignored.
- Tests: **378** across **48** files (`npm run test`).
- Version: `0.5.0` (footer on the main menu).

## AI (Cursor must respect)

All tank AI implements `AIEngine` (`src/game/entities/ai/AIEngine.ts`). Single router: `AIByProfileStrategy` (wired in `GameCanvas.tsx`).

| Profile | Class | Label |
|---------|--------|-------|
| `v1-random` | `AISimpleStrategy` | IA SIMPLE — naive, **no** `fallibleAim` |
| `v2-heuristic` | `AIHeuristicStrategy` | IA OK — first shot ≥ 36 px, lock at shot 5 |
| `v3-sniper` | `AISniperStrategy` | IA SNIPER — first shot ≥ 36 px, lock at shot 4, 14 % slip after |
| `v4-smart` | `AISmartStrategy` | IA EXPERT — first shot ≥ 36 px, lock at shot 3 |

v2–v4 share `fallibleAim.ts` + `roundSkill.ts`. Warmup ease-out: 15% on round 1, table spec at round 5, then late tighten to skill 1.35. First shot stays ≥ 36 px. Before round 5 the lock shot can still miss. New strategies → new file under `game/entities/ai/`, register in the dispatcher + `GameCanvas.tsx`. Never put AI inside `TankManager` or `GameEngine`. `AIStrategy` is legacy and unwired.

## Edit strategy

- Concise, production-ready. Lead with paths and diffs.
- Small targeted edits. Explore with grep / symbols before writing.
- After changes: `npm run lint` → `npm run build` → `npm run test` (see [AGENTS.md § Verification](./AGENTS.md#verification-checklist)).
- React-heavy work: run the react-doctor skill (`/doctor`).
- Document architecture inline only when it is not already in AGENTS.md.
- Do not edit rule files unless the user asked.

## Commit style

- Imperative mood.
- Sign with agent identity + exact model.

## Quick Links

- [AGENTS.md](./AGENTS.md) — operational source of truth
- [GROK.md](./GROK.md)
- [CLAUDE.md](./CLAUDE.md)
- [.cursorrules](./.cursorrules)
