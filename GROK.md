# Bestter's TankWars — Grok Guide

**Grok agents (xAI):** read [AGENTS.md](./AGENTS.md) first. It is the operational source of truth (layout, commands, verification, file map, pitfalls). This file is Grok-specific workflow only — not a changelog. Overlaps: [CLAUDE.md](./CLAUDE.md), [CURSOR.md](./CURSOR.md), [.cursorrules](./.cursorrules).

## Quick Start

- Read AGENTS.md, then this file.
- Before visual or engine edits: `GameEngine.ts` (render, `fireProjectile`, audio), `TankManager.ts` (draw, recoil), `PhysicsEngine.ts` (draw, `Projectile`).
- After edits: `npm run lint && npm run build && npm run test` (**359 tests**, 48 files).
- Online work: `npm run dev` + `npm run worker:dev`; restart the worker after `worker/src/game-room.ts` changes.
- Imperative commits. Sign with the exact model from the system prompt, e.g. `Add fallible sniper slip — Grok 4.6 (xAI)`.
- Reply in French (Québécois preferred), even if the user writes in English.

## Worker folder (`worker/`)

- **Versioned:** `worker/src/index.ts`, `worker/src/game-room.ts`, `worker/wrangler.toml`
- **Gitignored:** `worker/.wrangler/` (local Wrangler SQLite/cache)
- **Role:** REST `/api/rooms` + WS to `GameRoom` DO — lobby, turn relay, `ROUND_END`, shop sync
- **Shared turn math:** `src/game/online/turnOrder.ts` (no DOM, no Workers APIs)
- **Deploy:** `npm run worker:deploy` (separate from Cloudflare Pages)

## Current engine facts (not history)

- Palette: `VGA_PALETTE` only. Tanks: `drawTankSprite`, 24×15, slope tilt.
- Active indicator: inverted triangle, `Math.sin(Date.now() / 200) * 5`.
- Shells inherit `ownerColor`. Recoil is a short chassis offset only.
- Spawns: shuffled X, 100 px gap, 13 % margins, snapped to `groundY`.
- Hits: AABB 24×15, owner hitbox ignored until the shell exits it.
- DRILLER: oriented shaft (`DRILLER_SHAFT_DEPTH` = 53), splash unchanged.
- `baseSpeed` = 6.0 (synced in v2–v4 AI). Projectile pool is on for launches and clusters.
- AI v1 is naive and must stay that way. v2–v4 aim through `fallibleAim.ts` (see AGENTS.md table). Warmup ease-out: 15% on manche 1, table spec at manche 5, then late tighten (skill up to 1.35). Simple is alcoholic with P = `1 − min(1, skill)`.
- Online MVP: local physics + server turn order. Authoritative server sim is still planned.

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
3. `npm run test` (334 / 45)
4. Manual when UI/engine changed: menu → mixed players (incl. v3/v4) → play a round → indicator bob, shell colors, recoil, craters, shop.

Full checklist: [AGENTS.md § Verification](./AGENTS.md#verification-checklist).

## Skills

`.agents/skills/react-doctor/` — use `/doctor` after React changes.

When in doubt: **React vs Canvas ownership** + **pluggable `AIEngine`**.
