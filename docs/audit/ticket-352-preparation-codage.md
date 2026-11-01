# Rapport de préparation au codage — Ticket #352

**Verdict : PRÊT À CODER. Aucune correction bloquante de spécification confirmée.**

La version révisée du ticket définit suffisamment les décisions de jeu, les priorités et les résultats inconnus pour permettre l’implémentation sans inventer de règle. Elle exige toutefois une modification importante de la circulation des prévisions, de la sélection et de l’observation. Ce n’est pas un simple filtre à ajouter au résultat d’une stratégie.

« Prêt à coder » ne signifie pas que la fonctionnalité est déjà validée, que sa performance sera acceptable ou que ses tests existent. Les risques ci-dessous devront être contrôlés pendant l’implémentation et avant la fusion.

Date : 28 octobre 2026, heure de Toronto.

Auteur : **GPT-6 — Codex**.

## 1. Sources et portée

- [Ticket #352](https://github.com/bestter/TankWars/issues/352), ouvert, sans commentaire au moment de la lecture; dernière modification retournée par GitHub : `2026-10-28T17:38:35Z`.
- Branche locale `main`, répertoire de travail propre avant l’analyse.
- Commit local et tête de `main` retournée par le connecteur GitHub : [`13ee4d9272c45360d83506d2d3bbe0c2fad2217e`](https://github.com/bestter/TankWars/commit/13ee4d9272c45360d83506d2d3bbe0c2fad2217e). C’est aussi le commit cité par le ticket.
- Lecture des stratégies EXPERT/SNIPER, du planificateur, des évaluateurs et replis, de la physique isolée, des menaces BULLDOZER, du solveur balistique, de la mémoire et du RNG, du conseiller et de son contrôleur, de l’observation et du journal endurance, ainsi que des tests pertinents.

L’analyse porte sur la faisabilité et la cohérence fonctionnelle de #352. Aucun audit de sécurité spécialisé ni travail multi-agent n’a été effectué. Aucun changement de source, de règle de jeu ou du ticket GitHub n’a été fait.

## 2. Classement des risques par gravité

Les niveaux ci-dessous décrivent les conséquences d’une mauvaise implémentation. Les écarts entre les API actuelles et les besoins de #352 ne sont pas, à eux seuls, des défauts du ticket : plusieurs sont déjà explicitement couverts par ses exigences.

| Ordre | Gravité du risque | Sujet | État de la spécification |
| --- | --- | --- | --- |
| 1 | Élevée | État physique après tir absent des résultats actuels | Couvert; adaptation indispensable |
| 2 | Élevée | Candidats éliminés trop tôt et incomplétude perdue | Couvert; refactorisation indispensable |
| 3 | Élevée | Modification accidentelle de SURVIE ou dépendance économique du détecteur | Couvert; isolation à prouver |
| 4 | Élevée | Réutilisation de caches entre états ou cibles incompatibles | Couvert; isolation à prouver |
| 5 | Élevée | Mémoire, callbacks et séquence RNG engagés sur une cible provisoire | Couvert, notamment par la correction 2A |
| 6 | Élevée, impact non mesuré | Temps de calcul et pauses du rendu | Mesures exigées; résultat encore inconnu |
| 7 | Moyenne | Diagnostics absents en endurance compilée ou données trop volumineuses | Couvert; validation hors DEV nécessaire |
| 8 | Moyenne | Départages différents entre plan principal, repli et conseiller | Couvert par 4B, 6A et 9A |
| 9 | Moyenne | Traces du conseiller doublées ou rattachées à une requête périmée | Couvert; cycle de vie à instrumenter |
| 10 | Faible | Formulations générales pouvant masquer les exceptions prioritaires | Clarifications rédactionnelles recommandées, non bloquantes |

### 2.1. État après tir : les agrégats ne permettent pas de reconstruire la deuxième simulation

**Constat.** `createResolution` crée bien des joueurs et un terrain isolés. Cependant, `finishResolution` ne retourne que les conséquences, impacts, survivants et informations de support. Les positions finales, le roster complet et la heightmap finale ne sortent pas de cette résolution.

**Conséquence possible.** Déduire l’état après tir des dégâts agrégés omettrait notamment le déplacement d’un BULLDOZER, un cratère, les chutes, les modifications de support ou des victimes collatérales. La recherche du prochain coup pourrait alors annoncer une transition inexistante ou manquer une transition réelle.

**Travail nécessaire.** Conserver l’état réellement stabilisé dans une structure interne; y appliquer exactement la consommation de la munition du premier tir. Préserver l’association entre la résolution et cet état malgré les copies `{ ...resolution, profit }`. Les objets transmis au conseiller ou au journal ne doivent pas embarquer les instances de terrain.

Le test réel demandé par le ticket est essentiel : un double qui fournit un état fabriqué ne démontrerait pas que le chemin de production le conserve. À l’inverse, accepter les anciens doubles sans cet état avec `after-state-missing` est une compatibilité de test, pas une solution de production.

**Sources :** [physicalShotForecast.ts](../../src/game/entities/ai/physicalShotForecast.ts), fonctions `createResolution`, `finishResolution`, `resolvePhysicalShot`; [expertShotEvaluator.ts](../../src/game/entities/ai/expertShotEvaluator.ts), `forecastPhysicalShot`.

### 2.2. Un post-traitement du seul gagnant actuel ne suffit pas

**Constat.** `evaluateExpertShot` réduit déjà les propositions à un gagnant par arme/groupe. `expertProposals` ignore les solutions balistiques incomplètes avec `continue`. `chooseSniperPhysicalShot` saute les MISSILE lorsqu’un BULLET/DRILLER convient et s’arrête au premier MISSILE utile.

**Conséquence possible.** Si #352 ne voit que ces résultats réduits, son repli pourrait prétendre choisir le tir « le plus létal » sans avoir conservé les propositions nécessaires. Il pourrait aussi transformer une recherche incomplète en absence de menace.

**Travail nécessaire.** Conserver les informations de complétude indépendamment des traces DEV. Permettre au repli létal de comparer les propositions avant leur réduction économique, sans modifier le classement habituel utilisé pour obtenir le choix initial. Pour SNIPER, réutiliser les recherches déjà faites sur C0 et compléter uniquement les cases manquantes du budget 2/4/4.

Il faut distinguer trois notions : résolution du tir retenu complète; analyse de son risque concluante; exploration de tous les essais nécessaires au maximum létal complète. Un tir sûr retenu peut être utilisé malgré un autre essai incomplet, alors qu’un maximum létal ne peut pas être annoncé dans ce cas. Le ticket fait cette distinction correctement.

**Sources :** [expertShotEvaluator.ts](../../src/game/entities/ai/expertShotEvaluator.ts), `expertProposals`, `evaluateExpertShot`; [sniperPhysicalSelection.ts](../../src/game/entities/ai/sniperPhysicalSelection.ts), `chooseSniperPhysicalShot`.

### 2.3. Préserver SURVIE exige une séparation explicite

**Constat.** `chooseExpertPlan` contient la recherche de menaces, le jet SURVIE, la neutralisation et le passage au profit. Les évaluateurs actuels de menaces ordinaires et BULLDOZER utilisent des gardes économiques. Le nouveau détecteur doit pourtant fonctionner pour SNIPER sans `localShotContext`.

**Conséquence possible.** Enlever globalement ces gardes ou modifier les comparateurs communs pour simplifier #352 changerait un comportement hors mandat. Se baser sur `decisionTrace.phase` serait aussi fragile : une trace peut être absente, et `REPLI` ne suffit pas à distinguer un repli économique d’un repli sans contexte.

**Travail nécessaire.** Transporter explicitement le contexte de politique dans l’orchestration et partager les primitives physiques sans changer les sorties des évaluateurs historiques de SURVIE. Ne jamais appeler la stratégie réelle de la cible. Le conseiller SURVIE reste exclu même s’il passe par une recherche interne de profit ou un repli.

Les tests existants couvrent déjà des jets refusés, des neutralisations et des replis : il faut conserver ces références et ajouter les cas #352 sans transformer les attentes historiques pour faire passer une régression.

**Sources :** [expertPlanner.ts](../../src/game/entities/ai/expertPlanner.ts), `chooseExpertPlan`; [expertShotEvaluator.ts](../../src/game/entities/ai/expertShotEvaluator.ts), `evaluateExpertShot`; [bulldozerThreat.ts](../../src/game/entities/ai/bulldozerThreat.ts), `evaluateBulldozerThreat`.

### 2.4. Les caches actuels ne sont pas prêts pour plusieurs états simulés

**Constat.** Le cache EXPERT appartient à un état immuable de décision. Les clés de recherche et de physique ne codent pas tout le terrain/roster. Le cache BULLDOZER est indexé seulement par `shooter.id`.

**Conséquence possible.** Réutiliser ce cache après un cratère, une chute ou une consommation de stock peut produire une menace obsolète. Le même tireur évalué contre C0 puis T peut aussi récupérer une réponse calculée pour la mauvaise cible.

**Travail nécessaire.** Séparer les caches par état physique; pour les résultats de menace, distinguer la paire tireur/cible. Partager l’avant-tir identique lorsque pertinent, mais ne jamais partager aveuglément deux après-tirs distincts. Tester les résultats négatifs aussi bien que les preuves positives.

Le ticket identifie correctement ce problème. Il n’impose pas une sérialisation complète du terrain dans chaque clé : une isolation structurelle des caches peut satisfaire le contrat.

**Sources :** [expertShotEvaluator.ts](../../src/game/entities/ai/expertShotEvaluator.ts), `ExpertForecastCache`, `expertProposals`; [bulldozerThreat.ts](../../src/game/entities/ai/bulldozerThreat.ts), accès à `cache.bulldozer`.

### 2.5. Mémoire et RNG : déplacer le choix sans déplacer ses effets de bord serait incorrect

**Constat.** SNIPER appelle actuellement `onTargetSelected` et `recordAimAttempt` avant sa sélection physique. EXPERT annonce également sa cible avant le calcul de son repli. L’offset SNIPER actuel ne consomme plus d’amplitude au plateau; EXPERT réserve déjà une paire amplitude/côté.

**Conséquence possible.** Une recherche naïve de plusieurs cibles pourrait incrémenter plusieurs mémoires, annoncer de faux changements de cible, consommer un tirage par alternative ou appliquer réaction/gaffe deux fois.

**Travail nécessaire.** Évaluer virtuellement, puis engager une seule cible finale. Capturer l’amplitude primitive de SNIPER lorsque nécessaire au lieu de rappeler ses fonctions de tirage pour chaque cible. Garder les commandes brute, évaluée et finale distinctes.

La correction 2A ferme un point important : si le tirage supplémentaire du plateau a eu lieu, revenir à C0 conserve sa commande brute, mais ne restaure pas l’ancienne position du RNG. La réaction et la gaffe peuvent donc produire une commande finale différente. Ce changement est explicitement approuvé; ce n’est pas une contradiction avec l’invariance observation active/inactive.

**Sources :** [AISniperStrategy.ts](../../src/game/entities/ai/AISniperStrategy.ts), [AISmartStrategy.ts](../../src/game/entities/ai/AISmartStrategy.ts), [fallibleAim.ts](../../src/game/entities/ai/fallibleAim.ts), [expertDecisionAim.ts](../../src/game/entities/ai/expertDecisionAim.ts), [aimMemory.ts](../../src/game/entities/ai/aimMemory.ts).

### 2.6. Performance : les bornes par simulation ne garantissent pas une décision fluide

**Constat.** EXPERT et SNIPER calculent sur le thread principal. Leur méthode `async` ne rend pas les boucles physiques parallèles au rendu. Le conseiller utilise son propre Worker. #352 ajoute des recherches avant/après au calcul habituel et peut poursuivre sur toutes les autres cibles.

À quatre joueurs, SNIPER peut examiner trois cibles au total : jusqu’à 30 recherches de tirs propres, avec réutilisation sur C0, auxquelles s’ajoutent les recherches de menace. EXPERT/conseiller peuvent analyser jusqu’à trois candidats retenus avec un avant et un après chacun, sous réserve des court-circuits. Une campagne BULLDOZER peut elle-même explorer jusqu’à 512 trajectoires; SNIPER ne reçoit pas cette arme dans ses menaces propres.

**Conséquence possible.** Pauses du Canvas, commandes retardées, surcoût de copie et de collecte endurance. Les durées des tests Node ne permettent pas de conclure à la fluidité en navigateur.

**Travail nécessaire.** Mesurer le parcours réel à 2–4 joueurs, avec risque confirmé et alternatives épuisées, terrains difficiles et stocks pertinents. Séparer recherches balistiques, prévisions physiques, copies d’état et observation. Comparer observation active/inactive et relever les pauses du rendu.

Le ticket demande déjà ces mesures et interdit d’inventer un seuil ou de réduire silencieusement les budgets. C’est une condition de validation de l’implémentation, pas une raison démontrée de refuser le codage. Aucun ralentissement propre à #352 n’a été mesuré ici puisqu’il n’est pas implémenté.

**Sources :** [TurnManager.ts](../../src/game/engine/TurnManager.ts), appel à `executeTurn`; [BallisticsSimulator.ts](../../src/game/entities/ai/BallisticsSimulator.ts), bornes des recherches; [shotAdvisor.worker.ts](../../src/game/entities/ai/shotAdvisor.worker.ts).

### 2.7. L’endurance peut recevoir une décision sans recevoir son explication

**Constat.** SNIPER conditionne plusieurs refus et candidats à DEV. Le cache EXPERT conditionne ses diagnostics à DEV. `DecisionObservation.finish` clone ensuite les données reçues; la session et le journal effectuent d’autres copies et persistent les événements.

**Conséquence possible.** Le build endurance compilé peut recevoir `ai-detail` sans les motifs exigés, même si les tests en développement passent. À l’autre extrême, attacher les états complets de chaque simulation aux diagnostics multiplierait les copies et le volume du JSONL. Le journal possède une file bornée et une gestion explicite de saturation : la conservation ne doit pas être présumée.

**Travail nécessaire.** Séparer collecte et écriture console. Collecter sur DEV ou demande de l’observateur; n’écrire les décisions console qu’en DEV. Produire des résumés sérialisables, sans solveur ni RNG additionnel pour les fabriquer. Vérifier le JSONL relu/exporté et son statut de conservation dans un build endurance compilé.

Les lacunes préexistantes touchées par la modification doivent être corrigées, comme demandé. Le constat sur SIMPLE n’autorise pas à modifier sa stratégie sans autre besoin.

**Sources :** [sniperPhysicalSelection.ts](../../src/game/entities/ai/sniperPhysicalSelection.ts), [expertShotEvaluator.ts](../../src/game/entities/ai/expertShotEvaluator.ts), [decisionObservation.ts](../../src/game/entities/ai/decisionObservation.ts), [session.ts](../../src/game/endurance/session.ts), [journal.ts](../../src/game/endurance/journal.ts).

### 2.8. Les départages doivent porter sur les candidats normalisés, pas sur leur provenance

**Constat.** Le plan principal et le repli utilisent des structures et ordres stables différents. Un duo peut avoir T1 comme cible principale, mais T2 comme prochain joueur à agir. Réutiliser sans adaptation `order` ou l’ordre d’insertion ferait dépendre le changement de cible de l’énumération des résultats.

**Travail nécessaire.** Conserver le classement historique à l’intérieur d’une cible; comparer ensuite les alternatives avec les métriques prescrites. Le repli solo doit porter les métriques du solo; le plan conserve celles du groupe. Appliquer le score de profil du conseiller seulement entre deux replis solo, avant `nextTurnDelay`, jamais au repli létal.

La justification de 4B est valide dans la portée actuelle : avec quatre joueurs maximum, il reste au plus deux autres cibles après exclusion du tireur et de C0. Il n’y a donc pas trois alternatives permettant un cycle de comparaison. Si le jeu dépasse un jour quatre joueurs, cette règle conditionnelle devra être réexaminée; ce n’est pas un blocage actuel.

**Sources :** [expertPlanner.ts](../../src/game/entities/ai/expertPlanner.ts), `primaryTarget`, `nextDelay`, tri de `candidates`; [expertShotEvaluator.ts](../../src/game/entities/ai/expertShotEvaluator.ts), tri de `choices`; [shotAdvisor.ts](../../src/game/entities/ai/shotAdvisor.ts), validation du nombre initial de joueurs.

### 2.9. Le cycle de vie du conseiller exige un état terminal distinct

**Constat.** `stop()` termine le Worker dans plusieurs situations : réponse traitée, changement d’objectif, invalidation, erreur ou fermeture. `refresh()` peut être appelé depuis `onmessage` et invalider la requête pendant le traitement de sa réponse.

**Conséquence possible.** Journaliser toute terminaison de Worker comme une annulation créerait une fausse annulation après un résultat accepté, ou deux événements finaux pour une réponse périmée.

**Travail nécessaire.** Ajouter une corrélation par requête et un état explicite de traitement; produire un seul résultat terminal de requête. Garder distincts le calcul, l’acceptation de la réponse et l’application ultérieure au jeu. Dans le code actuel, l’état affiché pendant le calcul se nomme `calculating`, et non `loading` comme dans une formulation du ticket.

Ce dernier écart de vocabulaire est mineur : le sens demandé reste identifiable, mais reprendre le vrai nom dans le ticket aiderait.

**Sources :** [AdvisorController.ts](../../src/components/advisor/AdvisorController.ts), `stop`, `refresh`, `request`, `apply`; [shotAdvisor.worker.ts](../../src/game/entities/ai/shotAdvisor.worker.ts).

## 3. Précisions rédactionnelles recommandées

Ces précisions réduiraient le risque de mauvaise lecture sans demander de nouvelle décision de jeu.

1. **Portée de `after-state-missing`.** La phrase générale « une résolution sans état après tir donne inconnu » devrait préciser « lorsque la branche après-tir est nécessaire ». L’ordre obligatoire permet déjà de conclure avant cette branche pour une cible hors périmètre, détruite ou déjà menacée. La section de garanties parle d’ailleurs de l’état après tir « qui en a besoin ». L’ordre détaillé fournit donc une interprétation cohérente.
2. **Absence de candidat et secours ordinaire.** À côté de « l’absence de tir offensif admissible après recherche complète est conclusive », rappeler l’exception prioritaire 1A : si le résultat retenu est `missile-ordinary`/non certifié, il reste inconnu et ne débloque pas le repli létal. Ne pas transformer `searchComplete: true` sur un secours ordinaire en preuve physique. La correction 1A tranche déjà ce cas, mais sa proximité avec la règle générale éviterait une erreur.
3. **Vocabulaire du conseiller.** Remplacer la référence à l’état `loading` par `calculating`, ou préciser qu’il s’agit d’un terme conceptuel.

Je ne classe pas ces formulations comme bloquantes, puisque les priorités et cas détaillés permettent de les résoudre sans inventer de comportement.

## 4. Autres conséquences du ticket à comprendre avant de coder

- **Une alternative dite sûre n’est pas nécessairement moins dangereuse dans l’absolu.** Une cible déjà menacée est admissible parce qu’il n’y a pas de nouvelle transition. L’algorithme n’évalue pas sa probabilité de riposte ni sa capacité à détruire le tireur.
- **Le risque collatéral est délibérément ignoré.** Un tir dont la cible principale est SIMPLE peut néanmoins fragiliser un EXPERT collatéral. Un tir sur T qui n’affecte qu’un autre ennemi reste même admissible pour EXPERT/conseiller selon 10A. Il faut expliquer cette limite sans élargir l’analyse tactique.
- **Le suicide reste possible dans certains changements de cible.** La destruction du tireur supprime son prochain coup; elle peut donc supprimer la transition. Le ticket conserve les suicides économiquement admissibles hors de la restriction 11A du repli létal sur C0. « Sans nouveau risque » ne signifie pas « survie du tireur ».
- **Le repli dit létal ne garantit pas une destruction.** Il maximise destruction puis pertes réelles dans l’espace autorisé. Si aucune destruction n’est disponible, il peut retenir un tir seulement dommageable. Il ne relance pas la détection, conformément à l’étape 8.
- **La stratégie ne recherche pas globalement la meilleure solution sûre.** Elle teste le meilleur tir habituel de chaque autre cible, sans chercher une variante inférieure qui serait sûre. Une cible peut donc être écartée même si un autre angle aurait évité la transition. C’est une restriction explicite de portée et de coût.
- **La nouvelle priorité peut réduire le profit immédiat.** Parmi les alternatives sûres, le profit départage EXPERT/conseiller; elle n’exige pas qu’une alternative soit aussi rentable que le choix initial risqué. Les filtres de profit des munitions payantes demeurent.
- **Les prévisions restent un modèle borné.** La physique isolée utilise un RNG privé constant pour ses éléments stochastiques. Le tir réel peut différer après réaction/gaffe et par ses résultats aléatoires. Ni l’absence trouvée dans la recherche ni une prévision déterministe ne constituent une garantie sur tous les tirs réels.
- **Le seuil BULLDOZER est volontairement différent d’un échec physique.** Une trajectoire encore en vol au pas 420 appartient à la limite de l’espace exploré; une chute non stabilisée après 2400 pas rend la conclusion négative inconnue. Un traitement uniforme du mot `incomplete` serait incorrect.
- **Aucun effet réseau n’est attendu.** La fonctionnalité concerne le moteur local et le Worker navigateur du conseiller. Elle ne rend pas l’IA serveur Cloudflare plus intelligente.

Ces comportements sont parfois contre-intuitifs, mais ils découlent des décisions explicites du ticket. Les corriger automatiquement changerait le mandat.

## 5. Validation effectuée et limites

Commande réellement exécutée :

```text
npm run test -- src/game/entities/ai/__tests__/expertStrategy.test.ts src/game/entities/ai/__tests__/expertProfit.test.ts src/game/entities/ai/__tests__/expertDecisionAim.test.ts src/game/entities/ai/__tests__/sniperPhysicalSelection.test.ts src/game/entities/ai/__tests__/shotAdvisor.test.ts src/game/entities/ai/__tests__/bulldozerThreat.test.ts src/components/advisor/__tests__/AdvisorController.test.ts src/game/endurance/__tests__/observation.test.ts
```

Premier essai : échec de chargement des huit suites, avant tout test, à cause d’un `EPERM` de renommage dans le cache temporaire Vitest du bac à sable. Reprise autorisée hors du bac à sable : **8 suites réussies, 289 tests réussis**. Ces résultats valident les contrats actuels ciblés; ils ne valident pas la fonctionnalité #352 à venir.

`git ls-remote` a échoué sur la résolution DNS de GitHub dans le terminal. Le connecteur GitHub a ensuite confirmé la tête de `main`, identique au commit local; ce blocage n’a donc pas empêché la vérification de la base analysée.

Lint, build, suite complète, React Doctor et parcours manuel n’ont pas été exécutés : il s’agit d’une analyse sans modification de source/configuration. Aucun score React Doctor n’est annoncé. Aucune mesure de performance de la future politique ni vérification d’un nouveau build endurance n’est revendiquée.

## 6. Conditions concrètes de réussite de l’implémentation

Les critères d’acceptation du ticket sont pertinents. Les preuves les plus importantes à obtenir sont :

1. Une transition réelle avant/après avec changement de cible, obtenue avec la physique réelle et son état final.
2. L’absence de modification de SURVIE, y compris ses jets et le conseiller SURVIE dans ses replis.
3. Le maintien des distinctions entre non certifié, inconnu, non exécuté, absence bornée et menace trouvée.
4. Le respect des budgets SNIPER et du suffixe RNG au plateau, en cas de changement comme de retour à C0.
5. Un repli létal qui voit tous les points/arcs requis, filtre le suicide selon 11A et revient au choix initial en cas d’incomplétude.
6. L’isolation des états/caches, la consommation exacte de stock et l’exclusion persistante des armes nucléaires des menaces adverses.
7. Les départages mixtes plan/repli et les groupes dont la cible principale diffère du prochain joueur.
8. Le JSONL compilé hors DEV, avec motifs, identifiants et statut de conservation, sans effets sur les choix ou le RNG.
9. Une seule conclusion par requête du conseiller et aucune trace d’annulation après traitement normal.
10. Les mesures réelles de temps de décision et de pauses du rendu, suivies de la batterie de validation imposée par le dépôt et des parcours manuels demandés.

**Décision de préparation : le ticket peut être confié à l’implémentation dans son état actuel.** Les trois précisions rédactionnelles sont utiles, mais aucune nouvelle décision de jeu n’est nécessaire pour commencer. Une implémentation qui ne traiterait que le changement de cible, en laissant les états après tir, l’incomplétude ou les traces pour plus tard, ne satisferait toutefois pas ce ticket.

Signé : **GPT-6 — Codex**.
