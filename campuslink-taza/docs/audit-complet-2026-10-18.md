# CampusLink Taza — audit complet, 18–19 octobre 2026

Les corrections et les passages de validation décrits ci-dessous sont terminés le 19 octobre 2026. Cette suite reprend les changements et preuves de la [première revue frontend](frontend-phase1-2026-10-18.md). Elle répond à la demande élargie du 18 octobre et à la consigne du 19 octobre : conserver le travail existant, terminer les parcours et retirer le bandeau « Campus connecté » des téléphones. Aucun commit, push ou déploiement n’a été effectué. Les modifications locales préexistantes, y compris la feuille de style du lecteur, sont conservées.

## 1. Problèmes reproduits

- À 1024 px dans Communauté, les douze icônes du menu compact disparaissaient.
- L’Accueil ne présentait plus les titres, types et filières des documents récents. Les cartes reprenaient la présentation volontairement minimale de la Bibliothèque.
- Le statut de connexion prenait de la place sur téléphone ; son ajout pouvait faire dépasser la hauteur du chat et pousser la rédaction sous le clavier.
- Plusieurs attentes de chargement du lecteur et des pages Campus/Feedback restaient de simples paragraphes.
- Une notification indisponible pouvait rester non lue après un clic ; l’action globale volontaire n’existait pas encore.
- Les événements SSE étaient limités au processus qui recevait l’écriture. Une autre instance API pouvait ne pas notifier ses propres appareils connectés.
- Les demandes privées ne possédaient pas d’acceptation exclusive, de récupération indépendante du navigateur, ni de réactions persistantes. Un résultat de chargement tardif pouvait remplacer une conversation récemment mise à jour.
- Les inscriptions restaient réservées au propriétaire, sans permission d’admission distincte. Le détail d’un compte ne proposait pas de copie individuelle.
- Deux catégories pouvaient partager un même dossier logique de même nom et même déposant. Les signalements de dossiers/modules/catégories n’avaient pas de contrat serveur.
- Un refus du fournisseur d’identité `INVALID_ORIGIN` pouvait être présenté comme des identifiants incorrects.
- Les connexions SSE de support pouvaient laisser un timer après fermeture, notamment lorsque le navigateur quittait la page pendant la vérification de session.
- Sur téléphone, la dernière page PDF pouvait être entièrement visible alors que le compteur revenait à l’avant-dernière page.

## 2. Causes identifiées

Le sélecteur du mode compact cachait tous les `span` du menu, y compris les nouveaux conteneurs `.nav-icon-wrap`. Les cartes récentes et celles de la Bibliothèque partageaient le même contrat d’affichage. La conversation fixée au viewport n’intégrait pas la hauteur du nouveau statut dans son calcul flex.

La lecture d’une notification exigeait précédemment une destination valide et la fin d’une visite. Le bouton global restait désactivé faute de route. Le registre SSE en mémoire ne reliait pas les processus. Les fils Feedback effectuaient leur propre chargement, séparé du bootstrap, sans écouter ces invalidations.

Les contacts n’enregistraient ni responsable, ni code de récupération, ni réactions. Les permissions ne distinguaient pas l’admission de l’assistance. Les dossiers dérivés des chemins ne comprenaient pas la catégorie dans leur clé. Les signalements ne possédaient pas de contexte collectif explicite.

La classification des erreurs d’authentification regroupait certains refus de configuration avec les mauvais mots de passe. Le nettoyage SSE utilisait la fermeture de la requête plutôt que celle de la réponse, et pouvait s’enregistrer après une déconnexion déjà survenue. Le lecteur choisissait sa page à partir d’un point fixe dans le viewport ; à la fin d’un document dont la dernière page était plus courte que la zone de lecture, ce point restait sur la page précédente.

## 3. Corrections effectuées

