// Ajouter une traduction en reprenant les clés de fr. Les tailles et dates
// utilisent Intl ; les plugins Moodle et Uppy ont leurs propres catalogues.
export const fr = {
  title: 'Ressources pédagogiques', subtitle: 'Le catalogue partagé de votre établissement',
  catalogue: 'Catalogue', trash: 'Corbeille', folders: 'Dossiers', root: 'Toutes les ressources',
  search: 'Rechercher un fichier…', upload: 'Déposer des fichiers', newFolder: 'Nouveau dossier',
  name: 'Nom', size: 'Taille', author: 'Déposé par', modified: 'Modification', actions: 'Actions',
  empty: 'Ce dossier ne contient aucune ressource.', emptySearch: 'Aucune ressource ne correspond à cette recherche.',
  emptyHint: 'Déposez votre premier fichier pour obtenir un lien utilisable dans Moodle.',
  moodle: 'Retour à Moodle', login: 'Se connecter avec Moodle', logout: 'Déconnexion',
  loginTitle: 'Vos fichiers, au même endroit.', loginHint: 'Connectez-vous avec votre compte Moodle pour gérer les ressources pédagogiques.',
  rename: 'Renommer', move: 'Déplacer', replace: 'Remplacer le fichier', remove: 'Mettre en corbeille',
  restore: 'Restaurer', download: 'Télécharger', copy: 'Copier le lien', copyHtml: 'Copier pour Moodle',
  versions: 'Versions', close: 'Fermer', save: 'Enregistrer', cancel: 'Annuler', previous: 'Précédent', next: 'Suivant',
  transfers: 'Transferts', noTransfers: 'Aucun transfert récent.', shared: 'Partagé avec les enseignants autorisés',
  used: 'Espace utilisé', available: 'disponibles pour de nouveaux dépôts', reserved: 'réservés aux transferts',
  ready: 'Disponible', missing: 'Fichier indisponible', trashed: 'Dans la corbeille',
  reservedState: 'Préparation', uploading: 'Transfert en cours', received: 'En attente de validation',
  verifying: 'Vérification SHA-256', publishing: 'Publication', completed: 'Publié', cancelled: 'Annulé', expired: 'Expiré', error: 'Erreur',
  copied: 'Lien copié.', failed: 'L’opération a échoué.', details: 'Détails',
  hash: 'Vérification locale', reload: 'Actualiser', admin: 'Accès API', createToken: 'Créer un jeton de lecture',
  tokenHint: 'Copiez ce jeton maintenant. Il ne sera plus affiché ensuite.', revoke: 'Révoquer',
  deletedWarning: 'Les liens existants cesseront de fonctionner. La ressource restera récupérable pendant 30 jours.',
  usagesWarning: 'Les sélections connues ne recensent pas tous les liens copiés manuellement.',
  resumeHint: 'Après fermeture du navigateur, sélectionnez à nouveau le même fichier pour reprendre un transfert incomplet.',
  accessDenied: 'Cet espace est réservé aux enseignants autorisés. Le téléchargement depuis une activité Moodle reste accessible aux étudiants.',
};
export type Messages = typeof fr;
