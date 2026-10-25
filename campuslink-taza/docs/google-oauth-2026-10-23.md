**Google OAuth dans CampusLink Taza — 23 octobre 2026**

L’intégration est implémentée et testée localement. `GOOGLE_OAUTH_ENABLED=false` reste la valeur par défaut et la configuration normale conserve cette valeur : les boutons y sont masqués et le serveur refuse tout nouveau parcours Google. Aucune migration, connexion Google réelle, activation Google, publication Vercel ou opération Git push n’a été effectuée en production.

**Mise à jour du 24 octobre 2026 :** Neon est connecté. Une branche indépendante a été créée, la migration 036 y a été appliquée et une prévisualisation locale utilise les véritables API Neon sur `http://localhost:5181`. **Le premier parcours du compte académique existant a réussi après confirmation volontaire de son ancien email par code, puis les reconnexions par Google seul ont réussi sans nouveau code ni mot de passe CampusLink.** L’utilisateur a confirmé qu’il choisit son compte et entre directement. La trace serveur confirme le premier callback vérifié et trois parcours Google ultérieurs terminés sur `/app`, sans autre vérification d’email. Le refus initial `account_not_linked` précédait la vérification de cet ancien email Neon. Voir le [rapport de la branche de test](google-oauth-neon-test-2026-10-24.md) pour la preuve et les limites actuelles. Les résultats du 23 octobre ci-dessous décrivent les suites locales initiales.

Les validations actuelles comprennent **221 tests backend**, **4 contrôles ciblés du contrat de limitation**, **24 scénarios UI** avec 18 combinaisons responsive et 23 variantes de destination refusées, ainsi qu’un build réussi en **11,18 secondes**. La régression d’historique utilise un vrai retour arrière du navigateur après le callback simulé et la déconnexion : l’ancienne page de vérification ne revient pas. Les premiers parcours réels et les reconnexions Google confirmés sont distincts de ces tests simulés. Les autres comptes et scénarios à vérifier sont décrits dans le [rapport de prévisualisation](google-oauth-neon-test-2026-10-24.md).

L’utilisateur a confirmé **`usmba.ac.ma` uniquement**. Cette règle est réservée à Google ; les comptes classiques, y compris leurs adresses personnelles, conservent leur accès et leur mot de passe. Aucun sous-domaine n’est accepté implicitement.

**Parcours et autorisations.** Le bouton appelle `POST /api/auth/google/start`. Le serveur choisit lui-même Google et les URLs de retour, et demande `prompt=select_account`. Neon gère le dialogue Google, le state et PKCE. Le test du fournisseur partagé du 24 octobre montre que son intermédiaire ne propage pas `prompt` : l’application ne garantit donc pas l’affichage forcé du sélecteur de compte. L’adaptateur Express suit le mécanisme officiel Neon : en-tête `x-neon-auth-middleware: true`, cookie de challenge HTTP-only de première partie, puis échange serveur du `neon_auth_session_verifier` sur `get-session`. Le token reste opaque dans `campus_neon_session`, HTTP-only, SameSite=Lax, Secure en HTTPS.

Le serveur contrôle la session Neon et son JWT/JWKS, puis sélectionne le compte Google via `list-accounts` et `account-info?accountId=<identifiant de ligne Better Auth>`. Il exige la correspondance du fournisseur, du sujet Google immuable et de l’email, ainsi que `email_verified=true` dans les données Google et `emailVerified=true` dans le profil Google normalisé par le fournisseur. Le booléen du compte Neon local peut être `false` pour une ancienne inscription classique ; l’application ne le force jamais à `true` et ne l’utilise pas comme substitut à la preuve Google. La confirmation officielle de l’email par Neon peut le mettre à jour après vérification du code. La preuve Google explicite reste côté serveur et accompagne uniquement les admissions Google validées. Aucun token d’accès ou de session Google/Neon n’est transmis au code React. L’URL intermédiaire d’initialisation Neon, avec son token opaque, sert uniquement à quitter l’application vers le fournisseur autorisé. Les callbacks quittent immédiatement l’URL contenant le verifier, avec une redirection fixe et `Referrer-Policy: no-referrer`.

Un nouvel étudiant passe par `/auth/google/complete` pour renseigner son nom, son nom d’utilisateur, sa faculté, sa filière et son semestre. L’email vérifié est non modifiable. La transaction crée uniquement un rôle `student`, un statut `pending`, la liaison Google et la notification administrative habituelle. Les API protégées restent fermées jusqu’à l’approbation existante. Les tentatives simultanées ou répétées ne créent pas de doublon.