- Icônes restaurées à leur taille normale dans le menu compact ; contrôle à 1440, 1024 et sur téléphone, puis vérification de l’ensemble de la navigation.
- Variante commune de carte récente : titre, type, filière, semestre, chapitre disponible et véritable username. Les informations absentes ne sont pas inventées. La carte compacte de la Bibliothèque et les détails complets restent disponibles.
- Espacements des sections d’Accueil harmonisés. Le statut normal est masqué jusqu’à 760 px. Les interruptions restent signalées. Le chat utilise une hauteur flex disponible, y compris avec clavier redimensionné/déplacé.
- Chargements partagés avec indicateur, libellé contextualisé, placeholders et respect de la réduction des animations. Les progressions de fichiers et erreurs explicites existantes sont préservées.
- Lecture persistante au clic explicite, même si la destination est absente ; indication compréhensible. Ouvrir la liste ou la cloche ne lit rien. Lecture globale volontaire, compteurs issus du reçu serveur et synchronisation des appareils. Un ancien clic retardé ne peut plus remplacer une navigation plus récente.
- La suppression d’un contenu retire les notifications qui ciblent exactement ce contenu, y compris les liens modernes. Les notifications indépendantes et les autres pièces jointes/messages sont préservés.
- Invalidations PostgreSQL entre instances, réconciliation au retour de connexion/visibilité et reprise périodique. Les données restent lues via les routes qui contrôlent les droits. Feedback, Campus et l’administration écoutent les mises à jour utiles.
- Présence par bail de 30 secondes, renouvelé toutes les 10 secondes pendant la consultation : comptes dédupliqués, vrais usernames, contrôle de faculté/filière/canal et exclusion des comptes ou accès chat invalides. Sortie et masquage libèrent le bail ; une coupure brutale finit par expiration.
- Acceptation du support verrouillée en base : un seul administrateur assigné. Les autres voient l’état et les métadonnées, sans lire ni rejoindre le fil privé. Le propriétaire conserve son autorité supérieure. Les routes alternatives, fichiers, réactions et statuts vérifient aussi le participant et ses droits.
- Messages et demandes protégés contre les soumissions et reprises identiques. La clôture répétée ne produit pas une nouvelle notification. Les réponses tardives ne remplacent pas les nouveaux messages ou brouillons. Les timers SSE sont nettoyés à la fermeture de la réponse et les réponses déjà détruites ne créent pas de flux.
- Le lecteur reconnaît maintenant la dernière page à la fin de sa plage de défilement. Le compteur, la page demandée et la position enregistrée concordent aussi sur un téléphone haut. La taille des boutons choisie localement par l’utilisateur reste conservée.
- Code UUID sécurisé également lorsque `crypto.randomUUID` est absent, notamment dans certains contextes HTTP de développement sur réseau local.
- Diagnostic d’authentification distinct pour les erreurs de configuration. Aucun mot de passe étudiant réel n’a été changé pour cette enquête.

## 4. Fonctionnalités ajoutées ou modifiées

**Support avant connexion.** `/support` est accessible depuis les parcours de connexion, inscription et première affectation. Nom complet, email, faculté, objet et description sont demandés. Un compte approuvé utilise son identité vérifiée et son contexte académique. Une adresse email anonyme ne sélectionne jamais automatiquement un compte.

La demande attend une acceptation. Ensuite, l’étudiant et le responsable échangent dans un fil persistant, avec dates, identités, réactions J’aime/J’adore et clôture lisible. Les réponses notifient le participant concerné. Le code privé téléchargeable permet de retrouver ce seul ticket depuis un navigateur neuf, sans données locales. Il est stocké sous forme de hash en base ; le cookie est HttpOnly. Aucun email externe n’est envoyé. Le code du ticket ne réinitialise pas le mot de passe du compte : la procédure administrative de vérification existante reste applicable.

**Administration.** `student.admit` est une capacité distincte de `feedback.manage` et de `student.support`. Le propriétaire peut la déléguer dans le périmètre autorisé, sans accorder les autres privilèges. Les comptes protégés et les restrictions entre facultés/filières sont conservés. Username et email se copient séparément, avec confirmation visible. La page d’attente vérifie automatiquement le statut pendant sa consultation et ouvre l’espace approuvé sans rechargement manuel.

**Bibliothèque.** Les dossiers sont distingués par chemin, déposant et catégorie. L’ouverture conserve le classement dans l’URL. Les ajouts restent attribués par le serveur à leur véritable déposant ; un chemin identique n’ajoute pas les fichiers au dossier d’un autre compte. Complet et 1 à 20 restent les choix de classement ; les chapitres historiques supérieurs restent consultables. Les signalements de fichiers restent disponibles ; ceux d’un dossier, module ou catégorie enregistrent le contexte exact dans `reports.target_context`, sans suppression automatique ni action groupée fictive.

**Démarrage et prévisualisation.** Le démarrage normal ne migre ni ne seed automatiquement, même si une ancienne variable les activait. Les commandes de migration restent explicites. `npm run preview:isolated`, après compilation, sert le build et les routes réelles avec un schéma temporaire, une identité de test et un stockage en mémoire. Ctrl+C nettoie uniquement ce schéma de test.

