# TankWars — Guide pour GitHub Copilot

**GitHub Copilot : lire et appliquer [AGENTS.md](../AGENTS.md) avant toute modification ou revue.** Il centralise les règles communes, les commandes, l’architecture, les contrats du jeu et les chemins utiles. Ce guide contient les directives essentielles pour Copilot.

## Méthode de travail

- Répondre en français québécois et respecter la portée autorisée selon les [règles de travail](../AGENTS.md#règles-de-travail).
- TypeScript strict sans `any` et respect de [`.editorconfig`](../.editorconfig) (UTF-8, fins de ligne LF, indentation 2 espaces).
- Avant d’éditer, vérifier `git status` et le diff existant. Privilégier des modifications chirurgicales et ciblées.

## Gestion des pull requests

- Pour toute interaction avec une pull request (notamment celles créées par Google Labs Jules), appliquer rigoureusement les directives de [Gestion des pull requests](../AGENTS.md#gestion-des-pull-requests).
- En particulier : interdiction absolue de publier des commentaires, revues ou approbations sur les PR de Jules, ne jamais mentionner son identifiant, et communiquer exclusivement par la mise à jour du corps/description de la PR.

## Références selon la tâche

- [Journaux et erreurs](../AGENTS.md#journaux-et-erreurs).
- [Architecture à préserver](../AGENTS.md#architecture-à-préserver).
- [Contrats sensibles](../AGENTS.md#contrats-sensibles).
- [Commandes](../AGENTS.md#commandes) et [Validation](../AGENTS.md#validation), dont React Doctor obligatoire dans chaque batterie de validation, même sans changement React.
- [Déploiement et staging privé](../README.md#deployment).
- [Gestion des pull requests](../AGENTS.md#gestion-des-pull-requests).

## Livraison

- Appliquer la validation centrale d’[AGENTS.md](../AGENTS.md#validation) et rapporter les résultats réels et les limites restantes.
- Suivre les [consignes de commit et de compte rendu](../AGENTS.md#commits-et-compte-rendu) : message à l’impératif, nom de l’application, identité de l’agent et modèle exact fourni par l’environnement.
