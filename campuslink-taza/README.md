# CampusLink Taza

CampusLink garde l’interface actuelle de ce projet et utilise désormais le backend Express/PostgreSQL du projet original. L’authentification passe par Neon Auth et les fichiers par le stockage privé Cloudflare R2. Les comptes, documents, discussions, favoris, historique, annonces, notifications et préférences sont persistants.

## Démarrer

Node.js 22 ou plus récent est nécessaire.

```sh
npm install
npm run dev
```

Ouvrir **http://localhost:5180**. Cette commande lance l’API sur le port 3001 et Vite sur le port 5180, avec un proxy `/api`. Le frontend et ses appels API partagent la même origine et les cookies de session sont HttpOnly.

Si ces ports sont déjà occupés, lancer `PORT=3002 CAMPUS_WEB_PORT=5181 CAMPUS_API_TARGET=http://127.0.0.1:3002 npm run dev`, puis ouvrir **http://localhost:5181**.

Pour un étudiant qui a oublié son mot de passe : Administration → Comptes → Réinitialiser le mot de passe. Le propriétaire vérifie son identité, crée un mot de passe temporaire et le transmet directement après confirmation. L’étudiant doit choisir son propre mot de passe à sa prochaine connexion, dans les 24 heures. L’action est aussi accessible depuis les demandes d’Assistance.

```sh
npm run build
npm start
```

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

Le démarrage local lit `CAMPUS_DB_SCHEMA`, `CAMPUS_DB_MIGRATE`, `CAMPUS_DB_SEED`, `CAMPUS_STORAGE_PREFIX`, `APP_ORIGIN`, `PORT` et `COOKIE_SECURE`. Les scripts de migration, d’import local et de liaison des identités sont conservés dans `server/`.

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

L’inscription réelle demande les informations académiques et reste en attente de validation. L’administrateur global accepte ou refuse les demandes. Un compte en attente ou refusé ne peut pas accéder au campus. Les comptes créés par l’administration passent également par Neon Auth.

Les capacités migrées et leurs limites par rôle sont détaillées dans [docs/admin-capabilities.md](docs/admin-capabilities.md). Les huit onglets existants restent en place : vue d’ensemble, comptes, organisation, ressources, annonces, signalements, communauté et assistance. L’administrateur global, l’administrateur de faculté et le modérateur sont distingués à la fois dans l’interface et sur chaque route serveur.

Les réponses d’assistance deviennent des notifications dans CampusLink. Elles n’envoient pas d’e-mail externe. Le changement personnel de mot de passe utilise Neon Auth ; la réinitialisation arbitraire du mot de passe d’un autre compte n’est pas une capacité du backend original.

Le profil permet de modifier le nom, la présentation, la photo et les préférences. Après attribution, la faculté, la filière et le semestre sont gérés par l’administration ; le profil propose un lien vers l’assistance pour demander une correction. Un changement de parcours confirmé par le serveur recharge les données du nouveau contexte et ferme les brouillons et aperçus associés à l’ancien.

Dans le profil, « Supprimer la photo » affiche les initiales en aperçu ; « Enregistrer les modifications » confirme sa suppression. « Annuler » restaure la photo avant enregistrement. Les photos portrait et paysage utilisent le même cadre circulaire, sans déformation.

## Interface conservée

Les thèmes chauds clair/sombre, le français/anglais/arabe, les sélecteurs personnalisés, les bulles de discussion et le menu par appui prolongé restent en place. Sur mobile, les quatre onglets du bas restent Accueil, Discussions, Library et Annonces. Le calendrier et l’administration utilisent les destinations secondaires.

La pile de ressources sur Accueil reste limitée au mobile. Le déplacement suit le doigt à la même vitesse, les hauteurs des documents s’adaptent progressivement et une seule animation termine chaque geste. Cinq cartes au maximum sont préchargées, avec une sixième conservée temporairement si un long geste en a encore besoin. Le défilement de la page reste disponible hors de la pile et à ses extrémités. L’affichage desktop d’Accueil et les pages sauvegardées conservent leur organisation.