## 5. Tests et résultats

Les validations backend utilisent un schéma aléatoire `campuslink_test_<uuid>` ; leurs identités et stockage sont injectés en mémoire. Aucun test ne crée un utilisateur Neon réel ni un objet R2 réel. Les suites frontend à réponses interceptées couvrent les échecs et délais sans appeler les données habituelles.

| Vérification | Résultat |
| --- | --- |
| Build de production Node 22.23.3 | Réussi. Avertissements non bloquants de dépendances et de taille du bloc Labs. |
| Tests JS ciblés Node 22 | **106 réussis, 0 échec, 0 ignoré** : ressources, dossiers/catégories, chapitres, UUID HTTP, transport/reprises, lecture, notifications, API, Labs, cache et contexte. |
| Régression backend élargie | **118 réussis, 0 échec, 0 ignoré**, y compris authentification, permissions, notification, administration, migrations/readiness et réinitialisation des mots de passe avec fournisseur injecté. |
| Nouveaux contrats backend | **9 scénarios réussis** : lecture explicite/globale, réservation concurrente, confidentialité, récupération sans stockage navigateur, identité connectée, admission indépendante, présence, signalements collectifs et invalidation entre instances. Passage complémentaire de clôture idempotente réussi. Ces suites recouvrent certains cas de la ligne précédente ; les nombres ne sont pas additionnés comme cas uniques. |
| Matrice générale frontend | **199 contrôles réussis** : 35 destinations authentifiées × 5 configurations, puis 24 destinations publiques/onboarding. Clair/sombre, français/anglais/arabe, 320/390/768/1440 px. |
| Structure et modales | 10 largeurs, de 320 à 2560 px : menu, inert/focus, clavier simulé, compteurs, action globale volontaire, notes et scanner. |
| Communauté | 7 configurations clavier réussies, puis 6 scénarios de toucher/clavier : rédaction visible, focus, pièces jointes, historique, appui long, navigation/fermeture des menus et paysage. |
| Bibliothèque | 7 configurations, 4 facultés, FR/AR et deux thèmes : navigation, chemins imbriqués, déposants distincts, 21 choix, historique 125 et lecteur. |
| Administration | 32 panneaux des quatre facultés, nominations, erreurs/reprise, droits de dépôt, révocation et destination Faculty Leader réussis. |
| Feedback | 5 groupes réussis : statut, clôture en lecture seule, brouillons, doubles actions, résultats tardifs, quotas/fichiers et reprise après erreur. |
| Parcours réels des ajouts | **8 groupes réussis**, sans erreur JavaScript : demande publique → acceptation → échanges/réactions → rechargement → navigateur vierge/code → clôture ; métadonnées ; absence de bandeau connecté sur téléphone ; icônes compactes ; notification indisponible ; cloche non destructive et lecture globale ; signalement de dossier à 320 px ; copies ; admission automatique. Plusieurs vérifications sont regroupées dans une même entrée du rapport JSON. |
| Intégration générale | **10 parcours réussis** avec routes réelles : connexion/session, upload et octets, bibliothèque, chat/réactions, profil/préférences, contexte protégé, huit onglets propriétaire, admission et restrictions administratives. Aucun échec dans le rapport JSON. |
| Lecteur après les derniers changements locaux | **6 groupes / 28 mesures réussis** sur le build de production, puis **7 groupes / 17 mesures réussis** de repli PDF sur Vite avec injection des pannes. Dernière page courte, PDF image, extraction/couche texte en échec, recherche partielle, page en panne et reprise vérifiés. |
| Prévisualisation isolée | Connexion et conversation vivante vérifiées à 320/390/768/1440 px ; aucun débordement horizontal ni rédaction hors viewport. Disponible sur `http://localhost:5190` lors de la livraison. |
| `git diff --check` | Réussi. |

Temps mesurés : **814 ms** pour l’invalidation de message entre deux instances dans le passage de référence ; **environ 1,4 s** pour voir la réponse de support dans l’autre navigateur après les optimisations (premier passage : environ 2,9 s). L’invalidation et le rendu complet sont deux mesures différentes. L’objectif inférieur à une seconde n’est pas garanti de bout en bout.

Preuves locales : `test-results/audit-next/`, notamment `unit-final.log`, `backend-final.log`, `backend-new-final.log`, `support-idempotency-final.log`, `frontend-final-results.json`, `browser-report.json`, les logs clavier/toucher/Feedback/Bibliothèque/administration/cohérence, et `test-results/integration-report.json`. Les captures du support masquent le code de récupération.

