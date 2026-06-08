# Bestter's TankWars — Grok Guide

**Grok agents (xAI):** read [AGENTS.md](./AGENTS.md) first for authoritative layout, commands, verification checklist, common tasks, "what not to do", and Step 4 polish details. This file provides Grok-specific context and quick rules. Overlaps exist with [CLAUDE.md](./CLAUDE.md), [CURSOR.md](./CURSOR.md), and [.cursorrules](./.cursorrules).

## Quick Start for Grok Sessions

- Always begin by reading AGENTS.md + the current file.
- Before any code change that affects visuals or engine: re-read `src/game/engine/GameEngine.ts` (render + fireProjectile), `TankManager.ts` (draw + recoil), `PhysicsEngine.ts` (draw + Projectile).
- After edits: run `npm run lint && npm run build` (mandatory per AGENTS).
- Use imperative commit style and sign with your exact model: e.g. `Add floating active indicator (Step 4) — Grok 4.3 (xAI)`.
- The system prompt identifies you as "Grok 4.3 released by xAI in April 2026".

## Recent Polish (Step 4, 5, 6 & 7)

Implemented (pure Canvas 2D, 120 Hz safe):
- Active turn indicator: inverted triangle above current player tank (via `turnManager.getCurrentPlayer()`), colored with tank primary, vertical bob via the exact formula `Math.sin(Date.now() / 200) * 5`. Drawn late in `GameEngine.render`.
- Projectile harmonization: `ownerColor` added to `Projectile`, set from firer at launch time, used in `PhysicsEngine.draw` (falls back gracefully). Cluster subs inherit it.
- Recoil: lightweight `recoilState` Map in TankManager (dx/dy/remaining frames). `triggerRecoil` called from fire path (opposite angle vector). Decayed in physics `update`. Offset applied to sprite draw position only (chassis "kick").
- Tank positioning (Step 5): Randomized tank X positions on canvas with 100px minimum distance safety constraint to avoid overlaps and 13% width margin from left/right edges. Snapped vertically to the terrain heightmap (`Y = groundY`).
- Shell-Tank collision (Step 6): Direct AABB collision check in `PhysicsEngine.updateProjectiles` checking against active tank bounding boxes (24x15) with self-sabotage protection at launch (ignores owner's hitbox until it exits it).
- Sniper AI (Step 7): Highly accurate numerical trajectory search in `AISniperStrategy.ts` replacing the vacuum trajectory equations. Features deliberate coordinate-shifting miss for the first shot (landing safely ~36px away) and 0-noise perfect hits for the second shot onwards.
- React Doctor Performance & Styling Fixes: Fixed the top 3 React Doctor warning types in the project:
  - Caching `tank.position` to local references `pos` inside loops in `TankManager.ts` to prevent repeated prototype member access (`js-cache-property-access`).
  - Pre-building a Player `Map` once outside the projectile update loop in `PhysicsEngine.ts` to replace nested `.find()` searches with O(1) key lookups (`js-index-maps`).
  - Moving static inline style blocks in `TankPreview.tsx`, `WindBanner.tsx`, `RoundSummary.tsx`, `GameCanvas.tsx`, `LanguageSwitcher.tsx`, `ColorPicker.tsx`, and `MainMenu.tsx` into unified CSS classes in `src/App.css` to prevent unnecessary objects allocation on every render (`no-inline-exhaustive-style`).
  - Configured React Doctor in CI with a GitHub Actions workflow.
- Round Transition Hang: Fixed a deadlock where the game would freeze on round transitions if the starting player was an AI. The turn manager's `resumeForCombat` now properly locks input for AI players instead of unconditionally unlocking it, allowing the in-flight async AI turn to execute and fire successfully. Verbose console logs were also added to `TurnManager.ts` to trace AI execution flow.
- AI Aiming/Trajectory Simulation Origin: Fixed a bug where all AI strategies (Sniper, Heuristic, Smart) simulated their shots starting at the center of the tank `(sx, sy)` instead of the actual barrel tip `(launchX, launchY)`. This created a vertical/horizontal offset discrepancy that caused the Sniper AIs to overshoot and miss perpetually in mutual combat. The simulation coordinates in `AISniperStrategy.ts`, `AIHeuristicStrategy.ts`, and `AISmartStrategy.ts` have been aligned with the engine's launch formulas.
- AI Terrain Obstacle Avoidance: Implemented a new search penalty (10,000 points) in all ballistic trajectory search loops (`AISniperStrategy`, `AIHeuristicStrategy`, `AISmartStrategy`) when an early collision with the heightmap terrain is detected between the shooter and the target tank. This forces the AI to select high arcing trajectories to clear mountains and obstacles rather than blindly firing directly into intervening hills.
- New Weapon BULLET: Added the `BULLET` weapon ($150, 10px blast radius) which inflicts a 3x damage multiplier in case of a direct hit on a tank hitbox. Auto-buy is restricted to the `AISniperStrategy` (Sniper v3) profile only.
- **Merge Compilation Issue (isNewTarget):** Fixed a compilation error (`TS2304: Cannot find name 'isNewTarget'`) in `AISniperStrategy.ts` introduced by a recent merge. The variable `isNewTarget` is now properly defined before updating `mem.currentTargetId`, restoring clean builds and linting.
- **Internationalization (i18n):** Extracted all hardcoded user-visible strings from components (MainMenu, ColorPicker, TankPreview, GameCanvas, GameHUD, RoundSummary, WeaponShop, WindBanner, and GameEngine canvas text) into English and French translation JSON files. Replaced strings with i18n translation tokens using the useTranslation hook (or global i18n for Canvas engine). Created a retro-styled LanguageSwitcher component to dynamically toggle languages.
- **Post-Merge Fixes:** Resolved test failures and lint errors after the latest merge. Fixed duplicate test suites in `wind.test.ts` by merging them into a single suite that properly mocks `secureRandom` instead of `Math.random`, and cleaned up unused `afterEach` and `MockInstance` imports to satisfy ESLint. Also resolved unused `TerrainManager` import in `PhysicsEngine.test.ts` and resolved explicit `any` lint errors in `SEO.tsx`.
- **Terrain Test Lint Fix:** Fixed an ESLint error (`@typescript-eslint/no-explicit-any`) in `src/game/engine/__tests__/Terrain.test.ts` by replacing the `any` cast on the private `heights` property with a typed cast via `unknown as { heights: number[] }`, preserving TS strictness.
- **Terrain Test Restoration:** Restored checkCollision test suite and beforeEach configurations in Terrain.test.ts that were corrupted during a manual merge conflict resolution.
- **Game Version Bump:** Bumped game version from `0.1.0` to `0.1.1` in `package.json` and `package-lock.json`.

Keep these cheap: no per-frame allocations in hot paths, use existing Maps, native Math.

## Key Reminders (Grok-flavored)

- You are an interactive CLI tool for software engineering. Prefer surgical `search_replace`, `read_file`, `grep`. Use `write` only for brand new files.
- For complex multi-step: use `todo_write` early and mark items done immediately when complete (never batch).
- When the task involves genuine ambiguity or high-impact restructure, consider `enter_plan_mode` first.
- Background long-running (dev server, build): use `background: true` + task_id + `get_command_or_subagent_output`.
- Never put canvas mutations in React render. Never store live projectiles/particles in useState.
- New AI? Only via `AIEngine` + registration in `AIByProfileStrategy.ts` + `GameCanvas.tsx`. Never bypass.
- Use `VGA_PALETTE` constants everywhere for rendering.

## Verification (always)

1. `npm run lint` (0 new errors)
2. `npm run build`
3. Manual: menu → configure mixed players (incl. v3/v4) → play round → observe indicator bob + matching shell colors + visible recoil on shots → craters → shop.

See full checklist in AGENTS.md.

## Skills & Tooling

This repo has `.agents/skills/react-doctor/` (use `/doctor` or the skill for React changes).

Other MCP / agent skills may be available in the session.

When in doubt on architecture: **strict React vs Canvas ownership** + **pluggable AIEngine** is the north star.

---

Happy tanking. Sign your work.


- Use `secureRandom` from `src/utils/random.ts` instead of `Math.random` for all random numbers.
