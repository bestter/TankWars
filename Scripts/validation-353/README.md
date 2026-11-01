# Validation navigateur — SNIPER #353

Ce banc utilise la vraie sélection SNIPER et le détecteur partagé, sur le thread principal. Les cas à 2, 3 et 4 joueurs couvrent absence de transition, transition sans riposte, riposte avec alternative, alternatives épuisées et plateau. En duel, les trois derniers cas conservent nécessairement la cible initiale.

```powershell
npx vite build --config Scripts/validation-353/vite.config.ts --mode endurance
npx vite preview --config Scripts/validation-353/vite.config.ts --host 127.0.0.1 --port 4174
```

Ouvrir `http://127.0.0.1:4174/Scripts/validation-353/index.html` et cliquer « Mesurer et vérifier le journal ». La sortie contient les temps, intervalles entre frames, compteurs distincts, branches exécutées et journal JSONL relu depuis IndexedDB. Les outils de validation sont exclus du build public normal.

## Mesures du 29 octobre 2026

Navigateur intégré Codex, build endurance compilé avec `DEV=false`, terrain plat 1600 × 480, stocks vides (MISSILE disponible selon son contrat), amplitude fixe 0,25. Une mesure par combinaison, sans moyenne statistique; le premier cas comprend l'échauffement. Ces chiffres ne bornent pas le coût de toutes les cartes et tous les stocks.

| Joueurs | Scénario | Sans / avec observation (ms) | Recherches sélection / détection |
| --- | --- | --- | --- |
| 2 | Absence de transition | 13,1 / 8,1 | 1 / 6 |
| 2 | Transition sans riposte | 7,3 / 7,0 | 1 / 7 |
| 2 | Riposte, duel | 5,8 / 5,7 | 1 / 6 |
| 2 | Alternatives épuisées, duel | 5,8 / 5,8 | 1 / 6 |
| 2 | Plateau, duel | 5,9 / 5,8 | 1 / 6 |
| 3 | Absence de transition | 6,3 / 6,0 | 1 / 6 |
| 3 | Transition sans riposte | 6,4 / 7,5 | 1 / 7 |
| 3 | Riposte, alternative acceptée | 7,7 / 7,4 | 4 / 6 |
| 3 | Alternatives épuisées | 14,0 / 14,1 | 4 / 13 |
| 3 | Plateau, alternative acceptée | 8,2 / 7,8 | 4 / 6 |
| 4 | Absence de transition | 6,0 / 6,0 | 1 / 6 |
| 4 | Transition sans riposte | 6,4 / 6,8 | 1 / 7 |
| 4 | Riposte, alternative acceptée | 8,0 / 8,0 | 4 / 6 |
| 4 | Alternatives épuisées | 21,3 / 21,4 | 7 / 18 |
| 4 | Plateau, alternative acceptée | 8,0 / 8,1 | 4 / 6 |

Dans ce corpus, chaque recherche a produit une prévision distincte; les compteurs de cache sont nuls. Choix, commandes et nombres de tirages identiques avec/sans observation pour les 15 paires. Au plateau, zéro tirage d'amplitude en duel et un seul lorsque des alternatives sont examinées. Intervalle maximal entre callbacks de rendu : 18,2 ms. Le calcul maximal de 21,4 ms peut dépasser le budget d'une frame à 60 Hz; aucune longue pause de 50 ms n'a été relevée dans ce corpus. Aucun plafond n'a été modifié pour réduire le coût.

Le journal compilé a émis une observation finale, persisté une entrée IndexedDB puis exporté et relu une ligne JSONL. Le motif `alternative-accepted`, la transition et la cible finale `a0` sont présents, avec `DEV=false`. Aucun roster hypothétique ni terrain complet n'est sérialisé. Aucune ligne console `[AI SNIPER] Décision` n'a été émise.

## Parcours rendu

Le client de développement a été ouvert au menu (version 0.12.1), puis une partie locale à deux SNIPER a été lancée. Combat, fin de manche, passage par les achats IA automatiques et nouvelle manche ont été vérifiés; le nouveau tour affichait notamment le stock BULLET réapprovisionné. La boutique humaine n'a pas été manipulée dans ce parcours entièrement IA. Le changement de cible spécifique #353 a été vérifié dans le banc navigateur avec vraie physique et journal persistant, séparément du parcours rendu non contrôlé.

Les tests Vitest couvrent aussi les vraies transitions avec/sans contexte économique, la conservation des copies, la dernière munition, la certification, l'ordre des alternatives, les rejets, la mémoire et les callbacks uniques, A → B → A, la réaction/gaffe et l'exception RNG au plateau. Les tests existants #352 couvrent les branches du détecteur partagé et BULLDOZER.

Signé : GPT-6 — Codex.
