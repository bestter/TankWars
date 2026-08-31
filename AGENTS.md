# AGENTS.md — TankWars

Lecture obligatoire avant toute modification. Companion docs: [CLAUDE.md](./CLAUDE.md), [GROK.md](./GROK.md), [CURSOR.md](./CURSOR.md), [.cursorrules](./.cursorrules), [.antigravityrules](./.antigravityrules).

Ce fichier est la source opérationnelle (commandes, architecture, pièges, fichiers clés). Les compagnons reprennent les règles — pas le journal de commits.

## Règle d'or

Répondre en français (FR, de préférence québécois). Même si l'utilisateur écrit en anglais. **Jamais de `any`.** Douter → demander.

Tous les contributeurs — agents IA comme humains 😁 — doivent respecter les conventions définies dans [`.editorconfig`](./.editorconfig) pour chaque fichier créé ou modifié.

## Commandes

| Tâche | Commande |
|-------|----------|
| Install | `npm install` |
| Dev frontend | `npm run dev` → http://localhost:5173 |
| Production build | `npm run build` (tsc -b + vite) |
| Lint | `npm run lint` |
| Tests | `npm run test` (vitest, 760 tests, 73 fichiers) |
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

### Rendu, Terrain & Boucliers

- **Palette:** `VGA_PALETTE` dans `src/types/game.ts` (16 couleurs VGA + néon). Seule palette autorisée.
- **Terrain & Relief:** heightmap custom dans `Terrain.ts` (génération procédurale riche multi-octaves avec bosses et creux tactiques, sans tunnels). Matériaux de terrain (`src/types/terrain.ts`) : `DIRT` (standard, herbe verte + terre brune), `ROCK` (roche indestructible en gris, mur pour le souffle latéral via `isBlastOccludedByRock` ; explosion par-dessus : +50% de dégâts via `ROCK_EXPLOSION_DAMAGE_MULTIPLIER = 1.5`, portée inchangée), `SOFT` (terrain meuble sable/jaune, `SOFT_TERRAIN_DESTRUCTION_MULTIPLIER = 2.5` fois plus destructible). DRILLER : puits orienté (`destroyTerrainShaft`, profondeur `DRILLER_SHAFT_DEPTH` dans `types/weapon.ts`) — le splash reste inchangé. GRENADE : rebond ~2× plus haut sur ROCK ; premier contact sur SOFT : colle, creuse, explose (`grenadeBounceParams`). Aucun moteur physique externe.
- **Boucliers & Dégâts (`TankManager.ts`):** 40 PV de bouclier inné par manche. Tir direct (`isDirectHitOnThisTank`) : le bouclier subit $2\times$ plus de dégâts (consomme 2 pts de bouclier par pt de dégât absorbé, calculé via `Math.ceil(shield / 2)`) ; le surplus de dégâts est appliqué sans amplification ($1\times$) sur `health`. Souffle indirect : absorption $1\times$. Dégâts de chute : réduisent directement `health` sans toucher à `shield` ; élimination immédiate si `health <= 0`.
- **Jauges au-dessus du tank (`TankManager.ts`):** Constantes exportées `TANK_GAUGE_*`.
  - `shield > 0 && health === maxHealth` : barre unique cyan foncé (`VGA_PALETTE.DARK_CYAN`) à $y - 24$ (`TANK_GAUGE_SINGLE_Y_OFFSET`).
  - `shield > 0 && health < maxHealth` : double jauge superposée — bouclier cyan foncé en haut ($y - 28$, `TANK_GAUGE_DOUBLE_SHIELD_Y_OFFSET`) et santé verte en bas ($y - 23$, `TANK_GAUGE_DOUBLE_HEALTH_Y_OFFSET`), avec nom du joueur rehaussé à $y - 36$ (`TANK_NAME_DOUBLE_GAUGE_Y_OFFSET`).
  - `shield <= 0` : barre unique verte à $y - 24$ (santé, rouge si $\le 40\%$).
