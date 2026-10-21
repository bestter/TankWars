# Journal fidèle des IA et de l’économie — 0.11.0

Cette étape ajoute un journal JSONL au mode endurance des builds de test. Elle ne lance aucun nouvel essai prolongé et ne déploie aucun artefact. L’essai de quatre heures décrit dans `endurance-0.11.0.md` précède ce journal et ne le valide pas.

Les quatre profils exposent une observation facultative : commande évaluée disponible, cible et point explicitement fournis, perturbations successives et commande retournée. Le moteur confirme séparément les paramètres de lancement et les tirages physiques CLUSTER/GRENADE. Les crédits réellement appliqués conservent leur cause, les soldes et les composantes rationnelles du calcul; les achats proviennent des transactions unitaires acceptées et sont publiés après application du roster. Les sorties anticipées, annulations, refus et reprises restent distincts. Aucune visée supplémentaire ni aucun tirage explicatif n’est exécuté.

La base IndexedDB passe à la version 2 par migration additive. Les résultats JSON restent en schéma v1. Le journal v1 possède une séquence de session, une enveloppe de contexte et des événements typés. Un en-tête JSONL décrit les séquences émises/persistées et l’état complet ou incomplet. Les identifiants causaux des tirs, munitions, frappes Zeus et visites sont dans les événements; l’identifiant de décision et les frontières bloc/manche/tour sont dans l’enveloppe. Les coordonnées suivent le moteur : pixels, x vers la droite, y vers le bas; angle en degrés, 0 vers la droite, 90 vers le haut, 180 vers la gauche. `null` signifie indisponible et non une valeur reconstituée.

Les écritures sont sérialisées avec les checkpoints, en lots de 256 au maximum, avec vidage chaque seconde et aux frontières. La file est plafonnée à 2 048 entrées, y compris le lot en cours. Une panne ou saturation arrête explicitement la collecte; les entrées non confirmées restent exportables tant que la page demeure ouverte. Après crash, seules les écritures confirmées sont garanties. Aucun combat ne reprend. Le pilote privé préparé pour 20 manches par bloc et six heures lit les pages persistées et les ajoute sur disque, sans conserver l’historique complet. Il n’est ni lancé ni déployé dans cette étape.

## Validation

Les tests ciblent la parité des quatre profils avec/sans observation, y compris les valeurs et l’ordre RNG, les gaffes et réactions, l’absence explicite de cible/commande nominale, la parité des trajectoires physiques, les arguments réellement lancés, les crédits appliqués et leur idempotence, les achats unitaires, vingt manches et la réinitialisation du bloc suivant, les séquences, migrations, pages, saturations, erreurs et exports. La passerelle locale vérifie aussi son exclusion des modes publics et son nettoyage compatible avec StrictMode.

Validation du 21 octobre 2026 sur les modifications locales non committées, à partir du commit `91c9a01b537e882aa2dbaae73e0462a83873b8c0` :

| Vérification | Résultat |
| --- | --- |
| `npm run lint` | Réussi |
| `npm run build` | Réussi, types client et Worker; avertissement Vite de taille du chunk principal |
| `npm run test` | 118 fichiers, 1 881 tests réussis |
| `npm run doctor -- --verbose --scope changed --blocking warning` | 55 fichiers analysés, 100/100, aucun diagnostic restant |
| `git diff --check` | Réussi |
| `npm run build -- --mode endurance` avec sortie privée distincte | Réussi |
| Inspection des deux artefacts | Stockage/journal/passerelle dédiés absents du build public, présents dans le build endurance |
| Pilote privé | Compilation Python réussie; pagination, vérification de séquences et réconciliation incrémentale préparées; aucun lancement |

Les trois attentes séquentielles signalées initialement par React Doctor sont intentionnelles : un lot attend son écriture confirmée et chaque page dépend de la dernière séquence lue. Des exceptions locales documentées préservent ces contrats; aucune règle globale n’est désactivée. La recherche des composantes économiques par bénéficiaire utilise maintenant un index. Le test de particules qui réutilisait une carte nouvellement générée au hasard réinstalle une situation contrôlée pour vérifier le nettoyage. Les versions des dépendances existantes sont préservées; `fake-indexeddb` est ajouté uniquement pour les tests de migration et de transactions.

Le menu et la configuration FR/EN ont été vérifiés dans le navigateur sans démarrer de session. Les tests d’interface téléchargent le JSONL avec un combat remplacé par une fixture et vérifient la récupération incomplète; ils ont aussi permis de corriger l’accès au menu avant confirmation de la sauvegarde finale. Le parcours réel combat/célébration/boutique/manche suivante n’a pas été rejoué manuellement dans cette étape; il demeure couvert par les tests d’intégration existants. La collecte détaillée et le pilote attendent leur prochain essai réel autorisé. Aucun succès d’un nouvel essai de quatre ou six heures n’est revendiqué.

