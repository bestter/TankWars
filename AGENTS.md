# AGENTS.md — TankWars

Lire ce fichier avant toute modification. Il centralise les consignes opérationnelles du dépôt; les règles de jeu détaillées vivent dans le code, ses tests et le [README](./README.md).

Compagnons selon l’outil utilisé : [CLAUDE.md](./CLAUDE.md), [GROK.md](./GROK.md), [CURSOR.md](./CURSOR.md), [.cursorrules](./.cursorrules), [.antigravityrules](./.antigravityrules). Garder ici les consignes communes, sans journal de changements ni copie des tableaux d’équilibrage.

## Règles de travail

- Répondre en français québécois, même si la demande est en anglais.
- TypeScript strict : jamais de `any`; valider les données externes avant de les utiliser, en partant de `unknown` au besoin.
- Respecter [`.editorconfig`](./.editorconfig) : UTF-8, fins de ligne LF, saut final, indentation et exceptions propres aux fichiers.
- Avant d’éditer, vérifier `git status` et le diff existant. Préserver les changements de l’utilisateur et limiter les modifications au mandat.
- Demander lorsqu’une ambiguïté change le comportement attendu ou la portée. Ne pas transformer une idée ou un ticket non approuvé en règle de jeu.
- Accompagner toute fonctionnalité de tests pertinents; pour une correction de bogue, ajouter un test de régression lorsque possible. Mettre à jour la documentation touchée.
- Ne modifier les fichiers de règles que sur demande explicite. Une demande visant `AGENTS.md` ne s’étend pas automatiquement aux compagnons.
- Utiliser `secureRandom` de `src/utils/random.ts`, jamais `Math.random`. Préserver les RNG injectés et l’ordre des tirages lorsqu’ils font partie du contrat testé.

## Commandes

Les scripts de [package.json](./package.json) font référence. Node.js 24 est utilisé par la CI.

| Tâche | Commande |
| --- | --- |
| Installer les dépendances localement | `npm install` |
| Reproduire l’installation CI avec le verrou existant | `npm ci --ignore-scripts` |
| Démarrer le client | `npm run dev` → http://localhost:5173 |
| Démarrer le Worker | `npm run worker:dev` → http://localhost:8787 |
| Vérifier le code | `npm run lint` |
| Construire et vérifier les types client + Worker | `npm run build` (`tsc -b` puis Vite) |
| Exécuter les tests | `npm run test` (Vitest, sans mode watch) |
| Prévisualiser le build | `npm run preview` |
| Diagnostic React | `npm run doctor` |
| Déployer le Worker | `npm run worker:deploy` |

Pour le multijoueur local, lancer le client **et** le Worker. Après une modification de `worker/src/game-room.ts`, redémarrer le Worker avant le test manuel. `worker/.wrangler/` contient l’état local ignoré par Git.

<a id="verification-checklist"></a>

## Validation

Avant de terminer, exécuter dans cet ordre :

1. `npm run lint`
2. `npm run build`
3. `npm run test`
4. `git diff --check`

Tous les contrôles doivent passer. Corriger les échecs liés au travail; signaler explicitement tout échec préexistant ou blocage sans élargir discrètement la portée. Rapporter les commandes réellement exécutées et leurs résultats; ne pas maintenir de nombre de tests figé ici.

Pour les changements React, appliquer le [skill react-doctor](./.agents/skills/react-doctor/SKILL.md). Consulter `.github/workflows/react-doctor.yml` : le diagnostic porte sur les changements et `blocking: warning` rend aussi les avertissements bloquants. `knip.json` définit les points d’entrée de l’analyse de code inutilisé.

Si l’interface ou le moteur change, vérifier manuellement le parcours concerné : menu, partie, fin de manche, boutique et manche suivante. Pour le réseau, couvrir aussi les reconnexions et les reprises pertinentes. Si un contrôle manuel n’a pas été fait, le dire.

## Journaux et erreurs

