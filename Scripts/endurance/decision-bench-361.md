# Banc de décisions EXPERT — #361

Ce banc s’exécute hors navigateur et hors endurance. Il recharge cinq états de la campagne `endurance-20261109-mirror-2h` dans le vrai `AISmartStrategy`, son planificateur, son solveur et `resolvePhysicalShot`. Aucun de ces modules n’est remplacé par un résultat fictif. Le comportement du jeu reste inchangé.

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

Les tests ordinaires vérifient l’intégrité des entrées, les replays, les certificats, l’isolation, la déterminisation, les callbacks et les sondes du solveur. **Quatre tests `it.fails` exécutent aussi la vraie décision et expriment l’objectif encore non satisfait : trouver un tir évalué utile contre un adversaire vivant dans ces états possédant un certificat.** Ils ne sont pas ignorés. Leur échec attendu n’est pas un correctif ni une approbation du repli actuel. Quand un correctif rend un cas utile, Vitest signale un succès inattendu : il faut alors promouvoir ce cas en test ordinaire. Les tests ordinaires exécutent les mêmes décisions pour qu’une exception ou une corruption du banc ne soit pas masquée par les échecs attendus.

Ne pas exiger une commande précise ou une cible précise pour le futur choix autonome : une autre décision utile et admissible peut être correcte. Un certificat physique ne prouve pas à lui seul son admissibilité économique ou tactique; il faut examiner les propositions et les refus dans `observation.diagnostics`.

## Expériences disponibles

Chaque rapport comprend six sondes isolées du solveur : plafonds 95/99 × arcs `full`, `low`, `high`, vers le centre de la cible historique sans offset. Elles ne changent pas le plafond réel d’EXPERT et ne reproduisent pas son choix complet. Chaque proposition est normalisée puis vérifiée par la vraie physique; modifier le plafond ne garantit pas une solution.

```powershell
node Scripts/diagnose-expert-361.mjs --matrix --seed 865 --output artifacts/issue361-decision-bench/nouvelle-matrice.json
```

La matrice comprend **30 décisions** : cinq états × vents −20/0/+20 × deux graines consécutives. Le certificat initial est resimulé pour chaque vent et n’est jamais présumé encore utile. Cette matrice reste un test court et ne lance pas Chromium. Les variations de profondeur de creux ou de montagne ne sont pas encore générées par ce banc : il faudra préparer, stabiliser et recertifier leurs états séparément. Le témoin sans certificat n’est pas présenté comme un cas physiquement inaccessible.

L’horizon de recherche courant reste celui du solveur de production. Les champs `steps` du résolveur incluent la stabilisation des tanks; **ils ne mesurent pas uniquement le temps de vol** et ne suffisent pas à attribuer l’échec à l’horizon de recherche.

Les captures `a-to-c-95` et `d-to-b-95` servent à vérifier la correction de l’horizon dans [#361](https://github.com/bestter/TankWars/issues/361). Les deux captures avec témoin à puissance 99 et celle sans témoin servent à explorer les lacunes résiduelles dans [#400](https://github.com/bestter/TankWars/issues/400).

Signé : **Codex — GPT-6**.
