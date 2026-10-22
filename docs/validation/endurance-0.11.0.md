# Validation du mode endurance — 0.11.0

## Environnement et build

- Dates : 20 et 21 octobre 2026, fuseau America/Toronto.
- Windows, Node.js local v25.6.1; la CI utilise Node.js 24.
- Navigateur intégré Chromium de Codex, build de production servi localement par `npm run preview -- --host 127.0.0.1 --port 4173`.
- Build mesuré : `5a6e9538ac61bd3b80da46d80b7fb14520c7e8bb-dirty/2026-10-20T20:13:13.346Z`.
- Les mesures ont précédé la publication de la branche; aucun changement du Worker. Le build Apache a été déployé séparément par l’utilisateur; le présent agent le conserve tel quel.

## Validation automatisée

La batterie finale a été exécutée dans l’ordre prescrit :

| Contrôle | Résultat |
| --- | --- |
| `npm run lint` | Réussi |
| `npm run build` | Réussi, types client et Worker inclus |
| `npm run test` | 112 fichiers, 1 842 tests réussis |
| `npm run doctor -- --verbose --scope changed --blocking warning` | 100/100, aucun diagnostic sur les 38 fichiers analysés |
| `git diff --check` | Réussi |

Une analyse React Doctor supplémentaire avec `--scope full --blocking warning` a aussi réussi : 254 fichiers, 100/100, aucun diagnostic. Cette analyse couvre notamment les nouveaux fichiers non suivis par Git, absents de la sélection `changed`.

La batterie a été répétée avant publication, après inclusion des modifications réalisées depuis VS Code : utilitaire UUID Web Crypto compatible HTTP/LAN, son utilisation pour les identifiants locaux et les actions client, et ses trois tests. La sélection `changed` inclut alors les nouveaux fichiers préparés dans l’index Git. Les versions des dépendances et les fichiers compagnons de règles restent inchangés.

La batterie a ensuite été répétée pour la restriction aux builds de test. Le build public normal ne produit aucun chunk `EnduranceScreen` et ses bundles ne contiennent pas le nom de la base IndexedDB dédiée. Le build explicite `npm run build -- --mode endurance` contient le module et permet d’ouvrir sa configuration. Les deux menus ont été vérifiés dans le navigateur. Les tests confirment l’absence des événements analytiques `game_start` et `round_end` pendant deux manches d’endurance, ainsi que leur maintien pour une partie ordinaire. L’essai prolongé utilise toujours son build antérieur; aucun redéploiement ne l’interrompt.

Les tests ont été repris avec l’accès approprié après un refus Windows `EPERM` sur les fichiers temporaires Vitest. Les avertissements jsdom concernant Canvas et l’avertissement Node `--localstorage-file` n’ont pas fait échouer la suite. Vite signale un chunk principal supérieur à 500 Ko; le mode endurance et les stratégies avancées restent chargés à la demande.

Les scénarios ajoutés couvrent configuration figée, limites, transitions, abandon/reprise, arrêt, décisions tardives, annulation après import différé, protection du tour suivant, préparation échouée, erreurs de conservation/nettoyage, historique borné, métriques physiques et neutralité des tirages sur les quatre profils. Le montage/nettoyage StrictMode et le parcours réel des boutiques sont couverts par des tests d’intégration.

## Parcours manuels

Le menu et le pied de page 0.11.0 ont été vérifiés. Une partie locale ordinaire avec EXPERT et SIMPLE a traversé combat, fin de manche, résumé, boutique entièrement IA et manche suivante; les munitions achetées étaient visibles dans le HUD suivant.

Un essai préliminaire rendu a complété un bloc de deux manches puis lancé le bloc suivant automatiquement. L’arrêt manuel a produit deux blocs tentés, un complété et un interrompu, sans abandon. Le dernier état sauvegardé était ensuite proposé dans la configuration après rechargement.

## Essai prolongé

