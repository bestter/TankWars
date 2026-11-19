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

- **Issue** *(requis)* : numéro (`440`, `#440`) ou URL GitHub complète.
- **Version cible** *(optionnel)* : version explicite (`0.16.2`, `v0.16.2`) ou mot-clé (`patch`, `minor`). **Si non précisée, aucun bump de version n'est effectué.**
- **Validation du plan** *(optionnel)* : si le ticket est clair, enchaîner directement jusqu'à la PR. N'attendre le feu vert après le plan que s'il existe une ambiguïté ou si l'utilisateur demande explicitement « plan d'abord ».

---

## Procédure étape par étape

### Étape 1 : Vérifier le dépôt et lire l'issue

1. Vérifier l'état local Git :
   ```bash
   git status --short
   git branch --show-current
   ```
   - Si l'arbre contient des modifications locales non commitées hors mandat, **arrêter** et demander à l'utilisateur quoi en faire (ne jamais écraser ni `stash` silencieusement).
2. Lire l'issue complète (description et commentaires) :
   ```bash
   gh issue view <N> --json number,title,state,labels,body,comments,url
   ```
   - Si l'issue n'est pas ouverte (`state != "OPEN"`), **arrêter** et informer l'utilisateur.
3. Vérifier qu'aucune PR ouverte ne traite déjà cette issue :
   ```bash
   gh pr list --search "<N>" --state open --json number,title,headRefName,url,author
   ```
   - Si une PR existe déjà pour ce ticket, **arrêter** et consulter l'utilisateur avant d'agir (et respecter les consignes pour les PR Google Labs Jules dans `AGENTS.md`).
4. Consulter `AGENTS.md` pour les contrats sensibles et les points d'entrée concernés.
5. Si l'issue touche l'HTML, le CSS, le DOM, l'accessibilité, les formulaires, les modales, les animations, la performance Web ou les API navigateur côté client (y compris dans React) : lire et appliquer **impérativement en premier** le skill [modern-web-guidance](../modern-web-guidance/SKILL.md).

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
   - Mettre à jour `README.md` si le comportement documenté, les fonctionnalités ou les notes de version changent.
   - Mettre à jour `AGENTS.md` **uniquement** si un contrat sensible, une convention opérationnelle ou un point d'entrée d'architecture change (sans y tenir de journal de changements et sans toucher `CLAUDE.md` ni `.github/copilot-instructions.md`).

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
4. Créer la Pull Request vers `main` via un fichier temporaire (pour éviter les problèmes d'échappement sous PowerShell), puis supprimer le fichier temporaire :
   ```bash
   gh pr create --base main --head <type>/issue-<N> --title "<titre>" --body-file <fichier_temp>
   ```
   La description de la PR doit contenir :
   - `Closes #<N>`
   - Résumé des changements et fichiers clés modifiés
   - Commandes de validation réellement exécutées et leurs résultats (incluant statut/diagnostics `react-doctor` et état du contrôle manuel)
5. **Ne jamais merger la PR ni lancer de déploiement.**

### Étape 7 : Vérification finale et compte rendu

1. Confirmer l'état final :
   ```bash
   git status --short
   gh pr view --json number,url,title,state
   ```
2. Présenter un compte rendu concis en français québécois :
   - Ce qui a changé et pourquoi
   - Branche, commit (hash et titre) et URL de la PR
   - Commandes de validation exécutées et leurs résultats réels (incluant `react-doctor`)
   - Section `### Modern Web Guidance` si le skill a été activé
   - Limites éventuelles ou vérifications manuelles restantes
