# CampusLink Taza

CampusLink garde l’interface actuelle de ce projet et utilise désormais le backend Express/PostgreSQL du projet original. L’authentification passe par Neon Auth et les fichiers par le stockage privé Cloudflare R2. Les comptes, documents, discussions, favoris, historique, annonces, notifications et préférences sont persistants.

## Démarrer

Node.js 22 ou plus récent est nécessaire.

```sh
npm install
npm run dev
```

Ouvrir **http://localhost:5180**. Cette commande lance l’API sur le port 3001 et Vite sur le port 5180, avec un proxy `/api`. Le frontend et ses appels API partagent la même origine et les cookies de session sont HttpOnly.

Gardez ce terminal ouvert pendant le développement : arrêter `npm run dev` arrête les deux services. `npm run dev:frontend` lance uniquement l’interface ; pour une API séparée, utilisez aussi `npm run dev:server`. Si l’API est arrêtée ou inaccessible, le proxy renvoie désormais une réponse JSON `503 API_UNAVAILABLE` avec un message explicite, au lieu d’une erreur 500 vide. Il reprend les requêtes suivantes dès que l’API redémarre, sans renvoyer automatiquement une tentative de connexion.

Si ces ports sont déjà occupés, lancer `PORT=3002 CAMPUS_WEB_PORT=5181 CAMPUS_API_TARGET=http://127.0.0.1:3002 npm run dev`, puis ouvrir **http://localhost:5181**.

Pour un étudiant qui a oublié son mot de passe : Administration → Comptes → Réinitialiser le mot de passe. Le propriétaire vérifie son identité, crée un mot de passe temporaire et le transmet directement après confirmation. L’étudiant doit choisir son propre mot de passe à sa prochaine connexion, dans les 24 heures. L’action est aussi accessible depuis les demandes d’Assistance.

```sh
npm run build
npm start
```

Les statistiques Vercel sont activées lors des builds Vercel. Un build local ou Express autonome ne charge pas le script Vercel absent. Pour un hébergement disposant de cet endpoint, `CAMPUS_WEB_ANALYTICS=1 npm run build` active explicitement les statistiques ; la valeur `0` les désactive.

En production locale, Express sert le build `dist` et les routes de l’application sur **http://localhost:3001**. Régler `APP_ORIGIN` sur l’origine réelle avant publication et activer `COOKIE_SECURE=true` en HTTPS.

Sur cette machine, le runtime Node se trouve dans `/home/issmail/.local/share/sanaa-runtime/node-v22.23.3-linux-x64/bin` si le shell ne trouve pas `node` ou `npm`.

## Configuration et migration

La configuration serveur est dans `.env.local`, exclu de Git. Aucun secret serveur ne doit recevoir de préfixe `VITE_`. `.env.example` contient les noms des paramètres sans leurs valeurs : PostgreSQL, URLs Neon Auth et credentials R2.

Le projet utilise le schéma PostgreSQL **`campuslink_prj`**, distinct de **`campuslink`** utilisé par le projet original. Les métadonnées originales ont été copiées une seule fois, avec les relations, identifiants et séquences. Les identités Neon et références aux fichiers R2 existants sont conservées. Les comptes déjà liés à Neon Auth conservent leurs identifiants. Les anciens profils non liés doivent être associés à une identité réelle avec `npm run auth:link`, comme dans le projet source. Les mots de passe des comptes existants restent ceux de Neon Auth ; les anciens comptes fictifs `sara.demo`/`admin.demo` du frontend ne permettent plus de se connecter.

Les nouveaux fichiers utilisent le préfixe R2 **`campuslink-prj/`**. La suppression ou le remplacement dans ce projet ne supprime pas les objets importés du projet original. Le schéma et les fichiers sources ne sont pas déplacés ni supprimés. Neon Auth reste le fournisseur d’identité commun : modifier son propre mot de passe modifie le compte Neon correspondant.

```sh
npm run db:migrate
npm run db:seed
npm run db:clone -- --source-schema campuslink --target-schema campuslink_prj
```

`db:migrate` applique les migrations du schéma configuré. `db:seed` insère les références académiques ; les données de démonstration nécessitent explicitement `--demo`. `db:clone` copie les métadonnées du schéma source vers une destination vide et refuse d’écraser une destination existante. Une installation déjà migrée n’a pas besoin de relancer le clonage.

