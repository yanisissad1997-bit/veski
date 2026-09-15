# VESKI — backend SMS Twilio

Ce mini serveur sert uniquement de passerelle entre VESKI et Twilio Verify.

## Variables à créer sur l'hébergeur

- `TWILIO_ACCOUNT_SID` = votre `AC...`
- `TWILIO_AUTH_TOKEN` = votre Auth Token Twilio (SECRET)
- `TWILIO_VERIFY_SERVICE_SID` = votre `VA...`
- `ALLOWED_ORIGIN` = URL exacte de votre site VESKI (pour les tests, `*` peut fonctionner)

Ne mettez jamais l'Auth Token dans le HTML.

## Routes

`POST /api/mo-register`
```json
{"phone":"+33612345678"}
```

`POST /api/mo-status`
```json
{"phone":"+33612345678","code":"123456"}
```

`GET /health`

## Déploiement Render

1. Créer un dépôt Git avec ces fichiers.
2. Render → New → Web Service.
3. Build Command : `npm install`
4. Start Command : `npm start`
5. Choisir Free pour un test.
6. Ajouter les 4 variables dans Environment.
7. Déployer.
8. Tester `https://VOTRE-SERVICE.onrender.com/health`.

Le plan Free Render est adapté aux tests, mais le service se met en veille après une période d'inactivité et peut mettre environ une minute à redémarrer.

## Important pour VESKI

Le backend est prêt à être relié au HTML. Il faut ensuite modifier les deux appels `/api/mo-register` et `/api/mo-status` du frontend pour pointer vers l'URL `https://VOTRE-SERVICE.onrender.com`.

Le code de départ de VESKI utilisait déjà ces deux endpoints.