- « Décisions IA » désigne les décisions des tanks contrôlés par le jeu. Les journaliser dans la console du navigateur uniquement en mode DEBUG/développement, avec assez de contexte pour comprendre le choix. Aucun journal de décision superflu en production.
- Côté Vite, utiliser `import.meta.env.DEV` pour protéger les traces de développement et leur calcul. Ne pas supposer qu’un drapeau global `DEBUG` existe.
- Journaliser les erreurs et exceptions avec le contexte utile et le niveau approprié : `console.error` pour les erreurs, `console.warn` pour les avertissements. Ne pas avaler silencieusement une exception ni exposer de secrets dans les journaux.
- Une erreur client va dans la console du navigateur; une erreur Worker va dans les journaux serveur. Afficher aussi un message compréhensible à l’utilisateur lorsqu’une action échoue.
- Attention à l’existant : `src/main.tsx` neutralise les méthodes de console autres que `console.error` en production, y compris `console.warn`. Ne pas compter sur un avertissement navigateur pour signaler une erreur de production.

## Architecture à préserver

| Couche | Responsabilités | Limites |
| --- | --- | --- |
| React (`src/App.tsx`, `src/components/`) | Phases, joueurs, argent, boutique, HUD et overlays | Aucun accès au contexte Canvas pendant le rendu; aucune donnée de simulation par frame dans `useState` |
| Moteur (`src/game/engine/`) | Physique, terrain, projectiles, dessin et audio de combat | Aucun state React ni appel à `setState`; les décisions tactiques restent dans les stratégies IA |
| Domaines partagés (`src/game/online/`, `shop/`, `economy/`, `zeus/`) | Règles et contrats utilisés par le client et le serveur | Garder les calculs partagés indépendants du DOM et des API de plateforme |
| Worker (`worker/src/`) | Autorité réseau et persistance de `GameRoom` | Ne pas faire confiance aux snapshots et commandes clients sans validation |

- `GameEngine` utilise un pas physique fixe de `1/120 s`; `requestAnimationFrame` cadence le rendu selon l’écran. Injecter entrées et configuration par refs et méthodes reliées dans `useEffect`.
- Le Canvas est démonté en `MENU`. `App.tsx` et `appReducer.ts` possèdent l’entrée/sortie de session; `GameCanvas.tsx` orchestre les phases internes définies dans `src/types/game.ts`.
- Rendu Canvas2D, terrain heightmap sans tunnels ni moteur physique externe. Employer `VGA_PALETTE` et `src/game/rendering/tankSprite.ts`.
- Conserver le style rétro monospace dans `src/App.css` et `src/index.css`; aucune bibliothèque UI, Tailwind ou MUI.
- `worker/tsconfig.json` est référencé par le projet racine : une erreur de type Worker fait échouer le build. Les types de plateforme existants, dont `DurableObjectNamespace`, sont globaux.

## Contrats sensibles

### Combat, terrain et économie

- Caractéristiques et prix : `src/types/weapon.ts` (`WEAPON_REGISTRY`). Matériaux et constantes : `src/types/terrain.ts` et `src/game/combatConstants.ts`. Consulter ces sources et leurs tests avant de modifier l’équilibrage.
- Distinguer dégâts directs, souffle et chute : l’amplification du bouclier sur un tir direct ne s’applique pas au surplus sur la santé; la chute contourne le bouclier. Voir `TankManager.ts` et ses tests de dégâts.
- BULLDOZER déplace les tanks sans explosion ni cratère et ne marque pas `wasDirectHit`. DRILLER creuse un puits orienté; GRENADE réagit au matériau. Préserver leurs chemins physiques propres.
- `Terrain.loadHeights` remet tous les matériaux à `DIRT` si `materials` manque ou si sa longueur diffère de `heights`.
- Une longue trajectoire de GRENADE ne doit pas provoquer un second tour IA après le déclenchement du filet de sécurité de `TurnManager`.
- Les gains passent par `src/game/economy/fixedPoint.ts` et `shotRewards.ts` : calcul rationnel, un seul arrondi final, argent entier sûr, aucun gain d’auto-dégât. Préserver l’application unique par tir et la distinction gain de manche / solde total.

### IA et boutique

