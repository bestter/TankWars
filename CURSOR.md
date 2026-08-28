# Bestter's TankWars — Cursor Rules (CURSOR.md)

**Cursor users:** read [AGENTS.md](./AGENTS.md) first. It is the single source of truth for layout, commands, verification, pitfalls, and the file map. This file is a Cursor-friendly companion. It is not a changelog. Also see [.cursorrules](./.cursorrules), [.antigravityrules](./.antigravityrules), [CLAUDE.md](./CLAUDE.md), [GROK.md](./GROK.md).

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

- Players: 2–4, any mix Human / IA SIMPLE / IA OK / IA SNIPER / IA EXPERT (`MainMenu.tsx`). Local AI names use the short localized profile name (`Simple`, `OK`, `Sniper`, `Expert`); suffixes count all other slots with that profile and advance past names used by any human or AI (`Simple`, `Simple-1`, `Simple-2`). Existing names are not renumbered, remain editable, and stay frozen after language changes. Manual names must be unique after locale-independent `trim().toLowerCase()` normalization; duplicates are highlighted after blur/button interaction and block local start. Never use default-locale `toLocaleLowerCase()` for this comparison.
- Tanks: `drawTankSprite` only (`src/game/rendering/tankSprite.ts`), 24×15, hull tilt + independent `turretAngle`. Active triangle, `ownerColor` shells, micro recoil.
- State machine (`src/types/game.ts`): `MENU` → `COMBAT` → `RESOLUTION` → `CELEBRATION` → `SUMMARY` → `SHOP` → `GAME_OVER`.
- Shields & Gauges: 40 innate shield points per tank/round. Direct hits deal 2× damage to shield (absorbs via `Math.ceil(shield / 2)`; 1× overflow to health); indirect splash deals 1× damage. Fall damage directly reduces health, leaving shield intact. Visual gauge on Canvas (constants `TANK_GAUGE_*`): single dark cyan bar (`VGA_PALETTE.DARK_CYAN`) at $y-24$ when shield > 0 and health is full; stacked dual bars (dark cyan shield at $y-28$, green health at $y-23$, name at $y-36$) when shield > 0 and health < maxHealth; single green bar at $y-24$ when shield <= 0 (red if $\le 40\%$).
- Terrain: heightmap custom dans `Terrain.ts` (relief diversifié multi-octaves avec bosses et creux tactiques). Matériaux (`src/types/terrain.ts`) : `DIRT` (normal), `ROCK` (roche indestructible, mur pour le souffle latéral ; explosion par-dessus : +50% dégâts, portée inchangée), `SOFT` (terrain meuble, multiplicateur 2.5x). GRENADE : rebond ~2× sur ROCK ; colle et explose au premier contact sur SOFT (`grenadeBounceParams`).
- Weapons (`WEAPON_REGISTRY` in `src/types/weapon.ts`): Missile unlimited (not in shop). Others decrement. Baby Nuke (`NUKE`) costs $420. DRILLER carves an oriented shaft of depth `DRILLER_SHAFT_DEPTH` (53 px); splash stays as registered. BULLET ×3 on direct hitbox hit. BULLDOZER ($150, 0 HP / 0 blast) pushes on direct hit and skips `applyExplosionDamage`. NUKE / THERMONUCLEAR have special VFX/audio in `GameEngine`.
- Economy: exact per-shot rewards in `src/game/economy/`. Base $X = $3 / $3.50 / $4 for 2 / 3 / 4 players; actual damage, attributed falls, destructions and round outcome are combined with one final ceiling. Self-damage pays nothing. Floating feedback lasts 3 seconds without blocking; summary = round earnings, shop = total balance.
- Zeus Lightning: pure anti-deadlock domain in `src/game/zeus/`, never a weapon. With ≥2 living AIs and no living human, appoint fairly after `living AI × 5` shots without a paid hit (`hasEarnings`). Reset on earnings/human/<2 survivors/Zeus death/round end; preserve fair history across rounds. Consume the last living direct attacker (BULLDOZER excluded), otherwise injected RNG; kill only the target and award `25X`. Never add `ZEUS_LIGHTNING` to `WeaponId`, `WEAPON_REGISTRY`, `FireCommand`, shop, or `AIEngine`.
- Spawns: shuffled X biased toward hollows (max canvas Y), 100 px gap, 13 % margins, `Y = groundY`. Local humans: −25 % on SOFT. AI all modes: −25 % on ROCK (`spawnAcceptsMaterial`).
- Hits: AABB 24×15, owner hitbox ignored until the shell exits it.
- Online (in `main`): `OnlineLobby.tsx` + `useGameSession.ts` + `onlineSession.ts` + `worker/` (`GameRoom` DO). Shared turn helper: `src/game/online/turnOrder.ts`; strict messages: `src/game/online/protocol.ts` (`ONLINE_PROTOCOL_VERSION` 1; mismatch overlay + close `4402`; deploy Pages then Worker). Shot replay: `authoritativeShotQueue.ts` + `DeferredTransitionBuffer`. Server owns turn order, FIRE validation/ammo, transactional shop (composite idempotency keys), reward/balance application, round end and ordered reconnect catch-up (round-scoped `shotHistory`). Clients launch physics only from `SHOT`, including the shooter; a restored `SHOP` without its first `SHOP_STATE` retries `SHOP_ENTER`, which creates or resumes one idempotent session and applies AI purchases once. Client FIRE during AI turn is rejected (`NOT_YOUR_TURN`); rejection notices display via a non-blocking toast alert (`.fire-rejection-toast`). First connected human is reward authority with persistent ordered failover. `GAME_START` sends `materials` only when the server array matches `heights`; `loadHeights` falls back to `DIRT`. Dev: `npm run dev` + `npm run worker:dev`. `worker/.wrangler/` gitignored.
- Online Zeus: `GameRoom` alone decides and persists appointment/history/revenge/RNG/order/strike before broadcast. `ZEUS_APPOINTED`, `ZEUS_STRIKE`, `ZEUS_STRIKE_APPLIED`, `ZEUS_STATE` are reconnect-safe and idempotent; economic-authority changes do nothing. VFX use strike ID + time, never room RNG.
- Tests: **751** across **73** files (`npm run test`).
- Version: `0.7.0` (footer on the main menu).

