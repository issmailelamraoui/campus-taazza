# Administration de CampusLink Taza

L’interface conserve les huit rubriques et les composants visuels du projet actuel. Les actions utilisent maintenant les routes du backend migré depuis `~/Projects/campuslink-taza`. Une action n’est annoncée comme réussie qu’après confirmation du serveur. Les listes sont ensuite actualisées ; une erreur reste visible et permet de réessayer.

## Rôles et périmètre

| Pouvoir | Administrateur global | Administrateur de faculté | Modérateur |
| --- | --- | --- | --- |
| Examiner les signalements et retirer les messages signalés | Toutes les facultés | Sa faculté | Sa faculté |
| Épingler, désépingler et promouvoir un message lisible | Oui | Oui | Oui |
| Modifier les ressources, remplacer leurs fichiers et les retirer | Toutes les facultés | Sa faculté, toutes ses filières | Non |
| Modifier le nom, la description et les droits d’un canal | Toutes les facultés | Sa faculté | Non |
| Voir et traiter les demandes d’assistance | Toutes les facultés | Sa faculté | Non |
| Publier des annonces et des événements | Une faculté ou toutes | Sa faculté | Non |
| Modifier les rôles et activer/désactiver les comptes | Tous les comptes autorisés | Étudiants et modérateurs de sa faculté | Non |
| Changer l’affectation de faculté d’un compte | Oui | Non | Non |
| Créer un compte et ses identifiants réels | Oui | Non | Non |
| Examiner les inscriptions étudiantes | Oui | Non | Non |
| Supprimer un compte étudiant | Oui | Non | Non |
| Bloquer ou rétablir uniquement l’accès aux discussions | Oui | Non | Non |

Ces restrictions sont également appliquées par le serveur. Masquer ou désactiver un contrôle dans l’interface ne remplace pas les contrôles d’autorisation. Un administrateur ne peut pas se désactiver ni se rétrograder lui-même. Les comptes en attente ou refusés se traitent par les admissions avant de modifier leur rôle ou leur accès.

## Capacités migrées et routes

Les chemins ci-dessous sont relatifs à `/api`.

| Rubrique actuelle | Action | Route et données |
| --- | --- | --- |
| Vue d’ensemble | Lire les comptes, ressources, signalements, contacts et canaux du périmètre autorisé | `GET /admin` |
| Comptes | Créer un étudiant, un modérateur, un administrateur de faculté ou un administrateur global | `POST /admin/users` : `name`, `username`, `email`, `password` d’au moins 10 caractères, `role`, `faculty_id` |
| Comptes | Modifier le rôle, l’affectation de faculté ou l’activation | `PATCH /admin/users/:id` : `role`, `faculty_id`, `disabled` ; les changements concernés révoquent les sessions |
| Comptes | Lire les inscriptions en attente ou refusées | `GET /admin/registrations` |
| Comptes | Accepter ou refuser une inscription ; accepter ensuite une inscription refusée | `PATCH /admin/users/:id/admission` : `status: approved` ou `rejected` |
| Comptes | Supprimer un étudiant après confirmation | `DELETE /admin/users/:id` ; son accès et ses informations personnelles sont retirés, ses documents restent conservés |
| Organisation | Consulter les facultés et leurs filières | Référentiel académique partagé conservé ; aucun contrôle de modification fictif |
| Ressources | Modifier le titre, la catégorie, le semestre, le module, la partie, l’auteur et le statut éditorial | `PATCH /admin/resources/:id` : `title`, `category`, `semester`, `module`, `part_number`, `teacher_name`, `status` |
| Ressources | Remplacer un fichier sans changer l’identité de la ressource | `POST /admin/resources/:id/replace`, formulaire multipart avec `file` ; version et historique conservés |
| Ressources | Consulter les informations du fichier et son historique de versions | Informations renvoyées par `GET /admin` ; aperçu par `GET /files/:id` dans le périmètre autorisé |
| Ressources | Retirer une ressource après confirmation | `DELETE /admin/resources/:id` ; retrait de la bibliothèque et des associations aux discussions/annonces |
| Annonces | Publier pour sa faculté ; publier pour une faculté ou toutes en tant qu’administrateur global | `POST /admin/announcements` : `content`, et éventuellement `faculty_id` ou `all` |
| Annonces | Créer une date de calendrier pour une faculté ou toutes | `POST /admin/events` : `title`, `date`, `time`, `type`, éventuellement `faculty_id` |
| Annonces | Choisir un examen, rattrapage, échéance, inscription, soutenance ou autre événement | Types `exam`, `rattrapage`, `deadline`, `registration`, `defense`, `event` |
| Signalements | Examiner, résoudre ou rouvrir un signalement | `PATCH /admin/reports/:id` : `status: open`, `reviewed` ou `resolved` |
| Signalements | Retirer le message signalé et traiter son signalement | `POST /admin/messages/:id/remove`, puis décision sur `/admin/reports/:id` |
| Communauté | Épingler/désépingler un message et synchroniser son annonce liée | `POST /messages/:id/pin` |
| Communauté | Promouvoir un message en annonce avec un titre choisi | Même route avec `pinned: true`, `title` ; la portée reste celle de la discussion d’origine |
| Communauté | Modifier le nom, la description et le mode lecture seule d’un canal | `PATCH /admin/channels/:id` : `faculty_id`, `name`, `description`, `read_only` |
| Communauté | Voir les accès aux discussions bloqués | `GET /chat/blocks` |
| Communauté | Bloquer les discussions sans désactiver le compte | `POST /chat/blocks` : `user_id` |
| Communauté | Rétablir l’accès aux discussions | `DELETE /chat/blocks/:id` |
| Assistance | Lire, clôturer ou rouvrir les demandes de contact et de récupération de compte | `GET /admin`, puis `PATCH /admin/contacts/:id` : `status` |
| Assistance | Répondre à une demande liée à un compte | Même route avec `reply` ; la réponse apparaît dans les notifications du compte, sans envoi d’e-mail externe |