- Toute stratégie locale implémente `src/game/entities/ai/AIEngine.ts` et passe par `AIByProfileStrategy`, branché dans `GameCanvas.tsx`. `AIStrategy` est un contrat legacy non utilisé au runtime. Ne pas placer de stratégie dans `TankManager` ou `GameEngine`.
- Profils : `v1-random` → `AISimpleStrategy`; `v2-heuristic` → `AIHeuristicStrategy`; `v3-sniper` → `AISniperStrategy`; `v4-smart` → `AISmartStrategy`.
- Conserver le chargement à la demande de v2–v4 et du solveur SIMPLE, après le court-circuit de grosse gaffe. Une nouvelle IA doit être intégrée au routeur et à la configuration des profils concernés.
- Les quatre profils utilisent `fallibleAim.ts`, la mémoire de cible et `hitReaction.ts`. Préserver les resets de cible/manche, la consommation unique de réaction, le plafonnement de `fallDistance` jusque dans les snapshots et les contrats de RNG/gaffes. Les courbes et seuils sont dans le code et les tests associés.
- SIMPLE conserve sa cible vivante, sinon privilégie l’IA vivante la plus faible avant les humains. Il ignore vengeance, tactiques de matériau et BULLDOZER; il utilise `currentWeapon` ou `MISSILE`. SNIPER conserve sa surcorrection au deuxième tir seulement, sans glissade après verrouillage.
- `terrainMaterialTactics.ts` concerne v2–v4; `bulldozerTactics.ts`, OK et EXPERT. Pour les lourdes EXPERT, lire `expertTactics.ts`, `AISmartStrategy.ts` et leurs tests : l’admissibilité géométrique ne garantit pas la survie réelle et le jet tactique est distinct de la gaffe.
- Tous les achats IA passent par `autoBuyForAI` dans `aiShopHelper.ts`, sans méthode boutique dans les stratégies de combat. Le nombre initial de joueurs reste fixe; respecter les plafonds de profil, les quotas de `shopPolicy.ts` et les transactions unitaires. Aucun budget proportionnel, réserve minimale ou vente automatique.
- Attention aux replis : un profil absent/inconnu utilise OK pour les achats, SIMPLE pour le routeur de combat.
- En local, propager le roster immuable après achat vers `TankManager.setPlayers`, `shopPlayersRef.current` et `APPLY_LOCAL_SHOP_TRANSACTION`. La boutique humaine doit rester accessible aux manches suivantes.
- Les noms locaux sont uniques après `trim().toLowerCase()` indépendamment de la locale. Préserver les noms édités, l’absence de renommage rétroactif et leur stabilité après changement de langue. Voir `playerNameUi.ts` et ses tests.

### Multijoueur et déploiement

- La physique demeure locale. `GameRoom` possède l’ordre des tours, l’acceptation et la consommation des tirs, l’application des gains, la boutique et Zeus. L’autorité cliente des rapports de gains peut changer après déconnexion; préserver son ordre de relève.
- Le combat IA serveur passe actuellement par `maybeRunAIServerTurn` et une `fakeCommand`; il n’exécute pas les stratégies locales. Ne pas présenter une amélioration locale comme une amélioration de l’IA en ligne.
- `src/game/online/protocol.ts` centralise versions, gardes et bornes `FIRE_COMMAND_*`. Préserver la validation en profondeur du Worker et la compatibilité v0 tant qu’une migration explicite ne la retire pas.
- `FIRE` est une intention : aucun projectile ni décrément avant `SHOT`, rejoué par tous les clients. Seul le tireur humain émet `SHOT_SETTLED`; un client ne tire pas à la place d’une IA. Un refus reste visible sans bloquer l’interface.
- Boutique : le Worker décide des transactions et exécute les achats IA une seule fois par époque. Un snapshot client v1 n’est pas une source d’autorité. Préserver la conversion v0 bornée, les clés `kind:slot:actionId`, l’ack `{ slot, actionId }` et le même identifiant au retry.
- Préserver la persistance avant diffusion, les gains/morts appliqués atomiquement, l’idempotence et l’historique de tirs borné à la manche. La file de reprise et les transitions différées maintiennent l’ordre `ROUND_END` → `SHOP_STATE` → `SHOP_FINISH`; un état boutique tardif ne rouvre pas une boutique terminée.
- Lors d’un déploiement multijoueur, publier le Worker avant le client, vérifier `/api/health` contre les versions attendues du protocole, puis construire/publier le client. Garder l’auto-déploiement de production Cloudflare Pages désactivé pour préserver cet ordre.
- Distinguer Cloudflare Pages du workflow GitHub Pages `.github/workflows/deploy.yml`, déclenché par un push sur `main`. Vérifier les workflows concernés avant toute publication; une commande de déploiement listée ici n’est pas une demande de déployer.