Pour un compte existant, le serveur peut désormais enregistrer automatiquement la liaison Google uniquement lorsque Neon a déjà authentifié le même sujet canonique que le profil applicatif, que l’email Neon est strictement vérifié, que Google fournit ses preuves brutes et normalisées de vérification, et que le domaine Workspace `hd` correspond exactement au domaine académique. L’email et les identifiants doivent concorder ; les conflits de liaison sont refusés. Une égalité d’email ne fusionne jamais deux sujets. Les rôles, droits, statut, études et données sont conservés.

Sur une visite normale, le bouton Google est placé sous le bouton principal des formulaires de connexion et d’inscription. Après une erreur de retour Google, la page de connexion affiche une vue dédiée sans champ de nom d’utilisateur ni mot de passe, avec Google comme action principale et **Connexion par mot de passe** comme choix facultatif. Ce dernier affiche simplement le formulaire classique ; seule sa soumission volontaire peut lancer une connexion classique. Le bouton Google lance uniquement `intent=login`, et le retour d’erreur ne déclenche aucune requête classique ni `intent=link`.

Pour un compte ancien dont le retour est `GOOGLE_LINK_REQUIRED`, une confirmation facultative de l’adresse par code est disponible dans cette vue. Elle correspond à la première mise en place d’un compte dont l’email Neon n’était pas vérifié, et n’est pas prévue à chaque connexion. L’envoi exige un clic explicite. Le serveur utilise les endpoints officiels de vérification d’email, jamais la connexion par OTP ni une modification SQL du champ de vérification. Les mots de passe existants sont conservés. La confirmation ne donne aucun accès applicatif : elle est suivie d’une nouvelle authentification Google soumise aux contrôles habituels. Le code réel de l’essai réussi a été demandé et confirmé par l’utilisateur ; les tests automatisés n’envoient pas d’email réel.

Avant un nouveau départ OAuth, seul le code d’erreur assaini est conservé dans l’entrée d’historique du navigateur après nettoyage de l’URL : la vue Google persiste au rechargement et au retour arrière. Le départ OAuth validé utilise désormais `location.replace` pour remplacer cette entrée et éviter de laisser l’ancien écran de vérification dans le parcours de retour. Une nouvelle visite ordinaire à `/login` retrouve le formulaire normal, et le choix explicite de la connexion classique efface cet état. Aucun secret OAuth n’est enregistré dans les stockages du navigateur. La liaison manuelle depuis un profil authentifié reste une fonctionnalité séparée, avec preuve du mot de passe et liaison de la tentative à la session initiale ; elle n’est pas imposée comme suite à l’erreur Google.

Une fois le compte vérifié et lié, la reconnexion passe par Google seul. L’utilisateur a confirmé le choix du compte suivi de l’entrée directe, et trois parcours réels ultérieurs atteignent `/app` sans nouvelle demande ni confirmation de code. Un scénario automatisé de déconnexion puis Google atteint aussi `/app` sans appel aux endpoints de confirmation d’email, à la connexion par mot de passe ou à `intent=link`. Le [rapport de prévisualisation](google-oauth-neon-test-2026-10-24.md) distingue les preuves réelles et simulées.

Neon peut associer des fournisseurs à un même sujet avant le retour au site. CampusLink exige aussi une liaison locale enregistrée après les contrôles ci-dessus, ou après la liaison manuelle authentifiée, et une admission durable de la session. Présenter directement une session Google obtenue sur l’API publique Neon ne permet pas de contourner les contrôles. Les sujets déjà liés et leurs sessions antérieures à la migration sont conservés ; les nouvelles sessions classiques sont admises après une vraie vérification du mot de passe. Le renouvellement d’une session Neon conserve sa preuve initiale sans réactiver une identité expirée ou révoquée.

**Configuration serveur.** Ne placer aucun secret dans une variable `VITE_*`.

