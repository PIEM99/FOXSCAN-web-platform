# FOXSCAN API (Node.js / Express)

API unique pour:
- app iOS FOXSCAN
- dashboard web
- back-office

Objectif: garder le contrat iOS existant, avec une stack compatible Hostinger Node.js.

## Routes principales (contrat iOS + web)

- `GET /health`
- `POST /auth/apple`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /subscriptions/status`
- `GET /dashboard/session`
- `GET /projects`
- `GET /reports`
- `GET /models`
- `POST /inspections/sync`
- `POST /exports`
- `POST /audit-events`

## Démarrage local

```bash
cd apps/api
npm install
npm run dev
```

## Démarrage production

```bash
cd apps/api
npm install --omit=dev
npm start
```

## Variables d'environnement

Voir `infra/.env.example`.

Variables minimales:
- `PORT` (ex: `8000`)
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `FOXSCAN_DB_PATH` (ex: `apps/api/data/store.json`)
- `DASHBOARD_REQUIRE_ACTIVE_SUBSCRIPTION` (`true`/`false`)
- `DEFAULT_SUBSCRIPTION_STATUS` (`active`/`inactive`)

## Déploiement Hostinger Node

1. Créer une app Node.js sur `api.foxscan.fr`.
2. Startup file: `server.js`.
3. Déployer le dossier `apps/api` (avec `package.json`, `server.js`, `data/store.json`).
4. Configurer les variables d'environnement dans Hostinger.
5. Lancer/restart l'app Node.
6. Vérifier: `https://api.foxscan.fr/health`.