- **Spawns:** `spawnTanks` mélange les X, favorise les creux (max Y canvas parmi les candidats `minDist` 100 px), marges 13 %, `Y = groundY`. Humains locaux : skip 25 % des samples SOFT. IA (tous modes) : skip 25 % des samples ROCK (`spawnAcceptsMaterial`).
- **Tank sprite:** `drawTankSprite()` dans `src/game/rendering/tankSprite.ts`. Procédural pur Canvas2D.
- **Armes:** `WEAPON_REGISTRY` dans `src/types/weapon.ts` est la source unique des caractéristiques et des prix. La Mini-Nuke (`NUKE`) coûte 420 $. BULLDOZER : 150 $, 0 HP, 0 rayon ; hit direct = poussée `sign(vx)` + recul (`min(|vx| × 0.25, 120 px)`), pas de cratère, pas d’`applyExplosionDamage` (donc pas de `wasDirectHit`) ; chute / lave via la gravité existante ; hors-carte → burial.
- **Style:** rétro monospace, `App.css`/`index.css`. Aucune librairie UI (ni Tailwind, ni MUI, etc.).

### Online multiplayer

Le multi est dans `main` (plus une branche `AddMultiplayer`). La physique demeure locale, mais le serveur est autoritaire sur l’ordre des tours, l’acceptation et la consommation des tirs, les gains et toute la boutique. La simulation complète serveur (terrain / dégâts / PV) reste prévue.

- `worker/` : Cloudflare Worker + Durable Object `GameRoom` (lobby, tirs serveur-first, boutique autoritaire, historique de rattrapage borné à la manche et état persistant via Durable Object storage).
- Client lobby : `OnlineLobby.tsx` (shell) + `useOnlineLobby.ts` + `OnlineLobbyCreate.tsx` / `OnlineLobbyWaiting.tsx` / `onlineLobbyTypes.ts`.
- Client combat : `useGameSession.ts`, `attachOnlineCombat.ts`, `onlineSession.ts` (reconnexion WS combat, validation stricte `sessionStorage` et résilience aux coupures).
- Ordre des tours vivant : `src/game/online/turnOrder.ts` (partagé client + worker, sans DOM ni APIs Workers).
- Protocole combat/boutique strict partagé : `src/game/online/protocol.ts` (`FIRE`/`SHOT` corrélés par `actionId`, refus, catch-up ordonné, gains, manches et messages `SHOP_*`). Les `FIRE` stricts et v0 ainsi que les `SHOT` partagent une garde finie inclusive : angle -360° à 360° et puissance 0 à 100, définie par les constantes `FIRE_COMMAND_*`; `GameRoom.executeFire` conserve la même validation en profondeur. `ONLINE_PROTOCOL_VERSION` reste à 1; le Worker accepte temporairement les clients v0 non versionnés et ferme en `4402` seulement une version numérique non supportée. Déploiement obligatoire Worker-first : Worker → `/api/health` exige `protocolVersion: 1` et `minimumClientProtocolVersion: 0` → build client → Pages. Désactiver l'auto-déploiement de production Pages.
- File SHOT reconnect : `src/game/online/authoritativeShotQueue.ts`. Pendant un replay, `DeferredTransitionBuffer` applique `ROUND_END` → `SHOP_STATE` → `SHOP_FINISH` (un `SHOP_STATE` tardif n'écrase pas un `SHOP_FINISH`). Dispatch WS combat : `src/components/online/combatMessageDispatch.ts`.
- En ligne, `FIRE` est une intention pessimiste : aucun projectile ni décrément avant l’écho `SHOT`. Tous les clients, tireur inclus, rejouent ce `SHOT`; seul le tireur humain émet `SHOT_SETTLED`. Les tirs clients émis pendant un tour IA sont rejetés (`NOT_YOUR_TURN`), l'IA serveur tirant uniquement via `maybeRunAIServerTurn`. Tout rejet de tir est affiché via un toast non bloquant (`.fire-rejection-toast`) avec auto-dismiss après 3,5 s.
- La boutique en ligne n’accepte aucun snapshot client v1. Pour la fenêtre v0, le Worker dérive au plus une transaction valide de l'écart économique et ignore le reste du snapshot. `GameRoom` ouvre une session par époque, normalise le roster, exécute les achats IA une fois et applique chaque transaction avec clé composite d'idempotence (`kind:slot:actionId`). `SHOP_STATE`/`SHOP_FINISH` acquittent une réussite avec `{ slot, actionId }`; seul cet ack corrélé libère l'intention locale, et un délai sans réponse renvoie le même `actionId`. Les retries réussis reçoivent l'état frais. `SHOP_FINISH` vide `shotHistory` et ne conserve que le dernier `SHOP_READY` terminal jusqu'au prochain `SHOP_ENTER`.
- Le premier humain connecté devient l’autorité des gains; `GameRoom` persiste l’ordre, l’époque, le tir actif et le dernier résultat. En cas de déconnexion, l’autorité passe au prochain humain selon l’ordre initial sans reprise automatique par l’ancien premier.
- Le Worker valide puis applique les gains et les états morts atomiquement avant diffusion. Un doublon identique est rediffusé sans double crédit. Le tour avance dès que la physique et le rapport économique sont stabilisés, sans délai d’affichage.
- Dev : lancer **les deux** `npm run dev` + `npm run worker:dev`. Redémarrer le worker après chaque changement de `game-room.ts`.
- `GAME_START` n'envoie `materials` que si le tableau serveur a la même longueur que `heights` (generate headless pas encore branché). `Terrain.loadHeights` remet tout à `DIRT` si le tableau est absent ou mismatch (pas d'état hybride).
- `worker/.wrangler/` est gitignoré (état local SQLite).
- Worker a son propre `worker/tsconfig.json`, référencé dans le `tsconfig.json` racine pour la validation statique stricte des types.

