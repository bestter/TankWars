# Validation du ticket #373 — v0.13.3

Date : 3 novembre 2026. Application : Codex. Agent et modèle : GPT-6.

## Portée et environnement

Validation locale sous Windows, Node.js 25.6.1 et navigateur Chromium intégré. La CI utilise Node.js 24. Le moteur est rendu à vitesse normale, au pas physique de 1/120 s. Aucun déploiement, changement réseau ou Worker Cloudflare, ni fusion de PR.

La base est `15134da52147814cf8ca5be94a7a6f5700fc9f1d`. Les archives indiquent cette base avec le suffixe `dirty` et l’heure du build; elles ont été produites avant le commit de livraison. Les données brutes et scripts ponctuels de mesure restent dans `artifacts/diagnostics-373/`, ignoré par Git.

## Batterie automatisée

Exécution dans cet ordre, après la dernière modification du code :

| Commande | Résultat |
| --- | --- |
| `npm run lint` | Réussi |
| `npm run build` | Réussi, types client et Worker vérifiés |
| `npm run test` | 2 206 tests réussis, 139 fichiers |
| `npm run doctor -- --verbose --scope changed --blocking warning` | 100/100, 39 fichiers analysés, aucun diagnostic ni avertissement |
| `git diff --check` | Réussi |
| `npm run build -- --mode endurance --outDir artifacts/diagnostics-373/endurance-release` | Réussi |

Vite signale un chunk dépassant 500 Ko et Node émet l’avertissement `--localstorage-file` sans chemin valide pendant Vitest. Aucun échec de test ni diagnostic React Doctor n’en découle. L’installation et les exécutions Vite ont nécessité l’accès hors bac à sable pour leurs caches temporaires Windows; les résultats rapportés sont ceux des exécutions terminées.

Les régressions couvrent le MISSILE de repli réel du SNIPER avec auto-dégâts, mutation ultérieure du terrain et export tardif; la copie de l’archive reste identique après une alternative. Elles comparent moteur et rejeu pour les huit armes, dont les rebonds GRENADE sur ROCK, CLUSTER, BULLDOZER, DRILLER et nucléaires locaux sur ROCK. La collecte activée/désactivée conserve les décisions, tirages et résultats des quatre profils. Le conseiller avec DEV faux ne change pas sa recommandation quand ses propositions sont observées.

Sont aussi vérifiés : sorties sans cible, refus avant lancement, délai et identité de repli, interruption, frontières de manche/bloc, schémas et dépendances invalides, suppression d’événement, bande physique épuisée/désalignée/surnuméraire, divergence économique distincte, simulation incomplète, budget insuffisant avant admission, clôture du dernier tir, quota simulé, réouverture, export figé, plages ouvertes sans tir et pagination de métadonnées sans lecture complète.

## Parcours navigateur

DEV et build endurance avec DEV faux : configuration locale, conseil calculé puis appliqué, tir humain, résolution, résumé, boutique et manche suivante; export après les tirs, capture courante et signalement manuel. Le build privé final a produit deux tirs humain/EXPERT, 52 événements et trois terrains, exportés en 158 087 octets. Le lecteur a rejoué les deux sans divergence physique ni économique. Une alternative MISSILE à 70°/40 utilise le RNG fixe annoncé à 0,5.

Pendant l’endurance finale, un export filtré en combat a conservé un tir résolu avec ses deux terrains : 56 289 octets, 19 événements, aucun écart au rejeu. Après les premières évictions de la vue mémoire, la recherche du tout premier tir depuis IndexedDB a produit un autre export autonome de 54 568 octets et 15 événements, également rejoué sans divergence. Les séquences supérieures figées étaient respectivement 1 514 et 3 671; les tirs courants ont continué pendant ces lectures.

Le build public normal a été inspecté après compilation : les marqueurs `tankwars-shot-archive`, `ARCHIVE_ADMISSION_BACKPRESSURE`, `diagnostic-panel` et `archive-manifest` sont absents de tous ses fichiers JavaScript. Son menu et son combat ont aussi été ouverts au navigateur : aucun panneau de diagnostic ni entrée endurance. Les modules de collecte et le panneau restent réservés à DEV/endurance. `CLAUDE.md` conserve son renvoi unique vers `AGENTS.md`; Copilot référence le contrat commun.