`db:migrate` ne lance plus de seed automatiquement. Pour préparer volontairement les références d'une installation vide, utiliser `npm run db:seed` ou `npm run db:migrate -- --seed`. Ne pas relancer un clonage ou une démonstration pour réparer une installation existante.

L'API vérifie les migrations appliquées, leurs empreintes et les tables/colonnes nécessaires avant de démarrer. Si le journal indique des migrations en attente, exécuter `npm run db:migrate` avec la configuration voulue, puis redémarrer `npm run dev`. Une migration déjà appliquée reste immuable : les ajouts doivent aller dans une nouvelle migration. `/api/health` vérifie désormais la disponibilité réelle du schéma et renvoie `503` en cas d'indisponibilité.

Le 12 octobre 2026, le schéma configuré `campuslink_prj` a été réparé jusqu'à la migration `027`, après une sauvegarde privée des métadonnées. La migration `012` retrouve exactement son empreinte historique ; ses ajouts ultérieurs de feedback sont dans `027`. Les comptes, le propriétaire, les messages, les ressources et les clés de stockage existants ont été conservés.

Le démarrage local ne lance aucune migration ni seed, même avec d’anciennes variables d’environnement. Les commandes `npm run db:migrate` et `npm run db:seed` sont explicites. Il lit `CAMPUS_DB_SCHEMA`, `CAMPUS_STORAGE_PREFIX`, `APP_ORIGIN`, `PORT` et `COOKIE_SECURE`. Les scripts de migration, d’import local et de liaison des identités sont conservés dans `server/`.

## Déploiement Vercel

Le dépôt conserve le dossier **`campuslink-taza/`**, attendu par le paramètre Root Directory du projet Vercel existant. Les commandes de ce README s’exécutent depuis ce dossier. `vercel.json` construit Vite dans `dist`, dirige `/api/*` vers `api/backend.js` et conserve les liens directs de l’application React.

Configurer côté serveur `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` et `R2_REGION`. Ces secrets restent dans les variables d’environnement Vercel et ne sont jamais publiés dans Git ou le frontend.

L’entrée Vercel utilise exclusivement le schéma existant **`campuslink_prj`** et le préfixe **`campuslink-prj/`**, même si les paramètres du projet Vercel ont été hérités de la version originale. Elle ne lance ni migration ni seed au démarrage. Le schéma doit donc avoir été préparé avec les migrations actuelles avant déploiement ; celui de ce projet est déjà migré. L’origine de chaque aperçu est déduite de `VERCEL_URL`, les cookies utilisent HTTPS et le proxy Vercel est pris en compte pour les vérifications d’origine.

Les connexions PostgreSQL sont renouvelées et les requêtes disposent d’une limite de 10 secondes pour empêcher une connexion bloquée de saturer le serveur. Une interruption temporaire renvoie une indisponibilité explicite et ne consomme pas les tentatives de connexion. Les clients de transaction défaillants sont retirés du pool ; les écritures ne sont pas relancées automatiquement.

## Dépôts de fichiers et partage de modules

La limite de fichier reste 20 Mio. Les fichiers de plus de 3 Mio passent automatiquement par des morceaux privés de 2 Mio, pour respecter la limite de requête de 4,5 Mo des fonctions Vercel. Les petits dépôts utilisent les routes multipart habituelles. La reprise garde le même identifiant de dépôt ; la publication et son reçu sont atomiques pour éviter les doublons après une réponse perdue. Les vérifications de signature, de permissions, de quotas et de destination restent celles des routes existantes.

Appliquer les migrations `029_message_module_shares.sql` et `030_resumable_uploads.sql` avec `npm run db:migrate` avant de déployer ce code sur une autre base. Les morceaux abandonnés expirent après une heure et sont nettoyés lors des prochains dépôts ; les reçus restent disponibles 24 heures. Le transport et ses tests sont décrits dans [docs/ux-reliability-2026-10-16.md](docs/ux-reliability-2026-10-16.md).

Dans la bibliothèque, chaque module dispose d’une action de partage et d’un appui long sur écran tactile. Le choix de discussion ajoute une référence au compositeur, avec un message personnel facultatif. La référence enregistrée conserve le semestre exact du module et les droits d’accès à sa bibliothèque.