Le mode lecture seule permet aux étudiants de lire ; les administrateurs et modérateurs conservent leurs droits de publication. Un blocage des discussions préserve l’accès à la bibliothèque et au profil. Les comptes d’administrateurs globaux et son propre compte ne peuvent pas être bloqués.

## Fonctions du projet actuel conservées grâce aux extensions du backend

Le projet source ne disposait pas de toutes les actions déjà présentées par l’interface actuelle. Les compléments suivants sont persistés sur le serveur, avec les mêmes restrictions de rôle et de faculté :

- Modification et suppression d’une annonce : `PATCH` et `DELETE /admin/announcements/:id`.
- Titre et épinglage des annonces, y compris la synchronisation d’un message lié.
- Portée de filière, type, discussion et document associé pour les annonces autonomes. Le serveur vérifie la faculté et la filière des associations ; une publication pour toutes les facultés reste sans association à un document unique.
- Note de modération persistée avec la décision d’un signalement.
- Parties « Complet » et numéros de partie sans la limite précédente de 999 ; auteur facultatif, catégories TD, TP et corrections.
- Contrôle des conflits de classement et des fichiers déjà présents. Un refus du serveur conserve le formulaire et les données existantes.
- Aperçu d’un document pour l’administration dans son périmètre de gestion.

Les listes utilisent les recherches et filtres de l’interface actuelle. Les anciens liens vers `tab=users`, `registrations`, `contacts`, `channels` ou `publish` ouvrent leur rubrique correspondante sans ajouter une nouvelle navigation principale.

## Limites réelles

Le backend source ne fournit pas de fonction administrateur pour changer directement le mot de passe d’un autre utilisateur. L’assistance permet de suivre et répondre aux demandes ; la récupération du mot de passe reste du ressort du fournisseur d’authentification. Aucun faux bouton de réinitialisation n’est ajouté.

Les statuts éditoriaux d’une ressource sont « Nouveau », « Mis à jour », « Populaire » et « Corrigé ». Les anciens états locaux « Approuvé » ou « Retiré » du prototype ne simulent plus une approbation ou une restauration distante. Le retrait utilise la vraie route du backend. Le projet source ne propose pas de restauration d’une ressource retirée ni d’édition/suppression des événements.

Le nom et le nom d’utilisateur d’un compte existant sont consultables dans la fiche ; l’API d’administration migrée modifie les rôles, la faculté et l’activation, pas ces informations personnelles. L’étudiant gère sa filière dans son profil.

## Vérification

`tests/admin-migration.browser.mjs` vérifie les contrats des contrôles avec des réponses API isolées : création et gestion des comptes, admissions, fichiers, canaux, blocages, erreurs et nouvelle tentative, annonces, événements, modération, assistance, périmètres des rôles et écrans de 320 pixels dans les deux thèmes. Il ne crée aucun compte auprès du fournisseur d’authentification et ne remplace aucun fichier réel. Les tests d’intégration du backend et du projet couvrent séparément la base de données, l’authentification et le stockage.
