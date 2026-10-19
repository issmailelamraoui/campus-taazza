# CampusLink Taza — notifications, discussions et délégations, 19 octobre 2026

Cette reprise traite la dernière demande sur les échanges immédiats, les messages non lus, les destinations précises, les administrateurs de toutes les facultés et la discrétion du propriétaire. Elle conserve les corrections de l’[audit précédent](audit-complet-2026-10-18.md), sans recommencer l’audit général. Les modifications locales, la feuille de style du lecteur et les sauvegardes existantes sont conservées. Aucun commit, push ni déploiement.

## 1. Problèmes constatés

- Chaque message ou arrivée dans le chat pouvait déclencher le rechargement complet du bootstrap : membres, bibliothèque, historique, annonces et messages. Les présences déclenchaient aussi des lectures sans rapport avec leur changement.
- Le secours sans flux SSE attendait jusqu’à 30 secondes, voire 90 secondes en économie de données. Un flux fermé définitivement n’était pas recréé explicitement.
- La navigation de Communauté distinguait le canal actif, mais ne signalait pas les messages non lus de chaque canal. Les messages non lus disparaissaient des compteurs après trois jours même sans lecture.
- Cliquer de nouveau sur la notification du même message pouvait conserver la position précédente. Une réponse d’assistance ouvrait le ticket sans cibler la réponse.
- Les nominations exigeaient la faculté académique du compte. Des lectures et contrôles supplémentaires de la console limitaient encore l’administration à cette faculté.
- Le nom et l’identifiant du propriétaire pouvaient être associés à ses réponses administratives dans l’assistance. La console déléguée et certains refus de gestion révélaient également son statut.
- Le titre, le résumé et les présences partageaient un espace horizontal sans répartition adaptée à la largeur disponible. Une variante sous 360 px changeait cette structure en colonne.

## 2. Causes identifiées

Le flux partagé entre instances existait déjà. Les délais provenaient notamment de l’invalidation trop générale et des chargements qui suivaient chaque événement. Les droits étaient bien vérifiés par capacité, mais plusieurs filtres antérieurs à cette vérification imposaient encore la faculté personnelle. L’identité publique et l’identité administrative étaient séparées dans les contenus publics, mais cette séparation ne couvrait pas encore tous les DTO de l’assistance.

## 3. Corrections effectuées

- Les événements de création et de réaction transportent seulement les identifiants de messages concernés. `/api/live` renvoie les messages autorisés demandés et les compteurs actualisés, sans reconstruire la bibliothèque ni les membres. Les événements sont regroupés avant lecture ; un lot trop important utilise un instantané de discussion.
- Les instantanés et les réponses restent protégés par les contrôles de session et de révision. Les messages optimistes et leur identifiant idempotent sont conservés. La publication du journal partagé, la livraison locale et la préparation du message se chevauchent après validation de l’écriture.
- Les présences ont leur propre événement. Elles ne rechargent plus le bootstrap ; les notifications de messages et de lecture ne relancent plus leur heartbeat.
- Reconnexion explicite des flux fermés, reprise complète au retour dans l’onglet et secours toutes les 5 secondes sans flux, 15 secondes en économie de données. Une vérification périodique récupère aussi les messages manqués avec un flux apparemment connecté ; une synchronisation complète périodique conserve les autres collections à jour en mode de secours.
- Compteurs persistants par canal, y compris les groupes S1–S2, S3–S4 et S5–S6. La lecture visible fait avancer un curseur monotone ; ouvrir un autre canal ou une fenêtre modale ne suffit pas. La limite de trois jours reste celle des notifications ordinaires, pas celle des messages non lus.
- Chaque clic sur une notification de discussion peut recentrer le message demandé. Les réponses privées ont une ancre `#reply-ID`, une cible focusable et une mise en évidence.
- Les participants d’une demande privée reçoivent également une invalidation directe, même quand l’administrateur assigné appartient à une autre faculté.
- L’en-tête de discussion conserve une ligne compacte : titre et résumé dans une zone flexible, présences séparées, outils accessibles. Sur téléphone, le résumé est retiré et la présence affiche un nombre compact. Les cibles tactiles conservent 44 px.

## 4. Fonctionnalités ajoutées ou complétées

Dans `/app/permissions`, le propriétaire peut choisir une faculté ou **Toutes les facultés**, puis cocher séparément admission, assistance privée, soutien des comptes, modération, documents, annonces et configuration des discussions. Le choix global crée atomiquement une nomination explicite pour chacune des quatre facultés existantes ; il ne change pas la faculté académique du compte. Le droit de dépôt conserve sa filière et sa faculté académique explicites.

La console affiche et traite les données des facultés effectivement autorisées. Les contenus des autres facultés sont accessibles dans le contexte administratif accordé ; les discussions et bibliothèques étudiantes ordinaires gardent leur périmètre. Le propriétaire peut retirer une nomination ou tous les accès administratifs d’un compte. Les sessions concernées sont révoquées. Un administrateur de toutes les facultés ne reçoit aucun droit de nommer les administrateurs, de transférer la propriété ou de gérer le propriétaire.