### Économie par tir

- Domaine pur : `src/game/economy/fixedPoint.ts` + `shotRewards.ts`; calcul exact rationnel, dégâts normalisés au millième et un seul `ceil` final. `Player.money` demeure un entier sûr.
- Base $X$ selon le nombre initial de joueurs : 3 $ (2 joueurs), 3,5 $ (3), 4 $ (4).
- Dégâts de projectile : direct = $X \times dégâts$, indirect = moitié; NUKE/THERMONUCLEAR divisent encore par 2. Chute attribuée : quart en direct, huitième en indirect. Aucun gain pour l'auto-dégât.
- Destruction : $25X$, ou $50X$ au premier tir de la manche; NUKE/THERMONUCLEAR = $2X$. Dernier survivant = $50X$; les nulles suivent le partage défini dans `shotRewards.ts`.
- `GameEngine` tient un registre de tir (`shotId` / `munitionId`), applique les gains une seule fois et cumule `roundEarningsByPlayer`. Le résumé montre le gain de manche; la boutique montre le solde total.
- `ShotEarningsOverlay.tsx` affiche `+montant$` au-dessus du tank pendant 3 secondes, avec montée/fondu et sans bloquer les entrées ni le prochain tour.

### Anti-impasse / Éclair de Zeus

- Domaine pur : `src/game/zeus/zeusDomain.ts` + `zeusRewards.ts`. `ZEUS_LIGHTNING` est une **action spéciale**, jamais une arme : ne jamais l’ajouter à `WeaponId`, `WEAPON_REGISTRY`, `FireCommand`, la boutique ou une stratégie `AIEngine`.
- Activation : seulement lorsqu’au moins deux IA sont vivantes et qu’aucun humain vivant ne reste. Après `IA vivantes × 5` tirs consécutifs sans **touche payante** (`hasEarnings === false`), une IA admissible devient Zeus et prend immédiatement le prochain tour.
- Compteur : un gain, un humain vivant, moins de deux survivants, la mort de Zeus ou la fin de manche le remet à zéro. Une mort sans gain conserve le cycle et recalcule le seuil avec les survivants; la résolution qui tue Zeus ne compte jamais dans le cycle suivant.
- Roulement équitable : `appointedPlayerIds` survit aux manches et est vidé seulement quand toutes les IA admissibles ont été Zeus; `resetGame`/nouvelle salle vide tout. L’ordre est réancré sur Zeus, puis reste circulaire (`Zeus → suivants → Zeus`).
- Vengeance : `Tank.lastDirectAttackerId` est distinct de `lastHitBy`/`hitReaction`; toute touche directe adverse, même absorbée entièrement par le bouclier, l’actualise sauf BULLDOZER. Zeus consomme le dernier agresseur direct encore vivant, sinon utilise le RNG injecté.
- Frappe : animation d’environ 700 ms, puis la cible seule passe à 0 santé/0 bouclier/morte. Aucun projectile, souffle, cratère ou dommage collatéral. Prime unique = destruction standard `25X`, sans dégâts, premier tir ni bonus de dernier survivant.
- En ligne, `GameRoom` est l’unique autorité Zeus. Il persiste compteur, historique, agresseurs, RNG, ordre, identifiants et frappe avant diffusion. `strikeId`/dernier résultat garantissent l’idempotence; `ZEUS_STATE` restaure aura, morts, tour et frappe à la reconnexion. Un changement d’autorité économique ne modifie jamais Zeus.

