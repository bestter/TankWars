# AGENTS.md — TankWars

Lecture obligatoire avant toute modification. Companion docs: [CLAUDE.md](./CLAUDE.md), [GROK.md](./GROK.md), [CURSOR.md](./CURSOR.md), [.cursorrules](./.cursorrules).

## Règle d'or

Répondre en français (FR, de préférence québécois). Même si l'utilisateur écrit en anglais. **Jamais de `any`.** Douter → demander.

## Commandes

| Tâche | Commande |
|-------|----------|
| Install | `npm install` |
| Dev frontend | `npm run dev` → http://localhost:5173 |
| Production build | `npm run build` (tsc -b + vite) |
| Lint | `npm run lint` |
| Tests | `npm run test` (vitest, 158 tests, 17 fichiers) |
| Worker dev | `npm run worker:dev` → http://localhost:8787 |
| Worker deploy | `npm run worker:deploy` |
| Doctor React | `npm run doctor` |

**Ordre de vérification obligatoire:** `npm run lint` → `npm run build` → `npm run test`. Tous les tests doivent passer. Corriger les échecs immédiatement.

## Architecture

### React vs Canvas (incompressible)

| Couche | Possède | Ne fait PAS |
|--------|---------|-------------|
| **React** (`App`, `GameCanvas`, composants) | `GamePhase`, joueurs, argent, shop, HUD, overlays | Toucher au canvas context ou à `getContext` dans un render |
| **GameEngine** (boucle rAF 120 Hz) | Physique, projectiles, vent, terrain, dessin | Tenir du state React ou appeler `setState` |

- `<canvas>` monté uniquement hors de `MENU` (App.tsx démonte le canvas en menu).
- Input et config injectés dans l'engine via **refs** et méthodes enregistrées dans `useEffect`.
- Physique à **pas fixe** découplé du rafraîchissement écran.

### Phases (`src/types/game.ts`)

`MENU` → `COMBAT` → `RESOLUTION` → `CELEBRATION` → `SUMMARY` → `SHOP` → ... → `GAME_OVER`

- `App.tsx` : `MENU` vs le reste.
- `GameCanvas.tsx` : phases intra-match (COMBAT → GAME_OVER).

### Rendu & terrain

- **Palette:** `VGA_PALETTE` dans `src/types/game.ts` (16 couleurs VGA + néon). Seule palette autorisée.
- **Terrain:** heightmap custom dans `Terrain.ts` (cratères circulaires avec falloff). Aucun moteur physique externe.
- **Tank sprite:** `drawTankSprite()` dans `src/game/rendering/tankSprite.ts`. Procédural pur Canvas2D.
- **Style:** rétro monospace, `App.css`/`index.css`. Aucune librairie UI (ni Tailwind, ni MUI, etc.).

### Online multiplayer (work in progress)

- `worker/` : Cloudflare Worker + Durable Object `GameRoom` (lobby, tour relay, shop sync).
- Client : `OnlineLobby.tsx`, `useGameSession.ts`, `onlineSession.ts`.
- Dev : lancer **les deux** `npm run dev` + `npm run worker:dev`. Redémarrer le worker après chaque changement de `game-room.ts`.
- `worker/.wrangler/` est gitignoré (état local SQLite).
- Worker a son propre `worker/tsconfig.json`, référencé dans le `tsconfig.json` racine.

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

Le routeur `AIByProfileStrategy` est instancié dans `GameCanvas.tsx`. Les v2–v4 sont lazy-loadés (`dynamic import`). Les nouvelles IA → nouveau fichier dans `game/entities/ai/`, enregistrement dans `AIByProfileStrategy.ts` + `GameCanvas.tsx`. **Jamais de logique IA dans `TankManager` ou `GameEngine`.**

## Pièges fréquents

- Utiliser `secureRandom` de `src/utils/random.ts` au lieu de `Math.random` pour tout le RNG.
- Ne pas stocker de tableaux de projectiles/particules/ImageData dans `useState` mis à jour à chaque frame.
- Ne pas muter le canvas context dans un render React.
- **CSP style-src** : Ne JAMAIS enlever `'unsafe-inline'` de la directive `style-src` dans `index.html` ou `public/_headers`. Vite et React en ont absolument besoin pour injecter les styles de dev et gérer les attributs `style` dynamiques (un test unitaire `csp.test.ts` veille au grain).
- `tsc -b` vérifie `worker/` aussi (projet reference). Les erreurs de type dans `worker/src/` cassent le build.
- Le worker DO utilise des types globaux (`DurableObjectNamespace`), pas d'imports de plateforme.
- Ne pas modifier les fichiers de règles (`AGENTS.md`, `CLAUDE.md`, etc.) sans instruction explicite.

## Fichiers clés par tâche

| Besoin | Fichiers |
|--------|----------|
| Nouvelle arme | `types/weapon.ts`, `GameEngine.ts`, `PhysicsEngine.ts`, shop + HUD |
| Nouveau cycle/manche | `TurnManager.ts`, `GameCanvas.tsx` |
| Physique/explosions | `PhysicsEngine.ts`, `GameEngine.ts` |
| Terrain cratères | `Terrain.ts` |
| Phase globale | `App.tsx`, `types/game.ts` |
| Online lobby | `OnlineLobby.tsx`, `worker/src/index.ts`, `worker/src/game-room.ts` |
| Online sync combat | `useGameSession.ts`, `onlineSession.ts` |
| Shop AI | `aiShopHelper.ts` (auto-buy lists) |

## Compétences disponibles

- `.agents/skills/react-doctor/` : avant/après changements React (`/doctor`).

## Style de commit

Impératif. Signer avec nom + modèle exact (`— Grok 4.3 (xAI)`).
