# TankWars — Guide pour Cursor

**Agents dans Cursor : lire et appliquer [AGENTS.md](./AGENTS.md) avant toute modification.** Il centralise les règles communes, les commandes, l’architecture, les contrats du jeu et les chemins utiles. Ce guide contient seulement des indications de travail pour Cursor; il ne doit pas devenir un miroir des autres compagnons ou des spécifications.

## Méthode de travail

- Répondre en français québécois et respecter la portée autorisée selon les [règles de travail](./AGENTS.md#règles-de-travail).
- Utiliser la recherche de fichiers et de symboles disponible dans Cursor pour repérer les points d’entrée indiqués dans [Où intervenir](./AGENTS.md#où-intervenir), puis lire les tests concernés.
- Privilégier des modifications ciblées et présenter les chemins utiles dans le compte rendu.

## Références selon la tâche

- [Journaux et erreurs](./AGENTS.md#journaux-et-erreurs).
- [Architecture à préserver](./AGENTS.md#architecture-à-préserver).
- [Contrats sensibles](./AGENTS.md#contrats-sensibles).
- [Commandes](./AGENTS.md#commandes) et [Validation](./AGENTS.md#validation), dont React Doctor obligatoire dans chaque batterie de validation, même sans changement React.
- [Déploiement et staging privé](./README.md#deployment).

## Livraison

- Appliquer la validation centrale et rapporter les résultats réels et les limites restantes, sans conserver de total de tests ou de version du jeu ici.
- Suivre les [consignes de commit et de compte rendu](./AGENTS.md#commits-et-compte-rendu) : application Cursor, identité de l’agent et modèle exact fourni par l’environnement, sans inventer de version.