### Système d'IA

Toute IA doit implémenter `AIEngine` (`src/game/entities/ai/AIEngine.ts`) :

```ts
executeTurn(tankId, gameState, terrainManager): Promise<FireCommand>
```

Noms IA du menu local (`MainMenu.tsx`) : le champ reçoit le nom court localisé du profil (`Simple`, `OK`, `Sniper`, `Expert`) au moment de la création ou de la sélection. Le suffixe correspond au nombre des **autres** joueurs qui utilisent déjà ce profil, peu importe leur position (`Simple`, `Simple-1`, `Simple-2`), puis avance si ce nom est déjà utilisé par un humain ou une autre IA. Seul le joueur sélectionné est renommé : aucun renommage rétroactif. Le nom demeure éditable et reste figé si la langue change ensuite. Tous les noms doivent être uniques après `trim()` + `toLowerCase()`; cette normalisation doit rester indépendante de la locale du navigateur (jamais de `toLocaleLowerCase()` sans locale explicite). Les doublons manuels sont signalés après blur/clic et bloquent le démarrage local.

Profils (mixables dans une même partie) :
| Profile | Classe | Label |
|---------|--------|-------|
| `v1-random` | `AISimpleStrategy` | IA SIMPLE |
| `v2-heuristic` | `AIHeuristicStrategy` | IA OK |
| `v3-sniper` | `AISniperStrategy` | IA SNIPER |
| `v4-smart` | `AISmartStrategy` | IA EXPERT |

Le routeur `AIByProfileStrategy` est instancié dans `GameCanvas.tsx`. Les v2–v4 sont lazy-loadés (`dynamic import`). **Jamais de logique IA dans `TankManager` ou `GameEngine`.** v2–v4 ajustent l’arme via `terrainMaterialTactics.ts` (pas de DRILLER sur `ROCK` ; DRILLER préféré sur `SOFT` si le pick par défaut est MISSILE) et `bulldozerTactics.ts` (BULLDOZER si stock, dist ≥ 80, bord de carte ou drop ≥ 12 px). Shop : v1 n’achète pas BULLDOZER ; v2 stock max 1 ; v3 jamais ; v4 stock max 2. **v1-random n’y touche pas.**

