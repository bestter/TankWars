# AGENTS.md — TankWars

Lire ce fichier avant toute modification. Il centralise les consignes opérationnelles du dépôt; les règles de jeu détaillées vivent dans le code, ses tests et le [README](./README.md).

Compagnons selon l’outil utilisé : [CLAUDE.md](./CLAUDE.md) et [.github/copilot-instructions.md](./.github/copilot-instructions.md). Garder ici les consignes communes, sans journal de changements ni copie des tableaux d’équilibrage.

## Règles de travail

- Répondre en français québécois, même si la demande est en anglais.
- TypeScript strict : jamais de `any`; valider les données externes avant de les utiliser, en partant de `unknown` au besoin.
- Respecter [`.editorconfig`](./.editorconfig) : UTF-8, fins de ligne LF, saut final, indentation et exceptions propres aux fichiers.
- Avant d’éditer, vérifier `git status` et le diff existant. Préserver les changements de l’utilisateur et limiter les modifications au mandat.
- Demander lorsqu’une ambiguïté change le comportement attendu ou la portée. Ne pas transformer une idée ou un ticket non approuvé en règle de jeu.
- Accompagner toute fonctionnalité de tests pertinents; pour une correction de bogue, ajouter un test de régression lorsque possible. Mettre à jour la documentation touchée.
- Ne modifier les fichiers de règles que sur demande explicite. Une demande visant `AGENTS.md` ne s’étend pas automatiquement aux compagnons.
- Une revue de code générale, même qualifiée d’« exhaustive », ne constitue pas une demande d’audit de sécurité spécialisé. Sans demande explicite, s’en tenir à la revue ciblée du diff, aux tests pertinents et à la validation normale. Si un risque concret justifie un scan spécialisé ou une analyse multi-agent susceptible de consommer beaucoup de ressources, l’expliquer et obtenir l’accord de l’utilisateur avant de la lancer.
- Utiliser `secureRandom` de `src/utils/random.ts`, jamais `Math.random`. Préserver les RNG injectés et l’ordre des tirages lorsqu’ils font partie du contrat testé.
- **Modern Web Guidance obligatoire (HTML / CSS / JS client)** : pour toute tâche touchant l’HTML, le CSS, le DOM, l’accessibilité, les formulaires, les modales/popovers, les thèmes/couleurs, les animations, la performance Web, la sécurité frontale ou les API navigateur côté client (y compris dans React), lire et appliquer **impérativement en premier** le [skill `modern-web-guidance`](./.agents/skills/modern-web-guidance/SKILL.md) (ou le plugin `modern-web-guidance` dans les environnements qui l’exposent) avant d’écrire ou de modifier du code. Suivre son flux complet (`search` → `retrieve`, ou consultation des guides locaux dans `.agents/skills/modern-web-guidance/guides/` en environnement hors ligne), vérifier la conformité et les replis *Baseline Widely available* requis (sans déroger au style rétro monospace ni aux contrats CSS/CSP du dépôt), et inclure en fin de réponse la section `### Modern Web Guidance` prescrite par le skill. Ne pas déclencher ce skill pour les tâches purement serveur (`worker/`), moteur/IA sans UI, CI/scripts ou modifications triviales.

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
| Diagnostic React | `npm run doctor` (base CLI; voir [Validation](#verification-checklist)) |
| Déployer le Worker | `npm run worker:deploy` |

Pour le multijoueur local, lancer le client **et** le Worker. Après une modification de `worker/src/game-room.ts`, redémarrer le Worker avant le test manuel. `worker/.wrangler/` contient l’état local ignoré par Git.

<a id="verification-checklist"></a>

## Validation

Avant de terminer une modification du code source ou de la configuration pouvant affecter le fonctionnement du projet, exécuter les validations suivantes dans cet ordre; une analyse, une revue ou une mise à jour de ticket ou de documentation seule ne nécessite pas cette batterie de validation :

1. `npm run lint`
2. `npm run build`
3. `npm run test`
4. `npx --yes react-doctor@latest --verbose --scope changed --blocking warning -y --no-score --no-supply-chain --max-duration 30`
5. `git diff --check`

Tous les contrôles doivent passer. Ne pas omettre React Doctor ni considérer un hook automatique comme un remplacement de cette étape; si le diagnostic ne trouve aucun fichier pertinent à analyser, rapporter ce résultat explicitement. Corriger les échecs liés au travail; signaler explicitement tout échec préexistant ou blocage sans élargir discrètement la portée. Rapporter les commandes réellement exécutées et leurs résultats; ne pas maintenir de nombre de tests figé ici.

React Doctor est obligatoire dans chaque batterie de validation, même si les changements ne touchent pas React. Le script `doctor` dans `package.json` doit conserver la commande polyvalente `npx react-doctor@latest` sans drapeaux, conformément à la [documentation officielle](https://www.react.doctor/docs/reference/cli-reference). Ce script minimal sert de base polyvalente pour toutes les sous-commandes (`rules explain`, `scan`, `design`, etc.) ainsi que pour les déploiements (`--scope full --blocking error`). Pour la batterie de validation obligatoire, la commande prescrite est la ligne complète avec ses drapeaux (directement ou via `npm --yes run doctor -- --verbose --scope changed --blocking warning -y --no-score --no-supply-chain --max-duration 30`). Le `--yes` de npm autorise l’installation du paquet sans invite, y compris lorsque le script lance npx. Le `-y` du scanner répond aux invites de React Doctor. `--no-score` et `--no-supply-chain` désactivent le score distant et la vérification Socket.dev.

Le budget initial est de 30 secondes. Si le rapport indique une analyse partielle ou des fichiers sautés à cause du délai, consigner la couverture et relancer avec un budget supérieur. Si la reprise reste partielle, déclarer la validation incomplète même avec un code de sortie 0. Signaler séparément le cas où aucun fichier n’est admissible.

Ne pas remplacer cette commande par le seul binaire local `react-doctor` ni figer la version du scanner sans demande explicite. L'Action GitHub conserve également `version: latest`. À la différence de la commande locale/sandbox, le workflow CI (`.github/workflows/react-doctor.yml`) utilise l'Action composite officielle `millionco/react-doctor@v2` dans un environnement non interactif disposant d'un accès réseau complet, nécessaire pour calculer le score, mettre à jour le statut de commit et publier les revues sur la PR (les drapeaux de bac à sable local ne s'y appliquent donc pas et ne font pas partie des entrées de l'Action). Toujours rapporter son statut, son score (ou mentionner qu'il est désactivé par `--no-score`) et ses diagnostics disponibles, y compris les avertissements. Appliquer le [skill react-doctor](./.agents/skills/react-doctor/SKILL.md). Consulter `.github/workflows/react-doctor.yml` : le diagnostic porte sur les changements et `blocking: warning` rend aussi les avertissements bloquants en développement et en CI. Les workflows de publication GitHub Pages/Release et les scripts de déploiement Cloudflare/staging utilisent plutôt `--blocking error` : les avertissements restent visibles sans bloquer la publication. Les erreurs et les échecs d'exécution de l'outil demeurent bloquants et doivent être rapportés. `knip.json` définit les points d’entrée de l’analyse de code inutilisé.

Si l’interface ou le moteur change, vérifier manuellement le parcours concerné : menu, partie, fin de manche, boutique et manche suivante. Pour le réseau, couvrir aussi les reconnexions et les reprises pertinentes. Si un contrôle manuel n’a pas été fait, le dire.

## Journaux et erreurs

- « Décisions IA » désigne les décisions des tanks contrôlés par le jeu. Les journaliser dans la console du navigateur uniquement en mode DEBUG/développement, avec assez de contexte pour comprendre le choix. Aucun journal de décision superflu en production.
- Pour les décisions EXPERT et conseiller, utiliser `writeDecisionConsole` : une seule chaîne par appel, résumé court et détails fragmentés avec `traceId`. Préserver les meilleurs candidats déjà calculés par cible et le motif de cible/repli, sans lancer de recherche pour un log. Tester la relecture par `Scripts/read-decision-console.mjs`; un fragment absent doit signaler un export incomplet. En endurance, garder ces mêmes motifs dans `ai-detail` / JSONL avec DEV faux et observateur actif; les consoles de décision restent réservées au développement.
- Côté Vite, utiliser `import.meta.env.DEV` pour protéger les traces de développement et leur calcul. Ne pas supposer qu’un drapeau global `DEBUG` existe.
- Journaliser les erreurs et exceptions avec le contexte utile et le niveau approprié : `console.error` pour les erreurs, `console.warn` pour les avertissements. Ne pas avaler silencieusement une exception ni exposer de secrets dans les journaux.
- Une erreur client va dans la console du navigateur; une erreur Worker va dans les journaux serveur. Afficher aussi un message compréhensible à l’utilisateur lorsqu’une action échoue.
- Attention à l’existant : `src/main.tsx` neutralise les méthodes de console autres que `console.error` en production, y compris `console.warn`. Ne pas compter sur un avertissement navigateur pour signaler une erreur de production.

## Architecture à préserver

| Couche | Responsabilités | Limites |
| --- | --- | --- |
| React (`src/App.tsx`, `src/components/`) | Phases, joueurs, argent, boutique, HUD et overlays | Aucun accès au contexte Canvas pendant le rendu; aucune donnée de simulation par frame dans `useState` |
| Moteur (`src/game/engine/`) | Physique, terrain, projectiles et dessin. L’audio de combat est délégué à `CombatAudio` | Aucun state React ni appel à `setState`; les décisions tactiques restent dans les stratégies IA |
| Domaines partagés (`src/game/online/`, `shop/`, `economy/`, `zeus/`) | Règles et contrats utilisés par le client et le serveur | Garder les calculs partagés indépendants du DOM et des API de plateforme |
| Worker (`worker/src/`) | Autorité réseau et persistance de `GameRoom` | Ne pas faire confiance aux snapshots et commandes clients sans validation |

- `GameEngine` utilise un pas physique fixe de `1/120 s`; `requestAnimationFrame` cadence le rendu selon l’écran. Injecter entrées et configuration par refs et méthodes reliées dans `useEffect`.
- L’audio de combat est délégué à `CombatAudio` dans `src/game/engine/audio/` (#413). Les tables de tir et d’impact sont exhaustives par `WeaponId`. Le guide d’ajout est dans le README.
- Le Canvas est démonté en `MENU`. `App.tsx` et `appReducer.ts` possèdent l’entrée/sortie de session; `GameCanvas.tsx` orchestre les phases internes définies dans `src/types/game.ts`.
- L’état du HUD vient des copies fournies par le moteur lors des mises à jour du tour. Garder le rendu Canvas2D, `VGA_PALETTE` et le style rétro monospace. Conserver le CSS du projet sans bibliothèque UI.
- Pour les commandes mobiles, le focus des dialogues, la veille d’écran et la suspension du dessin, consulter les composants concernés et leurs tests dans [src/components](./src/components/). La visibilité du Canvas commande la boucle de dessin indépendamment du pas physique.
- Conserver `'unsafe-inline'` dans `style-src` de `index.html` et `public/_headers`, comme l’exige `src/utils/__tests__/csp.test.ts` pour les styles du client actuel. Dans `connect-src`, ne pas réintroduire les schémas globaux `ws:` ou `wss:` nus; dans `public/_headers`, toute ligne de note doit être préfixée par `#` pour ne pas être interprétée comme un en-tête HTTP.

## Contrats sensibles

### Combat, terrain et économie

- Caractéristiques et prix : `src/types/weapon.ts` (`WEAPON_REGISTRY`). Matériaux et constantes : `src/types/terrain.ts` et `src/game/combatConstants.ts`. Consulter ces sources et leurs tests avant de modifier l’équilibrage.
- Distinguer dégâts directs, souffle et chute : l’amplification du bouclier sur un tir direct ne s’applique pas au surplus sur la santé; la chute contourne le bouclier. Voir `TankManager.ts` et ses tests de dégâts.
- Pour le creusement, l’affaissement et l’occlusion, consulter [Terrain.ts](./src/game/engine/Terrain.ts) et [ses tests](./src/game/engine/__tests__/Terrain.test.ts). Seuls NUKE et THERMONUCLEAR peuvent creuser ROCK en partie locale. Préserver les comportements propres à DRILLER, GRENADE et BULLDOZER.
- Un projectile en vol empêche les filets de sécurité locaux d’avancer le tour. Un lancement refusé ne consomme aucune munition. Voir les [filets de sécurité des tours locaux](./README.md#filets-de-sécurité-des-tours-locaux-358-v0122).
- Les gains passent par `src/game/economy/fixedPoint.ts` et `shotRewards.ts` : calcul rationnel, un seul arrondi final, argent entier sûr, aucun gain d’auto-dégât. Préserver l’application unique par tir et la distinction gain de manche / solde total.

### IA et boutique

- Les stratégies locales implémentent `AIEngine` et passent par `AIByProfileStrategy`. Conserver le chargement à la demande des profils et du solveur SIMPLE. Le combat IA du Worker suit son propre chemin.
- Le conseiller partage le planificateur EXPERT. Il travaille sur copies, à offset nul, sans muter la mémoire ni consommer le RNG du jeu. Vérifier que la situation est encore valide avant d’appliquer ensemble arme, angle et puissance, sans tirer.
- L’IA locale ignore les stocks nucléaires adverses, y compris après un tir observé. Préserver l’ordre des tirages, la mémoire par cible et par manche, ainsi que la consommation unique d’une réaction après perte réelle de PV ou de bouclier sur impact direct.
- Pour les choix d’armes, de cibles et de replis, consulter les sections [EXPERT](./README.md#décision-expert-locale-229-267-271-287-288) et [SNIPER](./README.md#décision-sniper-locale-289) ainsi que les [stratégies et leurs tests](./src/game/entities/ai/).
- Les achats IA passent par `autoBuyForAI`. Un profil inconnu utilise OK pour les achats et SIMPLE pour le combat local. Le mode armes gratuites s’applique au local et à l’endurance. Les quantités par profil et leur réapprovisionnement sont vérifiés dans [freeWeapons.test.ts](./src/game/shop/__tests__/freeWeapons.test.ts).
- En local, propager le roster immuable après achat vers `TankManager.setPlayers`, `shopPlayersRef.current` et `APPLY_LOCAL_SHOP_TRANSACTION`. La boutique humaine doit rester accessible aux manches suivantes.
- Les noms locaux sont uniques après `trim().toLowerCase()` indépendamment de la locale. Préserver les noms édités, l’absence de renommage rétroactif et leur stabilité après changement de langue. Voir `playerNameUi.ts` et ses tests.

### Endurance IA locale (#206)

- L’endurance utilise le moteur local. Le build public normal l’exclut. Le mode de build `endurance` l’active. Un onglet masqué interrompt la session. Installer la seed avant de construire le moteur et restaurer le RNG précédent au nettoyage.
- Séparer l’observation de la physique et les transactions économiques. Conserver les octets du journal et des captures ainsi que les attestations de récupération. Signaler une vue dérivée incomplète. Une perte de données sources invalide le verdict.
- Pour modifier les scénarios, la collecte, les exports ou la récupération, suivre le [guide du pilote](./Scripts/endurance/README.md), y compris les tests Python et le parcours Chromium documentés.

### Diagnostics et rejeu de tirs locaux (#373, v0.13.3)

- `src/game/diagnostics/` possède les captures, archives versionnées, validation, export et rejeu isolé. Capturer aux frontières métier, jamais au rendu React ni par frame. L’activation est limitée à DEV local et au build explicite endurance; aucun changement réseau, politique IA, solveur ou RNG de jeu.
- Capturer la décision avant mutation de la mémoire et le tir avant consommation. Seul `shot-launched` confirme le lancement. Réutiliser les calculs existants et préserver le RNG du jeu.
- Valider les archives depuis `unknown`. Le rejeu original exige la bande de tirages physiques enregistrée. Une commande alternative utilise la valeur fixe 0,5. Distinguer capture incomplète, divergence physique et divergence économique.
- Pour les budgets, l’export progressif et la CLI, consulter le [guide des archives et du rejeu](./README.md#archives-de-diagnostic-et-rejeu-local--local-shot-diagnostics-373-v0133). Documenter les parcours et les commandes en français et en anglais.

### Multijoueur et déploiement

- Participation en ligne (#321) : `onlineParticipation.ts` valide les invitations et persiste séparément le lobby versionné dans `sessionStorage` (nom, état de jonction, invitations hôte). Capturer avant de nettoyer uniquement `room`/`slot`/`token`, hors rendu React; préserver les autres paramètres, le fragment et `history.state`. Une invitation explicite prévaut sur une sauvegarde incompatible; sans invitation, reprendre le combat valide avant le lobby. Ne pas connecter un formulaire non engagé ni recréer une salle restaurée. Conserver le lobby jusqu’à la première sauvegarde de combat réussie; purger les deux sauvegardes au départ volontaire et à la fin de partie. Le build local seulement ne restaure aucun réseau. Signaler les échecs de stockage/nettoyage sans secret; garder l’URL valide si sa capture échoue, sans jamais injecter le jeton hôte dans l’adresse. Le Worker utilise `tokenComparison.ts` et la primitive Cloudflare, y compris un appel sur deux tampons identiques en cas de longueurs UTF-8 différentes, toujours refusées. Vérifier aussi la primitive réelle avec `node Scripts/test-online-token-comparison.mjs` et un Worker local démarré; les doubles Node ne prouvent pas sa disponibilité.
- La physique demeure locale. `GameRoom` possède l’ordre des tours, l’acceptation et la consommation des tirs, l’application des gains, la boutique et Zeus. L’autorité cliente des rapports de gains peut changer après déconnexion; préserver son ordre de relève.
- Le combat IA serveur passe actuellement par `maybeRunAIServerTurn` et une `fakeCommand`; il n’exécute pas les stratégies locales. Ne pas présenter une amélioration locale comme une amélioration de l’IA en ligne.
- `src/game/online/protocol.ts` centralise versions, gardes et bornes `FIRE_COMMAND_*` (`src/utils/onlineSession.ts` réutilise directement son garde `isFireRejectedReason`, y compris `ZEUS_TURN`). Le protocole courant et minimal est v4 : rejeter les anciens clients et exiger `NEW_GAME_REQUIRED` pour une salle commencée sans schéma de combat v4. Préserver la validation en profondeur du Worker : vérification stricte du nombre de segments d’URL sur `/api/rooms/:roomId/join` et `/api/rooms/:roomId/ws` avant toute résolution de Durable Object, application de `RATE_LIMITER` sur `POST /api/rooms` et `POST /api/rooms/:roomId/join`, et restriction de `fetchCreate` aux seules requêtes `POST` internes (`/internal/create` ou `/create`) hors upgrade WebSocket.
- `FIRE` est une intention : aucun projectile ni décrément avant `SHOT`, rejoué par tous les clients. Seul le tireur humain émet `SHOT_SETTLED`; un client ne tire pas à la place d’une IA. Un refus reste visible sans bloquer l’interface.
- Boutique : le Worker décide des transactions et exécute les achats IA une seule fois par époque. Un snapshot client v1 n’est pas une source d’autorité. Respecter les contrats v4, les clés `kind:slot:actionId`, l’ack `{ slot, actionId }` et le même identifiant au retry.
- Préserver la persistance avant diffusion, les gains/morts appliqués atomiquement, l’idempotence et l’historique de tirs borné à la manche. La file de reprise et les transitions différées maintiennent l’ordre `ROUND_END` → `SHOP_STATE` → `SHOP_FINISH`; un état boutique tardif ne rouvre pas une boutique terminée.
- Combat v4 : fiches complètes validées avant mutation, argent reçu ignoré, copie réseau des morts à PV zéro; résultats exacts et cumuls gardés jusqu’à la manche suivante, avec révision économique monotone. Journal/résultats/actions en entrées distinctes et transactions atomiques. Rattrapage complet fragmenté sous 64 Kio JSON UTF-8; garder le verrou jusqu’au lot et au rejeu complets. Le `physicsSeed` autoritaire isole les tirages physiques CLUSTER/GRENADE sans changer le RNG global; aucun second décrément au rejeu.
- Lors d’un déploiement multijoueur, publier le Worker avant le client, vérifier `/api/health` contre les versions attendues du protocole, puis construire/publier le client. Garder l’auto-déploiement de production Cloudflare Pages désactivé pour préserver cet ordre.
- Distinguer Cloudflare Pages du workflow GitHub Pages `.github/workflows/deploy.yml`, déclenché par un push sur `main`. Vérifier les workflows concernés avant toute publication; une commande de déploiement listée ici n’est pas une demande de déployer.

## Où intervenir

Les chemins ci-dessous sont relatifs à la racine du dépôt. Chercher les tests voisins dans `__tests__/`.

| Besoin | Points d’entrée |
| --- | --- |
| Phases et session React | `src/App.tsx`, `src/appReducer.ts`, `src/components/GameCanvas.tsx`, `src/components/useGameSession.ts` |
| État des tanks en visée | `src/components/PlayerStatusList.tsx`, `src/components/playerStatus.ts`, `src/components/weaponShortLabel.ts` |
| Physique, tours, terrain | `src/game/engine/` (`GameEngine.ts`, `PhysicsEngine.ts`, `projectileMotion.ts`, `bulldozerImpact.ts`, `TurnManager.ts`, `Terrain.ts`), `src/game/entities/TankManager.ts` |
| Audio de combat | `src/game/engine/audio/` (`CombatAudio.ts`, familles de sons, instantanés de graphe) |
| Armes, matériaux, rendu | `src/types/weapon.ts`, `src/types/terrain.ts`, `src/game/combatConstants.ts`, `src/game/rendering/tankSprite.ts` |
| IA, visée et achats IA | `src/game/entities/ai/` (stratégies, tactiques, `BallisticsSimulator.ts`, `bulldozerThreat.ts`, `physicalShotForecast.ts`, `aiShopHelper.ts` et tests) |
| Endurance IA locale | `src/game/endurance/`, `src/components/endurance/`, observation additive du moteur et orchestration dans `useGameSession.ts` |
| Conseiller de tir local | `src/game/entities/ai/shotAdvisor.ts`, `shotAdvisor.worker.ts`, `expertPolicy.ts`, `src/components/advisor/`, `TurnManager.captureAdvisorState` / `applyAdvisorCommand` |
| Boutique et gains | `src/game/shop/`, `src/components/shop/`, `src/game/economy/`, `src/components/ShotEarningsOverlay.tsx`, `src/components/RoundSummary.tsx` |
| Menu, noms, traduction | `src/components/MainMenu.tsx`, `src/components/playerNameUi.ts`, `src/components/playerControllerUi.ts`, `src/components/usePlayerNameValidation.ts`, `src/locales/` |
| Lobby | `src/components/OnlineLobby.tsx`, `src/components/useOnlineLobby.ts`, `worker/src/index.ts` |
| Combat réseau et reconnexion | `src/components/online/`, `src/utils/onlineSession.ts`, `src/game/online/`, `worker/src/game-room.ts` |
| Zeus (action spéciale) | [Domaine et tests](./src/game/zeus/), [règles et reprise réseau](./README.md#zeus-et-reprise-réseau-v4-269-184) |
| Build, CI et déploiements | `package.json`, `tsconfig.json`, `worker/tsconfig.json`, `worker/wrangler.toml`, `.github/workflows/` |

## Commits et compte rendu

- Message de commit à l’impératif, signé avec le nom de l’application utilisée, l’identité de l’agent et son modèle exact fourni par l’environnement. Ne pas copier la signature d’un autre agent ni inventer une version.
- Le compte rendu indique ce qui a changé, pourquoi, les validations effectuées et les limites restantes. Distinguer modifications locales, commit, push, PR et déploiement; ne déclarer une publication qu’après vérification.

## Gestion des pull requests

### Pull requests créées par Google Labs Jules (Consignes pour agents tiers)

Avant toute interaction ou écriture sur une pull request existante par un agent IA, inspecter rigoureusement ses métadonnées GitHub :
`gh pr view <id> --json author,body,commits`

Traiter la pull request comme créée par **Google Labs Jules** si au moins un des critères suivants est satisfait :
- `author.login` appartient à `{google-labs-jules, google-labs-jules[bot]}`.
- Le corps (`body`) contient une ligne exactement égale à la signature de création automatique `PR created automatically by Jules`.
- L’un des commits a pour auteur ou co-auteur Jules (`google-labs-jules` ou `google-labs-jules[bot]`).

Ne jamais se fier uniquement au nom de la branche locale ou distante pour conclure qu’il s’agit ou non d’une PR Jules.

Si la pull request est identifiée comme émanant de Jules et que l’agent intervenant **n’est pas Jules lui-même** (agent tiers : Antigravity, Copilot, Claude, etc.) :

- **Interdiction absolue d’ajouter des commentaires ou revues** : Ne publier aucun commentaire général, commentaire de revue, commentaire en ligne sur le diff, réponse à un fil de discussion ou revue GitHub (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`), même vide, afin de ne pas réveiller ni désynchroniser Jules.
- **Aucune notification active** : Ne jamais mentionner `@google-labs-jules` ou `@google-labs-jules[bot]` dans les descriptions de PR ou les messages de commit (utiliser des backticks si le nom doit être cité).
- **Communication par la description uniquement** : Pour consigner les modifications apportées, mettre à jour uniquement le corps/description de la PR (ex. `gh pr edit <id> --body ...`), en préservant scrupuleusement le contenu utile initial et en ajoutant une section distincte au bas (ex. `### Modifications apportées`).
- **Commits et poussées autorisés** : Les commits et les poussées (`git push`) sur la branche de la PR demeurent permis lorsqu’ils sont demandés.
- **Priorité de la règle** : Cette directive prévaut sur toute routine de revue, skill (notamment `code-review-skill`) ou commande automatisée qui génère habituellement des commentaires de PR.
- **Vérification obligatoire** : Toujours inspecter l’état réel de la pull request sur GitHub avant d’agir, et vérifier après publication qu’aucun commentaire n’a été créé par mégarde.
- **Exception pour Jules** : L’agent Jules lui-même demeure pleinement autorisé à publier des commentaires sur ses propres pull requests (notamment pour expliquer son travail, réagir aux échecs de la CI ou clore ses tâches).