## Comptes et administration

La récupération autonome est disponible sur `/forgot-password` : code à six chiffres envoyé uniquement à une adresse universitaire autorisée, puis mot de passe de 8 à 128 caractères (chiffres seuls acceptés). Le profil utilise ce même parcours pour les comptes universitaires ; les comptes classiques avec une autre adresse conservent le changement avec leur mot de passe actuel. Les réservations durables empêchent une ancienne session de rester utilisable si le service distant change le mot de passe puis perd sa réponse. Voir [la validation du 25 octobre](docs/password-recovery-2026-10-25.md).

La première association Google n’exige plus le drapeau historique de vérification de l’utilisateur Neon lorsque le callback prouve déjà le même sujet canonique, l’adresse Google vérifiée et le domaine Workspace autorisé. **Certains anciens comptes restent bloqués en amont par Managed Neon (`account_not_linked`), avant tout callback vérifiable.** Ce cas nécessite une évolution du fournisseur ou une intégration Google OIDC distincte ; la correction locale ne garantit pas encore l’entrée directe pour ces comptes. Voir [le diagnostic actuel](docs/google-direct-login-2026-10-25.md). Les paragraphes suivants conservent l’historique du déploiement initial.

L’intégration « Continuer avec Google » reste **désactivée par défaut** dans la configuration normale. Une prévisualisation réelle utilise une branche Neon indépendante sur `http://localhost:5181`, via `npm run preview:google-oauth` ; ses paramètres locaux sont contrôlés sans connexion avec `npm run preview:google-oauth -- --check`. Seul `usmba.ac.ma` est autorisé pour Google ; les accès Email/Password actuels sont conservés. **Le parcours réel du compte existant testé a réussi après une confirmation volontaire de son email par code, puis une nouvelle authentification Google.** L’utilisateur a confirmé son entrée dans le site et la trace serveur confirme le callback vérifié puis la redirection vers `/app`.

Après l’erreur, une vue dédiée présente Google sans champ de nom d’utilisateur ni mot de passe. La confirmation volontaire par code sert à la première mise en place d’un ancien compte dont l’email Neon n’était pas vérifié ; elle n’est pas prévue à chaque connexion Google. Aucun email n’est envoyé à l’ouverture et cette confirmation ne crée aucune session applicative. Les endpoints officiels de vérification sont utilisés ; la connexion par OTP et la modification des mots de passe sont exclues. Le formulaire classique reste un choix facultatif. Avant de relancer OAuth, le code d’erreur assaini reste associé à l’entrée d’historique pour conserver la vue au rechargement ou au retour arrière. Le départ vers Google remplace ensuite cette entrée, pour ne pas laisser l’ancien écran de vérification comme étape obsolète du parcours.

Le serveur enregistre une liaison automatique uniquement pour le même sujet Neon canonique déjà authentifié, avec email Neon strictement vérifié, preuves Google vérifiées, domaine Workspace correspondant et absence de conflit. Cette règle ne fusionne pas deux sujets par email. **La reconnexion par Google seul est maintenant validée réellement : l’utilisateur choisit son compte académique et entre directement, sans nouveau code ni mot de passe CampusLink.** La trace confirme trois parcours Google suivants terminés sur `/app`, sans nouvel appel de vérification d’email. Le test automatisé de retour arrière retrouve aussi la page normale sans ancienne confirmation. La migration additive `036_google_oauth_sessions.sql`, les variables et les callbacks sont décrits dans [le rapport initial](docs/google-oauth-2026-10-23.md) ; les preuves réelles et les validations actuelles — 221 tests backend, 4 contrôles ciblés, 24 scénarios UI et build réussi en 11,18 secondes — figurent dans [le rapport Neon du 24 octobre](docs/google-oauth-neon-test-2026-10-24.md). Ce succès ne couvre pas tous les comptes ni les scénarios de production. `npm run auth:google-check -- --verify-provider` examine la configuration publique sans lancer de connexion. Aucune publication ni activation Google ne doit précéder les vérifications restantes et l’autorisation du propriétaire.