Visée faillible (`fallibleAim.ts`) — v2–v4 seulement ; **v1-random n’y touche pas** :
| Profile | Courbe d’offset (px, par tentative sur la cible) |
|---------|--------------------------------------------------|
| `v2-heuristic` | 1er tir ≥ 36 px, lock au **5e** (`SHOTS_TO_HIT`) |
| `v3-sniper` | 1er tir ≥ 36 px, lock au **4e**, 14 % de glissade après lock |
| `v4-smart` | 1er tir ≥ 36 px, lock au **3e** |

Les gaffes de personnalité restent dans chaque stratégie. `AIStrategy` est un contrat legacy, non branché au runtime.

Warmup ease-out : manche 1 = 15 % (`AI_WARMUP_START_SKILL`), gros saut aux manches 2–3, palier du tableau à la manche 5. Après 5, `roundSkill` monte jusqu’à 1.35 (cap) et `aimMissScale` descend jusqu’à 0.55. Le 1er tir reste hors splash (`FIRST_SHOT_FLOOR_PX` = 36). Avant la manche 5, même le tir de lock peut rater (`EARLY_LOCK_LEFTOVER_PX`). Simple : P(alcoolique) = `1 − min(1, skill)`. `v1-random` reste hors `fallibleAim`.

Courbe de réaction après coup/chute (`hitReaction.ts`, Issue 174) :
- **1er tir après l'événement :** Coup direct de projectile sur la hitbox (`wasDirectHit`) = +50% d'imprécision ; chute de terrain (`fallDistance`) = +1% à +25% d'imprécision (échelle 0 à 120 px). Les deux sont **cumulables**.
- **2e tir après l'événement (sans nouveau coup) :** SNIPER = 0% (précision normale/chirurgicale) ; EXPERT = 12% d'imprécision ; OK et SIMPLE = 25% d'imprécision.
- **3e tir :** Retour complet à 0% d'imprécision.

Nouvelles IA → nouveau fichier dans `game/entities/ai/`, enregistrement dans `AIByProfileStrategy.ts` + `GameCanvas.tsx`. Si le profil vise, brancher `fallibleAim` (sauf si on veut un profil volontairement naïf comme v1).

## Pièges fréquents

- Utiliser `secureRandom` de `src/utils/random.ts` au lieu de `Math.random` pour tout le RNG.
- Ne pas stocker de tableaux de projectiles/particules/ImageData dans `useState` mis à jour à chaque frame.
- Ne pas muter le canvas context dans un render React.
- **CSP style-src** : Ne JAMAIS enlever `'unsafe-inline'` de la directive `style-src` dans `index.html` ou `public/_headers`. Vite et React en ont absolument besoin pour injecter les styles de dev et gérer les attributs `style` dynamiques (un test unitaire `csp.test.ts` veille au grain).
- `tsc -b` vérifie `worker/` aussi (projet reference). Les erreurs de type dans `worker/src/` cassent le build.
- Le worker DO utilise des types globaux (`DurableObjectNamespace`), pas d'imports de plateforme.
- Boutique locale humain vs IA : ne pas rebloquer le shop humain en manche 2+ (`useGameSession.ts`).
- Boutique IA locale (`src/components/shop/localHotseatShop.ts`) : après `autoBuyForAI`, propager le nouveau roster immuable dans `TankManager.setPlayers`, synchroniser `shopPlayersRef.current` et dispatcher `APPLY_LOCAL_SHOP_TRANSACTION` afin que les achats soient conservés à la manche suivante et lors des re-renders.
- Grenade longue : le filet de sécurité du `TurnManager` ne doit pas laisser l’IA rejouer après un bounce trop long.
- `loadHeights` sans `materials` (ou longueur mismatch) : tout retombe sur `DIRT` — pas d’état hybride.
- Ne pas modifier les fichiers de règles (`AGENTS.md`, `CLAUDE.md`, etc.) sans instruction explicite.
- Zeus : persister toute nomination/frappe avant de la diffuser; ne jamais double-créditer un `strikeId`, consommer le RNG de salle pour des effets visuels, ni accepter `ZEUS_LIGHTNING` dans `FIRE`. La géométrie cosmétique dépend seulement de `strikeId` et du temps.