### Zeus et protections du client

- `ZEUS_LIGHTNING` est une action spéciale dans `src/game/zeus/`, jamais une arme : ne pas l’ajouter à `WeaponId`, `WEAPON_REGISTRY`, `FireCommand`, la boutique ou `AIEngine`.
- Préserver les conditions d’activation/reset, l’équité intermanches et la séparation entre `lastDirectAttackerId`, `lastHitBy` et `hitReaction`. BULLDOZER ne compte pas comme agresseur direct pour Zeus.
- En ligne, `GameRoom` décide et persiste Zeus avant diffusion. `strikeId` empêche les doubles frappes/crédits; `ZEUS_STATE` restaure l’état après reconnexion. Les effets visuels utilisent l’identifiant et le temps, jamais le RNG de salle; la relève de l’autorité économique ne change pas Zeus.
- Conserver `'unsafe-inline'` dans `style-src` de `index.html` et `public/_headers`, comme l’exige `src/utils/__tests__/csp.test.ts` pour les styles du client actuel.

## Où intervenir

Les chemins ci-dessous sont relatifs à la racine du dépôt. Chercher les tests voisins dans `__tests__/`.

| Besoin | Points d’entrée |
| --- | --- |
| Phases et session React | `src/App.tsx`, `src/appReducer.ts`, `src/components/GameCanvas.tsx`, `src/components/useGameSession.ts` |
| Physique, tours, terrain, audio | `src/game/engine/` (`GameEngine.ts`, `PhysicsEngine.ts`, `TurnManager.ts`, `Terrain.ts`), `src/game/entities/TankManager.ts` |
| Armes, matériaux, rendu | `src/types/weapon.ts`, `src/types/terrain.ts`, `src/game/combatConstants.ts`, `src/game/rendering/tankSprite.ts` |
| IA, visée et achats IA | `src/game/entities/ai/` (stratégies, tactiques, `aiShopHelper.ts` et tests) |
| Boutique et gains | `src/game/shop/`, `src/components/shop/`, `src/game/economy/`, `src/components/ShotEarningsOverlay.tsx`, `src/components/RoundSummary.tsx` |
| Menu, noms, traduction | `src/components/MainMenu.tsx`, `src/components/playerNameUi.ts`, `src/components/playerControllerUi.ts`, `src/components/usePlayerNameValidation.ts`, `src/locales/` |
| Lobby | `src/components/OnlineLobby.tsx`, `src/components/useOnlineLobby.ts`, `worker/src/index.ts` |
| Combat réseau et reconnexion | `src/components/online/`, `src/utils/onlineSession.ts`, `src/game/online/`, `worker/src/game-room.ts` |
| Zeus | `src/game/zeus/`, `src/game/engine/GameEngine.ts`, `src/game/engine/TurnManager.ts`, `src/game/entities/TankManager.ts`, `worker/src/game-room.ts` |
| Build, CI et déploiements | `package.json`, `tsconfig.json`, `worker/tsconfig.json`, `worker/wrangler.toml`, `.github/workflows/` |

## Commits et compte rendu

- Message de commit à l’impératif, signé avec le nom de l’application utilisée, l’identité de l’agent et son modèle exact fourni par l’environnement. Ne pas copier la signature d’un autre agent ni inventer une version.
- Le compte rendu indique ce qui a changé, pourquoi, les validations effectuées et les limites restantes. Distinguer modifications locales, commit, push, PR et déploiement; ne déclarer une publication qu’après vérification.
