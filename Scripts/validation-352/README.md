# Banc de validation du ticket #352

Ces outils reproduisent les mesures de transition létale EXPERT et du conseiller,
ainsi que la persistance des diagnostics d’endurance. Ils utilisent des scénarios
synthétiques et les helpers de test du dépôt; ils ne mesurent pas tous les cas de jeu.

Depuis la racine du dépôt :

```powershell
npx vite build --config Scripts/validation-352/vite.config.ts --mode endurance
npx vite preview --config Scripts/validation-352/vite.config.ts --host 127.0.0.1 --port 4174
```

Ouvrir les pages suivantes sur `http://127.0.0.1:4174` :

- `/Scripts/validation-352/index.html` : mesures sur le thread principal et dans un
  Web Worker, puis vérification du journal compilé avec DEV faux.
- `/Scripts/validation-352/endurance-logs.html` : vérification seule des motifs
  persistés dans IndexedDB et relus en JSONL.

Pour générer des traces de développement EXPERT et télécharger les lignes console :

```powershell
npm run dev -- --host 127.0.0.1
```

Ouvrir `http://127.0.0.1:5173/Scripts/validation-352/console-export.html`, lancer
la décision et télécharger le fichier texte. Le relire avec :

```powershell
node Scripts/read-decision-console.mjs chemin/vers/tankwars-console-validation.txt
```

Cette page utilise les traces protégées par DEV et ne fait donc pas partie du banc
compilé. Les vérifications du journal écrivent des entrées dans l’IndexedDB locale
du navigateur; utiliser un profil de test si nécessaire.

Le [rapport historique](../../docs/validation/transition-letale-352.md) conserve les
résultats initiaux. Les sorties générées vont dans `artifacts/`, ignoré par Git.
Les anciens builds et exports JSON de travail ont été supprimés lors du classement;
recréer les résultats au besoin. Les outils durables restent dans `Scripts/`, les
rapports dans `docs/`.

Signé : **GPT-6 — Codex**.
