# Bestter's TankWars — Cursor Rules (CURSOR.md)

**Cursor users:** read [AGENTS.md](./AGENTS.md) first. It is the single source of truth for project layout, build commands, verification, "what agents must not do", AI contract, and visual polish details (including Step 4). This CURSOR.md is a Cursor-friendly companion that mirrors key rules from [.cursorrules](./.cursorrules) while pointing back to the canonical docs.

## Role & Stack (for Cursor Composer / Agent)

- Role: Senior Software Architect & Expert Game Developer (retro artillery focus)
- Stack: TypeScript (strict), React 19 (hooks, no class components for new code), HTML5 Canvas 2D (pure, no WebGL, no external game libs)
- Styling: monospace retro aesthetic; inline styles + `App.css` / `index.css` (no UI kit, no Tailwind, no external component libraries)

## Core Principles (non-negotiable in Cursor edits)

1. Never mix React state with the Canvas high-frequency render loop. React owns `GamePhase`, players, money, shop, HUD state. Canvas + GameEngine own physics, terrain mutation, projectiles, and all drawing.
2. Write modular, strongly-typed TypeScript. **Zero `any`**. New shared types go in `src/types/`.
3. Keep physics updates (fixed 120 Hz timestep in GameEngine) decoupled from display raf.
4. All rendering uses `VGA_PALETTE` from `src/types/game.ts` (classic + neon extensions for tanks).

## TankWars Game Specifications (keep in mind when editing)

- Game loop: `requestAnimationFrame` + fixed `PHYSICS_DT = 1/120` accumulator in `GameEngine`.
- Terrain: fully custom heightmap in `Terrain.ts`; crater destruction with falloff. No third-party physics.
- Players: 2–4 (any mix Human / AI). Configured in `MainMenu.tsx`.
- Tank visuals: exclusively `drawTankSprite(...)` (see `src/game/rendering/tankSprite.ts`). Supports hull angle (slope) + independent turretAngle. Now includes Step 4: active indicator (GameEngine), owner-colored shells (PhysicsEngine), recoil (TankManager).
- State machine (see `src/types/game.ts`): `MENU` → `COMBAT` → `RESOLUTION` → `CELEBRATION` → `SUMMARY` → `SHOP` → `GAME_OVER`.
- Weapons & Economy: `WEAPON_REGISTRY` in `src/types/weapon.ts`. Missile unlimited (never in shop). Others limited, decrement on use. Shop between rounds. Advanced weapons (Thermonuclear etc.) have special VFX/sounds in GameEngine.
- Step 4, 5 & 6 Polish (recent): 
  - Active Player floating indicator (inverted triangle, player color, sine bob `Math.sin(Date.now() / 200) * 5`) drawn in `GameEngine.render` for the tank returned by `turnManager.getCurrentPlayer()`.
  - Projectiles inherit tank color (`ownerColor`).
  - Recoil: small temporary chassis displacement opposite firing angle on every shot.
  - Step 5 Tank Spawn Positioning: Randomized X coordinates at each round via `spawnTanks` (100px minimum separation safety, 13% width margins, snapped vertically to `Y = groundY`).
  - Step 6 Shell-Tank Collision: Direct AABB collision check in `PhysicsEngine.updateProjectiles` checking against active tank bounding boxes (24x15) with self-sabotage protection at launch (ignores owner's hitbox until it exits it).

## AI Implementation Rule (Cursor must respect)

- All tank AI **must** implement the `AIEngine` interface (`src/game/entities/ai/AIEngine.ts`).
- The single router is `AIByProfileStrategy` (instantiated in `GameCanvas.tsx` and passed via `engine.setAIEngine`).
- It dispatches based on `player.aiProfile`:
  - `'v1-random'`: `AISimpleStrategy` ("IA SIMPLE" / "Mr. Simple")
  - `'v2-heuristic'`: `AIHeuristicStrategy` ("IA OK")
  - `'v3-sniper'`: `AISniperStrategy` ("IA SNIPER")
  - `'v4-smart'`: `AISmartStrategy` ("IA EXPERT")
- New strategies → new file in `game/entities/ai/`, add to the dispatcher, update MainMenu labels if exposing in UI. Never put AI logic in TankManager/GameEngine.

## Response & Edit Strategy in Cursor

- Be concise and production-ready. Lead with file paths and diffs.
- Prefer small, targeted edits. Use Cursor's apply / search-replace style.
- When the user asks for a feature or bugfix, first explore with project symbols / grep before writing code.
- Always ensure `npm run lint` and `npm run build` would pass after your change.
- For React-heavy work, suggest or run the react-doctor skill.
- Document architectural decisions inline only when they are non-obvious and not already covered in AGENTS.md.

## Commit Style (when Cursor helps generate commits)

- Imperative mood: `Add ownerColor to projectiles for Step 4 harmonization`
- Sign with your agent identity + exact model if applicable.

## Quick Links

- Full agent guidance: [AGENTS.md](./AGENTS.md)
- Grok-specific: [GROK.md](./GROK.md)
- Claude-style: [CLAUDE.md](./CLAUDE.md)
- Original dotfile (may be used by some tools): [.cursorrules](./.cursorrules)

---

Follow AGENTS.md strictly. When in doubt, prefer the strictest interpretation of React/Canvas separation and pluggable AI.
