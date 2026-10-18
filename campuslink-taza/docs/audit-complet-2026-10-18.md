# CampusLink Taza — suite de l’audit complet, 18 octobre 2026

Travail en cours. Ce document complète `frontend-phase1-2026-10-18.md` ; il ne remplace pas les preuves du travail antérieur. La demande de référence est la pièce jointe `e3d5a81c-6524-44b2-8340-0881a9bbfdb7/Pasted text.txt`. La nouvelle demande autorise maintenant les corrections backend. Aucune modification de production, aucun compte réel, aucun fichier R2 réel. Les tests sont exécutés dans des schémas temporaires. Incident de rechargement local : voir le relevé ci-dessous. Le patch initial est archivé dans `/tmp/campuslink-new-audit-initial.patch`.

## Problèmes reproduits et causes

- À 1024 px dans Communauté, les douze icônes de navigation disparaissaient : le sélecteur du mode compact masquait tous les enfants `span`, dont les nouveaux conteneurs `.nav-icon-wrap`. Corrigé en ciblant uniquement les libellés et compteurs.
- Les cartes de l’Accueil réutilisaient la présentation minimaliste de la bibliothèque. Une variante commune « recent » ajoute titre/type/filière sans remplir les valeurs absentes ; les chapitres historiques restent conservés.
- L’ajout du statut réseau pouvait dépasser la hauteur fixe de la conversation : le contenu du chat participe désormais au dimensionnement flex. À la demande de l’utilisateur, l’état connecté est masqué sur téléphone ; seuls les états utiles d’interruption restent affichés.
- Notification #8 : la lecture exigeait une destination valide et la fin d’une visite. Le clic explicite dispose maintenant de son propre endpoint avec vérification du propriétaire. L’action globale volontaire possède également son endpoint.
- SSE : la liste des connexions était locale au processus. Un journal d’invalidation PostgreSQL transmet maintenant les mises à jour entre instances, avec réconciliation par snapshot lors d’une reconnexion.
- Support : pas de réservation exclusive, de récupération anonyme, ni de réactions persistantes. Ajouts en cours de validation : attribution atomique, participant assigné, clôture, réactions, code privé de récupération indépendant du stockage navigateur.
- Authentification : le refus Neon `INVALID_ORIGIN` était regroupé avec les mots de passe incorrects. Le diagnostic de configuration est maintenant distinct. Aucun élément ne prouve que cette cause explique le cas réel du ticket #7.

## Vérifications obtenues à ce stade

- Diagnostic avant/après des icônes à 1440, 1024 et 390 px.
- Build frontend réussi après les premières corrections.
- Matrice de 199 contrôles responsive réussie après les corrections visuelles initiales.
- 39 tests d’authentification réussis, y compris la distinction erreur de configuration/identifiants.
- Premier passage backend : récupération publique, présence et invalidation entre deux instances réussies (912 ms mesurés entre envoi et invalidation). Trois attentes de fixtures corrigées : réponse booléenne de lecture et reconnexion après nomination, qui révoque volontairement l’ancienne session. Nouveau passage en cours.

## Travaux à terminer avant bilan final

- Finaliser et tester de bout en bout les nouveaux écrans de support, réactions et permissions ; vérifier tous les accès alternatifs.
- Ajouter et vérifier les signalements de dossiers/modules/catégories, sans suppression groupée automatique.
- Refaire les parcours clés sur build stable après les derniers changements : téléphone, tablette, PC, clavier, récupération hors navigateur, deux sessions, notifications et administration.
- Vérifier la compatibilité des tests existants avec les nouvelles règles explicitement demandées, terminer les tests backend pertinents et documenter les limites mesurées.
- Produire le rapport final en sept parties, avec preuves et limites réelles (pas de validation sur appareils physiques ni déploiement).

## Incident constaté pendant le travail

Un processus `npm run dev` préexistant comportait un watcher backend, avec `.env.local` autorisant `CAMPUS_DB_MIGRATE=true` sur `campuslink_prj`. Il a automatiquement exécuté les migrations additives 033, 034 et 035 lors des modifications, avant que le processus soit identifié et suspendu. La vérification en lecture seule du journal confirme les heures UTC 14:54:57, 19:00:54 et 19:07:25 le 18 octobre. Ces migrations ajoutent tables/colonnes/index et rendent nullable l’auteur des réponses anonymes ; elles ne suppriment ni ne réécrivent de compte, message ou fichier existant. Aucune restauration destructive n’a été tentée.

Mesures : watcher et enfant suspendus dès la découverte ; migration automatique désactivée dans la configuration locale ; `server/index.js` démarre maintenant sans migration ni seed, même si une ancienne variable les active. Les opérations de migration restent des commandes explicites. Ce point doit figurer au bilan final, sans prétendre que le schéma habituel est resté inchangé.