## AI (Cursor must respect)

All tank AI implements `AIEngine` (`src/game/entities/ai/AIEngine.ts`). Single router: `AIByProfileStrategy` (wired in `GameCanvas.tsx`).

| Profile | Class | Label |
|---------|--------|-------|
| `v1-random` | `AISimpleStrategy` | IA SIMPLE — naive, **no** `fallibleAim` |
| `v2-heuristic` | `AIHeuristicStrategy` | IA OK — first shot ≥ 36 px, lock at shot 5 |
| `v3-sniper` | `AISniperStrategy` | IA SNIPER — first shot ≥ 36 px, lock at shot 4, 14 % slip after |
| `v4-smart` | `AISmartStrategy` | IA EXPERT — first shot ≥ 36 px, lock at shot 3 |

v2–v4 share `fallibleAim.ts` + `roundSkill.ts`, `terrainMaterialTactics.ts` (no DRILLER on ROCK; prefer DRILLER on SOFT when the default is MISSILE), and `bulldozerTactics.ts` (pick BULLDOZER on map edge / drop ≥ 12 px, dist ≥ 80; v1 never buys or fires it). All AI share `hitReaction.ts` (Issue 174: direct hit +50%, fall 1–25% cumulative on shot 1; shot 2: Sniper 0%, Expert 12%, OK/Simple 25%; shot 3: 0%). Warmup ease-out: 15% on round 1, table spec at round 5, then late tighten to skill 1.35. First shot stays ≥ 36 px. Before round 5 the lock shot can still miss. New strategies → new file under `game/entities/ai/`, register in the dispatcher + `GameCanvas.tsx`. Never put AI inside `TankManager` or `GameEngine`. `AIStrategy` is legacy and unwired.

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
- [.antigravityrules](./.antigravityrules)