| Variable | Valeur et rôle |
| --- | --- |
| `NEON_AUTH_BASE_URL` | URL Managed Better Auth existante de la branche choisie. |
| `NEON_AUTH_JWKS_URL` | URL JWKS existante, vérifiée côté serveur. |
| `APP_ORIGIN` | `http://localhost:5181` pour la prévisualisation Neon isolée ; `https://taza-link.vercel.app` pour la future production. |
| `COOKIE_SECURE` | `false` pour HTTP local, `true` pour HTTPS. Le handler Vercel configure déjà HTTPS/Secure. |
| `GOOGLE_OAUTH_ENABLED` | **`false`** dans la configuration normale jusqu’aux vérifications réelles et à l’autorisation de publication ; `true` uniquement dans le fichier local dédié à la branche de test. |
| `ALLOWED_ACADEMIC_EMAIL_DOMAINS` | `usmba.ac.ma` ; domaines exacts séparés par virgules, sans `@` ni wildcard. Une liste vide ou invalide ferme Google. |
| `GOOGLE_WORKSPACE_DOMAINS` | Facultatif : `usmba.ac.ma` si seuls les comptes Workspace de ce domaine sont autorisés. L’absence de `hd` est alors refusée. |

Sans restriction Workspace explicite, un compte Google externe avec email académique vérifié peut déposer une nouvelle demande en attente. Un `hd` présent mais différent du domaine de l’email reste refusé. Cette distinction évite de traiter `email_verified` comme une preuve suffisante pour reprendre un ancien compte.

Pour un client Google personnalisé, l’ID client et le secret doivent être renseignés dans **Neon Console → Auth → OAuth → Google**. Ils ne sont pas requis dans le bundle frontend et ne sont pas exposés par l’outil de diagnostic. La branche de test utilise le fournisseur Google partagé de Neon, avec localhost autorisé ; aucun nouveau secret Google n’a été nécessaire pour cette prévisualisation de développement. Cela ne valide pas les identifiants privés ni les réglages Google Cloud nécessaires au client personnalisé de production.

**Deux callbacks distincts.** Dans Google Cloud, le callback autorisé doit être exactement `${NEON_AUTH_BASE_URL}/callback/google`, pour la branche utilisée. Ce n’est pas l’URL Vercel. Après cette étape, Neon revient sur `${APP_ORIGIN}/api/auth/google/callback`. L’origine `https://taza-link.vercel.app`, déjà déclarée par l’utilisateur dans les Trusted Domains, doit être vérifiée sur la même branche Neon que l’URL Auth. Les branches de test doivent avoir leurs propres URLs et origines autorisées.

La commande suivante affiche les callbacks exacts déduits des variables locales, les domaines admis et l’existence des endpoints, sans lire ni afficher un secret et sans déclencher de connexion :

```sh
npm run auth:google-check -- --verify-provider
```

**Migration et fichiers.** La migration additive `036_google_oauth_sessions.sql` crée le seuil des anciennes sessions, leur liste de sujets, les admissions, les liaisons Google et les tentatives OAuth à usage unique. Elle ne modifie ni les utilisateurs ni les tables `neon_auth`. Les historiques de migrations restent inchangés. Le contrôle de schéma impose cette migration avant le démarrage du nouveau backend. Elle a été appliquée uniquement à la branche de test indépendante le 24 octobre ; son absence en production a été vérifiée par une lecture SQL. Ne pas lancer `db:migrate` avec les variables de production pour tester.

| Périmètre | Fichiers principaux |
| --- | --- |
| Transport et preuve Neon/Google | `server/auth.js` |
| Admission des sessions et règles de domaines | `server/auth-sessions.js` |
| Connexion, liaison et complétion | `server/google-oauth.js`, `server/app.js` |
| Schéma et disponibilité | `server/migrations/036_google_oauth_sessions.sql`, `server/db.js`, `server/schema-readiness.js` |
| Boutons, erreurs, liaison, styles | `src/components/GoogleAuth.jsx`, `src/components/google-auth.css`, `src/pages/PublicPages.jsx`, `src/pages/StudentPages.jsx`, `src/pages/public.css` |
| Complétion et session frontend | `src/pages/GoogleProfilePage.jsx`, `src/context.jsx`, `src/App.jsx` |
| Configuration et commandes | `.env.example`, `package.json`, `scripts/check-google-oauth.mjs`, `scripts/test-google-oauth.mjs`, `scripts/preview-google-oauth.mjs` |
| Régressions | `tests/neon-google-oauth.test.mjs`, `tests/backend-google-oauth.test.mjs`, `tests/google-oauth.browser.mjs`, `tests/register-mobile.browser.mjs` |