Avec Google désactivé, une base antérieure à `036_google_oauth_sessions.sql` continue à démarrer avec le fonctionnement d’authentification précédent, uniquement si cette migration et ses cinq tables sont entièrement absentes. Une migration partielle, un checksum différent ou un autre objet manquant reste bloquant. Activer Google exige la migration complète. Après application de `036`, redémarrer l’API pour activer les admissions durables ; une base déjà migrée les conserve même si Google est ensuite désactivé. Voir la [reprise et les vérifications sous Windows](docs/recovery-2026-10-25.md).

L’inscription réelle demande les informations académiques et reste en attente de validation. Le propriétaire et les administrateurs disposant de la capacité distincte `student.admit` acceptent ou refusent les demandes dans leur périmètre. Un compte en attente ou refusé ne peut pas accéder au campus. Les comptes créés par l’administration passent également par Neon Auth.

Les capacités migrées et leurs limites par rôle sont détaillées dans [docs/admin-capabilities.md](docs/admin-capabilities.md). Les huit onglets existants restent en place : vue d’ensemble, comptes, organisation, ressources, annonces, signalements, communauté et assistance. L’administrateur global, l’administrateur de faculté et le modérateur sont distingués à la fois dans l’interface et sur chaque route serveur.

Les réponses d’assistance deviennent des notifications dans CampusLink. Elles n’envoient pas d’e-mail externe. Le changement personnel de mot de passe utilise Neon Auth ; la réinitialisation arbitraire du mot de passe d’un autre compte n’est pas une capacité du backend original.

Le profil permet de modifier le nom, la présentation, la photo et les préférences. Après attribution, la faculté, la filière et le semestre sont gérés par l’administration ; le profil propose un lien vers l’assistance pour demander une correction. Un changement de parcours confirmé par le serveur recharge les données du nouveau contexte et ferme les brouillons et aperçus associés à l’ancien.

Dans le profil, « Supprimer la photo » affiche les initiales en aperçu ; « Enregistrer les modifications » confirme sa suppression. « Annuler » restaure la photo avant enregistrement. Les photos portrait et paysage utilisent le même cadre circulaire, sans déformation.

## Interface conservée

Les thèmes chauds clair/sombre, le français/anglais/arabe, les sélecteurs personnalisés, les bulles de discussion et le menu par appui prolongé restent en place. Sur mobile, les quatre onglets du bas restent Accueil, Discussions, Library et Annonces. Le calendrier et l’administration utilisent les destinations secondaires.

La pile de ressources sur Accueil reste limitée au mobile. Le déplacement suit le doigt à la même vitesse, les hauteurs des documents s’adaptent progressivement et une seule animation termine chaque geste. Cinq cartes au maximum sont préchargées, avec une sixième conservée temporairement si un long geste en a encore besoin. Le défilement de la page reste disponible hors de la pile et à ses extrémités. L’affichage desktop d’Accueil et les pages sauvegardées conservent leur organisation.

La bibliothèque rassemble la navigation semestre/module, puis les contrôles de recherche, catégorie et année. Les filtres actifs restent visibles et peuvent être retirés séparément ; « Tout effacer » conserve le module, le semestre et le tri choisis. Le tri est enregistré dans l’URL avec les filtres, y compris lors des retours arrière/avant. La recherche avancée dans le texte des PDF couvre tous les PDF accessibles, indépendamment de ces filtres. Les cartes affichent le module, le Part/Chapitre, le semestre et le nom d’utilisateur du déposant. Le titre, le nom original, le professeur, la catégorie, la taille, la date et le chemin restent accessibles dans les informations du lecteur.

TD et TP disposent de filtres et de raccourcis distincts. Les fichiers et dossiers partagés sont regroupés par catégorie, y compris lorsque deux dépôts du même étudiant utilisent le même chemin. Un dépôt lancé depuis un module et une catégorie reprend ces choix dans le formulaire, sous réserve des semestres autorisés. Les anciens documents portant réellement la catégorie combinée `tdtp` restent accessibles dans un emplacement distinct, sans classement deviné. `npm run test:library-types` vérifie ces parcours avec des API interceptées sur téléphone, tablette et ordinateur.

Fermer un document ouvert par un lien retire son ordre d’ouverture (`document`, `page`, `version` et le mode d’étude associé) de l’URL en conservant les filtres et le contexte de navigation. Une recherche, un rafraîchissement ou une autre action ne rouvre donc pas le document fermé. `npm run test:document-preview-routing` couvre la fermeture, les actions suivantes et une nouvelle ouverture volontaire, ainsi que les pièces jointes des discussions.

