Audit du code et des parcours CampusLink — 15 octobre 2026

Les corrections portent sur les requêtes coûteuses, les accès concurrents, les sessions privées, le mode hors ligne et les échanges avec l’administration. Les contrôles couvrent le serveur Express/PostgreSQL, les contrats API, les pages publiques et les espaces étudiant et administrateur.

Corrections et mesures :

- Recherche : les auteurs et leurs badges sont chargés en groupe. Pour 30 messages correspondants, les lectures de profils et badges passent de 180 à 2. Les filtres de faculté, filière, semestre, auteur et les restrictions de discussion restent vérifiés.
- Permissions XP : PostgreSQL renvoie un résumé au lieu du classement complet de la filière. Les permissions restent calculées depuis les données actuelles ; elles ne sont pas mises en cache.
- Présence : les requêtes répétées ne réécrivent plus la ligne utilisateur pendant 60 secondes. Le test vérifie la version PostgreSQL de la ligne, pas seulement sa valeur.
- Connexion et contact : les demandes concurrentes réservent leur quota avant les opérations asynchrones. Les tables de limitation sont bornées et les réponses 429 indiquent `Retry-After`.
- Initialisation : une erreur de configuration ou d’installation des routes libère les connexions et services créés par cette tentative. Les dépendances fournies par l’appelant restent ouvertes en cas d’échec.
- Chargement initial : les espaces connectés et les dialogues sont chargés à la demande. Le JavaScript principal passe de 514,41 à 413,06 ko, soit environ 20 % de moins ; il s’agit de la taille du fichier, sans promesse équivalente sur le temps de réponse.
- Notifications : les identifiants des messages correspondent désormais à ceux recherchés lors de la consultation ; l’accusé de lecture est envoyé après avoir quitté la destination.
- Assistance : une réponse conserve le statut existant, les brouillons sont séparés entre conversations, les doubles soumissions sont bloquées et une réponse tardive ne modifie pas une autre conversation.
- Client : annulation et expiration sont distinguées, les délais couvrent aussi la lecture du corps JSON, les en-têtes `Headers` sont conservés et les messages retrouvent leurs ressources via un index en mémoire.
- Travail privé : les téléchargements, lectures et conflits d’une ancienne session ne peuvent plus alimenter la nouvelle session. Les modifications en attente sont fusionnées et la dernière position de lecture est conservée lors de la fermeture.
- Installation : le cache conserve les fichiers de démarrage, reste borné et retrouve les assets publics malgré `Vary: Origin`. Les API privées restent exclues du cache du service worker.

Vérifications effectuées :

- Build de production avec Node 22 ; audit npm sans vulnérabilité signalée.
- Suite complète : 346 tests unitaires et API réussis, aucun échec ni test ignoré, avec une base PostgreSQL locale et des schémas temporaires ; migrations, permissions, authentification, uploads, lecture et concurrence inclus.
- Intégration navigateur avec les vraies routes de l’application et PostgreSQL temporaire : connexion, bibliothèque, fichiers de discussion, profil, contexte universitaire protégé, administration, inscription et validation.
- 199 vérifications de pages : 35 destinations connectées et les parcours publics, largeurs 320, 390, 768 et 1440 px, français/anglais/arabe, thèmes clair et sombre. Aucun débordement de page, erreur JavaScript ou appel API inattendu dans cette suite.
- Lecteur PDF : rendu, navigation, recherche, notes, comparaison, focus, erreurs et reprise ; téléphone 320/390 px et paysage 844 × 390, ainsi que PC.
- Régressions de gestes tactiles, inscription mobile, assistance, interactions étudiantes, synchronisation et installation réelle Chromium avec navigation hors ligne puis reconnexion.

Les captures et rapports sont dans `test-results/frontend-consistency/`, `test-results/reader-workspace-browser-report.json`, `test-results/integration-report.json` et `test-results/code-audit/`. Ces résultats générés sont exclus de Git.

Pour reproduire, définir `CAMPUS_TEST_DATABASE_URL` vers une base PostgreSQL de test, puis lancer `npm test` et `npm run test:integration`. Les suites visuelles utilisent `CAMPUSLINK_TEST_URL` pour sélectionner Vite ou le serveur du build ; `test:install-worker` doit être vérifié contre un build de production. La nouvelle régression d’assistance est accessible par `npm run test:feedback`.

La base configurée de l’application a passé l’inspection de schéma et le serveur local a répondu `200 {"ok":true}` sur `/api/health`. Aucun changement de migration n’a été nécessaire. Les scénarios d’identité et de stockage utilisent des doubles explicites : les mots de passe Neon et les objets R2 réels n’ont pas été modifiés par ces tests.

Limites : les essais mobiles utilisent Chromium avec émulation de taille et de toucher ; Safari et les appareils physiques restent à vérifier. Les quotas de connexion sont locaux à chaque processus. La recherche groupe ses lectures secondaires, mais charge encore les collections de contenu autorisées avant filtrage ; cette revue ne constitue pas un test de charge en production ni une pagination complète du catalogue.
