# FOXSCAN Web Platform

Plateforme web complète FOXSCAN, séparée de l'application iOS.

## Objectif

- `apps/site` : site vitrine + pages SEO/articles
- `apps/dashboard` : espace utilisateur/agence
- `apps/admin` : back-office admin
- `apps/api` : API backend (connexion app iOS + sync + exports + audit)
- `packages/shared` : types/contrats partagés
- `docs` : documentation technique
- `infra` : déploiement / variables d'environnement

## Règle de séparation

Ce repo ne contient **aucun** fichier Xcode/iOS.
Le repo iOS reste séparé.

## Lien avec l'app iOS

L'app iOS attend une variable:

- `FOXSCAN_API_BASE_URL=https://api.foxscan.fr`

et envoie des requêtes JSON vers les endpoints documentés dans:

- `docs/API_CONTRACT.md`