Les premières attentes de test devenues incompatibles avec les règles demandées ont été corrigées : conversations fermées désormais non modifiables, pièces jointes réservées au responsable après attribution, notifications supprimées avec leur contenu et bouton global devenu actif. Un conflit de port lors d’un lancement concurrent d’intégration a été distingué du passage réussi ; la suite prend désormais un port libre. Un premier contrôle de lecture globale attendait seulement que le bouton soit désactivé pendant l’envoi ; il attend maintenant aussi la fin effective de la requête avant de vérifier la base. La fuite de timer constatée au nettoyage a été corrigée et le passage final termine son nettoyage. La suite de pannes PDF cible les modules PDF.js de développement : son premier lancement sur le bundle de production ne pouvait pas injecter ces pannes ; elle a été exécutée sur Vite avec les API interceptées. Ce passage a aussi reproduit et permis de corriger le compteur de dernière page sur téléphone.

## 6. Points qui restent à établir

La cause historique exacte du ticket #7 ne peut pas être attribuée à distance à un mauvais mot de passe ni au défaut de configuration trouvé. Les scénarios de service indisponible, session, reprise, révocation et changement de mot de passe sont vérifiés ; le cas individuel nécessiterait les journaux du fournisseur et du déploiement au moment de l’incident. Aucun identifiant réel n’a été réinitialisé pour essayer de le résoudre.

La latence dépend encore du fournisseur d’identité, de PostgreSQL et du réseau. Les échanges sont automatiques et récupèrent les données à la reconnexion ; une promesse générale de rendu inférieur à une seconde dépasserait les mesures obtenues.

Les dossiers restent des regroupements logiques de documents, identifiés par périmètre, chemin et déposant. Un même déposant réutilisant le même chemin et la même catégorie retrouve le même dossier logique. Aucun dossier vide ou identifiant de dépôt distinct n’est inventé. La récupération publique nécessite le cookie encore valide ou le code privé conservé ; une adresse email seule n’ouvre pas l’historique.

## 7. Risques, limites et incident de migration locale

Les téléphones et tablettes sont émulés sous Chromium. Safari/iOS natif, claviers système physiques et lecteurs d’écran réels ne sont pas certifiés. La présence peut subsister jusqu’à l’expiration du bail après une coupure brutale, puis jusqu’à la prochaine actualisation de la liste. Aucun déploiement de ces changements n’a été réalisé.

**Incident à conserver dans le bilan :** un processus local préexistant `npm run dev` comportait un watcher backend et `.env.local` autorisait `CAMPUS_DB_MIGRATE=true` sur le schéma habituel `campuslink_prj`. Il a appliqué les migrations nouvelles **033, 034 et 035** lors des modifications, avant que ce processus soit identifié et suspendu. Une vérification en lecture seule du journal confirme les heures UTC du 18 octobre : 14:54:57, 19:00:54 et 19:07:25.

Ces migrations ajoutent tables, colonnes et index ; elles rendent nullable l’auteur des réponses anonymes. Elles ne suppriment ni ne réécrivent les comptes, messages et fichiers existants. Le serveur local a également utilisé les nouvelles tables temporaires de présence et d’invalidation. Il serait donc inexact de prétendre que le schéma habituel est resté entièrement inchangé. Aucune restauration destructive n’a été tentée.

Le watcher a été suspendu dès la découverte. La configuration locale désactive maintenant la migration automatique et `server/index.js`/le démarrage par défaut ne migrent ni ne seedent, même avec d’anciennes variables. Les tests et la prévisualisation utilisent les schémas isolés. Le patch des modifications préexistantes a été conservé dans `/tmp/campuslink-new-audit-initial.patch`.


Prévisualisation de livraison : `http://localhost:5190`, comptes synthétiques `admin / Admin2026!` ou `yassine / Campus2026!`. Il s’agit exclusivement de l’environnement isolé. Le port 5180 de développement déjà utilisé par l’utilisateur n’a pas été remplacé. Pour relancer sur ce port alternatif : `CAMPUS_ISOLATED_PORT=5190 npm run preview:isolated`.


Suite du 19 octobre : les optimisations de notifications/discussions, les délégations interfacultés, la confidentialité du propriétaire et le nouvel en-tête ont leur [rapport et vérifications propres](notifications-discussions-permissions-2026-10-19.md).
