# Politique de sécurité

## Périmètre

TankWars est un jeu Web. La configuration du dépôt prévoit un client statique sur Cloudflare Pages, un workflow GitHub Pages distinct et, pour les parties en ligne, un Worker Cloudflare déployé séparément. Le Worker dirige le trafic des salles vers `GameRoom` et consulte `RateLimiter` pour les quotas HTTP et d’admission WebSocket par IP. Ces deux Durable Objects ont des espaces de stockage distincts.

La revue couvre le client et ses modes de build, le Worker, les contrats réseau partagés, les outils locaux qui lisent des scénarios ou des archives, ainsi que la chaîne de build et de publication. Le staging documenté est réservé au jeu local et se déploie sans Worker.

## Frontières de confiance

- Traiter les chemins, paramètres, en-têtes, corps HTTP et messages WebSocket comme des entrées non fiables, y compris lorsqu’ils proviennent d’un joueur déjà connecté. CORS et les contrôles d’origine protègent le parcours navigateur. L’absence d’un en-tête `Origin` est prévue pour les clients hors navigateur.
- Le lien d’invitation donne accès au siège correspondant. L’hôte reçoit les liens de sa salle pour les distribuer. Les jetons de siège, les invitations, l’état des salles et les droits de publication font partie des actifs à protéger.
- La physique est simulée chez les clients. Le Worker valide les rapports qu’il accepte et décide de l’ordre des tours, des mutations de combat et de boutique et de leur persistance. Un client qui détient l’autorité courante pour un rapport demeure une source non fiable.
- Les données restaurées depuis le navigateur et les scénarios ou archives fournis aux outils locaux restent des entrées à valider. Les empreintes d’archive servent à vérifier l’intégrité des données. La provenance exige une preuve distincte.

## Invariants de sécurité

- L’accès à un siège humain nécessite un jeton valide pour cette salle et ce siège. La reconnexion, les reprises et les changements d’autorité doivent préserver l’isolation entre salles et sièges. Les jetons doivent rester dans les flux d’invitation, de connexion et de reprise qui en ont besoin, à l’abri des journaux, de la télémétrie et des destinataires non autorisés.
- Le Worker doit vérifier l’identité du siège, l’autorité, la phase et les bornes propres à l’action avant de modifier l’état. Les actions acceptées doivent rester idempotentes lors d’une répétition ou d’une reprise. Persister les mutations avant de diffuser le résultat.
- Maintenir des bornes de taille et de coût adaptées à chaque point d’entrée. Appliquer les quotas distincts de création et de jonction HTTP et d’admission WebSocket avant d’allouer ou de réveiller une salle. Refuser ces opérations si le limiteur échoue.
- Confiner les lectures et écritures des outils locaux à leurs chemins autorisés. Traiter les contenus importés comme des données et limiter leur accès aux ressources autorisées. Les secrets et droits de publication doivent rester réservés aux contextes de déploiement prévus.

## Critères de signalement

Pour signaler une vulnérabilité en privé, ouvrir les [avis de sécurité de TankWars sur GitHub](https://github.com/bestter/TankWars/security/advisories) et choisir **Report a vulnerability**.

Établir le point d’entrée, les privilèges nécessaires, l’actif touché et l’effet reproductible. Évaluer séparément l’accès sans invitation, l’abus avec un siège légitime, l’abus avec l’autorité de rapport et les scénarios qui exigent un fichier importé ou l’accès à la chaîne de publication.

Tenir compte de la portée de l’impact, par exemple le détournement d’un siège, une mutation non autorisée dans une salle, une atteinte à plusieurs salles ou à la disponibilité du service, ou la compromission du poste qui traite une archive ou d’un artefact publié. Une partie locale modifiable par son utilisateur devient pertinente si un effet franchit une frontière de confiance, par exemple en atteignant une autre personne, des données protégées ou le système hôte.
