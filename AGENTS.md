# AGENTS.md — TankWars

Lecture obligatoire avant toute modification. Companion docs: [CLAUDE.md](./CLAUDE.md), [GROK.md](./GROK.md), [CURSOR.md](./CURSOR.md), [.cursorrules](./.cursorrules).

Ce fichier est la source opérationnelle (commandes, architecture, pièges, fichiers clés). Les compagnons reprennent les règles — pas le journal de commits.

## Règle d'or

Répondre en français (FR, de préférence québécois). Même si l'utilisateur écrit en anglais. **Jamais de `any`.** Douter → demander.

## Commandes

| Tâche | Commande |
|-------|----------|
| Install | `npm install` |
| Dev frontend | `npm run dev` → http://localhost:5173 |
| Production build | `npm run build` (tsc -b + vite) |
| Lint | `npm run lint` |
| Tests | `npm run test` (vitest, 397 tests, 50 fichiers) |
| Worker dev | `npm run worker:dev` → http://localhost:8787 |
| Worker deploy | `npm run worker:deploy` |
| Doctor React | `npm run doctor` (entries dead-code : `knip.json`) |

## Verification checklist

**Ordre obligatoire:** `npm run lint` → `npm run build` → `npm run test`. Tous les tests doivent passer. Corriger les échecs immédiatement.

## Architecture

### React vs Canvas (incompressible)

| Couche | Possède | Ne fait PAS |
|--------|---------|-------------|
| **React** (`App`, `GameCanvas`, composants) | `GamePhase`, joueurs, argent, shop, HUD, overlays | Toucher au canvas context ou à `getContext` dans un render |
| **GameEngine** (boucle rAF 120 Hz) | Physique, projectiles, vent, terrain, dessin, audio de combat | Tenir du state React ou appeler `setState` |

- `<canvas>` monté uniquement hors de `MENU` (App.tsx démonte le canvas en menu).
- Input et config injectés dans l'engine via **refs** et méthodes enregistrées dans `useEffect`.
- Physique à **pas fixe** découplé du rafraîchissement écran.

### Phases (`src/types/game.ts`)

`MENU` → `COMBAT` → `RESOLUTION` → `CELEBRATION` → `SUMMARY` → `SHOP` → ... → `GAME_OVER`

- `App.tsx` + `appReducer.ts` : `MENU` vs le reste (session React via `useReducer`).
- `GameCanvas.tsx` : phases intra-match (COMBAT → GAME_OVER).

### Rendu & terrain

- **Palette:** `VGA_PALETTE` dans `src/types/game.ts` (16 couleurs VGA + néon). Seule palette autorisée.
- **Terrain & Relief:** heightmap custom dans `Terrain.ts` (génération procédurale riche multi-octaves avec bosses et creux tactiques, sans tunnels). Matériaux de terrain (`src/types/terrain.ts`) : `DIRT` (standard, herbe verte + terre brune), `ROCK` (roche indestructible en gris, mur pour le souffle latéral via `isBlastOccludedByRock` ; explosion par-dessus : +50% de dégâts via `ROCK_EXPLOSION_DAMAGE_MULTIPLIER = 1.5`, portée inchangée), `SOFT` (terrain meuble sable/jaune, `SOFT_TERRAIN_DESTRUCTION_MULTIPLIER = 2.5` fois plus destructible). DRILLER : puits orienté (`destroyTerrainShaft`, profondeur `DRILLER_SHAFT_DEPTH` dans `types/weapon.ts`) — le splash reste inchangé. Aucun moteur physique externe.
- **Tank sprite:** `drawTankSprite()` dans `src/game/rendering/tankSprite.ts`. Procédural pur Canvas2D.
- **Style:** rétro monospace, `App.css`/`index.css`. Aucune librairie UI (ni Tailwind, ni MUI, etc.).

### Online multiplayer

Le multi est dans `main` (plus une branche `AddMultiplayer`). MVP = physique locale + ordre des tours côté serveur. Simu serveur authoritative encore prévue.

- `worker/` : Cloudflare Worker + Durable Object `GameRoom` (lobby, tour relay, shop sync persistant et transactionnel via Durable Object storage).
- Client lobby : `OnlineLobby.tsx` (shell) + `useOnlineLobby.ts` + `OnlineLobbyCreate.tsx` / `OnlineLobbyWaiting.tsx` / `onlineLobbyTypes.ts`.
- Client combat : `useGameSession.ts`, `onlineSession.ts` (reconnexion WS combat et résilience aux coupures).
- Ordre des tours vivant : `src/game/online/turnOrder.ts` (partagé client + worker, sans DOM ni APIs Workers).
- Dev : lancer **les deux** `npm run dev` + `npm run worker:dev`. Redémarrer le worker après chaque changement de `game-room.ts`.
- `worker/.wrangler/` est gitignoré (état local SQLite).
- Worker a son propre `worker/tsconfig.json`, référencé dans le `tsconfig.json` racine pour la validation statique stricte des types.

### Système d'IA

Toute IA doit implémenter `AIEngine` (`src/game/entities/ai/AIEngine.ts`) :

```ts
executeTurn(tankId, gameState, terrainManager): Promise<FireCommand>
```

