# Bestter's TankWars — Grok Guide

**Grok agents (xAI):** read [AGENTS.md](./AGENTS.md) first. It is the operational source of truth (layout, commands, verification, file map, pitfalls). This file is Grok-specific workflow only — not a changelog. Overlaps: [CLAUDE.md](./CLAUDE.md), [CURSOR.md](./CURSOR.md), [.cursorrules](./.cursorrules), [.antigravityrules](./.antigravityrules).

## Quick Start

- Read AGENTS.md, then this file.
- Before visual or engine edits: `GameEngine.ts` (render, `fireProjectile`, audio), `TankManager.ts` (draw, recoil, shields, damage), `PhysicsEngine.ts` (draw, `Projectile`).
- After edits: `npm run lint && npm run build && npm run test` (**769 tests**, 74 files).
- Online work: `npm run dev` + `npm run worker:dev`; restart the worker after `worker/src/game-room.ts` changes.
- Imperative commits. Sign with the exact model from the system prompt, e.g. `Add fallible sniper slip — Grok 4.6 (xAI)`.
- Reply in French (Québécois preferred), even if the user writes in English.

## Worker folder (`worker/`)

- **Versioned:** `worker/src/index.ts`, `worker/src/game-room.ts`, `worker/wrangler.toml`
- **Gitignored:** `worker/.wrangler/` (local Wrangler SQLite/cache)
- **Role:** REST `/api/rooms` + WS to `GameRoom` DO — lobby, server-first FIRE, authoritative rewards/balances and shop, `ROUND_END`, ordered reconnect catch-up (round-scoped `shotHistory`)
- **Shared turn math:** `src/game/online/turnOrder.ts` (no DOM, no Workers APIs)
- **Shared strict protocol:** `src/game/online/protocol.ts`; version 1 with temporary unversioned-v0 normalization. Strict/v0 `FIRE` and authoritative `SHOT` commands share finite inclusive `FIRE_COMMAND_*` bounds (angle -360° to 360°, power 0 to 100), repeated defensively in `GameRoom.executeFire`. Only an unsupported numeric version gets `PROTOCOL_MISMATCH` + close `4402`. Successful shop state/finish responses ack `{ slot, actionId }`; the client retries the same ID until that correlation arrives. Composite keys preserve idempotence.
- **Deploy:** Worker first, require `/api/health` protocol 1/minimum client 0, then build and deploy Pages. Disable automatic production Pages deployment; staging uses `VITE_HOTSEAT_ONLY=true` and never deploys the Worker.

## Current engine facts (not history)

