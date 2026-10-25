**CampusLink Taza — prévisualisation réelle Neon, 24 octobre 2026**

Une version locale de test utilise maintenant une branche Neon indépendante et les véritables API Neon Auth. Elle s’ouvre à **http://localhost:5181** lorsque le lanceur est démarré. Google est activé uniquement dans sa configuration locale dédiée. La configuration normale conserve `GOOGLE_OAUTH_ENABLED=false` ; aucun déploiement, push Git, migration de production ou activation publique n’a été effectué.

**Succès réel confirmé : l’utilisateur a confirmé son email puis est entré dans le site avec Google.** Le parcours a été effectué sur la branche de test, avec le compte académique existant. L’utilisateur a lui-même demandé et confirmé le code, puis terminé la nouvelle authentification Google. La trace serveur assainie confirme le callback avec identité vérifiée et la redirection vers `/app`.

**Reconnexions réelles confirmées : Google seul suffit ensuite pour ce compte.** L’utilisateur a confirmé qu’après avoir choisi son compte académique, il entre directement dans le site. La trace confirme trois parcours Google ultérieurs réussis, sans nouvel envoi ni confirmation de code et sans mot de passe CampusLink imposé.

L’email Neon de cet ancien compte n’était initialement pas vérifié : Google revenait avec `account_not_linked` avant de fournir une identité ou une session. La confirmation officielle de cet email a permis le premier parcours réussi puis les reconnexions directes. Aucun refus interne de liaison n’a ensuite bloqué ce compte. Cela ne démontre pas que tous les autres comptes ou scénarios fonctionnent.

