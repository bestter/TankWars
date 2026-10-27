# Bestter's TankWars

> A browser-based artillery tank battle game with material-dependent destructible terrain and a retro DOS/VGA title screen. Built from scratch with React + TypeScript + HTML5 Canvas.

**Classic Scorched Earth / Worms-style gameplay** — no external physics engines, no game frameworks. Pure custom terrain algorithms, projectile simulation, and a strict decoupled architecture.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![React](https://img.shields.io/badge/React-19-61DAFB)
![Vite](https://img.shields.io/badge/Vite-8-646CFF)

---

## Features

- **Local AI Endurance (0.11.0, test builds only)** — Run rendered AI-only blocks of multiple rounds at normal speed, with automatic celebrations, summaries and shops, watchdogs, structured physical statistics, local checkpoints and Markdown/JSON exports. Excluded from public builds. See [AI Endurance](#ai-endurance-206).

- **Local Shot Advisor (0.9.9)** — During a stable living human turn, **Suggest a shot** uses EXPERT’s shared candidate search and physical/economic forecasts in a dedicated browser Web Worker. **SURVIVAL** is the default for each human, retained between rounds and reset for a new match. It first attempts a safe destruction of the priority lethal threat, accepting a loss: neutralization ranks opponent destructions and real HP/shield losses rather than profit. Otherwise it maximizes profit among safe shots. **MAXIMIZE_PROFIT** directly maximizes immediate net earnings, allowing a more profitable suicidal shot and preferring survival at equal profit. Outside neutralization, negative-profit paid ammunition is excluded; zero-profit shots remain admissible. Ties use opponent destructions, real losses, turn order and stable search order, without human/AI preference. EXPERT’s automatic policies and randomness remain unchanged.
  - The result shows weapon, angle, power, targets, objective, HP/shield losses, predicted deaths (including the shooter), earnings, ammunition cost and net profit in production. **Apply aim** voluntarily replaces weapon/angle/power together; it never fires or consumes ammunition. Manual aiming stays available during calculation and does not expire advice.
  - The advisor snapshots the full situation, uses ideal zero-offset aim and private forecast randomness, and never changes game state, AI memory or the real RNG. Only one calculation runs at a time. Changing objectives cancels it; firing, changing turns/rounds/sessions, terrain, positions, HP/shields, stock, economics or environment invalidates it. Results are checked again on arrival and application, and workers are terminated on cancellation or unmount.
  - This is a forecast over the shared bounded search, not the best of every possible shot or a guarantee of future survival. GRENADE/CLUSTER forecasts do not predict real physical random draws. Enemy nuclear stocks remain unknown; the shooter’s own nuclear ammunition remains available. BULLDOZER is fallback-only, DRILLER keeps its ROCK veto, and incomplete forecasts or the uncertified last MISSILE are never suggested. The advisor is unavailable online, during AI/Zeus turns, falls, resolution, shops, menus or round transitions. Missing/invalid economics produces an error rather than invented profit.
- **Destructible Heightmap Terrain & Diverse Topography** — Procedurally generated diverse terrain using multi-octaves layered sine waves, localized tactical hollows (shelters for tanks), and steep hills/ridges. Distinct terrain materials (#184):
  - `DIRT` (Standard earth & grass: parabolic craters with rim smoothing and brown/green dust particles)
  - `ROCK` (Indestructible against conventional weapons and in online matches: all blast and carving occlusion tests intermediate `ROCK` column rectangles `[c, c+1) × [surfaceY, ∞)` without an impact-column exemption, and exploding on `ROCK` deals +50% damage to unoccluded targets within the unchanged radius. In local play (#302), `NUKE` and `THERMONUCLEAR` carve `ROCK` within their nominal 62 px / 160 px radii using the same parabolic profile as pure DIRT without sand amplification, smoothing or slumping on `ROCK`; remaining columns stay `ROCK`, direct hits are qualified at the impact position — `NUKE` kills its direct target immediately — and projectile damage, including indirect blast and the 75 px thermonuclear kill zone, is applied once after carving and before any fall)
  - `SOFT` (Loose sand/sediment: rounded bowls with smooth shoulders anchored to the original surface, preserving the historical 2.5× half-width and central depth on pure sand, via 8-column local softness blend, followed by rim smoothing, deterministic sand slumping tapered at the rounded shoulders, and yellow/brown dust + falling sand grains)
  - Crater reach accumulates material resistance outward from the impact, with a single decreasing bowl profile on each side. Once reach is exhausted, distant SOFT cannot restart carving and create a detached pit. Central depth follows impact softness; mixed-material widths follow the material path, with a maximum of 2.5× the weapon radius on pure sand. Pure DIRT retains its nominal parabolic profile, and ROCK keeps its existing carving and occlusion rules. Protected columns cannot contribute a SOFT bonus to the envelope.
  - Surface caps cover each full column `[x, x+1)` in its material color, including material boundaries and isolated columns, with identical full and partial rendering.
  - DRILLER carves an oriented shaft of material-specific stamps (parabolic DIRT, rounded SOFT) without smoothing or slumping, enforcing both initial-impact and per-stamp `ROCK` occlusion.
- **Safe Initial Placement** — In local and online play, all 24 px of a tank base must intersect either only ROCK columns or no ROCK columns; wide ROCK plateaus remain allowed and DIRT/SOFT transitions are allowed. Positions retain 13% side margins, 100 px minimum separation, tactical hollows and probabilistic material preferences. If sampling fails, a deterministic search packs the leftmost admissible continuous centers (including fractional positions). A map that cannot fit the entire roster is discarded; preparation tries at most 16 maps total. Exhaustion stops combat, preserves the roster/economy and offers a translated retry. This rule applies to initial placement only; recovery and post-shot falls never respawn tanks.
- **Authentic 16-Color VGA Palette + Neon Extensions** — All rendering (tanks, explosions, UI, terrain) uses the classic high-contrast VGA 16-color palette, extended with arcade/neon colors (ELECTRIC_CYAN, FLASH_GREEN, NEON_PINK, CYBER_YELLOW, FLUO_ORANGE, VOLT_PURPLE, …) for the procedural tank sprites.
- **Realistic Projectile Physics** — Gravity, variable wind, different ballistic profiles (missiles, arcing grenades, clusters). Object pool recycles launches and cluster sub-munitions.
- **Multiple Weapons**
  - Missile (balanced, unlimited)
  - Grenade (arcing + bounces ~2× higher on rock; sticks, digs, and explodes in sand)
  - Cluster Bomb (sub-munitions)
  - Baby Nuke ($420; massive blast; direct hit instakill; carves `ROCK` in local matches)
  - Driller (oriented shaft + current splash; depth `DRILLER_SHAFT_DEPTH`)
  - Bullet (precision shot, ×3 direct hitbox damage)
  - Bulldozer ($150; 0 HP / 0 blast; direct hit pushes the target and recoils the shooter; falls use existing gravity / lava; does not go through `applyExplosionDamage`)
  - Thermonuclear Bomb (destroys ~1/4 of the map with an inner instant-kill zone; carves `ROCK` in local matches; outer tanks fall into the crater; large VFX + deep bomb sound)
- **Configurable Matches (2–4 Players)** — Retro Main Menu: player count, editable names, and mix of Human / IA SIMPLE / IA OK / IA SNIPER / IA EXPERT. Local AI names default to the short localized profile name (`Simple`, `OK`, `Sniper`, `Expert`). Suffixes preserve profile ordering while skipping every name already used by a human or an AI (`Simple`, `Simple-1`, `Simple-2`). Name comparisons are trimmed, case-insensitive, and locale-independent (`trim()` + `toLowerCase()`), so browser locale cannot change collision results. Manual duplicate names are highlighted after leaving the field or pressing a button and block local match start until corrected. Names are assigned in the active language, remain frozen after language changes, and are never retroactively renumbered. Unique VGA colors include live previews and a mutual-exclusion picker.
- **Turn-Based Combat** — Full turn system with Human and AI players. Any combination up to 4 participants.
- **Zeus Lightning Anti-Deadlock** — After `living players × 5` consecutive fully resolved human or AI shots without earnings, Zeus automatically takes the next turn. Only surviving AIs are eligible while any AI lives; otherwise surviving humans are eligible. Fair match history comes first, then the lowest real health + shield, then the AI profile score (SIMPLE → OK → SNIPER → EXPERT). A unique candidate consumes no nomination draw; a complete tie consumes exactly one. An exhausted pool clears only its living members from history. Zeus automatically vaporizes one opponent on each of its turns, preferring its last living direct attacker, until Zeus dies or the round ends. Ordinary commands and watchdogs cannot skip this special turn. `ZEUS_LIGHTNING` remains an internal action with the sole `25X` destruction reward.
- **Pluggable Local AI System** — `AIEngine` interface. In local matches, `AIByProfileStrategy` selects per player (mixed Human + AI supported):
  - `AISimpleStrategy` ("IA SIMPLE", `v1-random`) — curve by round/target, sticks to a live target, prioritizes the weakest AI, and does not use revenge or weapon tactics. Locks on shot 7.
  - `AIHeuristicStrategy` ("IA OK", `v2-heuristic`) — wind/terrain-aware, revenge (`lastHitBy`), memory, smart weapon choice. Locks on shot 5.
  - `AISniperStrategy` ("IA SNIPER", `v3-sniper`) — ballistic search after one shared aim offset. Locks on shot 3; its only deliberate overcorrection is shot 2. Chooses BULLET, DRILLER or MISSILE from the physical forecast, without an economic ranking (#289).
  - `AISmartStrategy` ("IA EXPERT", `v4-smart`) — forecasts complete local shots after their normal aim offset, counters the next ideal lethal threat, then ranks net profit and fires the evaluated command. Aim reaches its round-dependent residual on shot 2; reaction and gaffe can still perturb the command (see #229/#271 below).
  All profiles share `fallibleAim.ts`, `aimMemory.ts`, `aimCorruption.ts`, `heuristicShot.ts`, and `hitReaction.ts`. Curves interpolate across M1/M5/M12+ and preserve a 36 px first-shot direct-aim floor. OK, SNIPER, and EXPERT reject DRILLER when a retained target rests on ROCK (EXPERT checks every member of its evaluated group). Only OK and EXPERT admit ordinary BULLDOZER opportunities (map edge / drop ≥ 12 px, dist ≥ 80); EXPERT validates it only in fallback.
  **Local material decisions (#226):** OK retains its target and ordinary weapon preferences, then examines at most 12 ideal proposals in stable weapon/point/arc order. It chooses the first useful shot that leaves the shooter alive, otherwise the first proven nonfatal shot, then the ordinary fallback. Useful means applied health/shield loss or an attributed elimination of that target; excavation alone is insufficient. A SOFT promotion from MISSILE to DRILLER additionally requires actual excavation of the target support, utility and survival. OK's GRENADE search now includes material-dependent bounces.
  **SNIPER physical selection (#289):** SNIPER keeps the same target rules, curves, second-shot overcorrection and ROCK veto. It no longer forces MISSILE on the first attempt and no longer rolls a 50% chance of BULLET. One shared signed offset is applied before every search, and X is left unclamped. Every admissible BULLET and DRILLER is ranked by destruction of the memorized target, then that target's real health and shield loss, then BULLET. BULLET must hit that target directly and produce a real effect. DRILLER must hit terrain, remove support, and either deal attributed fall damage to health or bury the target or drop it in lava. A direct tank hit, blast alone, harmless excavation and a dead shooter are rejected. MISSILE is only the fallback and is not ranked against those weapons; its last ordinary tank/`full` command is uncertified. A decision searches at most 2 BULLET, 4 DRILLER and 4 MISSILE arcs, and at most 10 forecasts. Shop prices, rewards and balances do not participate. Reaction and gaffe still start from the retained raw command, so the fired shot can differ from the forecast. In development the local strategy logs one `[AI SNIPER] Décision` JSON string after that final command.
  EXPERT enriches only its own proposals, in both SURVIE and OPTIMISER_PROFIT: historical points plus points adjacent to the two closest local material transitions, at most eight points and three arc searches per weapon/group (24 proposals). Before comparing them, it reserves two shared random values (amplitude, then side), after the optional SURVIE roll. Virtual attempts depend on each group's primary target without advancing memory. Threats remain ideal; own candidates are simulated after this one offset and reuse their normalized command. SURVIE keeps safety before net profit and may spend a loss-making munition to eliminate the threat while surviving. OPTIMISER_PROFIT (#288) ranks immediate net profit first, then survival at equal profit, #267 consequences and historical tie-breaks, starting with the tactical point/arc selection. A suicidal +100 shot beats a surviving +80 shot. Paid shots with strictly negative profit are rejected; zero profit remains admissible without a free-ammunition preference. With no admissible main plan, EXPERT compares its ordinary fallback weapon and MISSILE after the same offset (at most 48 proposals); ordinary BULLDOZER uses only three searches toward the target hitbox center. Economic fallback uses profit, survival, consequences and stable order, including complete suicidal forecasts; it permits a free MISSILE without adverse effects to conserve loss-making ammunition. Without economic context it preserves the physical fallback: useful nonfatal shots, then nonfatal shots without useful effects, `profit: null` and physical consequences. Only if no complete admissible forecast exists does it perform one ordinary MISSILE search toward `(target.x + offset, target.y - 6)` with its existing proximity penalty; even an incomplete search supplies a bounded, uncertified last-resort command with no invented forecast or profit.
  Validation uses deep copies of tanks, terrain heights and materials, real projectile/gravity/burial routines at 1/120 s, and a private physical RNG fixed at 0.5. Ballistic trials remain bounded to 420 steps and full physical forecasts to 2400; incomplete results are rejected and identical normalized commands reuse forecasts within one decision. Retained material points keep their original Y and selected arc (`full/low/high`). OK retains its ideal proposals and final fallible search. SNIPER searches only after its shared offset and reuses the retained raw command, so reaction and gaffe are its only later perturbations. EXPERT applies its shared offset before searching, leaves X unclamped and reuses evaluated commands without another search; only the selected target advances memory. Reaction then gaffe start from that proposal's raw command and are normalized once at the end. Physical randomness can still make real GRENADE/CLUSTER consequences differ from the forecast. SIMPLE receives no additional material analysis or RNG draws. Curves and resets remain unchanged; EXPERT intentionally consumes both offset draws even at its residual plateau. Material diagnostics run only in development.
  AI shop stocks scale from the initial 2–4 player count: Simple buys GRENADE/CLUSTER; OK adds DRILLER/BULLDOZER/NUKE; Sniper buys BULLET/DRILLER/BULLDOZER; Expert prioritizes THERMONUCLEAR/NUKE before GRENADE/CLUSTER/DRILLER/BULLDOZER. Every unit uses the shared #215 shop transaction and its global limits; there is no percentage budget or cash reserve. Local hotseat applies purchases immediately, while online purchases run once per shop epoch on the authoritative Worker.
  **Post-hit & fall reaction (`hitReaction.ts`):** Direct hits and cumulative fall distance are retained for one next riposte, then consumed. Reaction intensity varies by profile and never introduces RNG when it is zero. Wired in MainMenu + GameCanvas.
  **Online combat limitation:** The Worker currently uses `maybeRunAIServerTurn` and a generated `fakeCommand`, not these local strategies. Local aiming, material and heavy-weapon tactics therefore do not describe online AI combat. Online AI purchases still use the shared authoritative shop policy.
- **Keyboard Controls** — ← → angle, ↑ ↓ power, SPACE to fire. Full on-screen HUD.
- **Wind Simulation** — Wind is generated for each round and affects every shot.
- **Shields + Health & Dynamic Gauges** — Tanks spawn with 40 innate shield points per round. Direct hits deal 2× damage to the shield (absorbs via `Math.ceil(shield / 2)`; normal 1× damage overflow to health); indirect splash deals 1× damage. Fall damage bypasses shield directly to health. Visual HUD on canvas: dark cyan shield bar (`VGA_PALETTE.DARK_CYAN`) above tank while shield > 0; if health is also reduced, a green health bar appears below the dark cyan shield bar; when shield is depleted, only the health bar (green, red if $\le 40\%$) is shown.
- **Per-Shot Economy + Shop** — Limited shots per weapon (Missile is unlimited and removed from the shop). Rewards are calculated after every resolved shot from actual shield/health damage, attributed falls, destructions, and the round outcome. The exact fixed-point calculator uses a player-count base of $3 / $3.50 / $4 for 2 / 3 / 4 players, rounds up only once, and never rewards self-damage. A Zeus strike pays only the standard destruction reward `25X`, with no damage or last-survivor component. A non-blocking `+amount$` floats above the rewarded tank for 3 seconds; the round summary shows round earnings while the shop shows the total balance.
- **Internationalization (i18n)** — French and English for UI, settings, weapon descriptions, and status. Retro LanguageSwitcher.
- **Mobile Playability & PWA** — Touch D-Pads (angle, power, fire, weapon cycle) with press-and-hold. `manifest.json` + `sw.js` (network-first navigations) for installable fullscreen landscape on iOS/Android.
- **Online Multiplayer** — Host creates a room (2–4 players: shareable human URLs + optional AI). Cloudflare Worker + Durable Object (`worker/`) owns turn order, FIRE/ammo, the transactional shop, rewards, round end, and Zeus. `FIRE` is server-first and idempotent by `actionId`. Protocol v4 (minimum client v4) requires a complete round map and uses finite inclusive FIRE bounds: angle -360° to 360° and power 0 to 100. Successful `SHOP_STATE` / `SHOP_FINISH` messages acknowledge `{ slot, actionId }`; concurrent states still update the UI but only the correlated ack unlocks local controls, and a timeout retries the same ID. The WebSocket handshake requires v4; older or missing versions receive `PROTOCOL_MISMATCH` and close `4402`. The Worker prepares and persists the common terrain, materials, initial positions and wind before every round. Clients load this result without regenerating terrain, respawning or rolling wind. Projectile physics and damage simulation stay local; server AI still uses its existing placeholder command.
- **Audio** — Chiptune explosions (spatialized), weapon hits, celebration fireworks, victory sting, and synthesized retro thunder at Zeus appointment/impact followed by the normal destruction sound. All in `GameEngine` (Web Audio).

---

## Online invitations and refresh

Valid invitations are captured in a separate, versioned `sessionStorage` lobby record before `room`, `slot` and `token` are removed from the address. Unrelated query parameters, the fragment and history state are preserved. Refresh restores an unjoined guest's form and name without connecting; an engaged guest or host reconnects to the existing room. Hosts retain their invitation links. A new invitation takes priority over incompatible saved combat; an identical invitation can resume combat. Without an invitation, valid combat takes priority over a saved lobby. Invalid invitations show an error and never silently restore a previous room.

If storage fails, a valid invitation stays in the address as a refresh fallback and a private-link warning appears. Hosts receive a restoration warning and keep their invitation links; their credentials are never inserted into the address. Failed address cleanup or storage removal also shows a warning. Leaving voluntarily clears both records and stops owned connections; successful combat persistence replaces the lobby record, and game end clears both. Local-only builds clear online participation without starting a network session.

Cleaning the address reduces exposure; it cannot remove previously copied links, requests or history copies, and does not revoke a token. Invitations and WebSocket URLs still carry private tokens. The Worker compares exact UTF-8 bytes through Cloudflare's `crypto.subtle.timingSafeEqual`, including the documented unequal-length rejection path. This does not make the entire HTTP request constant-time. See the [Cloudflare comparison example](https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/).

For a local runtime check, start `npm run worker:dev -- --local`, then run `node Scripts/test-online-token-comparison.mjs`. This runs the actual helper in workerd and checks the real WebSocket route, including refusals that preserve a legitimate socket. Node unit tests use a test double for Cloudflare's nonstandard primitive.

## Controls

| Key / Input  | Action                          |
|--------------|---------------------------------|
| `←` `→`      | Adjust turret angle             |
| `↑` `↓`      | Adjust firing power             |
| `SPACE`      | Fire current weapon             |
| `A` / `E`    | Switch weapon                   |
| Mouse        | Click weapon buttons in HUD     |
| Touch Screen | On-screen retro controls (mobile) |

The game starts on a retro Main Menu (color picking + tank previews) where you configure 2–4 players (Human or any of 4 AI profiles). During a match the HUD + canvas overlays (active indicator, colored shells, recoil) provide feedback. Round-winner CELEBRATION fireworks play before SUMMARY. Mobile touch controls appear on tactile devices.

When combat stalls with only AIs alive, a three-second bilingual banner announces Zeus without blocking input. A permanent aura marks the appointed AI; each special turn draws a deterministic branched bolt from the sky, flashes, vaporizes only its target, and then resumes the ordinary circular turn order.

---

## Getting Started

### Prerequisites

- Node.js 24 (the version used by CI)
- npm (the repository includes `package-lock.json`)

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

# Mandatory React health scan for source/configuration changes
npm run doctor

# Run unit and integration tests (Vitest, without watch mode)
npm run test

# Online multiplayer backend (run alongside npm run dev)
npm run worker:dev    # http://localhost:8787

# Deploy worker to Cloudflare
npm run worker:deploy
```

**Online dev:** start both `npm run dev` (frontend, port 5173) and `npm run worker:dev` (API, port 8787). Restart the worker after editing `worker/src/game-room.ts`.

### Validation

To reproduce the CI dependency installation, run `npm ci --ignore-scripts`. Before finishing a change, run these checks in order:

```bash
npm run lint
npm run build
npm run test
npm run doctor -- --verbose --scope changed --blocking warning
git diff --check
```

The build checks both client and Worker TypeScript before bundling the client. Vitest reports the current test and file totals. Always run React Doctor as `npx react-doctor@latest`, directly or through `npm run doctor`, whose script must remain exactly `npx react-doctor@latest`, following the [official CLI documentation](https://www.react.doctor/docs/reference/cli-reference). Do not substitute the bare local `react-doctor` binary or pin the scanner version without an explicit request. The GitHub Action also explicitly uses `version: latest`. This intentionally receives current rules and fixes; npm resolution and the scanner's own services may require network access. React Doctor is mandatory in every validation run, even without React changes; automatic hooks do not replace this step. Always report its status, score and available diagnostics, including warnings. Explicitly report when no relevant files are found to scan. Follow the [React Doctor skill](./.agents/skills/react-doctor/SKILL.md): the [React Doctor workflow](./.github/workflows/react-doctor.yml) treats warnings as blocking in development and CI. Publication workflows and Cloudflare/staging deployment scripts use `--blocking error` instead: warnings remain visible without blocking publication. Errors and tool execution failures remain blocking. Changes to the interface or engine also require checking the affected menu, combat, round summary, shop and next-round flow; network changes need the relevant reconnect/resume checks. See [AGENTS.md](./AGENTS.md#verification-checklist).

### Deployment

Production uses a controlled Worker-first publication. First, [disable automatic production deployments in Cloudflare Pages](https://developers.cloudflare.com/pages/configuration/git-integration/#disable-automatic-deployments); otherwise a Git push can publish the client before its compatible Worker.

On a machine with the private deployment script configured, run `.\deploy-cloudflare.ps1` from PowerShell. The script:

1. runs `npm run lint` → `npm run build` → `npm run test` → `npm run doctor -- --verbose --scope changed --blocking error` → `git diff --check`, displaying React Doctor diagnostics while allowing warnings;
2. deploys the Worker with the repository's local Wrangler;
3. polls the uncached `/api/health` without following redirects for at most 60 seconds, requires `ok: true` and service `tankwars-api`, and checks both numeric versions against the literal constants in `src/game/online/protocol.ts` (currently `4`/`4`);
4. rebuilds with `VITE_API_BASE=<Worker URL>` and `VITE_HOTSEAT_ONLY=false`;
5. deploys `dist` to the `tankwars` Pages project on `main`.

The script requires a unique production URL in Wrangler's deployment output. Optionally set `WORKER_API_URL` to require that it matches the deployed origin. Only HTTPS origins of the form `tankwars-api.<account>.workers.dev` on port 443 are accepted, without credentials, paths other than `/`, query parameters or fragments. Invalid configured URLs are rejected before deployment. The script runs from its own directory, uses explicit local Wrangler/configuration/artifact paths, and restores its working directory and Vite environment variables on every exit. A failed validation, Worker deploy or health gate prevents any Pages publication.

With the private script present, run `pwsh -NoProfile -File Scripts/test-deploy-cloudflare.ps1` to test deployment guards locally. This harness replaces native commands and the HTTP transport, shortens the probe budget, and never publishes or connects to a remote service.

For the private staging machine, run `.\deploy-staging.ps1`. It runs lint, build and tests, then rebuilds only `dist` with `VITE_HOTSEAT_ONLY=true` and no `VITE_API_BASE`. It validates the exact remote staging directory before cleaning it, uploads through SSH/SCP, and never deploys a Worker. This artifact supports local humans and AI but exposes no online lobby, invitation, or saved online session. Both scripts remain gitignored because their deployment parameters are machine-specific. See `.env.production.example` for manual build variables.

The repository also contains a separate [GitHub Pages workflow](./.github/workflows/deploy.yml), triggered by pushes to `main`. It runs lint, build, tests and React Doctor (`--verbose --scope full --blocking error`) on the checkout being published before uploading or deploying the client. The full scan is explicit because a clean main or detached tag checkout may have no usable branch diff; warnings remain visible, while errors and execution failures block publication. It does not deploy the Worker or perform the Cloudflare Worker-first health gate. Disabling automatic Cloudflare Pages deployments does not disable this GitHub Actions workflow.

The [Release workflow](./.github/workflows/release-and-deploy.yml) runs the same checks before publishing build artifacts for `v*` tags or published releases. A failed check blocks artifact publication; for an already published release, it cannot undo the release event. Both workflows run their own checks rather than assuming the independent CI and React Doctor workflows have finished.

The [njsscan workflow](./.github/workflows/njsscan.yml) keeps security findings advisory, but fails when the scanner cannot run, its report is missing or malformed, its execution is incomplete, or its exit code disagrees with the report. An available SARIF report is still uploaded after a failed scan check. The runner validates the expected njsscan 1.0.1 report structure and execution evidence; GitHub's upload action performs the SARIF schema validation. Run its isolated regression tests with `python -B -m unittest discover -s Scripts -p "test_njsscan_runner.py" -v`.

---

## Architecture Highlights

This project follows a strict separation of concerns:

- **React Layer** (`src/components/`, `src/App.tsx`, `src/appReducer.ts`): Owns high-level game state (`GamePhase` starting at `'MENU'`, players, money, shop) via `useReducer`. `useGameSession` initializes the Canvas inside an effect; React rendering never reads or mutates the Canvas context directly. The Canvas is not mounted while on the menu screen.
- **In-match phases** (`GameCanvas.tsx`): `COMBAT` → `RESOLUTION` → `CELEBRATION` → `SUMMARY` → `SHOP` → … → `GAME_OVER` (types in `src/types/game.ts`).
- **Online layer** (`OnlineLobby.tsx` + `useOnlineLobby.ts` + create/waiting views, `useGameSession.ts`, `src/game/online/turnOrder.ts`, `src/game/online/protocol.ts`, `worker/`): REST room creation + persistent WS to `GameRoom`; the server validates and consumes FIRE/shop intentions and persists idempotent results. Shop success is correlated explicitly by `{ slot, actionId }`, while retries reuse the original ID. If next-round preparation fails, purchases, readiness and the closing READY identity remain persisted; an accepted READY retry or `REQUEST_GAME_START` retries preparation with that identity. After success, accepted shop actions replay the same terminal map with their own ack, without repeating purchases or preparation; refusals remain unchanged until the next shop opens. An older persisted shop without a closing identity requires a valid READY to establish it. Protocol v4 requires a complete map on `GAME_START` and `SHOP_FINISH`; map preparation is shared with local play and authoritative online. No legacy client adapter is provided. Persisted rooms without a conforming map require a new game. Each client still runs local Canvas physics.
- **Room creation & join rate limiting** (`worker/src/rate-limiter.ts`): A separate SQLite-backed `RATE_LIMITER` namespace enforces 5 accepted requests per IP over a sliding 60-second window before allocating or waking a `GameRoom` on `POST /api/rooms` and `POST /api/rooms/:roomId/join`. `/api/rooms/:roomId/join` and `/api/rooms/:roomId/ws` also require exact path segment counts before resolving a Durable Object, and `GameRoom` restricts room initialization to internal `POST` requests on `/internal/create` or `/create`. Adjust `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_IDLE_MS` in that file. Rejections return HTTP 429 with the remaining wait in `Retry-After`. Requests without Cloudflare's `cf-connecting-ip` header (e.g. local development) share the `unknown` bucket. Limiter exceptions or unexpected responses are logged server-side and fail open for room creation; origin checks and normal room creation errors still apply. An alarm purges limiter state after 24 hours without attempts, including rejected attempts. The `v2` Wrangler migration adds the namespace without changing existing game rooms; previous limiter counters in `GAME_ROOM` are not migrated.
- **Economy** (`src/game/economy/`): Exact rational reward calculation from structured damage/destruction events. `GameEngine` owns shot ledgers and round earnings; React owns the floating reward feedback and summaries.
- **Zeus domain** (`src/game/zeus/`): Pure deadlock evaluation, fair appointment history, revenge/fallback targeting, monotonic event IDs, and isolated `25X` reward. It uses a lightweight shared profile score, independent of the EXPERT planner and React.
- **Game Engine** (`src/game/engine/`): Owns the 120 Hz fixed-timestep physics loop, terrain mutations, projectile simulation, Zeus action/VFX, rendering, and combat audio. Communicates exclusively via callbacks.
- **Rendering helpers** (`src/game/rendering/`): Pure Canvas 2D procedures (e.g. `drawTankSprite`) kept separate from React.
- **AI** (`src/game/entities/ai/`): Runtime behavior via `AIEngine`. `AIByProfileStrategy` (wired in `GameCanvas`) dispatches on `player.aiProfile`:
  - `v1-random` → `AISimpleStrategy` ("IA SIMPLE")
  - `v2-heuristic` → `AIHeuristicStrategy` ("IA OK")
  - `v3-sniper` → `AISniperStrategy` ("IA SNIPER")
  - `v4-smart` → `AISmartStrategy` ("IA EXPERT")
  All four profiles share `fallibleAim.ts`, target/round memory, corruption helpers, and the shared ballistic solver. Weapon tactics remain specific to OK, SNIPER, and EXPERT. Swap implementations without touching the core engine.
- **EXPERT tactics** (`src/game/entities/ai/expertPlanner.ts`, `expertShotEvaluator.ts`, `expertDecisionAim.ts`): Local survival and profit ranking use isolated full-shot forecasts after one shared normal offset, while adverse threats remain ideal. Search caches use exact requested coordinates/policy; physical caches share only normalized commands within one decision, preserving each proposal's raw command and original-point filters. `AISmartStrategy` advances only the selected target's memory and reuses the evaluated command before reaction/gaffe. `src/game/combatConstants.ts` shares the 24 × 15 px tank hitbox with collision handling and the 75 px THERMO instant-kill radius with explosion damage.
- **Types** (`src/types/`): Single source of truth. Zero `any`. Structural types only.

**Design Rules (enforced):**
- Custom terrain algorithms only (heightmap + `ImageData`-style mutations).
- VGA palette for all visual assets.
- No React state inside the render loop.
- AI strategies must not block the core architecture.

**Developer docs:** [AGENTS.md](./AGENTS.md) (coding agents — layout, commands, checklists) · [CLAUDE.md](./CLAUDE.md) · [.github/copilot-instructions.md](./.github/copilot-instructions.md).

---

## Current Status

**v0.11.2** — Playable local (hotseat + AI) and online multiplayer. Version is imported from `package.json` and shown in the Main Menu footer next to the license (© Martin Labelle).

In the build today:

- Retro `MENU` with 2–4 players, Human + four AI profiles, ColorPicker + TankPreview
- Procedural tanks, slope tilt, active-player indicator, owner-colored shells, micro recoil
- Randomized / shuffled spawns each round (local humans −25 % on SOFT; AI −25 % on ROCK); AABB shell-to-tank hits with owner-exit guard
- Destructible heightmap (parabolic `DIRT` and smoothly rounded `SOFT` craters, `2.5×` sand half-width/depth with slumping, unified `ROCK` column-rectangle occlusion, VGA material impact particles #184, plus local `NUKE` / `THERMONUCLEAR` `ROCK` carving and pre-fall blast #302), DRILLER oriented shaft, GRENADE bounce/stick by material, wind and the configured projectile launch speed
- Four AI profiles use `fallibleAim` plus target/round memory (first shot remains outside direct aim; locks Simple/OK/Sniper/Expert at 7/5/3/2); SIMPLE avoids revenge/material/BULLDOZER tactics and SNIPER has no post-lock slip; shared `BallisticsSimulator`; lazy-loaded v2–v4 chunks (legacy `AIStrategy` interface removed #327)
- Shop + ammo + exact per-shot economy; 3-second non-blocking floating rewards; round-only earnings summary; local hotseat shop stays usable after round 1
- CELEBRATION fireworks (60 Hz, 250-particle cap) + Web Audio
- i18n FR/EN, PWA (network-first SW), mobile D-Pads
- Online lobby + strict combat/shop protocol (`ONLINE_PROTOCOL_VERSION`, mismatch overlay), server-first shots, authoritative transactional shop, reward/balance application, Durable Object authority failover, session resume, reconnect (WebSocket test constructor mocks fixed #327)
- Durable Object-authoritative Zeus nomination/strike, fair cross-round history, deterministic VFX, bilingual announcement, and reconnect restoration
- Terrain dirty-band redraw, HUD ~15 Hz + `React.memo`, projectile pooling
- Unit and integration coverage with Vitest; run `npm run test` for the current totals

Still planned:

- Authoritative server projectile/damage/HP simulation shot-by-shot (initial round terrain is already server-prepared)
- Migration of local AI combat strategies to the authoritative Worker
- More weapons and power-ups
- Persistent high scores / match history
- Further audio and particle polish

---

## AI Endurance (#206)

AI Endurance is available **only in explicitly selected test builds**. The normal `npm run build` excludes its menu entry and lazy-loaded configuration, session, storage and report modules. Enable it for a private test artifact with `npm run build -- --mode endurance`, or use `npm run dev -- --mode endurance` locally. The mode is fixed during compilation; URL parameters and browser storage cannot enable it in a public build. `VITE_HOTSEAT_ONLY=true` can additionally disable online features for the test artifact. Existing private deployment scripts must explicitly select the `endurance` mode when this feature is needed.

In that test build, open **AI Endurance** from the local menu. Choose two to four existing AI profiles, a positive number of rounds per block and at least one session limit: attempted blocks or elapsed minutes. Zero disables an optional session limit. Defaults are four distinct profiles, two rounds per block and four hours, continuing after an incident abort.

Simulation and IndexedDB storage run on the browser's device, without creating online game rooms. Endurance does not send the ordinary `game_start` or `round_end` analytics events to Zaraz; ordinary matches retain their existing analytics. This does not disable analytics scripts that may be configured separately on the hosting service.

The real local game runs with rendering, audio and normal timing. Each block preserves money, ammunition, AI continuity and Zeus history between rounds. Celebrations retain their normal duration; summaries advance after three seconds into the existing AI shop. After the final round presentation there are no further purchases. The next block restores a deep copy of the initial roster and creates fresh engine/strategy instances. Blocks have no overall champion; wins, survival and draws belong to completed rounds.

Operational watchdogs default to 1,000 started turns per round, 30 minutes of combat per round, 120 seconds per combat action and 30 seconds per automatic transition. All are editable before starting and recorded in exports. The page uses a monotonic clock independent of physics; exceeding a limit aborts one block and records context without asserting an infinite-loop defect. Exceptions and invalid states also abort; ordinary safety recoveries are warnings. Optional stop-on-first-abort and manual stop are available. Session limits count attempted blocks, including failures.

Keep the tab active and the device awake. Hiding the tab stops and saves the session as an environmental interruption. A page timer cannot interrupt a synchronous infinite loop or recover a browser crash. Seeds and full initial configuration are recorded before preparation; visual/audio scheduling can affect random consumption, so identical replay and combat resume are not promised. This mode does not exercise the online Worker AI and changes no balancing or protocol rules.

**Statistics:** decisions and their call duration, executed commands, launched/resolved shots, real HP and shield losses, self-damage, attributed destructions/suicides, unattributed deaths, BULLDOZER displacement/recoil, Zeus and safety recoveries. CLUSTER sub-munitions are not new shots. Offensive-effect rate counts at most one effect per resolved shot; zero denominators are not applicable. Results aggregate by player/profile/weapon where applicable and keep completed rounds separate from partial observations. An aborted block is not a defeat. Suspect blocks overlap terminal categories and must not be added to them. Command evaluation/perturbation diagnostics that are not exposed are marked unavailable rather than inferred from final aim. Observers never reveal opponent nuclear stocks to strategies.

**Storage and exports:** IndexedDB stores session metadata, compact block/round results, aggregates and incidents incrementally. Checkpoints occur every 15 seconds, at round/block boundaries and on incidents. Incidents include the last 256 structured events plus available roster, terrain, command and error context. Result history is read in batches of 128 records. Storage failures stop the session visibly; export preserves the available in-memory tail and marks collection incomplete. The configuration screen offers the latest saved session after a crash; it remains incomplete and never resumes combat. Saved sessions remain in the browser profile; exports require that same origin/profile. JSON schema v1 contains detailed results; Markdown provides a readable summary. Game version and build identity (Git SHA, dirty flag, build timestamp) are recorded.

**Detailed JSONL journal (test builds):** The separate JSONL button exports a status header followed by version 1 events with session-wide sequences, wall/monotonic timestamps and block, round, turn and decision context. It records available evaluated commands, explicit targets/points, aim offsets, hit reactions, gaffes and final decisions; confirmed launches retain actual commands, tank positions and barrel origins. Unavailable values are `null`: no target or uncomputed nominal shot is inferred. Physical CLUSTER/GRENADE draws are recorded where consumed; visual randomness and presentation delays are excluded. Credits are observed after application with before/after balances and exact rational reward components explaining the single rounded payment. Zero-gain resolutions, Zeus credits, accepted unit purchases, empty shop visits and boundary rosters remain distinguishable. The endurance observer follows the full local shop orchestration, including all AI shoppers and visits with no affordable purchase; the final round of a block has no shop. Initial balances and block resets are initialization events, not income. Full inventory snapshots are observational only and never enter opponent nuclear threat information.

Database version 2 adds journal stores while retaining existing sessions and result schema v1. Journal writes share the serialized checkpoint lane, flush every second and at boundaries, and use at most 256 entries per batch with a maximum 2,048-entry queue including in-flight writes. Saturation or write failure stops the session, exposes the error and marks the journal incomplete; the JSONL status reports emitted and confirmed sequences. Failed queued entries remain available for manual export while the page is open. After a crash, only confirmed IndexedDB writes are recoverable. Old sessions without a journal retain their result exports. Normal execution retains bounded queues/recent events; manual downloads may assemble the requested file in memory.

The endurance-only `window.__tankwarsEnduranceTest.readJournalPage(after, limit)` bridge returns confirmed pages of at most 256 entries for a local Playwright driver. It opens no HTTP service and sends nothing externally. The private driver can append pages to disk and check sequence continuity and final completeness without holding the history in memory. Protect raw journals as test data; they contain complete inventories and player names. The next long-run protocol is 20 rounds per block for six hours, subject to separate launch authorization; preparing the driver does not run it.

Implementation: `src/game/endurance/` is independent of React; `src/components/endurance/` owns configuration and presentation. Existing local session/shop paths orchestrate play, with optional additive observers in the engine and AI router. Reports should identify the exact configuration, build, browser/environment and measured duration; automated tests are not evidence of a successful four-hour rendered run.

---

## Tech Stack

- **Runtime**: React 19 + TypeScript (strict)
- **Build**: Vite 8 + Rolldown
- **Rendering**: HTML5 Canvas 2D (no WebGL, no external libs)
- **Physics**: Hand-rolled fixed-timestep integrator (no Matter.js, Rapier, etc.)
- **Online backend**: Cloudflare Workers + Durable Objects (`worker/`, deployed separately from Pages)
- **Hosting**: Cloudflare Pages (`tankwars.pages.dev`) + optional Worker API
- **Styling**: Minimal CSS + a few inline styles (monospace retro aesthetic)

---

## License

MIT © 2026 Martin Labelle

See [LICENSE](./LICENSE) for details.

---

## Development Notes

This project stays architecture-first. Contributions that respect the React/Canvas split and TypeScript discipline are welcome.

To explore the codebase:

- Start with `src/main.tsx` (entry; production console suppression) and `src/App.tsx` + `src/appReducer.ts` (top-level phase)
- Local menu and player naming: `src/components/MainMenu.tsx`, `MainMenuView.tsx`, `PlayerConfigList.tsx`, `PlayerConfigRow.tsx`, `playerControllerUi.ts`, `playerNameUi.ts`, and `usePlayerNameValidation.ts`
- Main game view + engine integration: `src/components/GameCanvas.tsx` + `useGameSession.ts`
- Core simulation: `src/game/engine/GameEngine.ts` (indicator, recoil trigger, celebration, audio)
- Terrain: `src/game/engine/Terrain.ts` (craters + `destroyTerrainShaft`) + `src/types/terrain.ts` (materials, spawn, grenade bounce)
- AI: `src/game/entities/ai/AIEngine.ts` + `AIByProfileStrategy.ts` + `fallibleAim.ts` + `aimMemory.ts` + `aimCorruption.ts` + `heuristicShot.ts` + `hitReaction.ts` + `terrainMaterialTactics.ts` (v1 `AISimpleStrategy`, v2 `AIHeuristicStrategy`, v3 `AISniperStrategy`, v4 `AISmartStrategy`)
- Tanks: `src/game/entities/TankManager.ts` + `src/game/rendering/tankSprite.ts`
- Projectiles: `src/game/engine/PhysicsEngine.ts`
- Online lobby + WS client: `src/components/OnlineLobby.tsx`, `useOnlineLobby.ts`, `OnlineLobbyCreate.tsx`, `OnlineLobbyWaiting.tsx`, `useGameSession.ts`
- Shared turn order: `src/game/online/turnOrder.ts`
- Economy: `src/game/economy/fixedPoint.ts` + `shotRewards.ts`
- Zeus special-action domain: `src/game/zeus/zeusDomain.ts` + `zeusRewards.ts`
- Shared online protocol: `src/game/online/protocol.ts`
- Online backend: `worker/src/index.ts`, `worker/src/game-room.ts`
- Agent guide: [AGENTS.md](./AGENTS.md)


### Chargement et couverture IA (#212)

Le solveur partagé synchrone `heuristicShot` et `BallisticsSimulator` restent chargés à la demande : SIMPLE importe le solveur au premier tir normal, après le court-circuit de grosse gaffe; OK, SNIPER et EXPERT demeurent des stratégies chargées à la demande. Tous les achats IA passent exclusivement par `autoBuyForAI` (#207), sans méthode boutique dans les stratégies de combat.

Les tests vérifient les gaffes sur deux tentatives consécutives (un seul jet, aucun appel au solveur ni aux décisions de remplacement pour SIMPLE), ainsi que le vrai solveur sur terrain plat à gauche/droite, ses bornes et la conservation des fractions avant l’arrondi final.

Le solveur commun privilégie les trajectoires complètes avant leur erreur de visée, dans la recherche de puissance et les deux balayages d'angles. Seule une solution complète peut déclencher l'arrêt anticipé. Si aucune trajectoire ne se résout dans la limite existante, la meilleure approximation demeure disponible avec `complete: false`; la commande de secours porte aussi ce statut. Ce classement conserve les paramètres des profils et les contrats de visée faillible de #212, sans tirage RNG supplémentaire.

### Décision EXPERT locale (#229, #267, #271, #287, #288)

Exception permanente au stock adverse connu : NUKE et THERMONUCLEAR sont exclues des menaces d’EXPERT local, pour les humains et tous les profils IA, même après sélection ou tir. SIMPLE et les profils absents/inconnus équipés d’une arme nucléaire ne produisent aucune menace de remplacement. Les autres armes restent évaluées selon leur profil et leur stock, avec le chemin distinct de BULLDOZER. EXPERT conserve l’évaluation et l’utilisation de ses propres armes nucléaires en SURVIE et OPTIMISER_PROFIT. Les inventaires réels, les achats et la consommation ne changent pas; les traces DEBUG gardent le roster et son stock nucléaire complet sous `import.meta.env.DEV`, sans révélation tactique ni mémoire ajoutée.

EXPERT prévoit les conséquences d'un tir complet sur une copie des tanks, du terrain et de ses matériaux. Pour ses tirs propres, il cherche vers `(point.x + offset, point.y)`, sans borner X ni recalculer Y; le sens de tir vient du X décalé, avec le sens gauche à égalité avec le tireur. Les arcs `full/low/high` conservent leur sens d'élévation dans cette direction. La commande du solveur #212 est bornée et arrondie, puis les projectiles, chutes et ensevelissements sont simulés à pas fixe. Seuls les tirs complets qui affectent réellement un adversaire et satisfont le point tactique sont retenus. Pour un point terrain ou une paire, au moins un impact doit être à distance euclidienne inclusive `max(24, blastRadius)` du point original, sans déplacer ni agrandir ce filtre pour compenser l'offset. Pour un point tank, la touche directe, les dégâts physiques appliqués ou la destruction attribuée de ce tank restent nécessaires. Le gain entier attribué au tireur par `calculateShotRewards`, moins une munition (MISSILE : 0), donne le profit net. Les quotas de propositions, bornes de recherche et budgets physiques demeurent déterministes; une prévision incomplète est rejetée.

Avant son tir, EXPERT cherche si un adversaire pourrait le détruire avec une arme permise par son profil et son stock; ces menaces restent évaluées sans imprécision. Il retient la menace vivante qui jouera la première; le score de profil décide d'un unique jet de SURVIE, sauf pour EXPERT à 1,00 qui entre sans jet. Après ce jet éventuel, il réserve exactement deux appels à `secureRandom`, amplitude puis côté, partagés entre toutes les cibles, armes, points, arcs et phases. Chaque cible reçoit sa prochaine tentative virtuelle et sa courbe de manche #212; les deux valeurs sont consommées même au plateau ou avec un résidu nul. SURVIE cherche le meilleur tir complet après offset qui détruit cette menace et préserve EXPERT, même à profit négatif; son choix du point ou de l'arc garde la survie avant le profit. Sans candidat SURVIE, ou avec un jet refusé, EXPERT optimise sur tous les adversaires seuls et toutes leurs paires de deux. OPTIMISER_PROFIT classe le profit net immédiat avant la survie, dès le choix du point ou de l'arc, puis entre armes et groupes : un tir suicidaire à +100 $ gagne contre un tir survivant à +80 $; à profit égal, le survivant gagne. Les munitions payantes au meilleur profit strictement négatif sont écartées; un tir utile à profit nul reste admissible dans le plan principal. Aucune valeur de survie, pénalité de mort, prime de destruction ou rentabilité future n'est ajoutée au gain entier moins le prix d'une munition. Aucun triplet, filtre universel de 80 px ni préparation de lourde ne sélectionne le tir.

La menace entrante BULLDOZER (#230) est réservée aux parties locales : humain, OK et EXPERT avec stock positif; SIMPLE et profil absent/inconnu seulement avec BULLDOZER courant et stock; jamais SNIPER. Une preuve conservatrice de corridor plat et sûr dans les deux directions peut écarter la recherche. Sinon, une grille directe idéale (15–85° à droite, 95–165° à gauche, pas 5°, puissances 20–95 par pas 15) applique les bornes 6–174°/25–95 puis la normalisation réelle. Les trajectoires à ≤ 8 px de la boîte sont raffinées à ±4,5°/±15 de puissance, par pas 1,5°/5. Chaque adversaire reçoit au plus **512 trajectoires distinctes**, de **420 pas à 1/120 s**, par décision. Le premier événement réel (sortie d'écran, tank selon le roster, terrain) doit toucher EXPERT. La poussée et le recul sont résolus sur des copies, avec attribution, gravité et ensevelissement jusqu'à **2400 pas**; seules les morts complètement démontrées comptent. Le meilleur tir létal privilégie la survie adverse puis le gain entier moins une munition, sans prime de premier tir. Il rejoint les autres armes avant le classement et le jet uniques de #229, sans RNG supplémentaire. Le cache inclut les absences de menace et expire à la décision suivante. Cette recherche bornée accepte des faux négatifs : elle ne garantit ni de trouver toutes les commandes létales ni de prédire le prochain tir adverse réel.

À sécurité et profit net égaux, le départage #267 compare les conséquences physiques de toute la prévision : moins d'humains détruits, moins de dégâts aux humains, davantage d'IA détruites, puis davantage de dégâts aux IA. Il s'applique dès le choix du point tactique, puis dans SURVIE et OPTIMISER_PROFIT, avant les départages historiques propres à chaque scénario. Les victimes collatérales hors du groupe comptent; le tireur reste traité par la sécurité. Chaque destruction attribuée compte une fois, même par lave, ensevelissement ou sortie de carte, sans perte fictive de santé ou de bouclier. Les pertes réelles de bouclier (`shieldLostMilli`) et de santé sont normalisées séparément au millième par événement, puis additionnées, chutes comprises. Les dégâts absorbés (`shieldAbsorbedMilli`) restent réservés au contrat économique existant : un impact direct retirant 10 points de bouclier peut n'en déclarer que 5 absorbés. Les récompenses, le profit net et la priorité de la prochaine menace létale restent inchangés; un tir plus profitable contre un humain peut toujours gagner.

Chaque point tactique provient du centre de la boîte d'un tank, du terrain voisin, du centroïde des centres d'une paire, du forage DRILLER côté tireur ou des frontières matérielles locales de #226. La cible principale d'une paire est déterminée avant l'offset : son membre au plus faible total santé+bouclier, départagé par le roster. Elle détermine la tentative et l'offset du groupe, indépendamment de la menace dont la destruction est obligatoire. L'exploration ne mute pas la mémoire; seul le tir choisi enregistre une tentative, avec les resets A → B → A et de manche. La commande brute, la commande normalisée simulée, le point original, le point demandé et la cible principale sont conservés aussi en production. Sans réaction ni gaffe, la commande tirée est exactement celle simulée, sans second offset ni recherche après classement. Avec perturbation, EXPERT part de la commande brute de la proposition retenue, applique réaction puis gaffe et normalise une seule fois.

Sans plan principal admissible, EXPERT conserve sa cible ordinaire vivante, sinon privilégie une IA, puis la santé et le roster. Son repli compare l'arme ordinaire après ajustements ROCK/SOFT et MISSILE, avec le même offset réservé et sans filtre géométrique du plan principal. Avec `localShotContext`, les prévisions complètes sont classées par profit, survie, conséquences #267, puis ordre stable des armes, points et arcs. Toute munition payante déficitaire est écartée, y compris GRENADE, CLUSTER, DRILLER et BULLDOZER. Une prévision suicidaire à profit nul ou positif reste admissible; le profit prime sur l'utilité. Le MISSILE gratuit peut être retenu sans effet adverse pour conserver les munitions déficitaires. À profit égal, aucune préférence de conservation ne s'ajoute : une arme payante utile à 0 $ peut battre un MISSILE sans effet à 0 $. Sans contexte économique, EXPERT va directement au repli physique, sans détection de menace ni jet de SURVIE : tirs utiles non mortels puis non mortels inutiles, `profit: null` et conséquences physiques. BULLDOZER peut être validé seulement en repli, avec trois arcs. Seulement si aucune prévision complète admissible n'existe, EXPERT effectue l'unique recherche du dernier MISSILE ordinaire vers `(target.x + offset, target.y − 6)`, arc `full` et pénalité de proximité. Sa commande bornée reste utilisable si la recherche est incomplète, sans certifier sécurité, utilité, destruction ou profit et sans nouvelle exploration; elle ne remplace jamais une prévision complète admissible, même suicidaire.

Le RNG physique privé des prévisions vaut `0.5` : il isole la partie et rend les calculs reproductibles, mais ne prédit pas les tirages réels de GRENADE/CLUSTER. Les réactions, gaffes et aléas physiques réels peuvent donc faire diverger les conséquences malgré l'identité de la commande propre. OK conserve ses propositions idéales et sa recherche finale actuelle. #271 modifie uniquement l'ordre offset/prévision d'EXPERT local. L'IA du Worker et les parties multijoueurs restent inchangées.

### Décision SNIPER locale (#289)

SNIPER local choisit BULLET, DRILLER ou MISSILE après un seul offset signé, partagé par tous les candidats et le repli. Le premier essai n'est plus un MISSILE imposé et le jet de 50 % vers BULLET disparaît. Les courbes, le sens, la surcorrection du deuxième essai, le plateau, la mémoire et le veto ROCK restent inchangés. X n'est pas borné après l'offset; Y et l'arc du point sont conservés.

BULLET est admissible seulement s'il touche directement la cible mémorisée et produit un effet physique réel sur elle, le tireur survivant. DRILLER est admissible seulement avec un impact au terrain, une perte de support (`support.after > support.before`) et soit des dégâts de chute attribués sur les PV, soit une destruction `buried` ou `lava` attribuée. Un impact direct sur un tank, le souffle seul, une excavation sans conséquence, une destruction `health-zero` ou hors carte, et un tireur détruit sont refusés. Le classement retient d'abord la destruction de cette cible, puis ses pertes réelles de PV et de bouclier, puis BULLET à égalité. Aucun prix, gain ou solde n'entre dans le choix.

MISSILE n'est examiné que si aucun BULLET ni DRILLER n'est admissible. Le repli prend le premier tir complet utile et survivant, sinon le premier tir complet survivant, sinon la commande brute déjà recherchée du point tank en arc `full`, même incomplète. Ce dernier secours n'est pas certifié. La décision fait au plus 2 recherches BULLET, 4 DRILLER et 4 MISSILE, donc au plus 10 prévisions, sans recherche finale supplémentaire. Sans réaction ni gaffe, le tir est exactement la commande normalisée prévue. La réaction, si son intensité est positive, puis la gaffe partent de la commande brute et ne sont normalisées qu'une fois. Une faible fréquence de BULLET ne bloque pas ce comportement.

Pour diagnostiquer un tir local dans `npm run dev`, ouvrir la console du navigateur. `[AI SNIPER] Décision` est une seule chaîne JSON, émise après la réaction et la gaffe. `choice` vient en tête : arme, motif, certification, point original, point visé, commande brute, commande prévue, intensité de réaction, gaffe et `finalCommand`. Suivent `selectionReason`, l'éventuel `runnerUp`, la règle de cible, la manche, le tour, le vent, la gravité, la tentative, le sens et la valeur de l'offset, le matériau et les stocks BULLET et DRILLER. `admissible` et `refusals` portent les coordonnées, la commande normalisée lorsqu'une recherche a eu lieu, et une preuve courte (`directTargetId`, support, perte, cause). Un MISSILE survivant ensuite écarté porte le refus `survivant écarté`. `searches`, `forecasts` et `cacheHits` séparent les recherches incomplètes des prévisions réutilisées. Sans tireur vivant ou sans adversaire, la même ligne porte `finalReason` et le MISSILE 45°/50, sans recherche. `[AI EXPERT] Décision` indique SURVIE, OPTIMISER_PROFIT ou REPLI, la menace et son éventuel jet, le candidat retenu, le suivant, les meilleurs tirs par arme et leurs quatre métriques. Le résumé compact `rejectedUnprofitableShots` (arme, cibles, profit et destruction d'EXPERT) et l'éventuel `conservationReason` du MISSILE gratuit précèdent le roster et les gros tableaux, pour résister aux lignes tronquées. `selectionReason` suit le classement réel, y compris le profit supérieur d'un tir suicidaire; le repli garde toujours son motif de classement, même quand le MISSILE gagne. Le motif de conservation reste distinct et exige des pertes rejetées, aucune munition payante admissible dans les candidats du repli, et un MISSILE sans effet à profit nul ou un dernier MISSILE non certifié. Chaque entrée de `threats` inclut `weaponId`, l'arme du meilleur tir létal retenu pour cet adversaire, BULLDOZER compris; la survie du tireur adverse précède toujours le profit, puis l'ordre stable des armes. La trace distingue tentative, offset, points original/demandé, commande brute, commande normalisée prévue et commande finale après réaction/gaffe; `choiceKind` distingue un choix évalué du dernier MISSILE ordinaire non certifié. Les compteurs de recherches/prévisions montrent le partage des caches. `[AI] Résultat réel du tir` relie ensuite le même tireur et l'arme aux dégâts, destructions et gains effectivement attribués. Les détails prévus et réels distinguent `shieldLost` et `shieldAbsorbed` en points; l'ancien champ `shield` conserve la valeur absorbée. Ces traces et leur calcul sont réservés au développement; le choix économique en production dépend de `localShotContext`.

### Zeus et reprise réseau v4 (#269, #184)

Le compteur inclut chaque tir humain ou IA une seule fois, après projectiles, chutes et gains. Un gain le remet à zéro; une élimination sans gain conserve le compteur et réduit le seuil. Les forfaits, pauses, reconnexions et éclairs ne comptent pas. Moins de deux survivants, une frontière de manche ou un Zeus actif remettent le compteur à zéro. La mort de Zeus révoque le mandat sans compter le tir qui le tue ni désigner immédiatement un remplaçant. L’historique équitable survit aux manches et disparaît au nouveau match. Le profil absent/inconnu garde le score OK de 0,5; les humains ne sont jamais départagés par leur profil.

Le Worker valide les fiches `Player` complètes de `SHOT_EARNINGS` avant mutation. La copie réseau normalise uniquement les PV des morts à zéro après le calcul des gains. Argent reçu ignoré, identité/inventaire/arme/plafonds comparés au Worker, toute hausse de PV ou de bouclier par rapport à leur valeur courante chez le Worker refuse le rapport complet avec `CAP_MISMATCH`, même sous les plafonds, sans tolérance ni correction silencieuse. Chaque valeur est comparée séparément; les égalités et diminutions sont permises. Aucun crédit, changement physique, compteur Zeus ou passage de tour après refus. Seuls les champs physiques autorisés sont copiés; la fin de manche découle des survivants validés. `EARNINGS_REJECTED` conserve séparément chaque identifiant valide, sinon `null`, et va uniquement à l’envoyeur. Un résultat déjà acquis est rediffusé à l’identique uniquement si le slot de l’envoyeur est l’autorité actuelle, sans exiger l’epoch courant ni lire le reste du retry divergent. Un autre joueur ou une ancienne autorité reçoit seulement `STALE_AUTHORITY`, sans diffusion aux autres clients ni mutation. Les résultats et cumuls de gains restent disponibles pendant la manche et sa boutique, puis sont retirés/remis à zéro au début de la suivante. Les révisions économiques empêchent un ancien résultat de restaurer un ancien solde.

Chaque rattrapage repart de la carte et du roster initiaux autoritaires, invalide l’ancienne simulation et rejoue la file unique des tirs, nominations et paires frappe/résultat. Le journal est ordonné par une séquence de manche; `afterShotId` conserve la frontière de chaque événement Zeus. Le résultat peut terminer l’action courante; les changements de scène/tour restent différés, dans l’ordre `ROUND_END` → `SHOP_STATE` → `SHOP_FINISH`. Les fragments `COMBAT_CATCH_UP_BEGIN` / `FRAGMENT` / `END` partagent un `catchUpId`, une manche et une frontière immuables. Base et journal sont découpés sous 64 Kio JSON UTF-8, enveloppe comprise. Un lot incomplet garde le verrou; une contradiction affiche une erreur et permet de redemander le lot complet. Les entrées du journal, des résultats et des actions sont stockées séparément, avec l’état dans une transaction Durable Objects, avant diffusion.

La graine `physicsSeed`, introduite en v3 et conservée en v4, dérive de `(roomId, roundNumber, shotId)` sans tirage Zeus/global. CLUSTER et GRENADE utilisent ce flux dédié en direct comme en reconstruction; le local/hotseat et les RNG injectés des prévisions IA conservent leurs contrats. Les rejeux utilisent l’arme de la commande sans seconde consommation ni remplacement de l’arme courante économique. Les étapes persistées du règlement distinguent gains acquis, preuve physique, évaluation Zeus et finalisation du tour; une interruption reprend les seules étapes manquantes.

Le passage de v3 à v4 est nécessaire pour les nouvelles règles de creusement et d’occlusion ROCK (#184) : les clients simulent et rejouent les tirs localement; mélanger les deux physiques ferait diverger le terrain et les dégâts, même si le format des messages reste identique. Les clients < v4 ou sans version sont rejetés (`PROTOCOL_MISMATCH`, fermeture 4402) et doivent recharger. Une salle déjà commencée sans schéma de combat v4 exige `NEW_GAME_REQUIRED`; les PV initiaux ne servent jamais à migrer une ancienne partie. La portée réseau demeure celle des salles avec au moins un client humain connecté, y compris un humain éliminé devenu spectateur autoritaire. Les salles uniquement IA et la simulation serveur autonome restent hors portée. Ordre de déploiement : publier le Worker avant le client, vérifier `/api/health` (`protocolVersion: 4`, `minimumClientProtocolVersion: 4`), puis construire et publier le client.
