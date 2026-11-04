# Validation — Collecte native JSON/JSONL et téléchargements natifs (#381)

## Contexte et objectif

Le ticket [#381](https://github.com/bestter/TankWars/issues/381) supprime la transformation des données par désérialisation / resérialisation d'objets Python dans le pilote d'endurance. Le navigateur sérialise désormais les pages d'événements avec `JSON.stringify`, et le pilote reçoit le texte UTF-8 brut et l'écrit directement en binaire (`ab`) sans passer par des structures intermédiaires. Les archives de tirs ne transitent plus par une méthode monolithique sur le pont JavaScript, mais sont téléchargées via les boutons natifs de l'interface (`exportStoredArchive` et `DiagnosticPanel`).

## Modifications architecturales

1. **Sérialisation JSONL commune (`src/game/endurance/journalJsonl.ts`)** :
   - Interface `JournalTextPage` et fonctions `validateJournalPageRequest`, `formatJournalTextPage`, `exportJournalJsonl`.
   - L'export séquentiel est partagé entre la session active (`journalJSONL`) et la récupération d'une session fermée (`recovered("jsonl")`).
   - Le parcours fige la borne confirmée `status.persisted` au départ et valide la contiguïté stricte (`JOURNAL_SEQUENCE_GAP`).
   - Si une erreur de journal survient en cours de session active, le suffixe `journal.pending()` est ajouté après le préfixe confirmé. En récupération, seules les entrées confirmées sont lues.

2. **Pont navigateur paginé (`src/components/endurance/journalBridge.ts`)** :
   - Remplacement de `readJournalPage` et `readArchive` par `readJournalText(after?, limit?)` et `readArchiveMetrics()`.
   - Validation stricte des arguments sans coercition (`INVALID_JOURNAL_PAGE_REQUEST`).
   - Retrait des anciennes méthodes de l'interface `window.__tankwarsEnduranceTest`.

3. **Téléchargements natifs d'archives** :
   - En session : bouton « Exporter les tirs » dans le panneau `DiagnosticPanel`.
   - En récupération : bouton « Exporter les tirs » dans la zone de session récupérée.

4. **Pilote privé et vérificateur hors Git** :
   - Nouveau pilote privé sous `artifacts/endurance-20261104-issue381/preparation/`.
   - Écriture binaire directe du flux UTF-8 reçu (`raw_bytes = text.encode("utf-8")`), avancement du curseur et du SHA-256 cumulatif avant l'analyse métier.
   - Suppression définitive de `compare_progressive` dans les nouvelles copies : les comparaisons sont strictement binaires.

## Résultats de l'essai réel local (1 bloc × 2 manches)

Un essai réel a été exécuté sur un build d'endurance local (`npm run build -- --mode endurance` puis `vite preview` sur port 4173) :

- **Configuration** : 1 bloc × 2 manches, 4 joueurs IA (`v1-random`, `v2-heuristic`, `v3-sniper`, `v4-smart`).
- **Arrêt normal** : Arrêt automatique sur limite de bloc (`block-limit`), sauvegarde complète dans IndexedDB.
- **Fichiers collectés** :
  - `decisions.jsonl` : 4 364 942 octets, 1 795 lignes d'événements.
  - `journal-final.jsonl` : 4 365 127 octets (en-tête de statut + 1 795 lignes).
  - `shots-final.json` : 2 628 489 octets, 983 captures, 34 terrains, `complete: true`.
  - `reopened-shots.json` : 2 628 489 octets.
  - `reopened.jsonl` : 4 365 127 octets.
- **Vérifications binaires (`verify_final_issue381.py`)** :
  - `binaryDecisionsEqual`: **true** (`decisions.jsonl` == `journal-final.jsonl` sans sa première ligne physique, SHA-256 `35abb3332ff6722cb6b3a107078b7e1e6c4488fd481b8e1d7db9b747f7a104ad`).
  - `reopenedJournalBinaryEqual`: **true** (journal téléchargé en session == journal téléchargé après réouverture du profil persistant).
  - `reopenedArchiveBinaryEqual`: **true** (archive téléchargée en session == archive téléchargée après réouverture).
  - Rejeu de tir certifié : tir `3c309dc5-6e74-4183-b206-4ff0591bf8ed:1:1` rejoué avec succès via `node Scripts/read-shot-archive.mjs`.

## Limites et invariants préservés

- Le comparateur historique `compare_progressive` reste présent pour l'analyse des archives antérieures au 4 novembre 2026, mais est exclu de tous les nouveaux essais.
- Les cas numériques limites (`-0`, `NaN`, `Infinity`, `undefined`) respectent rigoureusement la sémantique de `JSON.stringify` sans normalisation artificielle.
- Les règles de jeu, la physique balistique, l'économie et le multijoueur en ligne demeurent inchangés.