Library regroupe automatiquement les anciens et nouveaux documents par module, dans leur faculté, filière et semestre. Les variantes de casse et les espaces superflus partagent le même dossier. La migration 011 rattache les anciens fichiers à leur module sans toucher aux octets, aux noms de fichiers ou aux versions. Dans un module, les chemins des fichiers partagés deviennent des dossiers et sous-dossiers navigables, séparés par déposant. Le fil d’Ariane, l’URL et le retour navigateur conservent le dossier choisi ; chaque dossier affiche au maximum 24 documents par page. Cette arborescence repose sur les chemins existants : les dossiers vides et les droits propres aux dossiers nécessitent une API dédiée.

Le partage de fichiers ou dossiers conserve les noms et chemins imbriqués. Le semestre, le module, la catégorie et le professeur facultatif restent des paramètres généraux. Pour plusieurs fichiers, le titre est automatiquement le nom du module en majuscules ; seul le Part/Chapitre se choisit individuellement dans un sélecteur proposant exactement Complet et les valeurs de 1 à 20. Les anciennes valeurs supérieures à 20 restent lisibles et conservées dans les documents existants. Un fichier unique conserve son titre personnalisable dans les paramètres généraux. Les fichiers sont réellement téléversés ; après une erreur partielle, seuls les fichiers restants sont renvoyés, avec les métadonnées déjà enregistrées conservées. Les pièces jointes de chat sont enregistrées avec le message, accessibles après reconnexion, sans être ajoutées automatiquement à Library. Les aperçus et téléchargements passent par les routes privées contrôlées par le serveur.

Le thème, la langue et le fait d’avoir déjà vu la proposition d’installation utilisent le localStorage du frontend. Les anciennes données de démonstration ne sont jamais utilisées pour établir une session ou autoriser une action.

CampusLink peut être installé comme application web. La proposition apparaît une seule fois par navigateur, puis l’installation reste accessible dans le profil. Chrome et Edge utilisent leur dialogue natif lorsqu’il est disponible ; les autres navigateurs affichent les étapes adaptées, notamment « Sur l’écran d’accueil » sur iPhone/iPad. La publication doit utiliser HTTPS pour permettre l’installation native sur téléphone ; HTTP sur localhost reste utilisable pour les vérifications locales. Le service worker conserve le shell et les assets publics. Les copies privées explicites de documents sont séparées dans IndexedDB, liées au compte et limitées à 24 heures ; les réponses API ne sont pas mises en cache par le worker.

Campus Labs exécute réellement JavaScript (QuickJS), Python (Pyodide), C17 et C++20 (Clang/WASI) dans le navigateur, avec un éditeur CodeMirror et une console stdout/stderr. JSON est validé et formaté. Les moteurs sont chargés à la demande et préparés automatiquement avant `npm run dev`, `npm run dev:frontend` et `npm run build`. Les exécutions sont bornées et peuvent être arrêtées ; Python utilise une origine opaque pour isoler les données privées du site. Les XP de pratique restent réservés aux sessions JavaScript volontaires. Les limites, licences, en-têtes de déploiement et tests sont décrits dans [docs/labs-runtime.md](docs/labs-runtime.md).

## Vérification

```sh
npm run build
npm test
npm run test:integration
npm run test:admin-ui
npm run test:resource-stack
npm run test:context-sync
npm run test:module-library
npm run test:install-app
npm run test:frontend-design
npm run test:reader-workspace
npm run test:feedback
npm run test:admin-mobile
npm run test:profile-photo
npm run test:labs-runtime
npm run test:labs-editor
npm run test:module-sharing
npm run test:community-keyboard
node tests/navigation-loading.browser.mjs
node tests/install-worker.browser.mjs
```

Les tests d’intégration utilisent les véritables routes API et un schéma PostgreSQL temporaire, avec des doubles explicites pour l’identité et les octets des fichiers. Ils ne modifient pas les comptes Neon ou les fichiers du projet original. Les schémas temporaires sont supprimés à la fin. `CAMPUS_TEST_DATABASE_URL` peut fournir une base PostgreSQL de test ; à défaut la connexion configurée est utilisée avec un schéma isolé.

