# MProviFileSharing

Catalogue partagé de ressources pédagogiques volumineuses, intégré à Moodle 5.2. Moodle authentifie et attribue les capacités ; Apache transmet les fichiers privés par X-Sendfile. Aucun contenu volumineux ne transite par Moodle.

## Version 0.1

API, worker de validation, interface Vue française, trois plugins Moodle et connecteur MCP implémentés. Banc Debian/Apache/X-Sendfile validé. Les tests métier utilisent PostgreSQL et tus réels. Un Moodle 5.2 isolé valide aussi l’installation des plugins et le véritable endpoint SSO PHP ; le double de protocole sert aux tests métier rapides.

Le déploiement public et les essais sur le Moodle de l’établissement restent à effectuer. Domaine pressenti : files.tspro.fr, après création DNS et certificat. Le pipeline GitHub passe et le runner de la VM est enregistré ; le déploiement public reste désactivé pendant la préparation.

Fonctions : catalogue, recherche/tri/pagination, dossiers logiques, dépôts résumables, SHA-256 navigateur/serveur, publication atomique et reprise, liens stables et versions, corbeille/restauration, SSO code unique/PKCE, capacités, icône Boost, TinyMCE et repository FILE_EXTERNAL, API de lecture, MCP, audit, statistiques Apache et sauvegarde Restic.

## Vérification

Node.js 24 et npm ; dépendances verrouillées.

```sh
npm ci
npm run build
npm run check
npm test
```

Sur Debian 13 avec PostgreSQL 17, sans root ni modification du service PostgreSQL existant :

```sh
bash deploy/scripts/test-integration-debian.sh tests
bash deploy/scripts/test-integration-debian.sh demo
# Écrit temporairement plus de 50 Gio sur le disque du dépôt :
bash deploy/scripts/test-integration-debian.sh large
# Apache HTTPS réel, charge locale 10/30/50 clients :
bash deploy/scripts/test-integration-debian.sh apache
# Avec sources Moodle 5.2 et PHP complet, installés dans l’outillage utilisateur :
bash deploy/scripts/test-integration-debian.sh moodle
```

Le mode demo utilise uniquement des identités et données synthétiques, sur adresses locales. Ne pas l’exposer sur Internet. Démarrer ce mode puis lancer `npx playwright test` pour le parcours navigateur ; installer Chromium avec Playwright sous Linux (Edge utilisé sous Windows).

Archives installables : dist/moodle après compilation. Rapports : test-results et .qualification ; preuves conservées : docs/qualification.

## Documentation

- [Installation Debian et Moodle](docs/exploitation/installation.md)
- [CI/CD GitHub et runner](docs/exploitation/cicd.md)
- [Sauvegarde et restauration](docs/exploitation/restauration.md)
- [Résultats et limites de qualification](docs/exploitation/validation.md)
- [Architecture](docs/conception/architecture.md)
- [Banc Apache/X-Sendfile](docs/exploitation/phase0.md)

Les configurations réelles et secrets restent sous /etc/mprovifilesharing, hors du dépôt. Les fichiers .example contiennent uniquement des exemples.