Library regroupe automatiquement les anciens et nouveaux documents par module, dans leur faculté, filière et semestre. Les variantes de casse et les espaces superflus partagent le même dossier. La migration 011 rattache les anciens fichiers à leur module sans toucher aux octets, aux noms de fichiers ou aux versions. L’ouverture d’un dossier conserve les cartes existantes et affiche au maximum 24 documents par page ; la recherche couvre tous les documents et les liens directs ouvrent la page du document concerné.

Le partage de fichiers ou dossiers conserve les noms et chemins imbriqués. Le semestre, le module, la catégorie et le professeur facultatif restent des paramètres généraux. Pour plusieurs fichiers, le titre est automatiquement le nom du module en majuscules ; seul le Part/Chapitre (entier positif sans limite ou Complet) se renseigne individuellement. Un fichier unique conserve son titre personnalisable dans les paramètres généraux. Les fichiers sont réellement téléversés ; après une erreur partielle, seuls les fichiers restants sont renvoyés, avec les métadonnées déjà enregistrées conservées. Les pièces jointes de chat sont enregistrées avec le message, accessibles après reconnexion, sans être ajoutées automatiquement à Library. Les aperçus et téléchargements passent par les routes privées contrôlées par le serveur.

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
npm run test:module-sharing
node tests/navigation-loading.browser.mjs
node tests/install-worker.browser.mjs
```

Les tests d’intégration utilisent les véritables routes API et un schéma PostgreSQL temporaire, avec des doubles explicites pour l’identité et les octets des fichiers. Ils ne modifient pas les comptes Neon ou les fichiers du projet original. Les schémas temporaires sont supprimés à la fin. `CAMPUS_TEST_DATABASE_URL` peut fournir une base PostgreSQL de test ; à défaut la connexion configurée est utilisée avec un schéma isolé.

Le compte rendu de la revue du 15 octobre 2026 est dans [docs/code-audit-2026-10-15.md](docs/code-audit-2026-10-15.md). Les nouvelles corrections des dépôts, de la navigation, du lecteur, de Labs et du partage de modules sont décrites dans [docs/ux-reliability-2026-10-16.md](docs/ux-reliability-2026-10-16.md).

`test:frontend-design` vérifie les pages et onglets sur ordinateur, tablette et téléphone, avec les deux thèmes et le français, l’anglais et l’arabe. Il utilise Vite sur 5180 et des réponses API contrôlées, sans modifier les données du campus. Le rapport est enregistré dans `test-results/frontend-consistency/report.json` ; `CAMPUS_DESIGN_SCREENSHOTS=1 npm run test:frontend-design` conserve aussi les captures.

`test:reader-workspace` vérifie le rendu réel d’un PDF de plusieurs pages, l’espace de lecture, les outils et notes, la recherche, la comparaison, le mode focus et la reprise après une erreur. Le lecteur affiche les pages en défilement continu et ne monte les canevas qu’à proximité de la zone visible. Une seule icône ouvre les réglages, le zoom, les notes, la recherche et les actions secondaires ; les anciennes flèches précédent/suivant ont été retirées. Les tests utilisent des réponses API contrôlées sur Vite 5180.

Le test de pile mobile utilise des réponses API contrôlées pour mesurer l’interaction et la performance indépendamment du réseau. Il nécessite Vite démarré sur 5180 et Chromium installé (`npx playwright install chromium`). Les anciennes suites du prototype restent disponibles dans `tests/` comme références de l’interface ; les suites ci-dessus vérifient l’application reliée au serveur.

Le test de synchronisation retarde une réponse de rafraîchissement pour vérifier qu’elle ne peut pas annuler un favori déjà confirmé par le serveur. Il utilise aussi Vite et des réponses API contrôlées.

Le test de bibliothèque utilise Vite et des réponses API contrôlées pour vérifier le regroupement des modules existants, la navigation, les noms Unicode et les anciens fichiers sans module, la pagination mobile, le partage multiple dans Library et les discussions, ainsi que la reprise après un échec partiel. Les tests PostgreSQL vérifient également la migration des anciens fichiers et les uploads concurrents de variantes d’un même module.
