# Validation du ticket 352 — TankWars 0.12.0

28 octobre 2026. État lors des validations initiales : modifications locales sur `main`, avant commit et publication de la PR; aucun déploiement.

## Implémentation

EXPERT avec contexte économique et le conseiller OPTIMISER_PROFIT analysent le gagnant du plan principal. Une alternative est cherchée seulement après preuve complète d'une transition absence → présence de menace létale et d'une riposte létale possible. Les deux hypothèses après tir utilisent le même état stabilisé, indépendamment. Le remplacement utilise seulement le meilleur candidat déjà calculé de chaque autre cible principale vivante. Inconnu, duel ou alternatives épuisées conservent le choix initial.

SURVIE, les replis, les comparateurs, les offsets/RNG, les autres profils et le réseau gardent leur comportement. Le stock nucléaire adverse reste inconnu. Les recherches ordinaires et BULLDOZER distinguent absence bornée, preuve positive et incomplétude.

Les états physiques restent dans une WeakMap interne, avec une seule consommation de munition et le contexte de premier tir passé à faux. Leur association survit à l'ajout du profit, à la réutilisation entre groupes et au passage d'une tentative SURVIE infructueuse au plan de profit. Les traces structurées demeurent disponibles pour un observateur hors DEV; les requêtes du conseiller ont un `requestId` et une seule conclusion terminale.

Version 0.12.0 dans les deux manifestes; README et AGENTS mis à jour. Les anciennes assertions de budget qui comptaient indistinctement les recherches du plan et celles du détecteur ont été remplacées par des vérifications séparées. Les tests toujours pertinents ont été conservés.

## Validation automatisée

Dans l'ordre demandé, après les changements fonctionnels finaux :

1. `npm run lint` : réussi.
2. `npm run build` : réussi, client et Worker typés. Vite signale un bundle principal de plus de 500 kB.
3. `npm run test -- --reporter=json --outputFile=artifacts/validation-352/tests.json` : **2068 tests réussis, aucun échec**. Les messages JSDOM concernant Canvas et les avertissements Node sur localStorage restent visibles. L'exécution initiale en sandbox avait échoué sur le cache temporaire Windows (`EPERM`); les résultats retenus proviennent de l'exécution autorisée hors sandbox.
4. `npm run doctor -- --verbose --scope changed --blocking warning` : **réussi, 100/100, 15 fichiers analysés, aucun diagnostic ni avertissement**. `npx react-doctor@latest` a été utilisé. Les nouveaux fichiers ont été inclus au diff avec `git add -N`, sans commit.
5. `git diff --check` : réussi après retrait d'une ligne vide finale superflue.

Le build réel endurance a aussi réussi : `npm run build -- --mode endurance --outDir artifacts/validation-352/endurance/dist`.

Les nouveaux tests couvrent notamment la physique réelle, le changement de cible, l'indépendance des hypothèses après tir, les courts-circuits, les résultats inconnus, les caches orientés, la dernière munition, les matériaux, BULLDOZER, l'exclusion des nucléaires et l'absence de RNG de jeu. Le test d'observation compare commandes, callbacks, état et tirages avec et sans observateur, puis relit le JSONL produit par EnduranceSession avec DEV faux.

## Vérification dans le navigateur

Sur le build de production local : menu → combat humain/EXPERT → conseiller profit → application de la visée → tirs et fin de manche → boutique humaine → achat d'une BULLET → manche suivante avec stock conservé. Le conseiller SURVIE fonctionne aussi après la boutique. Les traces de requête ont été vérifiées en développement : `calculating`, puis une seule conclusion, sans annulation après succès. Aucune trace de décision issue du build de production n'a été observée.

Le banc séparé a été compilé en mode endurance :

```powershell
npx vite build --config artifacts/validation-352/vite.config.ts --mode endurance
npx vite preview --config artifacts/validation-352/vite.config.ts --host 127.0.0.1 --port 4174
```

Ouvrir `/artifacts/validation-352/index.html`, puis lancer la mesure. Avec DEV faux, une observation réelle EXPERT a été écrite dans IndexedDB, relue et sérialisée en JSONL. Le motif `initial-retained / no-lethal-reply`, les trois recherches et les commandes brute/évaluée sont conservés; aucun terrain simulé complet n'est sérialisé.

## Coût mesuré

Banc navigateur local compilé, terrain plat de 900 × 480, MISSILE uniquement. Trois scénarios : transition sans riposte, transition avec riposte et alternative admissible lorsque disponible, alternatives toutes risquées. Chaque scénario est exécuté avec et sans observation, sur le thread principal et dans un Worker. Les plages ci-dessous réunissent ces scénarios; ce sont des échantillons locaux, sans garantie sur d'autres terrains, stocks ou machines.