## Fichiers clés par tâche

| Besoin | Fichiers |
|--------|----------|
| Nouvelle arme | `types/weapon.ts`, `GameEngine.ts`, `PhysicsEngine.ts`, shop + HUD |
| BULLDOZER / poussée | `types/weapon.ts`, `PhysicsEngine.ts` (`applyBulldozerHit`), `TankManager.ts` (`applyBulldozerDisplacement`), `bulldozerTactics.ts` |
| DRILLER / puits | `types/weapon.ts` (`DRILLER_SHAFT_DEPTH`), `Terrain.ts` (`destroyTerrainShaft`), `PhysicsEngine.ts` |
| Nouveau cycle/manche | `TurnManager.ts`, `GameCanvas.tsx` |
| Physique/explosions | `PhysicsEngine.ts`, `GameEngine.ts` |
| Terrain & matériaux | `Terrain.ts`, `types/terrain.ts` (`spawnAcceptsMaterial`, `grenadeBounceParams`, constantes de blend/distribution) |
| Phase globale | `App.tsx`, `appReducer.ts`, `types/game.ts` |
| Online lobby | `OnlineLobby.tsx`, `useOnlineLobby.ts`, `OnlineLobbyCreate.tsx`, `OnlineLobbyWaiting.tsx`, `onlineLobbyTypes.ts`, `worker/src/index.ts`, `worker/src/game-room.ts` |
| Online sync combat | `useGameSession.ts`, `attachOnlineCombat.ts`, `onlineSession.ts`, `authoritativeShotQueue.ts`, `deferredTransitions.ts`, `flushDeferredTransitions.ts`, `combatMessageDispatch.ts` |
| Ordre des tours (online) | `src/game/online/turnOrder.ts` + `worker/src/game-room.ts` |
| Shop AI | `aiShopHelper.ts` (auto-buy lists) |
| Shop métier (buy/sell) | `game/shop/shopPolicy.ts`, `shopTransaction.ts`, `shopSessionGuard.ts` + `src/components/shop/` (`completeShopRound.ts`, `localHotseatShop.ts`, `shopPlayerActions.ts`) |
| Économie / gains par tir | `game/economy/fixedPoint.ts`, `game/economy/shotRewards.ts`, `GameEngine.ts`, `ShotEarningsOverlay.tsx`, `RoundSummary.tsx` |
| Protocole autoritaire des gains | `game/online/protocol.ts`, `useGameSession.ts`, `onlineSession.ts`, `worker/src/game-room.ts` |
| Anti-impasse / Éclair de Zeus | `game/zeus/zeusDomain.ts`, `game/zeus/zeusRewards.ts`, `GameEngine.ts`, `TurnManager.ts`, `TankManager.ts` |
| Autorité Zeus / reconnexion | `game/online/protocol.ts`, `useGameSession.ts`, `onlineSession.ts`, `worker/src/game-room.ts` |
| Visée IA (v2–v4) | `fallibleAim.ts` + `roundSkill.ts` + `hitReaction.ts` + `terrainMaterialTactics.ts` + `bulldozerTactics.ts` + la stratégie concernée |
| Noms joueurs du menu local | `MainMenu.tsx`, `MainMenuView.tsx`, `PlayerConfigList.tsx`, `PlayerConfigRow.tsx`, `playerControllerUi.ts`, `playerNameUi.ts`, `usePlayerNameValidation.ts` |
| Audio combat / victoire | `GameEngine.ts` |

## Compétences disponibles

- `.agents/skills/react-doctor/` : avant/après changements React (`/doctor`).

## Style de commit

Impératif. Signer avec nom + modèle exact (`— Grok 4.6 (xAI)`).
