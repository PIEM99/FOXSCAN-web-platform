# FOXSCAN API Contract (iOS Integration)

Document de référence pour connecter l'app iOS au site/back-office FOXSCAN.

## Base URL

Configurer dans l'app iOS:

- `FOXSCAN_API_BASE_URL=https://api.foxscan.fr`

Toutes les routes ci-dessous sont préfixées par cette base URL.

## Auth

- `POST /auth/apple`
- `POST /auth/refresh`
- `POST /auth/logout`

## Consentements

- `POST /consents/terms`
- `POST /consents/privacy`
- `POST /consents/ai`

## Agence / RBAC

- `GET/POST /agencies`
- `GET/POST /members`
- `GET/POST /roles`
- `GET/POST /permissions`

## Projets / États des lieux

- `GET/POST /projects`
- `GET/POST /inspections`
- `POST /inspections/sync`  ← endpoint déjà appelé par l'app iOS
- `POST /media/upload-url`

## Exports / Audit

- `POST /exports`           ← endpoint déjà appelé par l'app iOS
- `POST /audit-events`      ← endpoint déjà appelé par l'app iOS

## Ce que l'app iOS envoie déjà aujourd'hui

### 1) Sync inspection

- Route: `POST /inspections/sync`
- Header: `Content-Type: application/json`
- Header optionnel: `Authorization: Bearer <accessToken>`
- Body JSON: payload sérialisé contenant `projectID`, `reportID`, `projectName`, `updatedAt`, `actorUserID`, `report`.

### 2) Export artifact

- Route: `POST /exports`
- Header: idem
- Body JSON: artifact export (`projectID`, `reportID`, `createdByUserID`, `createdAt`, `kind`, `fileName`, `contentHash`).

### 3) Audit event

- Route: `POST /audit-events`
- Header: idem
- Body JSON: événement d'audit.

## Réponses minimales recommandées

Pour compatibilité iOS actuelle:

- HTTP `2xx` = succès
- Toute réponse non `2xx` = erreur côté app

Réponse JSON standard recommandée:

```json
{
  "ok": true,
  "id": "optional-id",
  "message": "optional"
}
```

## Sécurité minimale

- HTTPS obligatoire
- JWT court + refresh token rotatif
- Validation stricte des droits agence (`agency_id`)
- Journalisation append-only pour l'audit

