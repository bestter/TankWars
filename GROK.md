# TankWars — Guide pour Grok

**Agents Grok (xAI) : lire et appliquer [AGENTS.md](./AGENTS.md) avant toute modification.** Il centralise les règles communes, les commandes, l’architecture, les contrats du jeu et les chemins utiles. Ce compagnon contient seulement des indications de travail pour Grok; il ne constitue ni une copie des spécifications ni un journal de changements.

## Méthode de travail

- Répondre en français québécois. Préserver le diff existant et limiter les modifications au mandat, conformément aux [règles de travail](./AGENTS.md#règles-de-travail).
- Utiliser les outils réellement disponibles dans la session pour chercher, lire, éditer et suivre l’avancement. Ne pas présumer la présence de commandes propres à une autre intégration, comme `search_replace`, `todo_write` ou `enter_plan_mode`.
- Pour un travail en plusieurs étapes, garder un suivi à jour; ne déclarer une étape terminée qu’après vérification. Pour un processus long, conserver le moyen de récupérer sa sortie et son code de retour.
- Avant de modifier le rendu ou le moteur, consulter les points d’entrée de la section [Où intervenir](./AGENTS.md#où-intervenir), puis les tests concernés. Dans les boucles exécutées à chaque frame, éviter les allocations inutiles et réutiliser les structures existantes lorsque possible.
- Pour le staging privé, suivre le [README — Deployment](./README.md#deployment) : build local seulement avec `VITE_HOTSEAT_ONLY=true`, sans déploiement Worker. Pour la production multijoueur, appliquer la procédure distincte d’[AGENTS.md](./AGENTS.md#multijoueur-et-déploiement).

## Références obligatoires selon la tâche

| Sujet | Consigne centrale |
| --- | --- |
| Types, tests, portée et format | [Règles de travail](./AGENTS.md#règles-de-travail) et [`.editorconfig`](./.editorconfig) |
| Décisions des tanks IA, traces de développement et erreurs client/serveur | [Journaux et erreurs](./AGENTS.md#journaux-et-erreurs) |
| Frontière React/Canvas et pas physique | [Architecture à préserver](./AGENTS.md#architecture-à-préserver) |
| Combat, économie, IA, réseau et Zeus | [Contrats sensibles](./AGENTS.md#contrats-sensibles) |
| Commandes et contrôles, dont React Doctor obligatoire dans chaque batterie de validation, même sans changement React | [Commandes](./AGENTS.md#commandes) et [Validation](./AGENTS.md#validation) |

## Livraison

- Exécuter la validation d’`AGENTS.md` dans l’ordre prescrit et rapporter les résultats réels, sans total de tests figé dans ce guide.
- Suivre les [consignes de commit et de compte rendu](./AGENTS.md#commits-et-compte-rendu). Utiliser l’identité Grok, l’application utilisée et le modèle exact fourni par l’environnement; ne pas recopier un ancien numéro de modèle.
- Distinguer le travail local, le commit, le push, la PR et le déploiement. Ne déclarer une publication qu’après vérification.