- Session : `27ffc2d7-ccd4-4bdf-8970-2b80e54daf50`.
- Début : `2026-10-20T20:24:34.688Z` (16 h 24, heure de Toronto).
- Configuration : quatre IA distinctes SIMPLE/OK/SNIPER/EXPERT, deux manches par bloc, durée maximale de 240 minutes, sans plafond de blocs, poursuite après abandon.
- Watchdogs : 1 000 tours, 1 800 000 ms par manche de combat, 120 000 ms par action, 30 000 ms par transition.
- Paramètres physiques : 800 × 480, gravité 260, vitesse de base 420, mode local et inventaires initiaux normaux.
- Rendu et vitesse normaux, onglet actif. Aucun rechargement à chaud pendant cette mesure.

**État de cet essai Windows : incomplet; il ne valide pas quatre heures continues.** Le résultat de l’essai Linux distinct figure plus bas.

Le dernier point de contrôle exporté contient 6 988 004,8 ms (environ 1 h 56 min), 21 blocs tentés, 19 complétés, un abandonné et un encore en cours, ainsi que 40 manches commencées et 38 terminées. Les manches terminées totalisent 981 tirs lancés et résolus, dont 424 avec effet offensif. Les exports JSON et Markdown concordent; le schéma v1, les seeds uint32, le roster entièrement IA et les sommes des agrégats ont été vérifiés. Le JSON porte l’empreinte SHA256 `32f5184d889ab55712025309b333c5255b6d3a9f2890165a8493b3bf7026ed83`.

Un incident de limite `roundMs` a abandonné le bloc 20 après une longue absence de progression (2 649 469,1 ms observées, manche 1, tour 1, seed 3261618337). La cause de cette absence n’est pas établie. Aucun incident d’exception ou d’invariant n’est enregistré; le bloc 21 a ensuite démarré. L’export récupéré conserve `collection: incomplete` et `reason: crash-checkpoint`; le temps mural écoulé ne prouve pas quatre heures de rendu continu.

## Exécution autonome sur Linux

Un navigateur Chromium installé dans un environnement Python/Playwright isolé teste le build déjà servi par Apache sur un serveur de validation. Aucune dépendance du projet ni configuration Apache n’est changée. Les coordonnées du serveur, les comptes et les chemins propres à cet environnement sont conservés uniquement dans les consignes opérationnelles privées.

Le pilote utilise Chromium 156.0.8078.4, le bac à sable activé et le mode headless moderne avec rendu Canvas réel. Il pilote uniquement l’interface publique, sans avancer l’horloge ni modifier les règles ou le RNG. La page voit `document.visibilityState === "visible"`. Aucune récupération après redémarrage, veille ou gel complet n’est promise.

Un essai préparatoire d’une minute sur l’URL loopback s’est arrêté sur `duration` à 60 020,8 ms, sans incident ni erreur de stockage. Les exports JSON/Markdown, les compteurs et l’empreinte de l’index avant/après concordent. Le service worker à chemin racine renvoie un 404 sur cette URL; l’essai principal utilise l’URL LAN demandée, où l’enregistrement du service worker n’est pas disponible en HTTP non sécurisé.

Le pilote écrit `status.json`, `latest.json`, `latest.md`, `latest.png`, `browser.jsonl` et, après un arrêt normal, `summary.md`. Les exports sont pris après 15 secondes, toutes les cinq minutes et à la fin; le journal de progression est mis à jour chaque minute. Le processus autonome est détaché de SSH et borné à 4 h 15 min. Il ne fait appel à aucun modèle pendant son exécution.

Le second essai préparatoire, sur l’URL LAN, s’est arrêté à 60 022,8 ms avec des exports cohérents et sans incident ou erreur navigateur. L’essai de quatre heures a démarré le 20 octobre à 20 h 59 (Toronto), avec le build `5a6e9538ac61bd3b80da46d80b7fb14520c7e8bb-dirty/2026-10-21T00:51:25.176Z`. Le superviseur possède une session distincte et reste actif après déconnexion SSH. La fin normale a eu lieu à 0 h 59 le 21 octobre.

