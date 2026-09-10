# Rapport de révision d’AGENTS.md

Date : 10 septembre 2026.

## Résultat et portée

`AGENTS.md` passe de **209 à 139 lignes**, soit environ **33 % de lignes en moins**. Il privilégie maintenant les consignes de travail, les frontières d’architecture et les contrats qui préviennent des régressions. Les détails d’équilibrage sont remplacés par des renvois aux sources et à leurs tests.

La comparaison prend comme point de départ le fichier de travail, qui contenait déjà trois ajouts non commités sur les tests, les décisions IA et les erreurs. Leur intention est conservée et leur formulation corrigée. Seuls `AGENTS.md` et le présent rapport sont modifiés ou créés; aucun changement de code, de compagnon, de workflow ou de configuration distante n’est inclus.

## Décisions de structure et de méthode

1. **Recentrer le rôle du fichier.** L’introduction distingue les consignes opérationnelles des règles détaillées du jeu. Les tableaux de prix, de probabilités et de coordonnées vieillissent plus vite que les règles d’architecture; les répéter oblige à entretenir plusieurs copies.

2. **Conserver les liens vers les cinq compagnons.** Ils restent accessibles selon l’outil utilisé. Ils n’ont pas été réécrits : le mandat nomme `AGENTS.md` et la règle existante exige une demande explicite pour les fichiers de règles. Leurs répétitions restent une limite connue de cette révision.

3. **Corriger la langue et uniformiser les formulations.** Les sections deviennent françaises, les fautes d’accord des ajouts sont corrigées, et les formulations comme « Douter → demander » sont précisées. Une question est requise lorsqu’une ambiguïté touche le comportement ou la portée; la consigne ne force pas à demander pour chaque choix rédactionnel.

4. **Rendre explicite la préservation du travail local.** Ajouter la lecture de `git status` et du diff avant édition protège les changements déjà présents. Cette précaution s’est appliquée ici aux trois ajouts de l’utilisateur.

5. **Conserver zéro `any` et préciser l’alternative.** La validation depuis `unknown` donne une marche à suivre pour les données externes sans relâcher TypeScript strict ni proposer un contournement par assertion.

6. **Conserver `.editorconfig` comme référence.** Résumer UTF-8, LF, saut final et exceptions rend la consigne exécutable, tout en laissant les détails par extension dans leur fichier source. Les deux documents produits utilisent UTF-8 sans BOM et LF.

7. **Préserver l’exigence de tests et ajouter la documentation touchée.** Toute fonctionnalité demeure accompagnée de tests. Un test de régression est demandé lorsque possible pour les bogues. Il n’est pas nécessaire d’inventer un test applicatif qui vérifierait seulement la rédaction de ce guide.

8. **Distinguer spécification et implémentation.** Ajouter qu’une idée ou un ticket non approuvé ne devient pas automatiquement une règle du jeu évite de transformer une piste de conception en comportement livré. Aucun ticket distant n’a été présenté comme vérifié pendant ce travail.

## Commandes, validation et livraison

9. **Vérifier les commandes contre `package.json`.** Conserver les scripts existants et ajouter `npm run preview`, utile pour vérifier un build. Les ports locaux sont conservés. La commande de déploiement demeure documentée sans déclencher de publication.

10. **Ajouter l’environnement CI réel.** `.github/workflows/ci.yml` utilise Node.js 24 et `npm ci --ignore-scripts`; ces informations permettent de reproduire son installation. `npm install` reste la commande locale existante. Aucun changement de dépendances n’est effectué.

11. **Retirer le total figé « 802 tests, 77 fichiers ».** Il n’est pas une règle et devient périmé avec la suite. Le guide demande dorénavant de rapporter le résultat effectivement obtenu. Les anciens totaux des compagnons ne sont pas synchronisés dans ce mandat.

12. **Garder l’ordre lint → build → tests et ajouter `git diff --check`.** La validation existante n’est pas allégée. Le contrôle final complète les outils applicatifs par la vérification des erreurs d’espacement du diff.

13. **Préciser le traitement des échecs.** Corriger les échecs liés au mandat demeure requis. Un échec préexistant ou environnemental doit être signalé, plutôt que servir de prétexte à des modifications sans rapport ou à une déclaration de succès inexacte.

14. **Préserver l’ancienne ancre de validation.** Une ancre HTML `verification-checklist` conserve les liens déjà utilisés par les compagnons malgré le titre français « Validation ».

15. **Rattacher React Doctor à sa procédure et au workflow.** Le lien pointe directement vers le skill du dépôt. La précision `blocking: warning` vient du workflow lu, et non d’une supposition sur les règles GitHub distantes. Aucun diagnostic React n’a été lancé pour cette modification exclusivement documentaire.

16. **Ajouter la validation manuelle conditionnelle.** Les changements d’interface, de moteur ou de réseau nécessitent de parcourir le comportement concerné; les commandes seules ne prouvent pas son rendu ou sa reprise après déconnexion. Cette exigence est conditionnée au type de modification et ne prétend pas qu’un parcours manuel a été exécuté ici.

