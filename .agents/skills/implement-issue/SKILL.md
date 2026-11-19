---
name: implement-issue
description: >-
  Implémente une issue GitHub dans TankWars de bout en bout : lecture du ticket,
  création d'une branche depuis origin/main, implémentation et tests, batterie de
  validation AGENTS.md, documentation, bump de version optionnel, commit atomique
  signé, push et création de la Pull Request.
  S'active lorsque l'utilisateur demande d'implémenter un ticket ou une issue
  GitHub (ex. « Implémente #440 », « Implémente #440 en v0.16.2 » ou « /implement-issue 440 »).
compatibility: Requires git and GitHub CLI (gh) authenticated.
---

# Implémenter une issue GitHub (TankWars)

Ce skill orchestre l'implémentation complète d'une issue GitHub dans TankWars, de l'analyse jusqu'à l'ouverture de la Pull Request, dans le strict respect de [AGENTS.md](../../../AGENTS.md).

## Entrées

- **Issue** *(requis)* :
  - Numéro entier strictement positif (`440`, `#440`), interprété comme un ticket de `bestter/TankWars`.
  - Ou URL GitHub complète d'une issue de `bestter/TankWars` uniquement : `https://github.com/bestter/TankWars/issues/<N>` (casse libre sur l'hôte et `bestter/TankWars`, `/` final, requête `?…` ou fragment `#…` autorisés).
  - **Refuser et arrêter immédiatement** toute URL ou référence explicite visant un autre hôte, un autre dépôt (ex. `autre/repo#440` ou `https://github.com/autre/repo/issues/440`) ou une ressource qui n'est pas une issue (ex. `/pull/<N>`).
- **Version cible** *(optionnel)* : version explicite (`0.16.2`, `v0.16.2`) ou mot-clé (`patch`, `minor`). **Si non précisée, aucun bump de version n'est effectué.**
- **Validation du plan** *(optionnel)* : si le ticket est clair, enchaîner directement jusqu'à la PR. N'attendre le feu vert après le plan que s'il existe une ambiguïté ou si l'utilisateur demande explicitement « plan d'abord ».

---

## Procédure étape par étape

### Étape 1 : Valider la cible, vérifier le dépôt et lire l'issue

1. Valider la référence d'issue avant toute action Git ou GitHub :
   - Si l'entrée est une URL complète, vérifier que le schéma est `https://`, l'hôte est `github.com`, le dépôt est `bestter/TankWars` (insensible à la casse) et le segment suivant est `/issues/<N>` avec `<N>` entier strictement positif; sinon **arrêter** et signaler l'erreur.
   - Si l'entrée est une référence explicite `<owner>/<repo>#<N>`, exiger `bestter/TankWars` (insensible à la casse); sinon **arrêter**.
   - Si l'entrée est un numéro seul (`<N>` ou `#<N>`), vérifier que `<N>` est un entier strictement positif et cibler `bestter/TankWars`.
2. Vérifier l'état local Git et le dépôt distant :
   ```bash
   git status --short
   git branch --show-current
   git remote get-url origin
   ```
   - Si `origin` ne pointe pas vers `bestter/TankWars`, **arrêter** et avertir l'utilisateur.
   - Si l'arbre contient des modifications locales non commitées hors mandat, **arrêter** et demander à l'utilisateur quoi en faire (ne jamais écraser ni `stash` silencieusement).
3. Lire l'issue complète (y compris les références structurées de PR liées) en ciblant explicitement `bestter/TankWars` :
   ```bash
   gh issue view <N> -R bestter/TankWars --json number,title,state,labels,body,comments,url,closedByPullRequestsReferences
   ```
   - Si l'issue n'est pas ouverte (`state != "OPEN"`), **arrêter** et informer l'utilisateur.