`state: completed` indique que les contrôles automatiques de durée, d’arrêt et de cohérence ont réussi; les incidents et les captures doivent encore être examinés. `state: failed` expose l’erreur. Le navigateur se ferme à la fin. Le serveur doit rester éveillé : la demande de verrou de veille par `systemd-inhibit` a été refusée au compte SSH et aucun réglage système n’a été modifié.

## Résultat vérifié des quatre heures sur Linux

**L’essai de quatre heures avec rendu à vitesse normale est réussi pour le build mesuré ci-dessus.** Les exports, le journal et la capture finale ont été récupérés et vérifiés le 21 octobre. La simulation utilise le Canvas réel dans Chromium headless moderne, sans accélération d’horloge; le superviseur est indépendant du clavardage.

| Observation | Résultat |
| --- | --- |
| Session | `0d342dd7-758c-4e35-a203-20ba23d94aeb` |
| Début du jeu | `2026-10-21T00:59:28.996Z` |
| Durée mesurée par le jeu | 14 400 014,8 ms (4 h) |
| Fin du pilote et des exports | `2026-10-21T04:59:30.282798Z` |
| État / motif / collecte | `stopped` / `duration` / `complete` |
| Blocs tentés / complétés / abandonnés / interrompus | 64 / 63 / 0 / 1 |
| Manches commencées / terminées | 128 / 127 |
| Incidents / erreurs de stockage | 0 / aucune |
| Tirs lancés et résolus dans les manches terminées | 3 280 / 3 280 |
| Tirs avec effet offensif dans les manches terminées | 1 418 |
| Actions Zeus observées | 7 |

Le bloc interrompu correspond à l’atteinte normale des quatre heures, sans abandon ni défaite attribuée. Sa seconde manche conserve des observations partielles distinctes : trois tirs lancés, deux résolus au moment de l’arrêt. Les manches terminées comprennent des tirs MISSILE, GRENADE, BULLET, DRILLER, NUKE et CLUSTER; BULLDOZER, THERMONUCLEAR et les matchs nuls n’ont pas été observés pendant cette exécution. Leur couverture repose sur les tests automatisés indiqués plus haut, pas sur cet essai réel.

La vérification indépendante confirme les nombres de blocs et de manches, les seeds uint32, les quatre profils entièrement IA, les plafonds de tours et l’égalité des agrégats avec la somme des manches, séparément pour les résultats complets et partiels. Le JSON et le Markdown concordent avec la capture finale. L’empreinte SHA256 du JSON final est `84019b1c60b05f286213fd0ae1f599b9b7fb710ab3c279474249095e151d702c`. Les données brutes et les renseignements opérationnels privés restent hors du dépôt.

Les 289 entrées du journal couvrent toute l’exécution, sans état d’échec et avec un intervalle maximal de 60,834 secondes entre entrées. L’index servi possède la même empreinte au début et à la fin. Aucun message d’erreur navigateur n’a été journalisé; les processus du pilote et du superviseur sont terminés lors de la vérification. La capture finale montre l’arrêt sur durée et la sauvegarde complète. Cela confirme le parcours prolongé observé, sans constituer une mesure de chaque frame ni une garantie de performance sur tous les appareils.

L’essai utilise le build préparé avant les commits publiés et avant la restriction du menu aux builds de test et la suppression des événements analytiques d’endurance. Ces dernières modifications sont vérifiées séparément par les builds, les parcours de menu et les 1 842 tests; elles n’ont pas fait l’objet d’un nouvel essai de quatre heures. Aucun replay déterministe ni test multijoueur n’est revendiqué.

## Limites d’interprétation

Une suite de tests réussie et un court parcours avec rendu ne remplacent pas l’essai de quatre heures. La seed ne garantit pas un replay identique. Les observations partielles et les interruptions ne constituent pas des défaites; les blocs suspects ne sont pas une catégorie terminale additionnelle. Le gel complet de JavaScript, le crash du navigateur et la veille ne sont pas récupérés par le watchdog de la page. Aucun parcours réseau n’a été modifié ou validé manuellement dans ce mandat local.

Codex — GPT-6
