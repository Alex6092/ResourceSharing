# Décisions d’architecture acceptées

## Produit cible

Catalogue pédagogique partagé entre enseignants autorisés. Tout compte Moodle actif peut télécharger une ressource avec son lien, sans accès au catalogue de gestion pour les étudiants. Accès réseau local et Internet, en HTTPS. Aucune copie de fichier dans Moodle.

Les enseignants modifient leurs ressources ; les gestionnaires interviennent sur celles d’autrui. Les capacités sont évaluées au contexte système, avec un rôle contributeur explicitement attribué. Les restrictions par cours et les liens publics sont hors première version.

## Composants

- Node.js 24 LTS, TypeScript, Fastify 5 ; Vue 3 et Vite.
- PostgreSQL 17 ; pg-boss et worker distinct pour validation, publication et entretien.
- Uppy, `@tus/server` et `@tus/file-store` pour les transferts. Requêtes brutes, aucun chargement complet en mémoire.
- Apache MPM event et mod_xsendfile pour la distribution. Le backend autorise puis renvoie des en-têtes ; aucun flux de téléchargement applicatif.
- Installation Debian native, services systemd, configurations séparées, migrations, sauvegardes et restauration testée.

Le dossier approuvé impose une validation bloquante de la délégation Apache avant le MVP. Ce jalon est validé sur Debian 13 ; l’application et ses composants sont maintenant implémentés. Les résultats et limites observés figurent dans le guide de validation.

## Stockage et cohérence

`incoming`, `objects`, `quarantine` sur le même volume ; dossiers logiques en base. Noms physiques générés côté serveur. Objets publiés immuables, Apache en lecture seule, API sans écriture dans les objets, worker chargé de la publication.

Choix confirmé le 3 novembre 2026 : utiliser le disque système de 400 Gio existant. Un montage bind protégé relie `/var/lib/mprovifilesharing-data` à `/srv/ressources`. Le mode bind vérifie la source exacte, les options de montage et le marqueur, même lorsque le stockage partage le système de fichiers racine. La marge d’espace s’applique au disque partagé avec le système ; aucun second disque ni formatage n’est requis.

Entités : utilisateur stable `(instance Moodle, identifiant Moodle)`, session, dossier, ressource, version, dépôt, lien, compte technique, audit, usages connus et agrégats de téléchargement.

Cycle : réservation → transfert → réception → vérification → publication → disponibilité. Le SHA-256 incrémental client est comparé au SHA-256 serveur avant publication. Ne pas annoncer l’extension tus Checksum : le FileStore retenu ne la fournit pas.

Un verrou partagé protège chaque transfert entre API et worker. Un renommage atomique est suivi d’une transaction de publication ; la réconciliation récupère les interruptions entre disque et base. Les états intermédiaires sont persistants et les tâches idempotentes.

Réservation sérialisée de l’espace restant à écrire, marge max(5 % du volume, 10 Gio), pas de quota enseignant initial. Trois fichiers actifs par enseignant, six au total, blocs 16 Mio. Nettoyage après sept jours d’inactivité, pas après sept jours depuis la création d’un transfert encore actif.

## Liens et versions

`/download/{resourceId}` reste stable après renommage ou déplacement et redirige sans cache vers une version immuable. Le remplacement bascule la version courante uniquement après validation. Une reprise doit identifier sa version ou fournir If-Range ; jamais d’assemblage entre versions.

Versions anciennes et corbeille conservées trente jours. Ressource supprimée : 410 après authentification. Les usages Moodle connus servent d’avertissement ; les liens manuels ne sont pas recensables exhaustivement.

## Moodle et authentification

Trois plugins : `local_filesharing`, `tiny_filesharing`, `repository_filesharing`.

Icône par callback `local_filesharing_render_navbar_output`, comme Proxmox. Sans modification du cœur ni déplacement DOM. Capacités : `viewicon`, `access`, `upload`, `manageothers`, `admin`, sous `local/filesharing:` au contexte système.

Code SSO opaque de 256 bits, haché en base Moodle, expiration soixante secondes, consommation atomique, state lié au navigateur, PKCE S256 et URL de retour enregistrée. Échange serveur à serveur signé HMAC, horodaté et protégé par nonce. Secrets distincts d’AlgoMaze. Aucun mot de passe ni jeton permanent transmis dans une URL.

Sessions opaques côté serveur ; cookies Secure/HttpOnly/SameSite=Lax sans domaine parent ; deux heures d’inactivité, douze heures au maximum. CSRF et origine vérifiés pour les mutations. Vérification Moodle avant mutation et nouvelle requête de téléchargement ; cache de cinq minutes maximum pour le catalogue. Une nouvelle autorisation échoue temporairement si Moodle est indisponible. Les flux Apache déjà ouverts peuvent se terminer.

TinyMCE insère une ancre HTML échappée avec URL stable et libellé français. La recherche passe par les services AJAX Moodle et un appel serveur à serveur. Repository limité à FILE_EXTERNAL, sans FILE_INTERNAL ni FILE_REFERENCE ; pas de prise en charge des sélecteurs qui imposent une copie.

## API et MCP

API `/api/v1` décrite en OpenAPI dès le MVP : identité, ressources/recherche/métadonnées/disponibilité/liens, versions, dossiers, dépôts/finalisation, stockage. Pagination 50/max 200 ; UUID ; tailles décimales sous forme de chaînes ; erreurs structurées ; 409 conflit, 503 indisponibilité, 507 espace insuffisant. Révision requise pour éviter les écrasements concurrents.

Comptes techniques séparés, jetons hachés/révocables/expirants, lecture seule par défaut. Adaptateur MCP : `resources_search`, `resources_get`, `resources_check_availability`, `resources_get_download_link`, `folders_list`. Aucun accès disque ou base depuis MCP.

## Qualification et exploitation

Avant production : fichier réellement supérieur à 50 Go ; coupures réseau et redémarrage VM ; intégrité ; SSO expiré/rejoué/concurrent ; capacités et compte suspendu ; aucune duplication Moodle ; charge 10/30/50 clients et dépôt simultané ; disque plein et volume absent ; restauration sur VM vierge.

Objectifs : aucune corruption ou exposition d’un fichier partiel, stabilité à 30/50 clients, mémoire bornée, p95 métadonnées < 500 ms, débit à 30 clients ≥ 80 % de la référence Apache mesurée dans les mêmes conditions. Aucun débit physique n’est considéré acquis.

Sauvegarde quotidienne des objets publiés, de la base et de la configuration, purge suspendue pendant l’opération. RPO cible 24 h, durée de restauration mesurée. Transferts incomplets exclus de cette garantie. Journaux sans secrets : audit 90 jours, accès détaillés 30 jours, statistiques agrégées 12 mois, configurables.
