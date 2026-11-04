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

Cycle de vie / lifecycle (#383): chaque contexte possède sa page et sa tentative unique de fermeture. Le même budget monotone couvre finalisation, récupération et secours. Après erreur, arrêter une seule fois une session encore active, attendre une clôture engagée et exporter uniquement les preuves manquantes accessibles. Aucune page créée, navigation ou réouverture de secours. Une fermeture non confirmée interdit la réouverture du profil. Les erreurs de fermeture restent bloquantes; une capture d’écran facultative échouée est seulement un avertissement. Après fermeture des deux contextes, aucun accès navigateur.

Les attestations conservent contrôle/session/étape/heure/borne/fichiers/empreintes. Copie brute et préfixe comptable vérifié ont des bornes séparées; un préfixe atteste seulement les octets à cette borne. Un échec d’analyse ne détruit pas la copie et n’étend pas le préfixe. Les candidats téléchargés sont validés avant promotion et ne remplacent jamais des octets attestés divergents. Les attestations retenues restent présentes même si un fichier devient indisponible; ce nouvel échec bloque le verdict. Erreur primaire conservée, erreurs secondaires séparées, statuts atomiques; un échec de publication laisse la dernière version lisible et écrit l’erreur sur stderr.

L’audit comptable reprend les contrôles de transactions de #381 (crédits, achats, consommation et snapshots). En armes gratuites, le premier roster natif de chaque manche fournit les soldes d’ouverture de stock; la politique de réapprovisionnement elle-même n’est pas réévaluée par Python. L’argent n’est jamais réinitialisé à cette frontière.

Shared real-browser smoke test (two short sessions, including an exception after verified recovery and both closes):

```sh
ENDURANCE_SMOKE_URL=http://127.0.0.1:4173/ \
ENDURANCE_SMOKE_BUILD='SHA/BUILD_TIMESTAMP' \
ENDURANCE_SMOKE_OUTPUT=artifacts/endurance-smoke-new \
PYTHONPATH=Scripts/endurance python -m unittest discover -s Scripts/endurance/tests -p test_browser.py -v
```

PowerShell: set the same environment variables with `$env:NAME='value'`. Output must be new. This exercises real IndexedDB persistence; unit doubles alone do not establish closed-browser persistence.

Run from the repository root with Python 3.11+, Node dependencies and Chromium. Install `requirements.txt`, run `python -m playwright install chromium`, build with `npm run build -- --mode endurance`, then serve with `npm run preview`. Use a **new output directory** and a configuration copied from `config.example.json`. The Linux supervisor command above accepts the exact served build identity, URL, output, mandatory positive duration, optional completed-block target and bounded technical timeouts. No deployment occurs.

Stop at the first active objective (`>=`). Native attempted-block limits are disabled; native duration remains enabled. Frozen native stop duration excludes preparation, saving and recovery; historical summary duration is preserved. Missing capabilities are errors. Results/codes: completed/0, protected-stop/2 (archive-budget only), interrupted/3, error/1. Real errors override objectives; budget overrides simultaneous attainment. Partial rounds and zero shots may be valid; native incident policy is preserved.

Versioned status and readable summary share one result, null until all required checks finish. Build/configuration, finalized session, contiguous confirmed journal, native archive validation, strict binary journal equality and closed-profile recovery comparisons are required. Recovery compares journal/archive bytes exactly and the complete session summary; it never resumes combat. No `passed` dependency or historical rewrite. Missing legacy fields mean unavailable information.

The supervisor records raw exit and intervention provenance. Codes 2/3 are not crashes. Confirmed external deadlines or stale/contradictory statuses produce error/1; unobservable termination remains unknown. No automatic timeout extension or budget increase. Use the Python test command above for short deterministic tests.

Each browser stage explicitly owns its context/page. Recovery opens the same persistent profile once, only after confirmed closure. Rescue never creates pages, navigates or reopens a browser; it requests one stop for an active session, waits for pending finalization and retrieves missing accessible evidence. One monotonic finalization deadline also bounds recovery, rescue and cleanup. Cleanup errors block the verdict; optional screenshot failures only warn. After both contexts close, all remaining work uses local files.

Evidence attestations include control, session, stage, time, sequence bounds and file hashes/sizes. Raw-copy and verified accounting cursors are separate; analysis failures preserve raw bytes without extending the verified prefix. Validated download candidates cannot overwrite divergent attested files. Retained attestations survive later failures, but a changed/missing file adds a blocking integrity/availability error. Primary errors remain distinct from secondary failures. Atomic status publication preserves the last readable version on failure and logs both errors to stderr. The real-browser smoke command above tests persistence and an injected exception after both closes.

Accounting retains #381's transaction checks (credits, purchases, ammunition and boundary snapshots). In free weapons mode, each round's first native roster provides opening stock balances; Python does not re-evaluate refill policy. Money balances are never reset at that boundary.

Précisions de robustesse : un seul délai de sécurité est actif (démarrage Playwright inclus par `main`); son expiration engage le secours puis le nettoyage dans le budget monotone de finalisation existant. Les appels directs à `Driver.run` gardent leur propre garde. Sous Windows, les interruptions volontaires utilisent le groupe console de l’enfant (`CTRL_BREAK_EVENT` / `SIGBREAK`). Une terminaison non observable conserve un verdict inconnu dans `process-exit.json`, mais le superviseur quitte avec le code 1.

Les attestations de curseur `raw-copy` / `ledger-prefix` conservent seulement leur première et leur dernière borne, sans modifier les objets retenus; les preuves de jalons et d’échec restent présentes. Leurs empreintes sont calculées progressivement pendant la copie et l’analyse, puis revérifiées indépendamment sur disque à la fin. Une page de collecte produit une seule publication de statut. L’export de progression est déclenché à chaque nouvelle fin de bloc, puis le compteur natif de blocs complétés décide de l’arrêt. La conversion des minutes est arrondie à la milliseconde; le pilote exige des millisecondes entières positives sûres pour JavaScript.

Robustness: only one safety guard is active (including Playwright startup in `main`); expiration enters rescue and cleanup within the existing monotonic finalization budget. Direct `Driver.run` calls retain their own guard. Windows voluntary cancellation uses the child console group (`CTRL_BREAK_EVENT` / `SIGBREAK`). Unobservable termination remains unknown in `process-exit.json`, while the supervisor exits with code 1.

Cursor attestations retain only their first and latest immutable checkpoints; milestone and failure history remains available. Incremental copy/analysis hashes are independently checked against disk at completion. Collection publishes once per page. Progress exports follow new block ends; only the native completed counter decides attainment. UI minutes round to milliseconds, and driver duration requires a positive JavaScript-safe integer.

Signé / Signed: **Codex — GPT-6**.
