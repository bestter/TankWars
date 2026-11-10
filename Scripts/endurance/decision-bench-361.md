# Banc de décisions EXPERT — #361

Ce banc s’exécute hors navigateur et hors endurance. Il recharge cinq états de la campagne `endurance-20261109-mirror-2h` dans le vrai `AISmartStrategy`, son planificateur, son solveur et `resolvePhysicalShot`. Aucun de ces modules n’est remplacé par un résultat fictif. Depuis v0.14.1, les tirs propres d’EXPERT local prolongent les vols encore ouverts de 420 à 600 pas.

## Données conservées

Les fixtures versionnées sont dans `src/game/entities/ai/__tests__/fixtures/issue361/`. Elles ne dépendent pas de la présence d’`artifacts/` en CI. Chaque JSON contient l’archive du tir avec ses terrains et ses empreintes natives, l’état initial de décision, la mémoire, les commandes historiques et un certificat physique lorsqu’il existe. Les SHA-256 des fichiers sources `shot.json` et `decision.json` sont conservés pour retrouver leur provenance; ce sont des empreintes des fichiers originaux, pas du JSON reformaté de la fixture.

| Fixture | Clé native | Certificat MISSILE |
| --- | --- | --- |
| `a-to-d-99` | `664178dd-7b10-440c-b1c0-b5cf9bd9f370:2:26` | 69,7° / 99 |
| `d-to-a-99` | `15dc692d-11f7-47e4-ae61-72201e4fe83c:19:251` | 110,5° / 99 |
| `a-to-c-95` | `664178dd-7b10-440c-b1c0-b5cf9bd9f370:5:84` | 74,4° / 95 |
| `d-to-b-95` | `664178dd-7b10-440c-b1c0-b5cf9bd9f370:11:184` | 105,6° / 95 |
| `no-witness-d-to-a` | `cb0c1658-4758-42ab-9e09-58733fc582e9:14:223` | Aucun conservé; inaccessibilité non démontrée |

Le chargeur valide depuis `unknown` les commandes, l’état, la mémoire, l’identité et les empreintes de l’archive. Il exige la concordance des positions, PV, boucliers, morts, vent et gravité entre décision et capture avant tir. Chaque expérience crée un état et un terrain neufs. La stratégie reçoit sa mémoire archivée par le même accès privé réservé aux tests que la suite `expertDecisionAim.test.ts`; aucune API de production n’est ajoutée.

## Deux vérifications différentes

1. Le **rejeu physique historique** consomme la bande physique enregistrée et vérifie les divergences physiques et économiques. Les quatre certificats touchent directement la cible historique, lui infligent des pertes et laissent le tireur vivant.
2. La **nouvelle décision IA** utilise le générateur injecté `createSeededRNG`, graine par défaut **865 (`0x361`)**. Les tirages sont consignés et le RNG précédent est rétabli, même après exception. Cette suite déterministe n’est **pas la bande RNG historique de l’IA**. L’offset, la réaction et la gaffe du nouveau calcul restent actifs. Il est normal que sa commande finale diffère de la commande historique.

L’observateur et le callback de cible doivent chacun être appelés une fois. Le rapport distingue commande évaluée et commande finale, cible, phase, nombre de candidats, tirages, mémoire après décision et prévisions physiques. Les durées mesurées peuvent varier entre machines; elles ne participent pas à la comparaison déterministe. La garde de 64 tirages est propre au banc; elle ne modifie pas les filets du jeu.

## Exécution courte

Depuis la racine du dépôt, avec les dépendances installées, de préférence Node 24 :

```powershell
npm run test -- src/game/entities/ai/__tests__/issue361Bench.test.ts

node Scripts/diagnose-expert-361.mjs --seed 865 --output artifacts/issue361-decision-bench/nouveau-rapport.json
```

L’outil refuse d’écraser le rapport. `--case a-to-c-95` limite l’exécution à une fixture. `--seed` accepte un entier uint32. Sans `--output`, le JSON est écrit sur stdout. Sous Windows, si Vitest rencontre `EPERM` dans son cache temporaire, utiliser un dossier temporaire accessible avant de relancer :

```powershell
$env:TEMP = Join-Path (Get-Location) 'artifacts/issue361-decision-bench/tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
npm run test -- src/game/entities/ai/__tests__/issue361Bench.test.ts
```

Les tests ordinaires vérifient l’intégrité des entrées, les replays, les certificats, l’isolation, la déterminisation, les callbacks et les sondes du solveur. Depuis #361 (v0.14.1), `a-to-c-95` et `d-to-b-95` sont des tests ordinaires : la décision évaluée, graine 865, doit être utile à puissance ≤ 95. **Deux tests `it.fails` conservent `a-to-d-99` et `d-to-a-99` pour [#400](https://github.com/bestter/TankWars/issues/400).** Ils ne sont pas ignorés. Leur échec attendu n’approuve pas le repli actuel. Quand un correctif rend un de ces cas utile, Vitest signale un succès inattendu : il faut alors le promouvoir avec #400. Le cas `no-witness-d-to-a` reste une recherche sans effet utile, en phase `REPLI`, sans candidat du plan principal. Les tests ordinaires exécutent aussi les décisions résiduelles pour qu’une exception ou une corruption du banc ne soit pas masquée par les échecs attendus.

Ne pas exiger une commande précise ou une cible précise pour le futur choix autonome : une autre décision utile et admissible peut être correcte. Un certificat physique ne prouve pas à lui seul son admissibilité économique ou tactique; il faut examiner les propositions et les refus dans `observation.diagnostics`.

