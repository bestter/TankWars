# Plan d’implémentation — demande GitHub #188

Source : [Changer méthode de calcul des montants reçu — Issue #188](https://github.com/bestter/TankWars/issues/188)

> **État final (23 août 2026) :** plan implanté dans la PR #200. Une décision UX prise après l’implantation remplace la barrière initiale : le gain flotte au-dessus du tank pendant 3 secondes, sans bloquer le jeu. Les sections ci-dessous reflètent ce comportement final.

## Objectif

Remplacer complètement les anciennes primes de `300 $`, `500 $` et `600 $` par un système de gains calculé après chaque résolution de tir à partir :

- des dommages réellement absorbés par le bouclier;
- des dommages réellement subis par la santé;
- des dommages de chute attribuables au tir;
- des destructions;
- du bonus de dernier survivant ou du partage de partie nulle;
- de règles particulières pour le premier tir, les armes de destruction massive, le Cluster et l’autodommage.

Le changement doit fonctionner en partie locale et en ligne. En ligne, le poste du premier humain connecté est la source de vérité des gains, avec relève persistante en cas de déconnexion.

## Décisions fonctionnelles confirmées

1. Toutes les composantes gagnées par un joueur pendant une résolution sont additionnées à l’état brut; un seul arrondi supérieur est appliqué au total final du joueur.
2. Lors d’un tir direct, la récompense compte les dégâts entrants absorbés par le bouclier, pas les points de bouclier consommés. Par exemple, 5 points absorbés comptent pour 5 même si 10 points de bouclier sont consommés.
3. Les dommages réels sont normalisés au millième avant le calcul économique.
4. Toutes les sous-munitions du Cluster sont cumulées, puis un seul arrondi est effectué par joueur.
5. Si une résolution Cluster touche directement un tank au moins une fois, toute chute de ce tank pendant cette résolution est classée directe.
6. « Premier tir » signifie la première volée de la manche; toutes les sous-munitions du Cluster héritent de cet état.
7. Une mini-nuke ou une thermonucléaire donne toujours seulement `2 × X` par destruction, même au premier tir.
8. En partie nulle normale, chaque joueur vivant avant le tir reçoit `50 × X / N` et le tireur reçoit aussi `X`.
9. En partie nulle provoquée par une arme massive, le tireur reçoit uniquement `X`; les autres joueurs se partagent `50 × X`.
10. Le message de gain flotte au-dessus du tank pendant 3 secondes avec montée et fondu, sans bloquer les entrées ni le prochain tour.
11. Le résumé de manche affiche uniquement le gain de la manche. Le solde total demeure dans la boutique.
12. En ligne, l’autorité transférée demeure chez son successeur tant que celui-ci reste connecté. La reconnexion de l’ancien premier humain ne lui redonne pas immédiatement l’autorité.
13. En ligne, le serveur n’impose aucun délai d’affichage; il avance dès que la physique et le rapport économique requis sont stabilisés.
14. Lorsqu’une résolution paie plusieurs joueurs, chaque montant est affiché simultanément au-dessus du tank bénéficiaire.

## Contraintes du dépôt

- Lire `AGENTS.md` et tous ses documents compagnons avant toute modification.
- Répondre et documenter en français.
- TypeScript strict, sans aucun nouveau `any`.
- React possède les phases, les joueurs, l’argent, la boutique, le HUD et les overlays.
- `GameEngine` possède la physique, les projectiles, le terrain, le rendu et l’audio de combat.
- Ne jamais toucher au contexte Canvas dans un render React.
- Ne jamais stocker les projectiles, particules ou données par frame dans `useState`.
- Utiliser uniquement `VGA_PALETTE` pour l’interface visuelle.
- Redémarrer `npm run worker:dev` après chaque modification de `worker/src/game-room.ts`.
- Vérification finale obligatoire : `npm run lint` → `npm run build` → `npm run test`.

## Hors portée

Ne pas profiter de la demande #188 pour corriger :

- la statistique `roundTerrainDestroyed`, actuellement toujours à zéro;
- la différence d’argent initial `200/250` entre certains chemins;
- la simulation physique serveur autoritaire, toujours prévue ultérieurement;
- la migration générale vers les WebSockets hibernables;
- les fichiers de règles du dépôt.

## 1. Préparation et garde-fous

Avant toute modification :

1. Relire `AGENTS.md`, `CLAUDE.md`, `GROK.md`, `CURSOR.md`, `.cursorrules` et `.antigravityrules`.
2. Vérifier le worktree avec `git status --short --branch` et préserver les changements étrangers.
3. Charger la compétence `react-doctor`, puisqu’il y aura des changements React.
4. Exécuter un diagnostic React initial avec la procédure de la compétence.
5. Localiser de nouveau les points d’intégration si la branche a évolué depuis la rédaction du plan.
6. Ne modifier aucun fichier de règles.
7. Ne jamais introduire de `any`.

## 2. Créer le domaine économique pur

Créer :

- `src/game/economy/fixedPoint.ts`
- `src/game/economy/shotRewards.ts`
- `src/game/economy/__tests__/shotRewards.test.ts`

### 2.1 Constantes

Définir explicitement :

```ts
export const BASE_REWARD_AMOUNT = 2.00;
export const MAX_REWARD_PLAYERS = 4;
export const DAMAGE_PRECISION = 1_000;
```

Reconnaître comme armes de destruction massive uniquement :

```ts
const MASS_DESTRUCTION_WEAPONS = new Set<WeaponId>([
  "NUKE",
  "THERMONUCLEAR",
]);
```

### 2.2 Calcul de `X`

Implémenter une fonction pure validant de 2 à 4 joueurs :

1. `Y = round((playerCount / 4) × 100) / 100`
2. `X = 2.00 × (1 + Y)`
3. Normaliser `X` au millième.

Résultats obligatoires :

| Joueurs | `Y` | `X` |
|---:|---:|---:|
| 2 | 0,50 | 3,000 |
| 3 | 0,75 | 3,500 |
| 4 | 1,00 | 4,000 |

### 2.3 Point fixe et fractions exactes

Les dégâts réels sont normalisés au millième avec `Math.round(value * 1000)` au moment de créer l’événement de dommage.

Après cette frontière :

- ne plus utiliser de flottants pour l’argent;
- utiliser des entiers représentant des millièmes;
- accumuler les divisions `/2`, `/4`, `/8` et le partage `/N` sous forme rationnelle exacte;
- privilégier un petit accumulateur interne avec numérateur/dénominateur en `bigint`;
- ne jamais sérialiser de `bigint`;
- convertir uniquement le résultat final avec une division entière arrondie vers le haut;
- vérifier que le montant produit est un entier sûr, positif ou nul.

Le `ceil` doit être fait une seule fois, par joueur, après l’addition de toutes les composantes de la résolution.

### 2.4 Types économiques

Définir au minimum :

```ts
type DamageSource = "projectile" | "fall";
type HitClassification = "direct" | "indirect";
type DestructionCause =
  | "health-zero"
  | "lava"
  | "out-of-bounds"
  | "buried";

interface CombatDamageEvent {
  shotId: number;
  munitionId: number;
  shooterId: string;
  victimId: string;
  weaponId: WeaponId;
  source: DamageSource;
  classification: HitClassification;
  shieldAbsorbedMilli: number;
  healthDamageMilli: number;
}

interface CombatDestructionEvent {
  shotId: number;
  shooterId: string;
  victimId: string;
  weaponId: WeaponId;
  cause: DestructionCause;
}

interface ShotRewardInput {
  shotId: number;
  shooterId: string;
  weaponId: WeaponId;
  playerCountAtMatchStart: number;
  isFirstShotOfRound: boolean;
  aliveBeforeShot: string[];
  survivorsAfterShot: string[];
  damageEvents: CombatDamageEvent[];
  destructionEvents: CombatDestructionEvent[];
}
```

La sortie doit contenir :

- le montant entier accordé par joueur;
- les dégâts réels cumulés par joueur pour le résumé;
- assez de ventilation interne pour tester les composantes, sans arrondir celles-ci individuellement.

### 2.5 Règles exactes du calculateur

Pour chaque événement non auto-infligé :

- projectile direct : `X × dommage réel`;
- projectile indirect : `X × dommage réel / 2`;
- projectile direct avec arme massive : résultat précédent `/ 2`;
- projectile indirect avec arme massive : résultat précédent `/ 2`;
- chute classée directe : `X × dommage de chute / 4`;
- chute classée indirecte : `X × dommage de chute / 8`;
- aucune réduction massive sur les dommages de chute.

Destruction :

- arme normale, premier tir de manche : `50 × X`;
- arme normale, autre tir : `25 × X`;
- arme massive, premier tir ou non : `2 × X`;
- aucune prime pour la destruction du tireur par lui-même.

Fin de manche :

- un survivant : ce joueur reçoit `50 × X`;
- nulle normale : chaque joueur vivant avant le tir reçoit `50 × X / N`, puis le tireur reçoit `X`;
- nulle massive : le tireur reçoit uniquement `X`; les autres se partagent `50 × X`;
- toutes ces composantes entrent dans le même accumulateur avant l’unique `ceil`.

## 3. Instrumenter les dégâts réels

Modifier `src/game/entities/TankManager.ts`.

### 3.1 Événements structurés

Ajouter des callbacks structurés :

```ts
onDamageApplied?: (event: CombatDamageEvent) => void;
onTankDestroyed?: (event: CombatDestructionEvent) => void;
```

Conserver les responsabilités audio dans `GameEngine`; ne pas mettre de logique économique dans `TankManager`.

### 3.2 Dégâts de bouclier

Pour un direct, la récompense compte les dégâts entrants absorbés, pas les points de bouclier consommés.

Exemple obligatoire :

- 5 points entrants absorbés;
- 10 points de bouclier consommés;
- événement économique : `shieldAbsorbedMilli = 5_000`.

Pour un indirect, le ratio est 1:1.

Le dommage réel d’un événement est :

```text
dommage absorbé par le bouclier + perte réelle de vie
```

Il faut plafonner la perte de vie à la vie disponible. Aucun surdommage ne doit rapporter.

### 3.3 Morts instantanées

Pour les zones de mort instantanée NUKE/THERMONUCLEAR, produire quand même un événement de dommage réel :

- vie perdue : toute la vie restante;
- absorption de bouclier directe : capacité réelle d’absorption au ratio 2:1;
- absorption indirecte : capacité réelle au ratio 1:1.

La destruction doit ensuite être signalée séparément, afin de cumuler dommage et prime de destruction.

### 3.4 Chutes et provenance

Ajouter dans `TankManager` une provenance temporaire de chute par tank :

```ts
interface FallAttribution {
  shotId: number;
  shooterId: string;
  weaponId: WeaponId;
  classification: "direct" | "indirect";
}
```

Au début d’un tir, la classification par défaut est indirecte. Dès qu’un tank est touché directement par une munition de cette résolution, sa classification de chute devient directe et ne peut plus redevenir indirecte pendant cette résolution.

Cela applique la décision retenue pour le Cluster : un seul impact direct suffit pour classer la chute complète comme directe.

Chaque tranche de dommage de chute appliquée par `applyGravity` doit émettre un événement utilisant cette provenance. Les morts par :

- dommage de chute;
- lave;
- sortie latérale;
- absence de support;
- chute sous la carte;

doivent émettre une destruction avec la même provenance.

Nettoyer toutes les provenances :

- à la finalisation de la résolution;
- au début d’une nouvelle manche;
- dans `setPlayers` et `spawnTanks`.

## 4. Propager l’identité de résolution dans la physique

Modifier `src/game/engine/PhysicsEngine.ts`.

Étendre `Projectile` avec :

```ts
shotId: number;
munitionId: number;
```

Règles :

- le projectile parent reçoit l’identifiant de résolution;
- les cinq sous-munitions Cluster conservent le même `shotId`;
- chaque sous-munition obtient un `munitionId` distinct;
- un projectile normal utilise un seul `munitionId`;
- un impact BULLDOZER marque la cible comme directement affectée avant le déplacement;
- le recul du tireur peut produire des dégâts ou une mort, mais ceux-ci seront filtrés comme auto-infligés.

Remplacer les paramètres positionnels de `applyExplosionDamage` par un objet strictement typé. Cela réduit les risques d’inverser `weaponId`, `isDirectHit`, le terrain ou les nouveaux identifiants.

Mettre à jour tous les tests et appels existants.

## 5. Remplacer les anciens accumulateurs dans le moteur

Modifier `src/game/engine/GameEngine.ts`.

### 5.1 Supprimer les règles historiques

Retirer complètement :

- `handlePlayerDeathGains`;
- le paiement immédiat de `300 $`;
- le paiement de `600 $`;
- le bonus de survie de `500 $`;
- `roundKills`;
- le faux cumul basé sur `weapon.damage`.

`awardEndOfRoundEarnings()` ne doit plus muter l’argent. Le remplacer par une méthode de construction du résultat de manche, par exemple `buildRoundResult()`.

### 5.2 Registre d’une résolution

Créer un objet de travail actif dans `GameEngine` :

```ts
interface ActiveShotLedger {
  shotId: number;
  shooterId: string;
  weaponId: WeaponId;
  isFirstShotOfRound: boolean;
  aliveBeforeShot: string[];
  damageEvents: CombatDamageEvent[];
  destructionEvents: CombatDestructionEvent[];
}
```

Au lancement du projectile parent :

1. refuser de commencer un second registre non finalisé;
2. capturer les vivants;
3. incrémenter le compteur de tirs de la manche;
4. déterminer `isFirstShotOfRound`;
5. initialiser la provenance dans `TankManager`.

Ne pas créer un nouveau registre lors de la division du Cluster.

### 5.3 Finalisation

Finaliser seulement lorsque :

- tous les projectiles ont disparu;
- les tanks ont fini de tomber;
- les morts par lave/enfouissement ont été vérifiées;
- le `TurnManager` considère la résolution physiquement stabilisée.

La finalisation doit :

1. capturer les survivants;
2. appeler le calculateur pur;
3. produire un aperçu de gains sans nécessairement muter l’argent;
4. produire l’issue de manche;
5. nettoyer la provenance de chute;
6. conserver le résultat jusqu’à son application autoritaire.

Ajouter une méthode idempotente pour appliquer un résultat autoritaire :

```ts
applyResolvedEarnings(
  shotId: number,
  balances: ReadonlyArray<{ playerId: string; money: number }>,
): void;
```

Elle doit refuser :

- un ancien `shotId`;
- un solde non entier;
- un entier non sûr;
- un joueur inconnu.

### 5.4 Gains de manche

Ajouter un accumulateur réel :

```ts
roundEarningsByPlayer: Record<string, number>;
```

Il est alimenté uniquement lorsque des gains sont effectivement appliqués, jamais lors du simple calcul local.

Étendre `RoundResult` dans `src/types/game.ts` :

```ts
interface RoundResult {
  damageDealt: Record<string, number>;
  earningsByPlayer: Record<string, number>;
  terrainDestroyed: number;
  survivors: string[];
}
```

Réinitialiser le compteur de tirs et les gains lors de `startNextRound` et `resetGame`.

## 6. Coordonner la résolution et le tour suivant

Modifier `src/game/engine/TurnManager.ts`.

`finishShotResolution()` sépare :

1. résolution physique terminée;
2. gains calculés/appliqués;
3. prochain tour ou fin de manche.

Ajouter un état idempotent du genre :

```ts
private isAwaitingEarningsRelease = false;
```

et une méthode :

```ts
releaseResolvedShot(): void;
```

Comportement final :

- partie locale : libération immédiate, avec ou sans gain;
- partie en ligne : ne pas avancer localement; attendre le `STATE_UPDATE` serveur;
- fin de manche : déclencher la célébration au lieu d’un prochain tour;
- les callbacks de sécurité existants ne doivent pas contourner la coordination physique/économique;
- un appel en double à `releaseResolvedShot` ne fait rien.

La détection de fin de manche doit être déplacée après la stabilisation complète. Elle ne doit plus lancer la célébration dès qu’une explosion laisse temporairement un seul tank vivant alors que d’autres chutes sont encore en cours.

## 7. Ajouter l’interface de gains

Créer :

- `src/components/ShotEarningsOverlay.tsx`
- `src/components/__tests__/ShotEarningsOverlay.test.tsx`

Modifier :

- `src/components/gameCanvasReducer.ts`
- `src/components/useGameSession.ts`
- `src/components/GameCanvas.tsx`
- `src/App.css`
- `src/locales/fr.json`
- `src/locales/en.json`

### 7.1 État React

Ajouter au reducer :

```ts
interface EarningsOverlayState {
  shotId: number;
  awards: Array<{
    playerId: string;
    playerName: string;
    color: string;
    amount: number;
    x: number;
    y: number;
  }>;
  displayedAt: number;
}
```

Ne pas utiliser `useState` pour les données physiques; seulement pour cet état d’interface peu fréquent.

### 7.2 Affichage

Constantes :

```ts
const EARNINGS_DISPLAY_MS = 3_000;
```

Comportement :

- un montant par bénéficiaire, placé au-dessus de son tank;
- texte compact `+100$`;
- couleur du tank;
- animation ascendante avec fondu;
- `pointer-events: none` afin de ne jamais bloquer les contrôles;
- ne pas afficher les joueurs à zéro;
- si toute la résolution vaut zéro, ne créer aucun overlay;
- nettoyer tous les timers au démontage et au changement de manche.

### 7.3 Interaction

L’affichage est purement informatif : il ne capture ni clavier, ni clic, ni contrôle tactile. Sa minuterie le retire automatiquement après 3 secondes et doit être nettoyée au démontage.

Ne pas réutiliser `CELEBRATION` et ne pas introduire une mutation Canvas depuis React. L’overlay demeure un composant React superposé.

## 8. Corriger le résumé de manche

Modifier `src/components/RoundSummary.tsx`.

Pour chaque joueur, afficher uniquement son gain pendant la manche :

```text
Joueur 1    +384$
Joueur 2    +0$
```

Ne plus afficher son solde total dans ce tableau.

Retirer le texte historique :

```text
base 500 si vivant, +300/kill, double pour le vainqueur
```

Le solde total continue d’être affiché par `WeaponShop`, sans changement.

Trier par gain de manche décroissant, puis conserver l’ordre initial en cas d’égalité.

## 9. Définir un protocole en ligne strictement typé

Créer `src/game/online/protocol.ts`, partagé par le client et le Worker.

Ajouter des types et gardes acceptant `unknown` pour :

```text
AUTHORITY_CHANGED
SHOT
SHOT_SETTLED
SHOT_EARNINGS
SHOT_EARNINGS_APPLIED
STATE_UPDATE
ROUND_END
```

Ne pas faire confiance à un objet provenant directement de `JSON.parse`.

### 9.1 Identité du tir

Le Worker attribue un `shotId` monotone et persistant.

Chaque message `SHOT` contient :

- `shotId`;
- `roundNumber`;
- `shotNumberInRound`;
- `isFirstShotOfRound`;
- `slot`;
- `ownerId`;
- `command`.

Le tireur local conserve son lancement optimiste actuel. Lorsqu’il reçoit son propre `SHOT`, il ne rejoue pas le projectile; il associe plutôt le `shotId` serveur au registre actif.

Les autres clients rejouent le projectile avec ce `shotId`.

Le rattrapage après reconnexion doit renvoyer le même tir avec le même identifiant.

## 10. Implémenter l’autorité persistante dans le Durable Object

Modifier `worker/src/game-room.ts`.

### 10.1 État persistant

Étendre `RoomState` avec :

```ts
authorityOrder: number[];
earningsAuthoritySlot: number | null;
authorityEpoch: number;
nextJoinOrdinal: number;
nextShotId: number;
roundNumber: number;
shotNumberInRound: number;
activeShot: PersistedActiveShot | null;
lastAppliedEarnings: PersistedEarningsResult | null;
```

Pour chaque humain, conserver son premier ordre de connexion. Une reconnexion ne doit jamais le remplacer.

À la fin du lobby :

1. figer `authorityOrder`;
2. élire le premier humain;
3. persister avant de diffuser.

### 10.2 Relève

Lors de la perte du WebSocket de l’autorité :

1. retirer la socket de la collection active;
2. choisir le prochain humain connecté selon l’ordre initial;
3. incrémenter `authorityEpoch`;
4. persister;
5. diffuser `AUTHORITY_CHANGED`;
6. retransmettre le tir actif si nécessaire.

Une reconnexion de l’ancien premier humain ne lui redonne pas l’autorité tant que l’autorité actuelle reste connectée. Si l’autorité actuelle se déconnecte plus tard, refaire une élection parmi les humains alors connectés selon l’ordre initial.

S’il ne reste aucun humain connecté :

- mettre l’autorité à `null`;
- ne pas inventer de gains;
- conserver le tir et la partie en attente;
- reprendre lors d’une reconnexion.

### 10.3 Persistance Cloudflare

L’autorité, le tir actif et le dernier paiement ne doivent pas vivre seulement dans des `Map` ou champs mémoire. Un Durable Object peut perdre son état mémoire lors d’un redémarrage ou d’une éviction; l’état important doit être stocké durablement.

Références :

- [Cycle de vie des Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [Stockage Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Pratiques WebSocket Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

La migration complète vers les WebSockets hibernables demeure hors portée de la demande #188.

## 11. Rendre le paiement autoritaire et idempotent

### 11.1 Soumission

Tous les clients peuvent calculer un aperçu local, mais seul celui dont le slot correspond à `earningsAuthoritySlot` envoie :

```ts
interface ShotEarningsMessage {
  type: "SHOT_EARNINGS";
  shotId: number;
  authorityEpoch: number;
  awards: Array<{ playerId: string; amount: number }>;
  deadSlots: boolean[];
  roundOutcome: {
    isRoundEnd: boolean;
    isDraw: boolean;
    roundWinnerId: string | null;
  };
}
```

Conserver l’aperçu calculé jusqu’à l’accusé serveur. Ainsi, un client promu pendant un tir peut soumettre son résultat déjà calculé.

### 11.2 Validation Worker

Le Worker doit refuser :

- un slot différent de l’autorité;
- un `authorityEpoch` périmé;
- un `shotId` différent du tir actif;
- un joueur inconnu;
- deux entrées pour le même joueur;
- un montant négatif;
- un montant non entier ou non sûr;
- un tableau de morts de mauvaise longueur;
- un deuxième résultat différent pour le même tir.

Le Worker ne peut pas recalculer la physique; conformément à la demande, il fait confiance au poste autoritaire pour les montants. Il ne doit toutefois accepter que des deltas, jamais un solde total arbitraire fourni par le client.

### 11.3 Application atomique

Dans le même traitement sérialisé :

1. valider le rapport;
2. ajouter chaque delta au solde serveur;
3. vérifier que le nouveau solde est un entier sûr;
4. appliquer les morts autoritaires;
5. mémoriser le résultat du tir;
6. persister une seule fois;
7. diffuser `SHOT_EARNINGS_APPLIED`.

Le message appliqué contient :

```ts
{
  shotId,
  awards,
  balances: Array<{ playerId, money }>,
  hasEarnings,
  blockDurationMs: 0,
  roundOutcome,
}
```

Toujours persister avant la diffusion.

Un doublon identique doit renvoyer le résultat mémorisé sans créditer une deuxième fois.

## 12. Coordonner paiement, pause et changement de tour

Pour chaque tir serveur, suivre séparément :

- résolution du tireur humain reçue;
- gains autoritaires reçus;

### Tir humain

Le changement de tour exige :

1. `SHOT_SETTLED` du tireur ou son watchdog existant;
2. `SHOT_EARNINGS` de l’autorité;

### Tir IA

Il n’y a aucun `SHOT_SETTLED` humain. Le rapport de l’autorité indique que la simulation du tir IA s’est stabilisée. Le délai fixe actuel de 4,5 secondes devient seulement un filet de sécurité; il ne doit pas avancer le tour sans résultat économique autoritaire.

### Résolution sans gain

Dès que la physique et le rapport autoritaire sont présents :

- ne pas diffuser d’overlay;
- avancer immédiatement;
- ne pas imposer de délai.

### Fin de manche

Supprimer l’envoi client autonome de `ROUND_END`.

Après application des gains :

- diffuser le `ROUND_END` autoritaire avec les soldes à jour;
- ne pas diffuser de prochain tour;
- les clients passent ensuite à la célébration et au résumé;
- aucun client ne rappelle une méthode d’attribution locale.

## 13. Synchroniser les clients

Modifier `src/components/useGameSession.ts`.

### Client autoritaire

À la résolution :

- calculer l’aperçu;
- envoyer `SHOT_EARNINGS`;
- ne pas muter l’argent avant `SHOT_EARNINGS_APPLIED`.

### Client non autoritaire

À la résolution :

- conserver temporairement son aperçu pour une éventuelle promotion;
- ne rien envoyer;
- ne pas muter l’argent;
- ne pas décider seul de la fin de manche.

### Tous les clients

À `SHOT_EARNINGS_APPLIED` :

1. appliquer les soldes reçus;
2. mettre à jour `uiPlayers`;
3. alimenter `roundEarningsByPlayer`;
4. afficher les gains s’ils sont non nuls;
5. mémoriser le `shotId` appliqué.

À `AUTHORITY_CHANGED` :

- mettre à jour le slot et l’époque;
- si ce client devient autoritaire et possède l’aperçu du tir actif, le soumettre;
- ne pas réclamer l’autorité lors d’une simple reconnexion.

À `ROUND_END` :

- appliquer le roster serveur;
- construire le résumé sans réattribuer d’argent;
- commencer la célébration une seule fois.

## 14. Reconnexion et persistance client

Modifier `src/utils/onlineSession.ts`.

Ajouter au snapshot :

- `authoritySlot`;
- `authorityEpoch`;
- `lastAppliedShotId`;
- `roundEarningsByPlayer`;
- l’overlay actif, s’il est encore visible.

Le rattrapage serveur doit envoyer :

- l’autorité actuelle;
- les soldes actuels;
- le tir actif éventuel;
- le dernier résultat appliqué;
- `ROUND_END` si la manche est déjà terminée.

Un client reconnecté ne doit jamais réafficher ou réappliquer deux fois le même paiement.

## 15. Matrice de tests obligatoire

### 15.1 Calculateur économique

Couvrir au minimum :

- `X` pour 2, 3 et 4 joueurs;
- direct et indirect;
- réduction massive;
- chute directe et indirecte;
- destruction normale;
- destruction au premier tir;
- destruction massive au premier tir restant `2 × X`;
- dernier survivant;
- nulle normale;
- nulle massive;
- auto-dommage;
- autodestruction;
- dégâts sur plusieurs tanks;
- Cluster avec plusieurs sous-munitions;
- un seul `ceil` après cumul;
- limites au millième;
- montant exact entier sans sur-arrondissement.

Exemple discriminant :

- deux composantes brutes `1,5` et `0,375`;
- résultat attendu `ceil(1,875) = 2`;
- jamais `ceil(1,5) + ceil(0,375) = 3`.

### 15.2 TankManager et PhysicsEngine

Tester :

- 5 points absorbés en direct même si 10 points de bouclier disparaissent;
- débordement bouclier vers santé;
- surdommage plafonné;
- NUKE directe;
- thermonucléaire indirecte;
- dommage de chute progressif;
- lave;
- sortie de carte;
- enfouissement;
- BULLDOZER cible;
- recul BULLDOZER;
- Cluster conservant un `shotId`;
- classification de chute directe conservée après d’autres impacts.

### 15.3 GameEngine et TurnManager

Tester :

- premier tir remis à zéro à la nouvelle manche;
- aucune ancienne prime `300/500/600`;
- finalisation après stabilisation complète;
- fin de manche après stabilisation;
- prochain tour immédiat après résolution locale;
- libération idempotente;
- résolution sans gain immédiate;
- gains de manche cumulés seulement lors de l’application.

### 15.4 React

Tester avec de faux timers :

- overlay visible 3 secondes;
- aucune capture des interactions;
- plusieurs bénéficiaires positionnés au-dessus de leurs tanks;
- couleurs correctes;
- aucun overlay à zéro;
- nettoyage au démontage;
- résumé affichant le gain de manche seulement;
- total toujours présent dans la boutique.

### 15.5 Worker

Étendre `worker/src/__tests__/game-room.test.ts` avec :

- premier humain autoritaire;
- relève à la déconnexion;
- reconnexion sans reprise immédiate;
- refus d’un non-autoritaire;
- refus d’une ancienne époque;
- refus d’un montant décimal;
- application atomique;
- doublon sans double crédit;
- attente de `SHOT_SETTLED`;
- attente des gains;
- avancement immédiat après physique + gains;
- zéro gain sans délai;
- tir IA;
- relève pendant un tir;
- rattrapage après reconnexion;
- fin normale;
- nulle normale;
- nulle massive.

## 16. Validation finale

Pendant les changements Worker, redémarrer `npm run worker:dev` après chaque modification de `worker/src/game-room.ts`.

Validation finale obligatoire, dans cet ordre :

```bash
npm run lint
npm run build
npm run test
```

Tous les échecs doivent être corrigés.

Ensuite :

1. exécuter de nouveau React Doctor;
2. lancer `npm run dev` et `npm run worker:dev`;
3. vérifier manuellement une partie locale à 2, 3 et 4 joueurs;
4. vérifier un Cluster, une NUKE, une thermonucléaire et un BULLDOZER;
5. vérifier une nulle;
6. vérifier deux onglets en ligne;
7. déconnecter l’autorité avant, pendant et après une résolution;
8. confirmer que tous les clients affichent exactement les mêmes soldes et gains;
9. confirmer que la boutique montre le solde total et le résumé seulement le gain de manche.

## Critères de réussite

La demande est terminée uniquement si :

- `Player.money` demeure toujours un entier sûr;
- aucun calcul monétaire intermédiaire n’est arrondi;
- un seul `ceil` est appliqué par joueur et par résolution;
- les dommages récompensés correspondent aux dégâts réellement absorbés ou subis;
- les chutes et destructions conservent leur provenance;
- l’autodommage ne rapporte rien;
- la fin de manche n’applique plus aucune prime historique;
- aucun gain nul ne bloque le jeu;
- les paiements en ligne proviennent uniquement de l’autorité active;
- une relève d’autorité ne double ni ne perd un paiement;
- tous les clients convergent vers les soldes persistés par le Durable Object;
- le résumé affiche les gains de manche et la boutique le solde total.

## Fichiers principaux concernés

### Nouveaux fichiers prévus

- `src/game/economy/fixedPoint.ts`
- `src/game/economy/shotRewards.ts`
- `src/game/economy/__tests__/shotRewards.test.ts`
- `src/game/online/protocol.ts`
- `src/components/ShotEarningsOverlay.tsx`
- `src/components/__tests__/ShotEarningsOverlay.test.tsx`

### Fichiers existants à modifier

- `src/types/game.ts`
- `src/game/entities/TankManager.ts`
- `src/game/engine/PhysicsEngine.ts`
- `src/game/engine/GameEngine.ts`
- `src/game/engine/TurnManager.ts`
- `src/components/gameCanvasReducer.ts`
- `src/components/useGameSession.ts`
- `src/components/GameCanvas.tsx`
- `src/components/RoundSummary.tsx`
- `src/utils/onlineSession.ts`
- `src/locales/fr.json`
- `src/locales/en.json`
- `src/App.css`
- `worker/src/game-room.ts`
- les tests unitaires et d’intégration associés.

## Ordre d’exécution recommandé

Pour réduire les régressions et permettre des commits logiques :

1. calculateur économique pur et tests;
2. événements réels de dommages/destructions dans `TankManager`;
3. propagation `shotId`/`munitionId` dans `PhysicsEngine`;
4. registre et finalisation dans `GameEngine`;
5. coordination de résolution dans `TurnManager`;
6. overlay et résumé React;
7. protocole partagé strict;
8. autorité, idempotence et persistance Worker;
9. synchronisation/reconnexion client;
10. tests transversaux, vérifications obligatoires et validation manuelle.