| Joueurs | Détecteur seul, ms | Décision EXPERT sur thread principal, ms | Intervalle rAF entourant EXPERT, ms | Conseiller dans Worker, ms |
| --- | --- | --- | --- | --- |
| 2 | 3,3–6,6 | 6,4–8,2 | 6,9–20,9 | 7,4–10,2 |
| 3 | 3,8–9,2 | 15,1–16,1 | 13,9–20,9 | 11,1–19,7 |
| 4 | 3,2–14,2 | 25,3–28,4 | 27,7–27,8 | 18,5–32,3 |

Sans riposte : 7 recherches et 7 prévisions du détecteur. Avec riposte et alternative immédiate : 5 et 5. Alternatives épuisées : 5 et 5 en duel, 12 et 12 à trois joueurs, 17 et 17 à quatre. L'activation de l'observateur conserve commandes et motifs dans les 18 paires comparées.

À quatre joueurs, EXPERT bloque le thread principal au-delà du budget d'une image à 60 Hz. C'est une limite réelle; aucun budget ni périmètre n'a été réduit pour masquer ce coût. Le Worker du conseiller évite ce blocage sur le thread de rendu. Le banc n'évalue pas les pires cas BULLDOZER, les gros stocks ni une distribution statistique de parties. Aucun test manuel réseau n'a été effectué, ce domaine étant hors périmètre.

Signé : **GPT-6 — Codex**.

## Complément — logs console et endurance

Après analyse de `Temp/Console20261028_1.txt`, plusieurs titres de décision sont présents sans JSON, et une trace est tronquée. La cause exacte de la perte dans l'ancien export n'est pas démontrée. Les données manquantes du tir 77 ne peuvent pas être reconstruites.

Les décisions EXPERT et conseiller ont maintenant un résumé court, une seule chaîne par appel console et des détails JSON fragmentés, numérotés et corrélés par `traceId`. Chaque ligne est bornée à 3000 caractères, y compris l'échappement JSON. Le résumé expose les meilleurs candidats admissibles par cible principale et les motifs de choix de cible en repli; les détails gardent les prévisions existantes. Aucun calcul physique ni tirage de RNG ne sert à fabriquer un log. Le lecteur `Scripts/read-decision-console.mjs` reconstitue les fragments et signale explicitement les exports incomplets, avec un code de sortie 2. Il ne peut pas détecter une décision entièrement absente du fichier.

En endurance, les mêmes comparaisons de cibles et motifs de cible/repli sont ajoutés à `ai-detail`. Les motifs de repli et de conservation ne dépendent plus uniquement de DEV : ils sont aussi collectés lorsqu'un observateur est actif, sans activer les logs console de production. Le conseiller émet toujours une seule conclusion terminale, et les observations finales ne sont pas multipliées par le nombre de fragments de console.

Vérification réelle dans le navigateur : deux décisions EXPERT avec humain et OK ont produit 12 lignes, de 2245 caractères maximum. Le fichier texte téléchargé a été relu par le script : deux décisions complètes, aucune erreur. La seconde décision conserve notamment le meilleur profit humain de 55 $, celui d'OK de 86 $, le choix d'OK et le motif `profit net supérieur`. La première conserve son repli, sa cible et le motif de classement. Cela valide les lignes effectivement émises et téléchargées; l'interface native « Enregistrer sous » des DevTools n'a pas été automatisée.

Le banc endurance compilé avec DEV faux a écrit puis relu deux observations dans IndexedDB/JSONL : l'une avec comparaison des cibles et analyse de transition, l'autre avec `ordinary-target-order` et le motif de repli `conséquences physiques préférées`. Aucun terrain simulé complet n'est sérialisé. Dans le vrai parcours de jeu, les requêtes conseiller SURVIE et OPTIMISER_PROFIT ont chacune un seul `calculating` et un seul `result`, avec des résumés de 183 à 1101 caractères.

Validation finale, dans l'ordre : lint réussi; build réussi; **2076 tests réussis sur 2076**; React Doctor latest **100/100, 23 fichiers, aucun diagnostic ni avertissement**; `git diff --check` réussi. Les avertissements Vite sur le bundle et les messages JSDOM/Node déjà observés demeurent. README et AGENTS documentent le format et sa relecture. Au terme de cette validation, les changements étaient locaux, avant le commit et la publication de la PR. Aucun déploiement n’a été effectué.

Signé : **GPT-6 — Codex**.