Les messages, profils publics et fichiers du propriétaire présentent son identité étudiante et son nom, sans rôle administratif. Ses réponses administratives et son attribution de tickets apparaissent comme **Administration** aux autres participants. Son compte est exclu des listes de comptes gérables par les délégués. Les privilèges supérieurs restent liés au propriétaire établi ; aucun compte réel n’a été renommé ou modifié pour cette séparation.

## 5. Vérifications et résultats

| Vérification | Résultat |
| --- | --- |
| Build de production avec Node 22 | Réussi |
| Backend : audit précédent, permissions, notifications, nouvelle suite live/admin | 38 scénarios distincts validés ; reprises ciblées après adaptation des fixtures aux nouvelles ancres et aux lectures persistantes |
| Nouvelle suite backend live/admin | 4/4 : delta et cloisonnement, délégation et révocation, contenus de plusieurs facultés, identité publique et ancre de réponse |
| Notifications backend | 6/6, y compris messages anciens non lus et curseurs monotones |
| Synchronisation entre deux instances API | Revalidée après les optimisations de publication |
| Tests unitaires notifications et identifiants | 5/5 |
| Navigateur avec API réelle et schémas jetables | 8/8 parcours, plus 1/1 parcours ciblé de modération interfacultés |
| Clavier et redimensionnement de la conversation | 7/7 scénarios Chromium, français/arabe et clair/sombre |
| Interactions tactiles et menus | 6/6 scénarios |
| Protection contre un bootstrap tardif après mutation | 1/1 |
| Géométrie du nouvel en-tête | 12 largeurs de 320 à 1920 px, plus arabe à 390 px ; aucun débordement ni chevauchement mesuré |
| Hauteur de l’en-tête | 54 px sur téléphone, 66 px sur les autres largeurs testées |
| Formulaire de délégation et modération administrative | Utilisables à 320 px |

Parcours réels supplémentaires : saisie et réception entre deux sessions, point non lu puis lecture, lecture d’un autre canal, clic répété sur une même notification, perte volontaire du flux SSE et récupération, réponse d’assistance PC → téléphone, identité du propriétaire masquée, nomination globale depuis le formulaire, réception automatique d’une inscription FEG par un administrateur FLAA et ouverture de son dossier exact, consultation/épinglage/suppression d’un message d’une autre faculté.

Mesures du passage complet : affichage optimiste **141 ms**, indicateur reçu dans la seconde session **1 449 ms**, réponse privée visible **1 949 ms**, récupération avec SSE indisponible **4 552 ms**. Ce sont des mesures du réseau et de l’environnement de test, pas des garanties de délai.

Preuves locales : `test-results/live-admin/results.json`, `results-content.json`, captures `header-320.png`, `header-768.png`, `header-ar-390.png`, `permissions-320.png` et `moderation-320.png`. Commandes reproductibles : `npm run test:live-admin`, `npm run test:live-admin-ui`. Les tests navigateur utilisent le build de production présent dans `dist`.

## 6. Travail restant

Aucun défaut bloquant reproduit ne reste ouvert dans le périmètre de cette demande après les corrections et vérifications décrites. Les nominations réelles restent à effectuer par le propriétaire dans l’interface, avec les personnes et droits qu’il choisit. Aucun privilège réel n’a été attribué pendant les tests.

## 7. Limites et préservation des données

Tous les parcours susceptibles d’écrire utilisent des schémas PostgreSQL jetables et des doubles d’authentification/stockage ; les tests tactiles et clavier interceptent toutes les API. Cette reprise n’ajoute aucune migration. L’incident de migration de la reprise précédente reste décrit dans son rapport et n’est pas effacé de l’historique.

Les mesures mobiles sont réalisées sous Chromium émulé ; elles ne certifient pas Safari/iOS ou un clavier système physique. La vitesse dépend toujours du réseau, du fournisseur d’identité et de PostgreSQL. Le journal partagé et la reconnexion améliorent la continuité ; les interruptions du fournisseur peuvent encore augmenter le délai.

Prévisualisation actualisée et isolée : **http://localhost:5190**, comptes synthétiques `admin / Admin2026!`, `yassine / Campus2026!` ou `sara / Campus2026!`. Le serveur de développement préexistant au port 5180 est préservé. Les changements sont locaux et ne sont pas déployés.

## Intégration pour publication sur `main`

Pendant la préparation du push, `origin/main` contenait deux corrections supplémentaires (`532541f`, `63dc321`). Leur fusion conserve la suppression des notifications liées aux contenus retirés et masque les anciennes lignes `target_deleted=1` dans les listes et compteurs. Une destination simplement indisponible reste distincte d’un contenu explicitement supprimé et peut être acquittée. L’endpoint `/api/notifications/state` est conservé pour les clients existants avec les mêmes règles de rétention ; l’acquittement explicite utilise une seule route canonique. Le flux partagé et la synchronisation récente remplacent le timer redondant de l’ancienne implémentation.

Après résolution des conflits : **build réussi, 44 tests backend/unitaires réussis sans échec ni test ignoré, 8 parcours navigateur réussis**. Les tests de suppression pour plusieurs destinataires, les anciennes notifications supprimées, les compteurs, les liens précis et les permissions sont inclus. La fusion préserve les commits distants et la totalité des corrections locales ; aucun push forcé, aucune migration ni modification de compte réel ne sont nécessaires à cette publication. Les fichiers `.env`, données, sauvegardes, résultats locaux et l’archive ZIP restent hors du commit.