Au terme de la validation, les changements étaient locaux, sans commit, push, changement de PR, déploiement ou lancement autonome. Leur publication ultérieure est distincte de cette validation et ne déclenche aucun essai d’endurance. Le protocole, le Worker et les fichiers de règles demeurent inchangés; aucun envoi analytique ou service réseau n’est ajouté par le journal. Les données brutes et les renseignements opérationnels privés demeurent hors du dépôt.

## Correction de la journalisation des boutiques réelles

Un essai autonome de quinze minutes, configuré en blocs de trois manches, a été interrompu par le pilote de vérification après environ 91 secondes. La première manche avait terminé; à l'entrée de la deuxième, l'événement 509 contenait les soldes après achats, sans événements de visite ni d'achat intermédiaires. Les transactions observées correspondent aux variations de stock et aux prix du catalogue. Ce résultat ne démontre aucune erreur de calcul économique et ne valide pas quinze minutes continues.

La fonction `hotseatHostFrom` omettait de propager la session d'endurance vers le traitement des boutiques IA. Le correctif transmet cet observateur facultatif, sans modifier les règles d'achat, les prix, les profils, les tirages RNG, le protocole ou le Worker. Les visites avec et sans achats sont maintenant observées dans le parcours complet.

Deux scénarios d'intégration supplémentaires couvrent les quatre profils, avec 250 ou zéro unité d'argent initial : célébration, résumé, boutique réelle, achats unitaires, réconciliation des soldes et stocks à la manche suivante, et absence de boutique après la dernière manche du bloc. Les deux scénarios échouent avant le correctif (zéro visite au lieu de quatre) et passent après. Ils complètent les tests unitaires qui appelaient auparavant les observateurs directement, sans couvrir leur transmission par l'orchestration.

Le pilote privé conserve dorénavant l'événement reçu sur disque avant de le valider. En cas d'échec, il tente un arrêt avec sauvegarde, les exports finaux et une capture avant de fermer le navigateur. Le motif d'échec initial reste distinct des erreurs de récupération, et les anciens compteurs sont signalés comme périmés si aucun nouvel export n'a pu être obtenu. Quatre tests Python isolés couvrent la conservation de l'événement fautif, la récupération, les erreurs secondaires et la fermeture normale. Le pilote, ses tests, les données brutes et les paramètres du serveur restent hors Git.

Validation du correctif le 21 octobre 2026, exécutée dans l'ordre prescrit :

| Vérification | Résultat |
| --- | --- |
| `npm run lint` | Réussi après retrait d'un paramètre inutilisé du stockage de test |
| `npm run build` | Réussi, types client et Worker; avertissement Vite sur le chunk principal supérieur à 500 Ko |
| `npm run test` | 118 fichiers, 1 887 tests réussis |
| `npm run doctor -- --verbose --scope changed --blocking warning` | 55 fichiers, 100/100, aucun diagnostic |
| `git diff --check` | Réussi |
| Build endurance avec sortie privée distincte | Réussi |
| Pilote privé | Quatre tests Python réussis et compilation réussie des deux points d'entrée et du module de récupération |

Un parcours local réel dans Chromium a exercé le menu, le combat des quatre profils, la célébration, le résumé, la boutique et le début de la deuxième manche. Build mesuré : `38efdae73650b8a7d5e5b623f9549b14b47366d4-dirty/2026-10-21T15:33:56.648Z`, incluant le correctif. Arrêt manuel après environ 139 secondes : une manche terminée sur deux commencées, aucun incident ni erreur de stockage. Le JSONL exporté est complet : 626 événements consécutifs, quatre débuts et quatre fins de visite, vingt achats unitaires. Le rapprochement original du pilote passe sur chaque événement, y compris les instantanés après boutique; aucun écart d'argent ou de stock. Le dernier bloc est interrompu volontairement par cet arrêt manuel. Les preuves brutes et la capture restent privées.

Aucun essai prolongé réussi n'est déduit de ce parcours court, des tests simulés ni de l'essai interrompu. Aucun redéploiement du staging n'est effectué pour cette correction. Les avertissements jsdom Canvas et Node sur `--localstorage-file` demeurent sans échec de test. Les modifications du pilote privé ont nécessité un accès adapté aux fichiers temporaires Windows pour exécuter leurs tests.

Codex — GPT-6