- Palette: `VGA_PALETTE` only. Tanks: `drawTankSprite`, 24×15, slope tilt.
- Active indicator: inverted triangle, `Math.sin(Date.now() / 200) * 5`.
- Shells inherit `ownerColor`. Recoil is a short chassis offset only.
- Shields & Gauges: 40 innate shield points per tank/round. Direct hits deal 2× damage to shield (absorbs via `Math.ceil(shield / 2)`; 1× overflow to health); indirect splash deals 1× damage. Fall damage directly reduces health, leaving shield intact. Visual gauge on Canvas (constants `TANK_GAUGE_*`): single dark cyan bar (`VGA_PALETTE.DARK_CYAN`) at $y-24$ when shield > 0 and health is full; stacked dual bars (dark cyan shield at $y-28$, green health at $y-23$, name at $y-36$) when shield > 0 and health < maxHealth; single green bar at $y-24$ when shield <= 0 (red if $\le 40\%$).
- Spawns: shuffled X biased toward hollows (max canvas Y), 100 px gap, 13 % margins, snapped to `groundY`. Local humans: −25 % chance on SOFT. AI (all modes): −25 % chance on ROCK (`spawnAcceptsMaterial`).
- Hits: AABB 24×15, owner hitbox ignored until the shell exits it.
- Terrain: multi-octaves procedural heightmap with bumps/creux. Materials: `DIRT` (normal), `ROCK` (indestructible stone wall for side blast; exploding on top: +50% blast damage, radius unaffected), `SOFT` (2.5x destruction multiplier).
- DRILLER: oriented shaft (`DRILLER_SHAFT_DEPTH` = 53), splash unchanged.
- BULLDOZER: $150, 0 HP / 0 blast. Direct hit pushes the target (`sign(vx)`) and recoils the shooter (`min(|vx| × 0.25, 120 px)`). Skips `applyExplosionDamage` (no `wasDirectHit`). Falls use existing gravity / lava.
- GRENADE: ~2× bounce height on ROCK; first contact on SOFT sticks, digs, and detonates (`grenadeBounceParams`).
- Weapon pricing comes from `WEAPON_REGISTRY`; Baby Nuke (`NUKE`) costs $420.
- Local AI names use the localized short profile label (`Simple`, `OK`, `Sniper`, `Expert`). Suffixes count every other configured player with that profile, regardless of slot order, and advance past names used by any human or AI (`Simple`, `Simple-1`, `Simple-2`). Only the newly selected slot is renamed; names remain editable and do not change with later language switches. Duplicate checks use locale-independent `trim().toLowerCase()` normalization, surface after blur/button interaction, and block local start; never use default-locale `toLocaleLowerCase()` here.
- Economy: exact per-shot calculator in `src/game/economy/` with base $X = $3 / $3.50 / $4 for 2 / 3 / 4 players. Actual damage, attributed falls, destructions, survivor/draw outcomes feed one final ceiling; self-damage pays nothing. `ShotEarningsOverlay` floats for 3 seconds without blocking. Summary = round earnings; shop = total balance.
- Zeus deadlock action: `src/game/zeus/` is separate from weapons. With ≥2 living AIs and no living human, appoint fairly after `living AI × 5` shots without a paid hit (`hasEarnings`); reset on earnings, living human, <2 survivors, Zeus death, or round end. Zeus consumes the last living direct attacker (never BULLDOZER), otherwise injected RNG, kills only that target, and earns `25X`. Never add `ZEUS_LIGHTNING` to `WeaponId`, `WEAPON_REGISTRY`, `FireCommand`, shop, or `AIEngine`.
- `baseSpeed` = 6.0 (synced in v2–v4 AI). Projectile pool is on for launches and clusters.
- AI v1 is naive and must stay that way. v2–v4 aim through `fallibleAim.ts` (see AGENTS.md table) and pick weapons via `terrainMaterialTactics.ts` (no DRILLER on ROCK; prefer DRILLER on SOFT when the default is MISSILE) and `bulldozerTactics.ts` (BULLDOZER on map edge / drop ≥ 12 px, dist ≥ 80; v1 never buys or fires it). First shot always ≥ 36 px; OK/Sniper/Expert lock at shots 5/4/3 (`SHOTS_TO_HIT`). Warmup ease-out then late tighten. Simple is alcoholic with P = `1 − min(1, skill)`. All AI share `hitReaction.ts` (direct hit +50%, fall 1–25% cumulative on shot 1; shot 2: Sniper 0%, Expert 12%, OK/Simple 25%; shot 3: 0%).
- AI shop (#207): capture initial `N` once; target `min(3N, profile cap, #215 policy)` through unit `delta: 1` transactions, with no budget ratio/reserve. Orders are Simple G→C; OK G→C→D→B→N; Sniper BULLET→D→B; Expert THERMO→N→G→C→D→B. Missing/unknown shop profiles use OK. Local applies immediately; online Worker applies once per shop epoch after normalization.
- Online MVP: local physics launches from authoritative `SHOT` echoes; the server owns turn order, ammo, shop transactions and rewards. `GameRoom` persists active state and idempotent results. Unversioned v0 messages are temporarily normalized and logged; unknown numeric versions close in `4402`. Shop success is correlated by `{ slot, actionId }`, and retries reuse the same ID. Shot replay lives in `authoritativeShotQueue.ts`; `DeferredTransitionBuffer` orders shop transitions. Full authoritative terrain/damage simulation is still planned. `GAME_START` sends `materials` only when lengths match; otherwise `loadHeights` resets to `DIRT`.
- Online Zeus is Durable Object-authoritative and persisted before broadcast (`ZEUS_APPOINTED`, `ZEUS_STRIKE`, `ZEUS_STRIKE_APPLIED`, reconnect `ZEUS_STATE`). Strike IDs prevent double death/credit; authority failover changes nothing; cosmetic geometry uses only strike ID + time, not room RNG.
- Test suite: unit/integration coverage for player names (case, whitespace, accents/Unicode, host-locale-independent casing), deferred duplicate validation, and real `i18n.changeLanguage`.

Keep hot paths cheap: no per-frame allocations, reuse existing Maps, native Math.

## Key Reminders

- Prefer surgical `search_replace` / `read_file` / `grep`. Use `write` only for new files or full rewrites.
- Multi-step work: `todo_write` early; mark items done when finished, not in a batch at the end.
- Genuine ambiguity or high-impact restructure: `enter_plan_mode` first.
- Long-running processes: `background: true`.
- Never put canvas mutations in a React render. Never store live projectiles/particles in `useState`.
- New AI only via `AIEngine` + `AIByProfileStrategy.ts` + `GameCanvas.tsx`. Never inside `TankManager` / `GameEngine`.
- RNG: `secureRandom` only.

## Verification

1. `npm run lint`
2. `npm run build`
3. `npm run test` (756 / 73)
4. Manual when UI/engine changed: menu → mixed players (incl. v3/v4) → play a round → indicator bob, shell colors, recoil, craters, shop.

Full checklist: [AGENTS.md § Verification](./AGENTS.md#verification-checklist).

## Skills

`.agents/skills/react-doctor/` — use `/doctor` after React changes.

When in doubt: **React vs Canvas ownership** + **pluggable `AIEngine`**.