Le compte rendu de la revue du 15 octobre 2026 est dans [docs/code-audit-2026-10-15.md](docs/code-audit-2026-10-15.md). Les nouvelles corrections des dépôts, de la navigation, du lecteur, de Labs et du partage de modules sont décrites dans [docs/ux-reliability-2026-10-16.md](docs/ux-reliability-2026-10-16.md).

`test:frontend-design` vérifie les pages et onglets sur ordinateur, tablette et téléphone, avec les deux thèmes et le français, l’anglais et l’arabe. Il utilise Vite sur 5180 et des réponses API contrôlées, sans modifier les données du campus. Le rapport est enregistré dans `test-results/frontend-consistency/report.json` ; `CAMPUS_DESIGN_SCREENSHOTS=1 npm run test:frontend-design` conserve aussi les captures.

`test:community-keyboard` vérifie la rédaction et le dernier message visibles lors du redimensionnement et du déplacement du viewport visuel, le focus continu après envoi, le menu de pièces jointes dès le premier appui, la lecture des anciens messages et la navigation au clavier. Les API sont simulées ; le backend n’est pas modifié. La suite couvre 320 à 1440 px, le français et l’arabe, les deux thèmes et Firefox avec `CAMPUSLINK_TEST_BROWSER=firefox npm run test:community-keyboard`. Le clavier système n’étant pas disponible en mode headless, ses changements de viewport sont simulés séparément du redimensionnement réel de la fenêtre ; les gestes et le focus utilisent les événements natifs du navigateur.

`test:reader-workspace` vérifie le rendu réel d’un PDF de plusieurs pages, l’espace de lecture, les outils et notes, la recherche, la comparaison, le mode focus et la reprise après une erreur. Le lecteur affiche les pages en défilement continu et ne monte les canevas qu’à proximité de la zone visible. Une seule icône ouvre les réglages, le zoom, les notes, la recherche et les actions secondaires ; les anciennes flèches précédent/suivant ont été retirées. Les tests utilisent des réponses API contrôlées sur Vite 5180.

Le test de pile mobile utilise des réponses API contrôlées pour mesurer l’interaction et la performance indépendamment du réseau. Il nécessite Vite démarré sur 5180 et Chromium installé (`npx playwright install chromium`). Les anciennes suites du prototype restent disponibles dans `tests/` comme références de l’interface ; les suites ci-dessus vérifient l’application reliée au serveur.

Le test de synchronisation retarde une réponse de rafraîchissement pour vérifier qu’elle ne peut pas annuler un favori déjà confirmé par le serveur. Il utilise aussi Vite et des réponses API contrôlées.

Le test de bibliothèque utilise Vite et des réponses API contrôlées pour vérifier le regroupement des modules existants, la navigation, les noms Unicode et les anciens fichiers sans module, la pagination mobile, le partage multiple dans Library et les discussions, ainsi que la reprise après un échec partiel. Les tests PostgreSQL vérifient également la migration des anciens fichiers et les uploads concurrents de variantes d’un même module.

La revue frontend du 18 octobre 2026 est détaillée dans [docs/frontend-phase1-2026-10-18.md](docs/frontend-phase1-2026-10-18.md). Les nouvelles suites `frontend-shell-phase1.browser.mjs`, `library-phase1.browser.mjs`, `frontend-admin-phase1.browser.mjs`, `phase1-community-campus.browser.mjs` et `labs-availability.browser.mjs` utilisent uniquement des réponses API de test interceptées.

Le [rapport de la suite de l’audit](docs/audit-complet-2026-10-18.md) décrit les nouveaux parcours, les vérifications et l’incident de migration automatique locale.

Pour examiner le build avec des données temporaires : `npm run build`, puis `npm run preview:isolated` (port 5180). Cette prévisualisation utilise les routes réelles, un schéma PostgreSQL jetable, des identités de test et un stockage de fichiers en mémoire. Les identifiants synthétiques sont affichés dans le terminal. Si le port est déjà occupé, utiliser `CAMPUS_ISOLATED_PORT=5190 npm run preview:isolated`. L’arrêt par Ctrl+C ferme les connexions et supprime uniquement le schéma temporaire gardé par le helper de tests.