**Validation effectuée avec Node 22.** Les tests des données utilisent un PostgreSQL local temporaire, lié exclusivement à `127.0.0.1`, avec des schémas jetables. Les appels Neon, Google, les identités et les octets de fichiers sont simulés. Aucun compte, mot de passe ou enregistrement de production n’a été créé ou modifié pour ces essais.

| Vérification | Résultat |
| --- | --- |
| Transport Neon OAuth et compatibilité du service d’authentification | 84 tests réussis. |
| Politiques et véritables routes HTTP avec PostgreSQL local | 22 tests réussis, aucun ignoré. |
| Exécution consolidée `npm run test:google-oauth` | Les 106 tests des deux lignes précédentes réussissent ensemble, sans échec ni test ignoré. |
| Authentification classique, permissions, récupération de mot de passe, migration/disponibilité du schéma et proxy Vercel | 110 tests réussis. |
| Interface Google | 13 scénarios réussis, dont 18 combinaisons de largeur/thème/langue : 320, 768, 1280 px ; clair/sombre ; français/anglais/arabe. |
| Inscription classique sur mobile, tablette et ordinateur | 6 scénarios réussis, y compris soumission, attente administrative et reprise après erreur. |
| Build Vite et `git diff --check` | Réussis. |
| OpenAPI du service Neon configuré | Endpoints sociaux, liaison, session et informations Google confirmés par GET uniquement. |

Les régressions couvrent les emails personnels, les booléens de vérification falsifiés, les sujets et comptes intervertis, les domaines Workspace, les tentatives expirées/rejouées, les refus CSRF, le profil incomplet, pending/rejected/approved, la conservation des rôles, les accès directs aux API, les révocations, logout/reconnexion, l’expiration et la prolongation des sessions, ainsi que les erreurs, les doubles clics et les changements de compte.

Ces suites partagent certains tests d’authentification classique ; leurs nombres ne représentent pas des cas tous distincts et ne doivent pas être additionnés.

Commandes reproductibles :

```sh
# Cette URL doit viser une base locale ou une branche de test indépendante.
CAMPUS_TEST_DATABASE_URL='postgresql://...' npm run test:google-oauth
npm run test:google-oauth-unit
# Avec Vite démarré : npm run dev:frontend
npm run test:google-oauth-ui
npm run build
git diff --check
```

Le runner `test:google-oauth` refuse une URL absente ou correspondant à la base applicative configurée. Les suites de régression historiques utilisent encore leurs mécanismes existants : toujours leur fournir explicitement une URL de test isolée.

**Avant une autorisation de production.** Le compte existant testé a terminé la confirmation officielle de son ancien email, l’authentification Google et les reconnexions par Google seul jusqu’à `/app`. La trace et les métadonnées de la branche isolée confirment le profil canonique, la liaison Google et l’admission de session. Aucun refus de liaison interne n’a bloqué ce compte après vérification. Il reste à vérifier réellement le refus d’un compte personnel, la complétion pending d’un nouveau profil et les navigateurs mobiles physiques, ainsi que les identifiants privés et origines du client personnalisé de production. Ce succès d’un compte ne valide pas tous les scénarios ni tous les comptes. Aucun déploiement, migration de production, activation publique ou push n’a été effectué.

Neon peut conserver une identité fournisseur ou une association implicite même lorsque CampusLink refuse l’accès. L’application ne supprime pas ces comptes distants : elle révoque la session provisoire quand elle peut et refuse toute admission ou création de profil non autorisée. Les anciennes sessions prises entre l’application de la migration et le déploiement coordonné du nouveau code peuvent nécessiter une reconnexion ; les comptes et leurs mots de passe restent valides.

Les limites du service géré sont documentées : l’application ne contrôle pas sa configuration interne Better Auth. Il faut vérifier le comportement réel de la branche et conserver le drapeau désactivé tant que ces essais et l’autorisation de publication ne sont pas obtenus.

Sources officielles : [Neon OAuth](https://neon.com/docs/auth/guides/setup-oauth), [proxy Neon](https://github.com/neondatabase/neon-js/blob/main/packages/auth/src/server/proxy/request.ts), [échange challenge/verifier](https://github.com/neondatabase/neon-js/blob/main/packages/auth/src/server/middleware/oauth.ts), [API compte Better Auth](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/api/routes/account.ts), [preuve d’identité Google et domaine hébergé](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [configuration OAuth du service géré Neon](https://api-docs.neon.tech/reference/updatebranchneonauthoauthprovider).