## Mesures de conservation

Les 32 scénarios de calibration combinent les quatre profils, DIRT/SOFT/ROCK/mélange, vents −30/+30, quatre joueurs et stocks d’armes gratuites. La plus grosse observation de décision sérialisée mesure 158 292 octets; la capture la plus lente de cette matrice prend 9,62 ms. Cette matrice mesure les diagnostics des décisions; le maximum d’action complet ci-dessous inclut aussi lancement, résolution et écritures journalisées.

La réserve minimale de 8 Mio par action, avec 2 Mio de clôture supplémentaires, dépasse deux fois les maxima mesurés. Elle augmente automatiquement si une action plus grosse est observée. La file reste bornée en nombre et en octets, écritures en vol comprises. La lecture paginée ne conserve que 20 métadonnées visibles; l’export complet assemble explicitement le document demandé en mémoire.

Les tailles budgétées sont une estimation conservatrice des données sérialisées, incluant la duplication des captures dans le journal et les marges par entrée. La taille du JSON exporté mesure des octets de contenu confirmé; elle ne mesure pas l’occupation physique IndexedDB sur disque. Le tas JavaScript ne mesure pas toute la RAM du processus navigateur. Au premier relevé de la dernière session, le système indiquait 6 232 518 656 octets de RAM disponible sur 34 111 709 184.

## Essais rendus de 30 minutes

Un premier essai de contrôle avec projectile initial archivé a terminé 19 manches et neuf blocs complets, plus un bloc partiel, sans abandon. Son archive confirmée contient 382 tirs résolus, 9 428 événements et 357 terrains, soit 17 269 276 octets. Les 382 tirs ont été rejoués hors ligne : aucune divergence physique ni économique. La clôture confirme 17 292/17 292 entrées journalisées. Le budget conservateur atteint 86 192 928 octets; le maximum d’action mesure 1 217 106 octets. Le tas observé à l’arrêt mesure 25 478 230 octets et l’export prend 829 ms. Cet essai précède l’enrichissement des propositions EXPERT et les lectures paginées.

La session finale, avec les propositions EXPERT complètes et les lectures paginées, porte l’identifiant `68f06d23-359b-4c09-bb7d-9bab2717a65e`. Le build de capture est `15134da52147814cf8ca5be94a7a6f5700fc9f1d-dirty/2026-11-03T15:53:11.299Z`. Le dernier correctif des plages ouvertes concerne l’export; il est couvert par la batterie ci-dessus et par le build de livraison utilisé pour récupérer ces données après rechargement.

| Mesure finale | Valeur |
| --- | --- |
| Durée rendue | 1 800 015,9 ms, arrêt normal `duration` |
| Progression | 18 manches terminées, neuf blocs complets, dixième interrompu à la limite; aucun abandon |
| Tirs | 375 lancés, 374 résolus; dernier tir explicitement interrompu |
| Archive confirmée | 9 072 événements, 338 terrains, séquences 1–9 072 |
| Journal | 16 616/16 616 entrées confirmées, complet, aucune erreur; file finale à zéro |
| Fichier d’archive | 31 466 498 octets |
| Données persistées sérialisées | Journal 53 686 124 + captures 25 387 973 + terrains 6 779 345 = 85 853 442 octets, hors checkpoints et surcoût physique IndexedDB |
| Budget conservateur | 127 553 781 / 536 870 912 octets |
| Débit moyen | 47 696 octets persistés sérialisés/s et 5,04 événements de capture/s |
| Vue récente en RAM | 11 063 309 octets; 5 981 événements évincés de cette vue, aucun de l’archive persistée |
| Capture | 5 327 ms cumulées, moyenne 0,587 ms, maximum 29,5 ms |
| Maximum d’action budgété | 1 866 039 octets |
| Réserve d’action / clôture | 8 388 608 / 2 097 152 octets; deux fois le maximum plus 2 Mio = 5 829 230, sous la réserve d’action |
| Assemblage et validation de l’export complet | 2 833,9 ms, hors téléchargement du fichier |
| Tas JavaScript observé | 37 473 434 octets à l’arrêt; 128 830 021 après l’export complet |
| RAM système disponible | 6 232 518 656 octets au premier relevé, 5 198 606 336 au relevé intermédiaire, 5 137 911 808 après export |