La requête de démarrage a été comparée au schéma OpenAPI de la branche : elle est conforme. Aucun paramètre `disableSignUp` n’est envoyé. Ajouter `requestSignUp` n’aurait pas résolu le refus initial, car le contrôle de liaison d’un compte existant intervient avant le parcours de nouvelle inscription. L’échange challenge/verifier ne pouvait pas commencer lorsque Neon renvoyait uniquement l’erreur sans verifier ; il a bien eu lieu dans le parcours réussi après confirmation de l’email. Cette inspection du protocole était en lecture seule ; la mise à jour réelle de vérification a ensuite été réalisée par l’API officielle Neon, sur action de l’utilisateur. Voir le [contrôle de liaison Better Auth](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/oauth2/link-account.ts) et le [middleware OAuth Neon](https://github.com/neondatabase/neon-js/blob/main/packages/auth/src/server/middleware/oauth.ts).

La connexion MCP à Neon a réussi après l’autorisation de l’utilisateur. La branche a été créée comme une copie normale des données de la branche originale : ce ne sont pas des identités fictives ni une base vide. Les comptes et données de la branche originale ne sont pas utilisés pour les écritures de cette prévisualisation.

| Élément | Valeur vérifiée |
| --- | --- |
| Projet Neon | `compuslink-taza` — `shy-morning-03795772` |
| Branche originale | `br-fancy-glade-b1o486ws` |
| Branche de test enfant | `br-young-lake-b1tyke1p` |
| Nom de la branche de test | `campuslink-google-oauth-test-20261023` |
| Compute de test | Minimum et maximum : 0,25 CU |
| Expiration de la branche | Aucune expiration automatique configurée |
| Origine de la prévisualisation | `http://localhost:5181`, serveur lié à `127.0.0.1` |
| Domaine Google autorisé | `usmba.ac.ma` exactement, sans sous-domaines implicites |
| Migration 036 | Appliquée uniquement à la branche de test ; absence en production confirmée par `SELECT` |

Les nombres d’utilisateurs, messages, ressources et annonces ont été comparés avant et après la migration sur la branche de test : ils sont inchangés. Les tables ajoutées servent aux preuves de session, aux liaisons Google et aux tentatives OAuth. La migration ne modifie pas les profils ni les tables `neon_auth`.

**Démarrer la version de test.** Utiliser Node 22, puis lancer ces commandes depuis le dossier `campuslink-taza` :

```sh
node --version
npm run preview:google-oauth -- --check
npm run preview:google-oauth
```

La première vérification doit afficher une version Node 22. Si nécessaire sur cette machine :

```sh
export PATH="/home/issmail/.local/share/sanaa-runtime/node-v22.23.3-linux-x64/bin:$PATH"
```

Le lanceur sert le build `dist` existant. Après une modification du frontend, exécuter `npm run build` avant de le redémarrer. Le mode `--check` valide les paramètres sans tenter de connexion ; il ne démarre pas le serveur.

Le fichier `.env.oauth-test.local`, ignoré par Git et avec les permissions `600`, contient les paramètres de cette branche. Il n’est pas reproduit ici. Le fichier normal `.env.local` reste inchangé et Google y reste désactivé. Le lanceur refuse le fichier normal comme configuration de test, compare les endpoints de base de données et d’Auth aux valeurs normales, exige des origines Auth/JWKS cohérentes et fixe l’origine locale à `http://localhost:5181`. Il élimine les paramètres serveur hérités avant d’importer l’application, ne lance aucune migration ni seed et réessaie le démarrage en cas de réveil temporairement lent du compute Neon.

Cette version utilise le vrai service d’authentification applicatif ; aucun compte de démonstration ni double d’authentification n’est injecté. Le stockage des fichiers est temporaire en mémoire : les anciens fichiers R2 ne sont pas disponibles dans cette prévisualisation, et les nouveaux octets chargés ici disparaissent au redémarrage. Les métadonnées et les autres écritures applicatives vont dans la branche Neon de test. Le port `5180` d’une éventuelle prévisualisation simulée antérieure est distinct ; pour cet essai réel, utiliser **5181**.

**Ce qui a été vérifié auprès de Neon.** La branche a hérité du fournisseur Google partagé de Neon, avec `allow_localhost=true`. Aucun nouveau secret client Google n’est nécessaire pour ce parcours de développement. La configuration d’un client Google personnalisé pour la production reste à vérifier séparément dans Neon et Google Cloud.

Le service réel renvoie une URL intermédiaire Neon `…/sign-in/social/init?token=…` avant la redirection Google. Cette forme, initialement rejetée par l’application, est maintenant admise uniquement pour l’origine HTTPS et le chemin exacts du service Neon configuré, avec un seul paramètre `token` valide. Le backend et le frontend contrôlent tous deux cette destination. La configuration publique fournit uniquement l’endpoint autorisé ; aucun token d’initialisation ni secret n’y figure. Les URLs directes Google continuent à subir leurs contrôles de fournisseur, callback et paramètres OAuth.

Les requêtes de vérification ont donné les résultats suivants :

| Vérification réelle | Résultat |
| --- | --- |
| Pages locales, configuration Google et options d’inscription | HTTP 200 |
| Session avant connexion | `null` |
| API protégée de bootstrap sans session | HTTP 401 |
| Callback sans tentative valide | HTTP 303 vers une URL locale avec un code d’erreur assaini |
| Démarrage OAuth | HTTP 200, cookies de challenge et de tentative HTTP-only, SameSite=Lax |
| Initialisation gérée Neon | HTTP 302 vers Google avec state et PKCE S256 observés |
| Premiers retours du compte académique existant avant vérification de son email | Erreur fournisseur `account_not_linked`, sans verifier, nouvelle session ou compte Google créé |
| Code demandé et confirmé volontairement par l’utilisateur | Envoi HTTP 200 ; confirmation HTTP 200 avec email vérifié |
| Session provisoire renvoyée par la confirmation Neon | Révoquée côté serveur, HTTP 200, sans ouverture de session applicative |
| Nouvelle authentification Google après confirmation | Démarrage HTTP 200, callback avec verifier sans erreur |
| Session Neon du callback | HTTP 200 ; JWT, issuer, audience et sujet validés ; email local vérifié |
| Compte et identité Google | Un seul compte Google ; fournisseur, ligne, sujet canonique et email concordants ; preuves Google brutes et normalisées vérifiées ; domaine Workspace présent |
| Fin du callback applicatif | HTTP 303 vers `/app`, entrée dans le site confirmée par l’utilisateur |
| Relecture de session après l’entrée | Appels réels `get-session` HTTP 200 |
| Trois reconnexions réelles suivantes par Google seul | Chaque démarrage social HTTP 200 est suivi d’un callback HTTP 303 vers `/app`, sans nouvel appel d’envoi ou de confirmation de code |

Les lectures seules des métadonnées de la branche de test ont confirmé un compte Google associé au profil canonique, une liaison `google_auth_links`, un profil actif approuvé et un email Neon vérifié. Une admission `auth_session_admissions` était présente lors de la validation du premier retour réussi. Les reconnexions par Google seul sont confirmées séparément par la trace des trois parcours ultérieurs et par l’utilisateur ; ces preuves ne prétendent pas décrire la méthode de toute autre session possible.

Le compte fournisseur `credential` existant est toujours présent, avec un mot de passe renseigné, vérifié uniquement par un indicateur booléen : aucune valeur ni aucun hash de mot de passe n’a été lu ou exposé, et aucune comparaison de hash avant/après n’est annoncée. Aucun identifiant personnel, adresse email, code ou token n’est reproduit dans ce rapport. Ces relectures ne créent ni compte ni session et ne modifient aucune donnée.

Ce refus protège le compte existant contre une association implicite. L’application affichait initialement une erreur générique ; elle traduit désormais uniquement le code exact `account_not_linked` en `GOOGLE_LINK_REQUIRED`, après validation et consommation de la tentative locale. Les autres erreurs fournisseur restent génériques.

La reprise forcée par identifiant/mot de passe a été retirée à la demande de l’utilisateur. Une erreur de retour Google affiche une vue dédiée **sans champ de nom d’utilisateur ni mot de passe**, avec le bouton Google visible. Cliquer sur Google lance uniquement une nouvelle tentative `intent=login`. Le retour d’erreur ne déclenche aucun appel automatique à la connexion classique ou à `intent=link`.

**Confirmation facultative du compte ancien.** Pour `GOOGLE_LINK_REQUIRED`, cette vue permet maintenant de saisir l’adresse universitaire et de demander volontairement un code. Aucun email n’est envoyé à l’ouverture de la page. Le backend utilise exclusivement `email-otp/send-verification-otp` avec `type: email-verification`, puis `email-otp/verify-email`. Le parcours de connexion `sign-in/email-otp`, qui peut retirer un mot de passe non prouvé, n’est jamais utilisé. Le [guide Neon de confirmation des emails](https://neon.com/docs/auth/guides/email-verification) décrit cette vérification de propriété.

Les deux routes applicatives `/api/auth/google/email-verification/start` et `/confirm` acceptent uniquement le domaine académique configuré. Les réponses sont assainies, les demandes sont limitées par IP et par adresse et aucun profil, rôle, lien Google ou admission applicative n’est créé par la confirmation. La configuration de test utilise déjà les codes et le fournisseur de messagerie partagé ; `auto_sign_in_after_verification` est actif. Toute session provisoire renvoyée par Neon est donc conservée côté serveur puis révoquée, sans publier de cookie au navigateur et sans toucher à sa session initiale. Ce nettoyage a été confirmé dans la trace du parcours réel. Un code correct est suivi d’une nouvelle tentative Google complète ; les contrôles d’identité et d’approbation restent obligatoires. L’adresse et le code restent uniquement dans l’état du formulaire, sans stockage navigateur ni historique. Le code réel a été demandé et confirmé par l’utilisateur, sans outil d’envoi de message de l’agent.

Cette confirmation correspond à la première mise en place de l’ancien compte non vérifié, pas au parcours normal de chaque connexion. Pour le compte vérifié et lié, le parcours **Google seul**, sans code de confirmation supplémentaire ni mot de passe CampusLink, a été confirmé réellement. Les trois parcours suivants ont terminé sur `/app` sans nouvel appel aux endpoints d’envoi ou de confirmation de code depuis la vérification initiale. Un scénario automatisé de déconnexion puis reconnexion Google atteint également `/app` sans appel aux endpoints de confirmation, à la connexion classique ou à `intent=link`.

Le choix facultatif **Connexion par mot de passe** réaffiche le formulaire classique, sans envoyer de requête de connexion à lui seul. La liaison manuelle **Associer Google** reste une fonctionnalité séparée du profil authentifié et de la page de suivi d’inscription ; elle n’est pas imposée à la suite de ce refus. Sur une visite normale aux pages de connexion ou d’inscription, le bouton social conserve son emplacement après le bouton principal du formulaire.

Avant un nouveau départ OAuth, le code d’erreur connu et assaini est conservé uniquement dans l’entrée courante de l’historique React Router, après retrait du paramètre de l’URL. Recharger ou revenir en arrière restaure alors la vue Google ; une visite normale indépendante à `/login` ne l’hérite pas. Le choix explicite du formulaire classique efface cet état. Lors du départ vers une destination OAuth validée, `location.replace` remplace désormais l’entrée courante au lieu de la conserver comme ancienne page de vérification. Cette correction supprime l’étape obsolète créée par le précédent départ avec `location.assign`. Elle ne change ni la validation de destination ni le backend. Les codes inconnus sont normalisés en `GOOGLE_OAUTH_FAILED`, et aucun verifier, token OAuth ou secret n’est conservé dans les stockages du navigateur.

**Preuve de vérification Google.** Un ancien compte Neon créé par mot de passe peut conserver son champ local `emailVerified=false`. L’application ne force jamais cette valeur à `true` : seule la confirmation officielle d’un code par Neon peut la mettre à jour dans le parcours facultatif. Elle exige séparément la preuve du fournisseur Google : les données Google brutes doivent contenir `email_verified=true`, le profil Google normalisé doit contenir `emailVerified=true`, et le fournisseur, les identifiants immuables et l’email doivent correspondre à la session vérifiée. Le service crée alors une preuve explicite `google.emailVerified=true` uniquement côté serveur. La politique exige cette preuve via `googleEmailVerified` pour les admissions Google ; sa reconstitution à partir d’une admission durable est limitée aux méthodes Google déjà contrôlées. Un booléen fourni par le navigateur ou le seul email d’un compte Neon ne permet pas de contourner ces contrôles.

**Association automatique limitée au même sujet.** Si Neon renvoie déjà une identité Google vérifiée pour le sujet canonique exactement associé au profil applicatif, CampusLink peut enregistrer sa première liaison sans demander le mot de passe. Ce cas exige en plus `identity.authUser.emailVerified===true`, l’email identique, un `hd` Workspace égal au domaine académique, les preuves Google strictes et l’absence de conflit de liaison. Il conserve le profil, ses droits et son statut. L’email seul ne fusionne pas des comptes et le serveur ne force jamais le champ Neon `emailVerified` à `true`. Le compte testé a atteint ces contrôles après la confirmation officielle de son email : le profil canonique, la liaison Google et l’admission ont été confirmés en lecture seule.

L’application transmet `additionalParams.prompt=select_account`, conformément au schéma OpenAPI du service. Pendant l’essai réel, l’intermédiaire Google partagé de Neon n’a pas conservé ce paramètre dans sa redirection vers Google. Le sélecteur de compte n’est donc pas garanti à chaque connexion ; ce comportement ne remplace aucun contrôle d’identité ou de domaine côté serveur.

Pour un client personnalisé, le callback Google est `${NEON_AUTH_BASE_URL}/callback/google` de la branche concernée. Le retour applicatif est distinct : `${APP_ORIGIN}/api/auth/google/callback`. Les origines autorisées doivent appartenir à cette même configuration de branche. Voir le [guide OAuth officiel Neon](https://neon.com/docs/auth/guides/setup-oauth).

**Régressions après adaptation au service réel.** Les tests automatisés utilisent toujours leurs doubles de fournisseur et une base de test isolée ; ils ne réalisent pas le consentement Google d’un utilisateur.

| Vérification | Résultat |
| --- | --- |
| Suite combinée backend, incluant confirmation d’email et association automatique du même sujet canonique | 221 tests réussis sur 221 |
| Interface après correction de l’historique, avec confirmation initiale et reconnexion Google seule | 24 scénarios réussis, avec 18 combinaisons largeur/thème/langue et 23 variantes de destination refusées |
| Contrôle navigateur de la confirmation sur la prévisualisation réelle 5181 | Réussi à 390 et 1280 px, en français sombre : aucun champ de connexion classique, confirmation facultative visible, aucune demande de vérification à l’ouverture ou au rechargement |
| Contrat complémentaire de limitation des demandes | 4 tests ciblés réussis ; délai JSON cohérent avec Retry-After |
| Retour arrière après le callback simulé et la déconnexion | Réussi depuis une connexion normale directe et une ancienne vue `GOOGLE_LINK_REQUIRED` via Neon : retour à la page normale, sans ancienne entrée de confirmation ni requête OTP, connexion classique ou liaison |
| Build de la correction d’historique, servi par la prévisualisation 5181 | Réussi en 11,18 secondes ; backend inchangé |

Les résultats backend précédents partagent des tests avec la suite combinée de 221 et ne doivent pas lui être additionnés. Les 18 combinaisons responsive couvrent 320, 768 et 1280 px, les thèmes clair et sombre, et le français, l’anglais et l’arabe. Les contrôles de destination couvrent notamment les autres origines ou chemins, les credentials dans l’URL, HTTP, les fragments, les paramètres supplémentaires, les tokens absents, multiples ou invalides. Les journaux locaux actuels, ignorés par Git, sont `test-results/google-email-verification-combined.tap`, `test-results/google-history-return-ui.log`, `test-results/google-linked-return-build.log` et `test-results/google-email-verification-retry-contract.tap`. Les captures réelles sont `test-results/google-oauth/live-email-verification-390-dark-fr.png` et `test-results/google-oauth/live-email-verification-1280-dark-fr.png`. Les captures du formulaire de code à 320 px sombre/arabe et 1280 px clair/français sont `test-results/google-oauth/verification-code-320-dark-ar.png` et `test-results/google-oauth/verification-code-1280-light-fr.png` ; les requêtes y sont interceptées, sans envoi réel. Les vérifications historiques des comptes classiques, de l’inscription et des permissions sont détaillées dans le [rapport initial](google-oauth-2026-10-23.md).

**Résultat pour le compte testé.** Le compte académique existant a terminé la confirmation de son email, le callback Google vérifié, l’entrée dans le site et les reconnexions par Google seul. Le blocage observé pour ce compte est résolu. Sa confirmation initiale répondait à l’état non vérifié de son ancien email ; elle n’a pas été répétée dans les trois parcours suivants. Aucun mot de passe CampusLink n’a été imposé dans ces parcours réussis. Aucun autre test identique n’est demandé à l’utilisateur pour ce compte.

La version réelle de test reste destinée à `http://localhost:5181`. La confirmation par code est un choix explicite proposé après le refus de liaison d’un ancien compte non vérifié, et ne doit pas être décrite comme nécessaire à chaque connexion. Les API classiques et la liaison manuelle authentifiée restent disponibles séparément. Ce succès ne valide pas tous les autres comptes, toutes les politiques de branche ni tous les navigateurs.

Il reste à vérifier réellement le refus d’un compte personnel, la complétion pending d’un nouveau profil et les navigateurs mobiles physiques. Un nouveau profil Google doit recevoir uniquement le rôle étudiant et rester en attente de l’approbation administrative existante. Aucun administrateur ni compte approuvé n’est créé automatiquement. La configuration privée du client Google personnalisé et les origines de production restent à contrôler avant une éventuelle autorisation de publication. Les parcours réels réussis de ce compte et les tests automatisés ne constituent pas une validation de tous les scénarios de production. Aucun déploiement, activation publique, migration de production ou push n’a été effectué.

La branche de test existe sans date d’expiration automatique. Son arrêt ou sa suppression n’est pas effectué par le lanceur local. Les identifiants de branche ci-dessus permettent de la retrouver et de la gérer dans Neon ; arrêter le serveur local ne supprime pas ses données.

Sources officielles : [OAuth Neon](https://neon.com/docs/auth/guides/setup-oauth), [proxy Neon et en-tête middleware](https://github.com/neondatabase/neon-js/blob/main/packages/auth/src/server/proxy/request.ts), [échange challenge/verifier](https://github.com/neondatabase/neon-js/blob/main/packages/auth/src/server/middleware/oauth.ts), [configuration OAuth du service géré](https://api-docs.neon.tech/reference/updatebranchneonauthoauthprovider), [vérification Google de l’identité et du domaine hébergé](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