## Expériences disponibles

Chaque rapport comprend six sondes isolées du solveur : plafonds 95/99 × arcs `full`, `low`, `high`, vers le centre de la cible historique sans offset. Elles ne changent pas le plafond réel d’EXPERT et ne reproduisent pas son choix complet. Chaque proposition est normalisée puis vérifiée par la vraie physique; modifier le plafond ne garantit pas une solution.

```powershell
node Scripts/diagnose-expert-361.mjs --matrix --seed 865 --output artifacts/issue361-decision-bench/nouvelle-matrice.json
```

La matrice comprend **30 décisions** : cinq états × vents −20/0/+20 × deux graines consécutives. Le certificat initial est resimulé pour chaque vent et n’est jamais présumé encore utile. Cette matrice reste un test court et ne lance pas Chromium. Les variations de profondeur de creux ou de montagne ne sont pas encore générées par ce banc : il faudra préparer, stabiliser et recertifier leurs états séparément. Le témoin sans certificat n’est pas présenté comme un cas physiquement inaccessible.

L’horizon partagé du solveur reste de **420 pas**. Les tirs propres d’EXPERT local prolongent une trajectoire encore en vol jusqu’à **600 pas** (`EXPERT_OWN_OPEN_FLIGHT_MAX_STEPS`). Le conseiller, les menaces, les autres profils, le dernier MISSILE ordinaire non certifié et BULLDOZER direct restent à 420. Les champs `steps` du résolveur physique incluent la stabilisation des tanks; **ils ne mesurent pas uniquement le temps de vol**. Le champ `steps` de `simulateShot` compte seulement l’intégration du projectile.

Les captures `a-to-c-95` et `d-to-b-95` vérifient cette correction dans [#361](https://github.com/bestter/TankWars/issues/361). Les deux captures avec témoin à puissance 99 et celle sans témoin restent des lacunes résiduelles dans [#400](https://github.com/bestter/TankWars/issues/400).

## Mesures avant et après #361

Graine 865, vent 0, `AISmartStrategy` réel, état neuf et mémoire archivée. Avant : horizon unique de 420 pas. Après : vols propres encore ouverts jusqu’à 600 pas. `utile` porte sur la commande évaluée et la cible historique. Les propositions viennent de `observation.diagnostics.exploration` (`ownProposals` / `adverseProposals`); sur ces cinq états, chaque proposition propre enregistrée a une prévision complète. Les durées sont celles de cette machine et ne font pas partie du contrat déterministe. Les 30 décisions de la matrice après correction ont pris 4,44 s au total.

| Fixture | Avant (420) | Après (600 sur les tirs propres) |
| --- | --- | --- |
| `a-to-d-99` | REPLI, 0 candidat, MISSILE 30,9°/58, inutile, roche proche, 132 propres / 12 adverses, 94 ms | REPLI, 0 candidat, MISSILE 30,9°/58, inutile, roche proche, 132 propres / 12 adverses, 113 ms |
| `d-to-a-99` | REPLI, 0 candidat, MISSILE 108,6°/94, inutile, 381 propres / 23 adverses, 193 ms | REPLI, 0 candidat, MISSILE 108,6°/95, inutile, 381 propres / 23 adverses, 218 ms |
| `a-to-c-95` | REPLI, 0 candidat, MISSILE 62°/95, inutile, roche proche, 36 propres / 6 adverses, 25 ms | OPTIMISER_PROFIT, 1 candidat, MISSILE 74°/95, utile, 18 propres / 6 adverses, 31 ms |
| `d-to-b-95` | REPLI, 0 candidat, MISSILE 118,5°/93, inutile, roche proche, 48 propres / 6 adverses, 29 ms | OPTIMISER_PROFIT, 3 candidats, MISSILE 107°/88, utile, 30 propres / 6 adverses, 50 ms |
| `no-witness-d-to-a` | REPLI, 0 candidat, MISSILE 110,5°/95, inutile, roche proche, 216 propres / 13 adverses, 99 ms | REPLI, 0 candidat, MISSILE 110,5°/95, inutile, roche proche, 216 propres / 13 adverses, 200 ms |

La baisse du nombre de propositions propres sur `a-to-c-95` et `d-to-b-95` vient du planificateur déjà en place : dès qu’un candidat classé existe, il n’énumère plus les replis à profit négatif. Les deux témoins à 95 entrent dans ce classement normal. `d-to-b-95` retient trois candidats; la sonde publiée 107°/92 n’est pas la commande retenue (107°/88), mais le tir reste utile à puissance ≤ 95. `a-to-c-95` retient exactement 74°/95.

Hors du certificat archivé (vent 0, graine 865), la même matrice rend quelques cellules utiles sans promouvoir les lacunes de #400 : `a-to-d-99` au vent +20 (865 : 71,1°/93; 866 : 72,9°/92), `d-to-a-99` au vent −20 et à la graine 866 seulement (112,4°/92), et `no-witness-d-to-a` au vent −20 (SURVIE, DRILLER 107,5°/94). Le cas archivé sans témoin reste inutile. `a-to-c-95` au vent −20 et `d-to-b-95` au vent +20 restent en REPLI.

La matrice complète, cinq états × vents −20/0/+20 × graines 865 et 866, est produite par la commande `--matrix` ci-dessus. Le JSON reste sous `artifacts/` et n’est pas versionné.

Signé : **Codex — GPT-6** (banc d’origine). Mesures après #361 : **Grok 4.7**.
