# Déploiement FOXSCAN Web (Hostinger)

## 1) Ce que contient ce dossier
- `index.html` : page d'accueil
- `login.html` : connexion
- `dashboard/` : dashboard web
- `articles/` : pages SEO
- `js/` : scripts front
- `robots.txt` et `sitemap.xml`

## 2) Où l'uploader
- Domaine principal `foxscan.fr` : uploader le contenu de ce dossier dans `public_html/`
- Ne pas mettre ce dossier "web" lui-même : envoyer son contenu (les fichiers/dossiers à l'intérieur).

## 3) API attendue
Le front appelle :
- `https://api.foxscan.fr`

Vérifie avant test :
```bash
curl -i https://api.foxscan.fr/health
```
Doit répondre `200` avec un JSON `{"ok":true,...}`.

## 4) Test rapide après upload
- `https://foxscan.fr/` -> page d'accueil
- `https://foxscan.fr/login.html` -> page connexion
- `https://foxscan.fr/dashboard/index.html` -> dashboard
- `https://foxscan.fr/articles/lidar-immobilier-guide.html` -> article SEO

## 5) Si tu vois une ancienne version
- Vider le cache Hostinger (section cache)
- Hard refresh navigateur (Cmd+Shift+R)

## 6) Important
- Ne pas mettre de clés API dans les fichiers web.
- Les secrets restent côté backend Node uniquement.
