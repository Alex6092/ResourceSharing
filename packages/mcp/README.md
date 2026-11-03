# Connecteur MCP

Adaptateur stdio en lecture seule, sans accès direct au disque de ressources ni à PostgreSQL. Créer un compte technique depuis l’interface d’administration, avec les portées resources:read, folders:read et availability:read ; conserver son jeton dans le gestionnaire de secrets du client MCP.

Exemple de configuration, à adapter au chemin d’installation :

```json
{
  "mcpServers": {
    "ressources-pedagogiques": {
      "command": "node",
      "args": ["/opt/mprovifilesharing/current/packages/mcp/src/main.ts"],
      "env": {
        "FILESHARING_BASE_URL": "https://files.tspro.fr",
        "FILESHARING_API_TOKEN": "FOURNI_PAR_LE_GESTIONNAIRE_DE_SECRETS"
      }
    }
  }
}
```

Outils : resources_search, resources_get, resources_check_availability, resources_get_download_link et folders_list. Le lien est stable mais reste soumis à une authentification Moodle ; il ne contient aucun secret. Le connecteur vérifie la disponibilité avant de proposer un nouveau lien. Une révocation ou expiration du compte technique bloque immédiatement ses prochaines requêtes.

Les tests d’intégration exécutent ce véritable processus stdio, appellent les outils et vérifient la révocation. Aucun outil de dépôt, suppression ou administration n’est exposé.