17. **Rendre la signature de commit indépendante d’un fournisseur.** Remplacer l’exemple Grok par le nom de l’application, l’identité de l’agent et le modèle exact fourni par l’environnement évite les signatures copiées et les numéros inventés. L’impératif est conservé. Aucun commit n’est créé dans ce mandat.

18. **Distinguer les états de livraison.** Le compte rendu doit séparer travail local, commit, push, PR et déploiement. Une modification de fichier ne prouve pas une publication.

## Journaux et erreurs

19. **Lever l’ambiguïté sur « décisions de l’IA ».** La consigne désigne les tanks du jeu. Elle ne demande pas à un agent de développement d’écrire son raisonnement dans la console du navigateur.

20. **Rendre DEBUG concret pour le client.** Le guide utilise `import.meta.env.DEV` pour les traces de développement et leur calcul, sans inventer un drapeau global `DEBUG`. Cela exprime la règle à appliquer; cela ne signifie pas que toutes les stratégies actuelles la respectent déjà.

21. **Distinguer navigateur et Worker.** Les erreurs du serveur ne peuvent pas toutes être journalisées directement dans une console navigateur. Elles vont dans les journaux Worker; les erreurs clientes restent dans le navigateur. Le texte conserve les niveaux appropriés et ajoute du contexte utile ainsi qu’un message utilisateur lorsqu’une action échoue.

22. **Documenter la suppression actuelle des avertissements.** `src/main.tsx` neutralise notamment `console.warn`, `console.log` et `console.debug` en production, mais conserve `console.error`. Le guide expose cette limite pour éviter qu’une erreur de production soit signalée uniquement par une méthode neutralisée. Aucun changement de cette politique ni audit exhaustif des journaux n’est inclus.

23. **Éviter les erreurs silencieuses et les secrets dans les traces.** Ces précisions rendent l’exigence de journalisation utile au diagnostic sans encourager l’exposition de données sensibles. Elles n’ajoutent pas de dépendance ou de nouveau mécanisme de journalisation.

## Architecture et règles du jeu

24. **Corriger « boucle rAF 120 Hz ».** `GameEngine.ts` fixe `PHYSICS_DT` à `1 / 120`, tandis que `requestAnimationFrame` cadence le rendu. Le tableau distingue maintenant ces deux mécanismes et conserve les frontières React/Canvas, les refs et le démontage du Canvas au menu.

25. **Regrouper les responsabilités partagées et serveur.** Le tableau ajoute les domaines réutilisés par le client et le Worker, leur indépendance de plateforme et la validation des entrées réseau. Le lien de compilation entre les projets TypeScript reste explicite.

26. **Retirer les détails visuels et numériques redondants.** Les offsets des jauges, probabilités de spawn, prix individuels, multiplicateurs détaillés des matériaux, formules de poussée et durées des overlays sont retirés du guide. Les sources sont `TankManager.ts`, `tankSprite.ts`, `src/types/weapon.ts`, `src/types/terrain.ts`, `PhysicsEngine.ts` et les composants concernés. Aucun de ces comportements n’est modifié.

27. **Conserver les distinctions physiques risquées.** Amplification du bouclier versus santé, chute sans bouclier, BULLDOZER sans explosion, puits DRILLER, rebond GRENADE, repli des matériaux à DIRT et protection contre un second tour restent visibles. Ce sont des distinctions qu’un agent pourrait facilement casser en factorisant du code.

28. **Résumer l’économie par ses invariants.** Retirer le barème complet des gains, mais conserver calcul rationnel, arrondi unique, entier sûr, absence de gain d’auto-dégât, application unique et différence entre gain de manche et solde. Les montants restent définis dans `shotRewards.ts`.

29. **Conserver les frontières et personnalités IA.** Le contrat local, le routeur, les quatre profils, les restrictions SIMPLE et la particularité SNIPER restent documentés. La pseudo-signature `Promise<FireCommand>` est remplacée par un renvoi à l’interface réelle, qui retourne actuellement un objet angle/puissance/arme optionnelle.

30. **Retirer les tableaux de visée et de réaction, conserver leurs contrats.** Les bandes M1/M5/M12, résidus, seuils et pourcentages sont à lire dans `fallibleAim.ts`, `hitReaction.ts` et leurs tests. Les resets de cible/manche, la consommation unique, le plafonnement jusque dans les snapshots et les contrats de RNG restent dans le guide.