La capture courante demandée pendant la résolution GRENADE porte bien `inProgress: true` à la séquence 7 546. Après rechargement dans le build de livraison, l’interface retrouve la session confirmée et son export est structurellement identique à celui obtenu avant rechargement, intégrité `9602d05eb3c65dfc`, sans reprise du combat. Le SHA-256 du fichier initial est `bb298d9e5f1d4e67f08873efcc3d03f981f9913a13b1e3f7cbca4ef96adac31e`.

Les 374 tirs résolus ont été rejoués après validation de l’archive complète, chacun depuis son export autonome : aucune divergence physique ni économique. Le dernier tir interrompu est signalé séparément. Un tir CLUSTER a révélé deux différences de dernier bit dans la trigonométrie Chromium/Node : le lecteur final restaure ces états de séparation déjà archivés, après validation exacte des identités, tirages, ordre et dispersion et une borne de `4 * Number.EPSILON` sur les valeurs dérivées. Aucun RNG de secours ni tolérance sur les impacts/résultats finaux. Deux régressions couvrent cette restauration et le rejet d’une modification dépassant la borne. Cette correction concerne le lecteur; elle ne change ni le moteur réel ni les données des 30 minutes.

## Suivi de lisibilité — 3 novembre 2026

Le README ajoute un démarrage rapide FR/EN avec les commandes exactes de build endurance et d’aperçu, l’adresse locale, l’entrée du menu et les limites de rejeu. Le panneau ajoute des bandeaux jaunes accessibles pour la dernière capture lue en cours et l’archive partielle, ainsi que des badges traduits pour les tirs en cours, interrompus/incomplets ou résolus. Les métadonnées endurance attendent la confirmation des captures demandées avant de présenter leur état; la pagination ne charge toujours pas l’archive complète.

Après ces changements : `npm run lint`, `npm run build`, `npm run test` (**2 209 tests, 139 fichiers**), `npm run doctor -- --verbose --scope changed --blocking warning` (**100/100, 39 fichiers, aucun diagnostic**) et `git diff --check` passent dans cet ordre. Le build endurance réussit ensuite. Les 49 tests ciblés du panneau et des archives passent également; ils couvrent la capture sans tir, la confirmation immédiate des métadonnées, les avertissements et leur retrait après résolution.

Au navigateur DEV, le bandeau en cours apparaît pendant un tir humain, puis disparaît après résolution et rafraîchissement; les deux tirs affichés passent à « RÉSOLU ». Dans le build endurance avec DEV faux, le contrôle ciblé `f60f2b92-86ec-4b4d-a9f4-f8efe2e1ed61` confirme les mêmes bandeaux, puis le badge « INTERROMPU — INCOMPLET » après un arrêt manuel. Le journal est complet à 304/304; le bandeau d’archive partielle disparaît tandis que l’état de capture en mouvement reste signalé. Ce suivi ne répète pas les parcours complets résumé/boutique/manche suivante ni l’essai de 30 minutes déjà documentés ci-dessus.

## Limites

Ces preuves concernent le moteur local, les quatre profils locaux et le conseiller. Elles ne couvrent pas l’IA serveur, le réseau, une reprise de combat après crash ou un rejeu déterministe de toute une partie. Les empreintes détectent une altération accidentelle; elles ne constituent pas une signature cryptographique. Les anciennes archives sans projectile initial annoncent leur reconstruction de commande, susceptible de différer de quelques unités de dernier chiffre entre moteurs JavaScript. Une alternative plafonnée à 2 400 pas demeure explicitement incomplète.

Signé : GPT-6 — Codex.