4. Vérifier qu'aucune PR ouverte ne traite déjà cette issue (sources structurées d'abord, puis complément textuel) :
   - **Liens structurés (panneau *Development* et mots-clés de fermeture)** : pour chaque PR retournée dans `closedByPullRequestsReferences` (qui inclut les PR liées manuellement dans le panneau *Development* même sans `#<N>` dans le titre ni la description, mais aussi des PR déjà `MERGED`), vérifier son état réel et ses métadonnées :
     ```bash
     gh pr view <pr_url> --json number,title,state,headRefName,url,author,body,commits
     ```
     Retenir toute PR dont `state == "OPEN"`.
   - **Complément par recherche textuelle** (pour repérer une PR ouverte qui mentionne `#<N>` sans lien *Development* ni mot-clé de fermeture) :
     ```bash
     gh pr list -R bestter/TankWars --state open --search "<N>" --json number,title,headRefName,url,author,body,closingIssuesReferences
     ```
     Pour chaque résultat retourné, **confirmer qu'il correspond réellement à `bestter/TankWars#<N>`** (via `closingIssuesReferences` pointant sur `bestter/TankWars` et `#<N>`, une référence explicite `#<N>` / `bestter/TankWars#<N>` / URL TankWars dans le titre ou la description, ou une branche dédiée `issue-<N>`; si le lien n'apparaît pas dans ces champs, inspecter `gh pr view <pr_url> --json comments,commits` pour trancher) et écarter les faux positifs (nombre sans rapport ou ticket `#<N>` d'un autre dépôt).
   - Si au moins une PR ouverte correspondante est confirmée, **arrêter** et consulter l'utilisateur avant d'agir (après inspection des métadonnées `author,body,commits` pour respecter les consignes de `AGENTS.md` sur les PR Google Labs Jules).
5. Consulter `AGENTS.md` pour les contrats sensibles et les points d'entrée concernés.
6. Si l'issue touche l'HTML, le CSS, le DOM, l'accessibilité, les formulaires, les modales, les animations, la performance Web ou les API navigateur côté client (y compris dans React) : lire et appliquer **impérativement en premier** le skill [modern-web-guidance](../modern-web-guidance/SKILL.md).

### Étape 2 : Analyser et planifier

1. Examiner le code existant et les tests voisins (`__tests__/`) dans les zones touchées par le ticket.
2. Si un point fonctionnel, un critère d'acceptation ou un choix technique important est ambigu : **stopper** et poser les questions précises à l'utilisateur avant de modifier le code.
3. Si l'utilisateur a demandé une validation préalable du plan : présenter le plan et attendre son accord.
4. Sinon (ticket clair) : enchaîner directement avec l'Étape 3.

### Étape 3 : Créer la branche et implémenter

1. Synchroniser `origin/main` et vérifier qu'aucune branche de même nom n'existe déjà :
   ```bash
   git fetch origin
   ```
2. Créer une branche dédiée depuis `origin/main` avec un préfixe adapté au type de ticket (`feat`, `fix`, `perf`, `refactor`, `chore`, `docs`) :
   ```bash
   git switch -c <type>/issue-<N> origin/main
   ```
3. Implémenter strictement ce que demande l'issue :
   - TypeScript strict (jamais de `any`; valider les données externes depuis `unknown`).
   - Utiliser `secureRandom` de `src/utils/random.ts` (jamais `Math.random`), en préservant les RNG injectés et l'ordre des tirages.
   - Respecter `.editorconfig` (UTF-8, fins de ligne LF, saut de ligne final, indentation).
4. Ajouter ou mettre à jour les tests couvrant la fonctionnalité ou la régression corrigée.

### Étape 4 : Documentation et version

1. **Bump de version (uniquement si demandé)** :
   - Si aucune version cible n'a été précisée, ne modifier aucun numéro de version.
   - Si une version cible est fournie (ou calculée via `patch` / `minor` à partir de `package.json`) :
     - Mettre à jour `"version"` dans `package.json`.
     - Mettre à jour les deux champs `"version"` racine dans `package-lock.json` (racine et `packages[""]`).
     - Inclure la version dans l'entrée correspondante de `README.md`.
2. **Documentation** :
   - Mettre à jour `README.md` (et la documentation technique touchée hors fichiers de règles) si le comportement documenté, les fonctionnalités ou les notes de version changent.
   - **Ne modifier aucun fichier de règles (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`) sans demande explicite de l'utilisateur**, conformément à `AGENTS.md`.
   - Si les changements touchent un contrat sensible, une convention opérationnelle ou un point d'entrée d'architecture (ou si le corps du ticket évoque `AGENTS.md`) sans demande explicite de l'utilisateur, **ne pas modifier `AGENTS.md`** : le signaler simplement dans la description de la PR et le compte rendu final afin que l'utilisateur décide s'il souhaite une mise à jour.
   - Même lorsqu'une demande explicite vise `AGENTS.md`, ne pas modifier automatiquement les compagnons (`CLAUDE.md`, `.github/copilot-instructions.md`) et ne pas y maintenir de journal de changements.

### Étape 5 : Validation (bloquante)

Exécuter intégralement et dans cet ordre la batterie de validation définie dans `AGENTS.md` :

1. `npm run lint`
2. `npm run build`
3. `npm run test`
4. `npx --yes react-doctor@latest --verbose --scope changed --blocking warning -y --no-score --no-supply-chain --max-duration 30`
5. `git diff --check`

- Ne pas passer à l'Étape 6 tant que tous les contrôles applicables ne passent pas.
- Appliquer les règles de `AGENTS.md` pour `react-doctor` (budget de temps, signalement explicite si aucun fichier admissible ou si analyse partielle) ainsi que les vérifications ciblées supplémentaires si le ticket touche l'endurance ou `tokenComparison.ts`.
- Pour un changement d'interface, de moteur ou de réseau, indiquer clairement dans le compte rendu si la vérification manuelle a été effectuée ou non.

### Étape 6 : Commit, push et Pull Request

1. Contrôler le diff et l'état du dépôt :
   ```bash
   git status --short
   git diff --stat
   ```
   - S'assurer qu'aucun fichier temporaire, secret ou changement hors mandat n'est inclus.
2. Stager explicitement les fichiers pertinents (`git add -- <fichiers>`) et créer un commit atomique conforme à `AGENTS.md` :
   - Titre à l'impératif : `<type>(<scope>): <résumé à l'impératif> (#<N>)` (ou `— v<X.Y.Z> (#<N>)` si une version a été bumpée).
   - Corps concis expliquant le changement et son objectif.
   - Signature avec le nom de l'application, l'identité de l'agent et le modèle exact fourni par l'environnement.
3. Vérifier le commit créé (`git log -1 --stat`) et pousser la branche (jamais de `git push --force`) :
   ```bash
   git push -u origin <type>/issue-<N>
   ```
4. Créer la Pull Request vers `main` dans `bestter/TankWars` via un fichier temporaire (pour éviter les problèmes d'échappement sous PowerShell), puis supprimer le fichier temporaire :
   ```bash
   gh pr create -R bestter/TankWars --base main --head <type>/issue-<N> --title "<titre>" --body-file <fichier_temp>
   ```
   La description de la PR doit contenir :
   - `Closes #<N>`
   - Résumé des changements et fichiers clés modifiés
   - Commandes de validation réellement exécutées et leurs résultats (incluant statut/diagnostics `react-doctor` et état du contrôle manuel)
   - Mention explicite si un contrat sensible ou un point d'entrée a changé et qu'une mise à jour de `AGENTS.md` pourrait être utile sur demande (sans l'avoir modifié sans autorisation explicite)
5. **Ne jamais merger la PR ni lancer de déploiement.**

### Étape 7 : Vérification finale et compte rendu

1. Confirmer l'état final :
   ```bash
   git status --short
   gh pr view -R bestter/TankWars <type>/issue-<N> --json number,url,title,state
   ```
2. Présenter un compte rendu concis en français québécois :
   - Ce qui a changé et pourquoi
   - Branche, commit (hash et titre) et URL de la PR
   - Commandes de validation exécutées et leurs résultats réels (incluant `react-doctor`)
   - Section `### Modern Web Guidance` si le skill a été activé
   - Limites éventuelles ou vérifications manuelles restantes