Profils (mixables dans une même partie) :
| Profile | Classe | Label |
|---------|--------|-------|
| `v1-random` | `AISimpleStrategy` | IA SIMPLE |
| `v2-heuristic` | `AIHeuristicStrategy` | IA OK |
| `v3-sniper` | `AISniperStrategy` | IA SNIPER |
| `v4-smart` | `AISmartStrategy` | IA EXPERT |

Le routeur `AIByProfileStrategy` est instancié dans `GameCanvas.tsx`. Les v2–v4 sont lazy-loadés (`dynamic import`). **Jamais de logique IA dans `TankManager` ou `GameEngine`.** v2–v4 ajustent l’arme via `terrainMaterialTactics.ts` (pas de DRILLER sur `ROCK` ; DRILLER préféré sur `SOFT` si le pick par défaut est MISSILE). **v1-random n’y touche pas.**

Visée faillible (`fallibleAim.ts`) — v2–v4 seulement ; **v1-random n’y touche pas** :
| Profile | Courbe d’offset (px, par tentative sur la cible) |
|---------|--------------------------------------------------|
| `v2-heuristic` | 1er tir ≥ 36 px, lock au **5e** (`SHOTS_TO_HIT`) |
| `v3-sniper` | 1er tir ≥ 36 px, lock au **4e**, 14 % de glissade après lock |
| `v4-smart` | 1er tir ≥ 36 px, lock au **3e** |

Les gaffes de personnalité restent dans chaque stratégie. `AIStrategy` est un contrat legacy, non branché au runtime.

Warmup ease-out : manche 1 = 15 % (`AI_WARMUP_START_SKILL`), gros saut aux manches 2–3, palier du tableau à la manche 5. Après 5, `roundSkill` monte jusqu’à 1.35 (cap) et `aimMissScale` descend jusqu’à 0.55. Le 1er tir reste hors splash (`FIRST_SHOT_FLOOR_PX` = 36). Avant la manche 5, même le tir de lock peut rater (`EARLY_LOCK_LEFTOVER_PX`). Simple : P(alcoolique) = `1 − min(1, skill)`. `v1-random` reste hors `fallibleAim`.

Nouvelles IA → nouveau fichier dans `game/entities/ai/`, enregistrement dans `AIByProfileStrategy.ts` + `GameCanvas.tsx`. Si le profil vise, brancher `fallibleAim` (sauf si on veut un profil volontairement naïf comme v1).

## Pièges fréquents

- Utiliser `secureRandom` de `src/utils/random.ts` au lieu de `Math.random` pour tout le RNG.
- Ne pas stocker de tableaux de projectiles/particules/ImageData dans `useState` mis à jour à chaque frame.
- Ne pas muter le canvas context dans un render React.
- **CSP style-src** : Ne JAMAIS enlever `'unsafe-inline'` de la directive `style-src` dans `index.html` ou `public/_headers`. Vite et React en ont absolument besoin pour injecter les styles de dev et gérer les attributs `style` dynamiques (un test unitaire `csp.test.ts` veille au grain).
- `tsc -b` vérifie `worker/` aussi (projet reference). Les erreurs de type dans `worker/src/` cassent le build.
- Le worker DO utilise des types globaux (`DurableObjectNamespace`), pas d'imports de plateforme.
- Boutique locale humain vs IA : ne pas rebloquer le shop humain en manche 2+ (`useGameSession.ts`).
- Grenade longue : le filet de sécurité du `TurnManager` ne doit pas laisser l’IA rejouer après un bounce trop long.
- Ne pas modifier les fichiers de règles (`AGENTS.md`, `CLAUDE.md`, etc.) sans instruction explicite.

## Fichiers clés par tâche

| Besoin | Fichiers |
|--------|----------|
| Nouvelle arme | `types/weapon.ts`, `GameEngine.ts`, `PhysicsEngine.ts`, shop + HUD |
| DRILLER / puits | `types/weapon.ts` (`DRILLER_SHAFT_DEPTH`), `Terrain.ts` (`destroyTerrainShaft`), `PhysicsEngine.ts` |
| Nouveau cycle/manche | `TurnManager.ts`, `GameCanvas.tsx` |
| Physique/explosions | `PhysicsEngine.ts`, `GameEngine.ts` |
| Terrain & matériaux | `Terrain.ts`, `types/terrain.ts` |
| Phase globale | `App.tsx`, `appReducer.ts`, `types/game.ts` |
| Online lobby | `OnlineLobby.tsx`, `useOnlineLobby.ts`, `OnlineLobbyCreate.tsx`, `OnlineLobbyWaiting.tsx`, `onlineLobbyTypes.ts`, `worker/src/index.ts`, `worker/src/game-room.ts` |
| Online sync combat | `useGameSession.ts`, `onlineSession.ts` |
| Ordre des tours (online) | `src/game/online/turnOrder.ts` + `worker/src/game-room.ts` |
| Shop AI | `aiShopHelper.ts` (auto-buy lists) |
| Shop métier (buy/sell) | `shopBuySell.ts` (`applyShopDelta`) + `useGameSession.ts` |
| Visée IA (v2–v4) | `fallibleAim.ts` + `roundSkill.ts` + `terrainMaterialTactics.ts` + la stratégie concernée |
| Audio combat / victoire | `GameEngine.ts` |

## Compétences disponibles

- `.agents/skills/react-doctor/` : avant/après changements React (`/doctor`).

## Style de commit

Impératif. Signer avec nom + modèle exact (`— Grok 4.6 (xAI)`).
