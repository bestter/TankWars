# TankWars — Guide pour Claude

**Agents Claude : lire et appliquer [AGENTS.md](./AGENTS.md) avant toute modification.** Il centralise les règles communes, les commandes, l’architecture, les contrats du jeu et les chemins utiles. Ce compagnon contient seulement des indications de travail pour Claude; il ne doit pas recopier les spécifications ou les tableaux d’équilibrage, ni devenir un journal de changements.

## Méthode de travail

- Répondre en français québécois et respecter la portée autorisée selon les [règles de travail](./AGENTS.md#règles-de-travail).
- Utiliser les outils réellement disponibles dans la session, sans présumer les commandes d’une autre intégration.
- Repérer les fichiers et tests dans [Où intervenir](./AGENTS.md#où-intervenir), puis consulter les contrats applicables avant d’éditer.

## Références selon la tâche

- [Journaux et erreurs](./AGENTS.md#journaux-et-erreurs).
- [Architecture à préserver](./AGENTS.md#architecture-à-préserver).
- [Contrats sensibles](./AGENTS.md#contrats-sensibles).
- [Commandes](./AGENTS.md#commandes) et [Validation](./AGENTS.md#validation), dont React Doctor si React change.
- [Déploiement et staging privé](./README.md#deployment).

## Livraison

- Appliquer la validation centrale et rapporter les résultats réels et les limites restantes, sans conserver de total de tests ou de version du jeu ici.
- Suivre les [consignes de commit et de compte rendu](./AGENTS.md#commits-et-compte-rendu) : application utilisée, identité de l’agent Claude et modèle exact fourni par l’environnement, sans inventer de version ni reprendre la signature d’un autre agent.
