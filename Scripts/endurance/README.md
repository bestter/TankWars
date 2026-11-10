# Pilote d’endurance / Endurance driver — 0.14.0

Le [banc court de décisions EXPERT](decision-bench-361.md) reproduit les cas des tickets [#361](https://github.com/bestter/TankWars/issues/361) et [#400](https://github.com/bestter/TankWars/issues/400) sans lancer d’endurance.

## Français

> v0.13.6 : le protocole du pilote/superviseur est maintenant v2; les indications historiques de fichiers monolithiques ci-dessous décrivent v1. Les sorties actuelles sont précisées dans la section des bundles.

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

## Bundles progressifs / Progressive bundles (#380)

**FR.** Le format d’export `tankwars-endurance-bundle`, `schemaVersion: 1`, est indépendant des schémas métier v1. Le pilote/superviseur utilise `schemaVersion: 2` et rejette les versions inconnues. Utiliser Node 24 (SQLite intégré), Python 3.11+ et Chromium. `--part-size-mib 20` et `--slow-decision-ms 1000` sont des entiers positifs sûrs; la conversion Mio → octets doit aussi être sûre. Un changement de paramètres crée un nouvel export.

**EN.** Export envelope v1 is independent of existing business schemas. Driver/supervisor protocol v2 rejects unknown versions. Use Node 24 with built-in SQLite, Python 3.11+ and Chromium. `--part-size-mib 20` and `--slow-decision-ms 1000` accept positive safe integers, including the MiB-to-bytes conversion. Changing settings starts a new export.

```text
bundle/manifest.json                     # génération, session, paramètres, borne, état
bundle/journal/part-000001.jsonl          # lignes natives intactes / unchanged native lines
bundle/captures/part-000001.jsonl         # journalSequence + ArchiveRecord original
bundle/terrains/part-000001.jsonl         # TerrainRecord dédupliqués / deduplicated
bundle/session/{metadata,blocks,rounds,incidents}/part-*.jsonl
bundle/catalog/page-*.json                # 256 références max, chaîne SHA-256
bundle/index/terrains/*.json              # emplacements UTF-8 / byte locations
bundle/derived/<generation>/index/...     # index machine paginé / paginated indexes
bundle/derived/<generation>/report/...    # HTML statique / static HTML
bundle/index.html                        # lien vers la génération publiée / published report
recovered-bundle/...                     # relecture indépendante / independent recovery
copy/part-*.jsonl                         # copie brute avant analyse / raw copy before analysis
copy/catalog-*.json                      # références bornées / bounded references
copy/checkpoint-*.stream.json             # attestations immuables / immutable checkpoints
technical/process-*.log                  # stdout/stderr fusionnés, rotation aux LF
evidence-*/...                           # preuves et erreurs paginées / paginated evidence
initial.json, progress.json, final.json, recovered.json # résumés légers / lightweight summaries
status.json, process-exit.json, summary.md # petits documents atomiques / atomic status
diagnostic.png, browser-profile/          # capture et profil, hors rotation / not rotated
```

Rotation avant dépassement, limite exacte acceptée, octets multioctets et LF inclus, sans BOM ni normalisation. Un enregistrement trop gros reste seul, marqué `oversized`. Les pages de références contiennent au plus 256 éléments; les vues HTML au plus 200. Les parties closes restent immuables. Les catalogues exposent chemin, type, ordre, octets, SHA-256, nombre et plages de séquences. Les collections de session conservent leurs révisions avec `capturedAtSequence`; les résumés déclarent leur point de capture. Une séance active peut être complètement exportée jusqu’à sa borne sans être terminée. Le suffixe RAM après panne de stockage est séparé sous `unconfirmed/`, sans devenir une preuve persistée.

Rotation occurs before exceeding the byte limit; equality is allowed. UTF-8 bytes and LF count, without BOM or normalization. Oversized records remain alone and flagged. Reference pages hold at most 256 entries; HTML views at most 200. Closed parts are immutable. Catalogs record paths, kinds, order, byte sizes, SHA-256, counts and sequence ranges. Session collections retain revisions and capture boundaries. A running session may be fully exported to a confirmed boundary. Recoverable RAM suffixes remain explicitly unconfirmed and cannot be recovered after reopening.

Même si la première écriture du journal échoue, le bundle partiel conserve le journal en attente et le terrain initial personnalisé sous `unconfirmed/`, tant que la séance demeure en mémoire. La borne confirmée reste inchangée. Après rechargement, seules les données confirmées sont récupérables.

Even if the first journal write fails, the partial bundle preserves the pending journal and custom initial terrain under `unconfirmed/` while the session remains in memory. The confirmed boundary stays unchanged. After reopening, only confirmed data can be recovered.

Le navigateur prépare le ZIP64 en OPFS, sans Blob de séance construit en RAM ni export de secours monolithique. Le pilote consomme directement des morceaux natifs bornés, sans ZIP par bloc ni sérialisation métier Python. Les index et tris utilisent IndexedDB ou SQLite sur disque. Prévoir l’espace pour source, parties temporaires, index et ZIP; les quotas d’export ne changent pas le budget du jeu. Annuler nettoie les temporaires de l’export manuel et conserve la source.

Chromium writes ZIP64 to OPFS. The driver transports bounded native chunks without rebuilding business JSON or creating a ZIP per block. Indexes and exact duration sorting use IndexedDB/SQLite on disk. Allow disk space for the source, staged files, indexes and ZIP in addition to the gameplay archive budget. Cancellation preserves source data.

Les vues sont statiques, sans `fetch(file://)`, CDN ou serveur. Les filtres sont des vues globales paginées. Les identités reposent sur session/bloc/manche, `playerId` et `shotKey`, jamais sur le nom ou `shotId` seul. Les événements capturés ne sont pas recomptés. Durées mesurées existantes seulement : médiane exacte, p95 au rang supérieur, maximum, valeurs manquantes et classement décroissant; égalités par séquence. Zeus, refus et décisions remplacées restent distincts des tirs lancés. Aucun rejeu automatique.

Views work through `file://` with static links. Global filters are paginated. Identities use session/block/round, `playerId` and full `shotKey`. Captured duplicates do not inflate counts. Existing measured decision times supply exact median, nearest-rank p95, maximum, missing values and descending ranks with sequence tie-breaking. Zeus, refusals and replaced decisions remain separate from launched shots. Replay is explicit.

```sh
node Scripts/endurance/validate-archive.mjs bundle/manifest.json
node Scripts/read-shot-archive.mjs bundle/manifest.json --shot 'FULL_KEY' --output shot.json --replay
node Scripts/endurance/build-report.mjs bundle/manifest.json --output report-regenerated
```

L’extraction refuse l’écrasement implicite, valide seulement les fichiers lus et réutilise le validateur TypeScript. La validation intégrale parcourt les parties. La récupération rouvre le même profil une fois après fermeture confirmée; les flux journal/captures/terrains sont comparés octet par octet même si leurs parties diffèrent. Les dernières révisions de collections et la session sont comparées séparément. Les fichiers de preuve sont revérifiés après fermeture. Seuls les échecs des vues dérivées sont non bloquants; les verdicts et codes 0/2/3/1 restent inchangés.

Extraction refuses implicit overwrites and validates the source files it actually reads through shared TypeScript rules. Full validation walks all parts. Recovery reopens the closed profile once and compares native journal/capture/terrain bytes regardless of part boundaries, plus collection revisions and session metadata. Required evidence is checked again after closure. Only derived-view failures are nonblocking; result codes remain 0/2/3/1.

Les tests courts incluent la suite Python, les tests Vitest du bundle, le test Chromium documenté plus haut et le contrôle manuel des exports actif/final/récupéré, de l’annulation, des liens hors ligne et d’un tir. Les mesures doivent séparer collecte, export, ZIP, index et récupération, tas JS, mémoire des processus et espace disque. Aucun gain de performance n’est présumé.

Short validation includes Python, bundle Vitest tests, the Chromium smoke above, active/final/recovered exports, cancellation, offline links and one-shot replay. Measure collection/export/ZIP/index/recovery separately and distinguish JavaScript heap, process memory and disk. No unmeasured performance improvement is claimed.

Mesures reproductibles / Reproducible measurements (Vite en mode endurance; source : dossier d’un bundle réel) :

```sh
npm run dev -- --mode endurance --host 127.0.0.1 --port 5179
# Dans un autre terminal / In another terminal:
ENDURANCE_BUNDLE_SOURCE=artifacts/run/bundle \
ENDURANCE_BUNDLE_DEV_URL=http://127.0.0.1:5179/ \
ENDURANCE_BUNDLE_OUTPUT=artifacts/bundle-measurements-new \
PYTHONPATH=Scripts/endurance python -m unittest discover -s Scripts/endurance/tests -p test_bundle_browser.py -v
```

Sous PowerShell, définir ces variables avec `$env:NAME='value'`. Le test mesure des préfixes de 256/512/1024 entrées avec remplissage déterministe déclaré, parties de 1 Mio et plusieurs pages de collecte; ce sont des données de test, pas de nouvelles observations de combat. Il contrôle le ZIP avec un lecteur indépendant, les liens `file://`, l’absence de requêtes réseau et l’annulation/nettoyage. `measurements.json` sépare durées, disque, pics de tas JS, mémoire navigateur RSS/privée, mémoire du pilote et tas retenu après GC. Les statuts du pilote ajoutent les durées de collecte, export natif, validation et récupération.

PowerShell uses `$env:NAME='value'`. The test uses declared synthetic padding on recorded prefixes, 256/512/1024 entries, 1 MiB parts and multiple collection pages. These are test fixtures, not new combat observations. It independently checks ZIP integrity, all offline links, absence of network requests and cancellation/cleanup. Measurements separate timing, disk, peak JavaScript heap, browser RSS/private memory, driver RSS and retained heap after GC. Driver status also records collection/native export/validation/recovery timings.

Signé / Signed : **Codex — GPT-6**.

## Scénarios personnalisés / Custom scenarios (#362)

**FR.** Le JSON d’échange et sa validation sont décrits dans le [README du dépôt](../../README.md#cartes-dendurance-personnalisées--custom-endurance-maps-362-v0140). Modifier le [croquis ASCII complet](scenarios/issue-361-rock-cliff.txt), puis convertir depuis la racine :

```sh
node Scripts/endurance/scenario.mjs convert Scripts/endurance/scenarios/issue-361-rock-cliff.txt Scripts/endurance/scenarios/issue-361-rock-cliff.json
node Scripts/endurance/scenario.mjs validate Scripts/endurance/scenarios/issue-361-rock-cliff.json
```

Légende : `.` air, `d` terre, `s` meuble, `r` roche. X vers la droite, Y vers le bas; sous la surface d’une colonne, remplir avec le même matériau jusqu’à la dernière ligne. Pour W × H caractères, x utilise `floor(x*W/800)` et Y=`floor(premièreLigneSolide*480/H)`. La fixture 80 × 480 représente 10 × 1 pixels par cellule. Pour modifier une colonne précise ou un X fractionnaire, éditer directement le JSON, puis retirer `terrainId` si le relief a changé; le validateur le recalcule. Caractère inconnu, largeur incohérente, vide, tunnel, surplomb ou matériaux superposés : échec avec ligne/colonne, sans publication d’un nouveau scénario. Un fichier de sortie antérieur reste inchangé en cas d’échec; le code de sortie fait autorité. Exemple : si la première ligne de `croquis-invalide.txt` est `{invalid}`, `node Scripts/endurance/scenario.mjs convert croquis-invalide.txt carte.json` affiche `INVALID_SCENARIO: header must be valid JSON metadata` et termine avec le code **1**; une sortie `carte.json` existante reste intacte.

La clé facultative `scenario` dans la configuration est un chemin **relatif au fichier de configuration**, ou `null`/absente pour générer. `--scenario` est prioritaire et son chemin est **relatif au répertoire d’appel**. Le prévol appelle le validateur TypeScript commun par Node/Vite et refuse le fichier ou une discordance entre départs et profils avant Chromium. L’import Playwright utilise les octets validés, attend l’aperçu et vérifie le nombre verrouillé avant de choisir les profils. Les exports initial, final et récupéré doivent conserver le scénario et les positions initiales exactes.

Configuration fournie : `Scripts/endurance/scenarios/issue-361-rock-cliff.config.json` (SIMPLE puis EXPERT). Après le build d’endurance et `npm run preview`, lancer avec l’identité exacte du build servi :

```sh
python Scripts/endurance/supervise.py --safety-seconds 480 -- --url http://127.0.0.1:4173/ --output artifacts/issue-361-custom-new --expected-build 'SHA/BUILD_TIMESTAMP' --config Scripts/endurance/scenarios/issue-361-rock-cliff.config.json --duration-ms 180000 --completed-blocks 2 --finalization-seconds 120 --safety-seconds 420
```

Pour imposer un autre fichier : ajouter `--scenario chemin/vers/carte.json`. Dans l’écran React, importer le même JSON, garder SIMPLE à l’emplacement 1 et choisir EXPERT (`v4-smart`) à l’emplacement 2. Les modes généré et personnalisé conservent les plafonds, règles d’arrêt et stocks du pilote. La fixture n’ajoute aucun incident #361.

Le test physique de la fixture reconstruite mesure MISSILE **149.5° / 57** → impact ROCK **(675.995843, 314.424137)**, sans dégâts; **127.5° / 96** → impact direct du premier tank **(126.362645, 398.885298)**, −37.212 bouclier puis −14 PV de chute (roster initial 100/40, vent 48.2, gravité 260). Le relief historique complet manque : aucun choix d’EXPERT ni correctif de #361 n’est revendiqué. Les archives restent compatibles avec `node Scripts/read-shot-archive.mjs manifest.json --shot 'CLÉ' --output shot.json --replay`.

**EN.** A sketch starting with `{invalid}` makes `node Scripts/endurance/scenario.mjs convert invalid-sketch.txt map.json` report `INVALID_SCENARIO: header must be valid JSON metadata`, exit **1**, and preserve any existing output. Use the same JSON in the React importer and driver. The optional configuration `scenario` path resolves from the configuration directory; CLI `--scenario` resolves from the calling directory and takes precedence. Null or absent keeps generated terrain. Shared TypeScript validation and roster-count checks run before the browser starts. The supplied ASCII sketch, deterministic conversion command and SIMPLE/EXPERT configuration reproduce the reference geometry. Every round/block starts with the original map and wind; current combat recovery retains damage. The initial terrain is stored once even before firing, and subsequent shots reference the terrain they actually used. Initial, final and recovered exports are checked. The measured blocked and high shots concern the reconstructed fixture only, not an exact replay of the historical map or an EXPERT solver fix.

Documentation #362 : Codex — GPT-6.
