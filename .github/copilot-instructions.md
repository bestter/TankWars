# TankWars — Guide pour GitHub Copilot

**GitHub Copilot : lire et appliquer [AGENTS.md](../AGENTS.md) avant toute modification ou revue.** Il centralise les règles communes, les commandes, l’architecture, les contrats du jeu et les chemins utiles. Ce guide contient les directives essentielles pour Copilot.

## Méthode de travail

- Répondre en français québécois et respecter la portée autorisée selon les [règles de travail](../AGENTS.md#règles-de-travail).
- TypeScript strict sans `any` et respect de [`.editorconfig`](../.editorconfig) (UTF-8, fins de ligne LF, indentation 2 espaces).
- Avant d'éditer, vérifier `git status` et le diff existant. Privilégier des modifications chirurgicales et ciblées.

## Gestion des pull requests

### Pull requests créées par Google Labs Jules (Consignes pour agents tiers)

Avant toute interaction ou écriture sur une pull request existante par un agent IA, vérifier rigoureusement l'identité de son auteur dans les métadonnées GitHub (ex. `gh pr view <id> --json author`).

Si la pull request a été créée par l'application GitHub **Google Labs Jules** (identifiant `google-labs-jules` ou `google-labs-jules[bot]`) et que l'agent intervenant **n'est pas Jules lui-même** (agent tiers : Antigravity, Copilot, Claude, etc.) :

- **Interdiction absolue d'ajouter des commentaires ou revues** : Ne publier aucun commentaire général, commentaire de revue, commentaire en ligne sur le diff, réponse à un fil de discussion ou revue GitHub (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`), même vide, afin de ne pas réveiller ni désynchroniser Jules.
- **Aucune notification active** : Ne jamais mentionner `@google-labs-jules` ou `@google-labs-jules[bot]` dans les descriptions de PR ou les messages de commit (utiliser des anti-apostrophes / backticks si le nom doit être cité).
- **Communication par la description uniquement** : Pour consigner les modifications apportées, mettre à jour uniquement le corps/description de la PR (ex. `gh pr edit <id> --body ...`), en préservant scrupuleusement le contenu utile initial et en ajoutant une section distincte au bas (ex. `### Modifications apportées`).
- **Commits et poussées autorisés** : Les commits et les poussées (`git push`) sur la branche de la PR demeurent permis lorsqu'ils sont demandés.
- **Priorité de la règle** : Cette directive prévaut sur toute routine de revue, skill (notamment `code-review-skill`) ou commande automatisée qui génère habituellement des commentaires de PR.
- **Vérification obligatoire** : Ne jamais se fier uniquement au nom de la branche ou à l'auteur d'un commit local. Toujours inspecter l'auteur réel de la pull request sur GitHub avant d'agir, et vérifier après publication qu'aucun commentaire n'a été créé par mégarde.
- **Exception pour Jules** : L'agent Jules lui-même demeure pleinement autorisé à publier des commentaires sur ses propres pull requests (notamment pour expliquer son travail, réagir aux échecs de la CI ou clore ses tâches).

## Références selon la tâche

- [Journaux et erreurs](../AGENTS.md#journaux-et-erreurs).
- [Architecture à préserver](../AGENTS.md#architecture-à-préserver).
- [Contrats sensibles](../AGENTS.md#contrats-sensibles).
- [Commandes](../AGENTS.md#commandes) et [Validation](../AGENTS.md#validation), dont React Doctor obligatoire dans chaque batterie de validation, même sans changement React.
- [Déploiement et staging privé](../README.md#deployment).
- [Gestion des pull requests](../AGENTS.md#gestion-des-pull-requests).

## Livraison

- Appliquer la validation centrale d'[AGENTS.md](../AGENTS.md#validation) et rapporter les résultats réels et les limites restantes.
- Suivre les [consignes de commit et de compte rendu](../AGENTS.md#commits-et-compte-rendu) : message à l'impératif, nom de l'application, identité de l'agent et modèle exact fourni par l'environnement.
