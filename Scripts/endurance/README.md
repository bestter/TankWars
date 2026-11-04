# Pilote d’endurance / Endurance driver — 0.13.5

## Français

Depuis la racine du dépôt, installer Python 3.11+, les dépendances Node (`npm ci --ignore-scripts`), puis :

```sh
python -m pip install -r Scripts/endurance/requirements.txt
python -m playwright install chromium
npm run build -- --mode endurance
npm run preview -- --host 127.0.0.1
```

Utiliser un dossier de sortie neuf. Copier `config.example.json` pour choisir les profils (2–4 IA), manches, budget, armes gratuites, politique d’incidents et délais natifs. L’identité attendue est la chaîne **exacte** `SHA[-dirty]/horodatage` du build servi, vérifiée dans le premier export de session; celui-ci est conservé même en cas de refus. Aucun déploiement automatique.

Exemple Linux (remplacer URL et identité) :

```sh
python Scripts/endurance/supervise.py --safety-seconds 480 -- \
  --url http://127.0.0.1:4173/ --output artifacts/endurance-new \
  --expected-build 'SHA/BUILD_TIMESTAMP' --config Scripts/endurance/config.example.json \
  --duration-ms 60000 --completed-blocks 1 --finalization-seconds 120 --safety-seconds 360
```

Durée obligatoire positive (ms entières), cible facultative de blocs **complétés**; arrêt au premier seuil atteint (`>=`). La limite native de tentatives reste désactivée (`maxBlocks=null`), la durée native reste active. Le verdict utilise `stoppedAtDurationMs`, figé au début de `stop()`, sans compter préparation/export/récupération. La durée historique du résumé reste inchangée. Un ancien build sans cette capacité échoue explicitement.

Résultats/codes : **Terminé** (`completed`, 0), **Écourté par protection** (`protected-stop`, 2, uniquement `archive-budget`), **Interrompu** (`interrupted`, 3), **Erreur** (`error`, 1). Budget et seuil simultanés donnent 2 avec `objectiveReached=true`. Toute erreur réelle prévaut. Les incidents historiques suivent toujours `stopOnIncident`. Un bloc interrompu ou zéro tir peut être valide.

`status.json` versionné et `summary.md` proviennent du même résultat, nul avant clôture vérifiée. Motif natif et déclencheur sont séparés. Preuves requises : build/configuration appliqués, clôture complète, journal contigu/confirmé, archive validée par le validateur TypeScript du dépôt, égalité binaire du journal natif (retrait de sa première ligne LF seulement), puis journal/archive récupérés identiques après réouverture du même profil et résumé cohérent. Aucun verdict positif avant récupération. Aucun `passed` décisionnel; anciens artefacts inchangés, champs absents = information indisponible.

Le superviseur conserve code brut, provenance d’intervention et verdict dans `process-exit.json` et `process.log`. Les codes 2/3 sont des sorties normales. Son délai externe produit une erreur même après sauvegarde propre. Un statut périmé/contradictoire est une erreur de protocole. Une terminaison non observable reste inconnue. Aucun allongement automatique des délais.

Tests déterministes courts, sans navigateur :

```sh
PYTHONPATH=Scripts/endurance python -m unittest discover -s Scripts/endurance/tests -v
```

PowerShell : `$env:PYTHONPATH='Scripts/endurance'`, puis la même commande Python. En bac à sable Windows restreint, définir `TEMP` et `TMP` vers un dossier accessible du dépôt. Aucune endurance de plusieurs heures requise.

## English

Run from the repository root with Python 3.11+, Node dependencies and Chromium. Install `requirements.txt`, run `python -m playwright install chromium`, build with `npm run build -- --mode endurance`, then serve with `npm run preview`. Use a **new output directory** and a configuration copied from `config.example.json`. The Linux supervisor command above accepts the exact served build identity, URL, output, mandatory positive duration, optional completed-block target and bounded technical timeouts. No deployment occurs.

Stop at the first active objective (`>=`). Native attempted-block limits are disabled; native duration remains enabled. Frozen native stop duration excludes preparation, saving and recovery; historical summary duration is preserved. Missing capabilities are errors. Results/codes: completed/0, protected-stop/2 (archive-budget only), interrupted/3, error/1. Real errors override objectives; budget overrides simultaneous attainment. Partial rounds and zero shots may be valid; native incident policy is preserved.

Versioned status and readable summary share one result, null until all required checks finish. Build/configuration, finalized session, contiguous confirmed journal, native archive validation, strict binary journal equality and closed-profile recovery comparisons are required. Recovery compares journal/archive bytes exactly and the complete session summary; it never resumes combat. No `passed` dependency or historical rewrite. Missing legacy fields mean unavailable information.

The supervisor records raw exit and intervention provenance. Codes 2/3 are not crashes. Confirmed external deadlines or stale/contradictory statuses produce error/1; unobservable termination remains unknown. No automatic timeout extension or budget increase. Use the Python test command above for short deterministic tests.

Signé / Signed: **Codex — GPT-6**.