31. **Intégrer le chargement IA à la bonne section.** La section historique « Chargement et couverture IA (#212) », placée après les commits, disparaît comme section autonome. Son exigence de chargement différé après le court-circuit SIMPLE rejoint les règles IA. Les détails des scénarios de tests restent dans la suite plutôt que dans un journal de livraison.

32. **Ajouter le point d’entrée EXPERT manquant.** `expertTactics.ts` et son utilisation dans `AISmartStrategy.ts` existent dans le dépôt. Le guide renvoie vers ces fichiers et leurs tests, et rappelle que la sécurité géométrique n’est pas une garantie de survie. Il ne recopie pas les probabilités ou le classement des sous-ensembles déjà décrits dans le README.

33. **Clarifier les RNG.** `secureRandom` reste obligatoire; l’ajout sur les générateurs injectés et l’ordre des tirages évite de remplacer une source déterministe testée par un appel global. Le jet tactique EXPERT reste distinct de la gaffe.

34. **Résumer les achats IA sans perdre leurs garanties.** Retirer le tableau d’ordres et plafonds par arme au profit de `aiShopHelper.ts` et `shopPolicy.ts`. Conserver nombre initial de joueurs, transactions unitaires, quotas, absence de budget/réserve/vente automatique et propagation du roster local. Ajouter la différence vérifiée entre le repli boutique OK et le repli combat SIMPLE.

35. **Réduire la procédure de nomination du menu.** Conserver unicité indépendante de la locale, stabilité après changement de langue et absence de renommage rétroactif. Les étapes exactes des suffixes et du déclenchement de validation sont renvoyées à `playerNameUi.ts` et aux tests du menu.

## Réseau, protections et navigation

36. **Retirer l’historique de branche du multijoueur.** La mention « dans main, plus AddMultiplayer » n’aide pas à modifier le code. La séparation entre physique cliente et autorité serveur reste explicite. Le guide ajoute que `maybeRunAIServerTurn` utilise encore une `fakeCommand`, fait vérifié dans le Worker.

37. **Préserver les garanties réseau et réduire les détails d’implémentation.** Intention FIRE, écho SHOT, tireur humain, rejet visible, validation en profondeur, compatibilité v0, ack corrélé, retries, idempotence, persistance, relève de l’autorité et ordre de reprise sont conservés. Les bornes numériques, versions et détails comme le délai du toast sont renvoyés au protocole et au code.

38. **Rendre la consigne de déploiement moins ambiguë.** L’ordre Worker → santé/protocole → client est conservé, avec comparaison aux constantes attendues plutôt qu’à des numéros copiés. L’interdiction d’auto-déploiement est précisée pour Cloudflare Pages : le dépôt possède séparément un workflow GitHub Pages sur push `main`. Aucun réglage Cloudflare ou GitHub distant n’a été inspecté ou modifié; le rapport ne prétend pas que l’auto-déploiement distant est désactivé.

39. **Réduire Zeus à ses frontières et garanties.** Les seuils, détails de nomination, durée d’animation et montant de prime sont renvoyés aux domaines Zeus. L’interdiction d’en faire une arme, les resets, l’équité intermanches, la séparation des agresseurs, l’autorité serveur, la restauration et l’idempotence restent. Les effets visuels ne consomment toujours pas le RNG de salle.

40. **Conserver la protection CSP sans généralisation.** L’obligation `style-src 'unsafe-inline'` reste liée au client actuel et à `csp.test.ts`. La phrase absolue affirmant que Vite et React en ont universellement besoin est retirée; ce guide documente la contrainte de ce dépôt.

41. **Fusionner les rappels en double.** Les interdictions Canvas, la compilation Worker, le repli DIRT, la boutique locale et Zeus n’apparaissent plus dans une deuxième section « Pièges fréquents ». Elles sont placées près du domaine concerné.

42. **Raccourcir et corriger la carte des fichiers.** Les chemins sont explicitement relatifs à la racine et incluent les vrais préfixes, notamment `src/game/engine/` et `src/utils/onlineSession.ts`. Les domaines regroupent les fichiers voisins, avec indication des tests `__tests__/`; les locales, les workflows et les points d’entrée manquants sont ajoutés.

## Validation et limites

| Contrôle | Résultat |
| --- | --- |
| `npm run lint` | Réussi, code de sortie 0 |
| `npm run build` | Réussi, vérification TypeScript et build Vite, code de sortie 0 |
| `npm run test` | Réussi après relance : 854 tests dans 79 fichiers, code de sortie 0 |
| `git diff --check` | Réussi |
| Documents produits | UTF-8 sans BOM, LF, saut final et liens Markdown locaux vérifiés |
| Portée finale | `AGENTS.md` modifié et `RAPPORT-AGENTS.md` ajouté seulement |

Le premier lancement des tests a échoué avant leur exécution avec `EPERM` lors de l’écriture du fichier temporaire de configuration dans `node_modules/.vite-temp/`. La relance avec les permissions nécessaires a réussi, sans modification de code ni suppression de cache. La sortie comporte des diagnostics Vite, jsdom Canvas et `--localstorage-file`; ils n’ont pas fait échouer la suite.

Aucun test applicatif ajouté, diagnostic React Doctor ou parcours manuel du jeu : le changement est exclusivement documentaire. Cette révision n’implémente pas la journalisation complète des décisions IA et ne synchronise pas les compagnons. Aucun commit, push, PR ou déploiement n’est effectué.
