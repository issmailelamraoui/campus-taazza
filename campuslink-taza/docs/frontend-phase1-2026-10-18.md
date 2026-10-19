# CampusLink Taza — Phase 1 frontend, 18 octobre 2026

État : audit frontend et corrections réalisés, validations terminées sur les matrices décrites ci-dessous. La Phase 2 backend n’a pas été engagée.

## Périmètre et protection du travail existant

L’audit a commencé par l’inventaire des routes, composants, styles, contrats API et tests existants, puis une exploration sous Chromium. Les thèmes chauds, la navigation, les trois langues et les fonctionnalités existantes ont été conservés.

Le dépôt comportait déjà des modifications locales, notamment le cycle des notifications dans le frontend et le serveur. Elles ont été préservées. La comparaison avec l’état initial confirme que les modifications des fichiers serveur suivis sont identiques à celles présentes avant cette mission. Cette phase n’a ajouté aucune migration ni changé les permissions serveur.

À la demande de l’utilisateur, les comptes et données de validation sont isolés : réponses API interceptées dans les suites visuelles, puis routes réelles avec identités et stockage en mémoire et schéma PostgreSQL temporaire pour l’intégration. Aucun compte Neon ni objet R2 réel n’est créé, modifié ou supprimé. Aucun déploiement n’est effectué.

## 1. Pages et sections effectivement inspectées

| Espace | Inspection réalisée |
| --- | --- |
| Public | Accueil, connexion, inscription, récupération via le formulaire de contact, attente/refus de compte, onboarding en trois étapes et changement de mot de passe imposé. |
| Structure partagée | Sidebar, navigation mobile, contexte académique, recherche globale, langues, thèmes, mode Éco, menu de compte, notifications et fenêtres communes. |
| Accueil étudiant | Annonces à la une, accès rapides par catégorie, ressources et pile mobile, discussions récentes, contenus vides. |
| Bibliothèque | Six semestres, modules, catégories, années, tri, recherche, filtres avancés, pagination, liens directs, partage, dossiers et sous-dossiers. |
| Dépôts | Fichier unique, sélection multiple, dossier, classement commun et individuel, vérification, erreurs partielles, reprise et compléments de documents. |
| Lecteur | PDF réel, texte, images et tableaux ; ouverture/chargement/erreurs ; pages et zoom ; recherche ; notes et zones sélectionnées ; comparaison ; focus ; détails ; qualité et signalement ; relations, corrections proposées, compléments et accès hors ligne. |
| Communauté | Chat général, Important Discussion et chats de filière par année ; liste/conversation mobile ; messages, rédaction, réactions, réponses, favoris, liens, pièces jointes, partage de modules, menus tactiles et clavier, modération. |
| Campus Feedback | Liste et création de demandes, détail privé étudiant/administration, auteur, statuts, réponses, pièces jointes, erreurs et reprises. |
| Campus | Forum, détail/réponses/commentaires/pièces jointes/signalements ; CloseRoom et échanges privés ; groupes de révision ; Study Match ; annonces et contacts privés Market ; modération. |
| Étude | Notes, flashcards et révisions espacées, checklists, collections, parcours par module et mode examen ; éditeurs, références et conflits/synchronisation. |
| Scanner | Sélection de photo, aperçu, rotation, recadrage tactile et numérique, luminosité/contraste, enregistrement privé. |
| Campus Labs | Éditeur, langages, exécution/arrêt/console, sessions et reprise, erreurs de disponibilité, graphiques et erreurs de saisie. |
| Campus XP | Niveau, progression, récompenses, classement, visibilité du profil, historique. |
| Autres pages étudiantes | Annonces et détail, notifications lues/non lues, favoris et historique, profil/photo, préférences, sécurité, installation et contact. |
| Administration | Huit onglets : vue d’ensemble, comptes, organisation, ressources, annonces, signalements, communauté et assistance ; admissions, filtres, détails, modifications et réinitialisation de mot de passe. |
| Propriétaire et délégations | Nominations, comptes éligibles, rôles, périmètres de faculté/filière, capacités explicites, erreurs, révocation et confirmation. |

Les contextes FSA, FLAA, FEG et FSJP sont couverts par les matrices bibliothèque et administration. Les droits étudiant, propriétaire et délégations sont testés dans leurs parcours respectifs ; les droits ne sont pas déduits seulement de l’intitulé du rôle.

L’inspection de source couvre les composants secondaires. La matrice générale exerce 35 destinations authentifiées et les écrans publics. Les suites ciblées ajoutent des données remplies, des actions, des erreurs et des délais réseau ; il ne s’agit pas d’une vérification exhaustive de chaque combinaison possible de données ou de permissions.

## 2. Défauts détectés

- Sidebar : une règle `flex: 1` s’appliquait aussi au conteneur des icônes, éloignant les intitulés et comprimant les libellés. Les noms longs du compte pouvaient également déborder.
- Navigation : un tiroir mobile resté ouvert lors d’un passage au desktop pouvait conserver le verrouillage du défilement. Le contact ouvert depuis le tiroir laissait deux couches de navigation actives.
- Fenêtres : leur dimension dépendait de `100dvh` sans suivre les variations et le déplacement du viewport visuel provoqués par le clavier.
- Fichiers : les cartes cumulaient titre, nom original, filière, professeur, type, taille, date et catégorie ; le déposant utilisait son nom affiché plutôt que son username.
- Classement : Part/Chapitre était une saisie libre avec suggestions incomplètes. Les fichiers déposés dans des dossiers distincts étaient mélangés au niveau du module.
- Feedback : auteur peu visible, wrappers vides créant des espaces, remplacement du fil pendant le rafraîchissement, confusion entre erreur et liste vide, validation des pièces jointes insuffisante.
- Données privées : des réponses tardives pouvaient réouvrir un aperçu ou modifier l’état d’un autre écran/contexte. Certains formulaires effaçaient du texte rédigé pendant une requête.
- Administration : statuts anglais bruts, rôle Faculty Leader non traduit, formulaires trop petits sur téléphone, choix de permissions incompatibles avec le périmètre sélectionné et erreurs peu explicites.
- Authentification : certaines destinations utilisaient une liste de rôles au lieu des droits administratifs effectifs.
- Étude : modifier une checklist contenant deux tâches au texte identique réutilisait le premier identifiant deux fois, faisant rejeter un formulaire valide.
- Soumissions : plusieurs formulaires s’appuyaient uniquement sur un état React pour bloquer les doubles envois.
- Labs : une panne du chargement des sessions disparaissait au lancement du code, sans indiquer que l’exécution locale n’avait pas été enregistrée.
- Favoris : le compteur Documents prenait celui de l’historique lorsque cet onglet était choisi. L’accueil vide affichait des sections sans explication.
- Build de production autonome : Analytics demandait un script Vercel absent et recevait la page HTML du site, provoquant une erreur JavaScript à chaque chargement.
- Modération du chat : l’action visible pour un modérateur utilisait la route de suppression réservée à l’auteur ou au propriétaire.

## 3. Modifications effectivement réalisées

### Navigation et composants partagés

Les icônes de sidebar ont une largeur fixe ; seul le libellé utilise l’espace restant. Le contexte et les noms longs restent contenus. Le tiroir expose sa relation avec son bouton, protège le contenu arrière et se ferme au changement de breakpoint ; le contact ferme d’abord le tiroir.

Les fenêtres suivent `visualViewport` pour rester dans la zone visible avec le clavier, en préservant le zoom natif. Le défilement interne, Échap, le confinement du focus et le retour au contrôle d’origine restent disponibles. Les saisies tactiles utilisent une taille lisible.

### Bibliothèque, cartes et classement

Les cartes présentent les quatre informations demandées : **module, Part/Chapitre, semestre, username du déposant**. Les actions ouvrir/favori sont conservées, ainsi que l’ouverture par clic sur la carte. Le titre continue d’identifier le document dans le nom accessible du bouton ; le nom original reste disponible dans les détails. Les informations retirées du résumé sont accessibles dans le volet Informations du fichier.

`PartSelect` réutilise le sélecteur CampusLink, avec Complet puis 1 à 20, navigation clavier et menu adapté au viewport. Il est utilisé dans les dépôts et la modification administrative. Une valeur historique supérieure à 20 reste lisible et conservée ; elle n’est pas proposée pour de nouveaux classements. Le serveur n’a pas été restreint pendant cette phase.

Les chemins relatifs existants deviennent une arborescence navigable. Deux dossiers de même nom de déposants différents restent séparés. L’URL, le fil d’Ariane, le dossier parent, le retour navigateur et les liens de document conservent le bon contexte. La pagination porte sur les fichiers du dossier ouvert. La recherche et les filtres restent disponibles.

### Assistance, communauté et Campus

Feedback dispose d’un en-tête auteur/date/catégorie/statut, d’une demande initiale et de réponses privées présentées en messages. Les espaces vides ont été supprimés. Le fil demeure visible pendant les opérations ; la saisie nouvelle n’est pas effacée par une ancienne réponse. Les limites réelles des pièces jointes sont affichées et vérifiées avant l’envoi. Les erreurs ont une reprise explicite.

Les lectures et mutations sont rattachées à leur compte, contexte académique et destination ; les résultats tardifs sont ignorés ou annulés. Les données devenues inaccessibles sont retirées de l’affichage. Les statuts Campus sont traduits et les contrôles de modération suivent les capacités existantes. La suppression par un modérateur utilise la route administrative déjà disponible.

Les cartes de pièces jointes de chat sont allégées ; leurs détails restent accessibles à l’ouverture. Un nom affiché n’est jamais transformé artificiellement en username. Les protections de viewport et de clavier du chat desktop/mobile existant sont conservées.

### Administration et parcours personnels

Les statuts d’assistance et rôles sont traduits. Les contrôles et contenus longs s’adaptent aux petites largeurs. Les nominations proposent des comptes actifs approuvés, expliquent le périmètre requis pour les dépôts, gardent les erreurs visibles et protègent les doubles requêtes. La révocation possède une confirmation locale.

La navigation après connexion/onboarding respecte les droits effectifs. Les tâches identiques d’une checklist conservent chacune leur identifiant et leur état. Les sauvegardes de notes, outils et scans sont protégées contre les doubles soumissions. Les compteurs des favoris et les états vides d’accueil sont corrigés.

Labs distingue le chargement, l’échec et l’absence de sessions. Une nouvelle tentative conserve le code. Le moteur continue de fonctionner localement ; une exécution non enregistrée est indiquée clairement, et seule une nouvelle exécution après récupération déclenche la sauvegarde.

### Build de production local

Le chargement Analytics dépend désormais de la configuration de compilation : actif sur Vercel, inactif dans le build Express local sans endpoint. Une variable explicite permet de choisir ce comportement. Le diagnostic a confirmé l’URL, le type HTML et l’erreur de parsing ; aucun endpoint serveur n’a été modifié.

### Notifications

Le travail préexistant de lecture à la destination est préservé. Ouvrir le panneau ne marque rien comme lu. Les grands compteurs affichent `99+` sans déformer la navigation. Le futur bouton « Tout marquer comme lu » est intégré au panneau et à la page, **désactivé et explicitement étiqueté « À venir »** : aucune fonctionnalité serveur inexistante n’est simulée.

## 4. Résultats sur ordinateur

- Navigation alignée et libellés moins comprimés ; destinations basses accessibles par défilement.
- Grilles et grandes surfaces conservées ; cartes plus faciles à parcourir et dossiers identifiables.
- Détails complets dans le lecteur ; comparaison, recherche, notes et mode focus préservés.
- Assistance structurée sans grand espace entre le fil et les contrôles.
- Administration lisible jusqu’à 1920 px ; structure partagée mesurée jusqu’à 2560 px.
- Exécution Labs et sauvegarde de session distinguées en cas de panne.

## 5. Résultats sur téléphone et tablette

- Contrôles partagés mesurés à 320, 360, 390, 430, 768, 1024, 1280, 1440, 1920 et 2560 px, sans débordement horizontal dans la matrice exécutée.
- Fenêtres contenues dans le viewport avec clavier redimensionné et déplacé ; focus restauré après fermeture.
- Conversation mobile exploitant la zone disponible, rédaction et dernier message visibles, retour à la liste sans réduire la conversation.
- Menus tactiles, listes longues, noms Unicode, RTL et formats paysage vérifiés.
- Dossiers, cartes, classement et écrans administratifs utilisables dès 320 px.

## 6. Tests exécutés et résultats

La matrice générale s’exécute sur le build de production local (`vite preview`, port 5184). L’intégration utilise le même build, servi par les routes Express réelles avec données temporaires.

| Vérification | Résultat disponible |
| --- | --- |
| Build de production | `npm run build` réussi, puis compilation Vite avec Node 22.23.3 (version cible) réussie ; même hash du bundle principal. Activation Analytics vérifiée pour quatre configurations local/Vercel/forçage oui/non. Avertissements non bloquants des dépendances et taille du bloc Labs. |
| Tests ciblés JS | 104 tests distincts réussis sous Node 22.23.3 : ressources/dossiers, chapitres, upload, notifications, lecture/outils, tableurs, Labs, cache privé, contexte académique, API et service worker. |
| Structure partagée | 10 largeurs réussies : alignement/reachabilité sidebar, changement de breakpoint, compteurs, panneau non destructif, fenêtres/clavier/focus, éditeur de collection, Scanner et accueil vide. |
| Bibliothèque | 7 configurations, quatre facultés, deux thèmes, FR/AR ; quatre champs, dossiers imbriqués, liens/retour/rechargement, 21 choix et lecteur texte/détails. Dernière régression 320 px réussie après ajustement du défilement. |
| Administration | 32 panneaux (4 facultés × 8 onglets), permissions, erreurs/reprise, protection des doubles envois, confirmation de révocation et destination Faculty Leader réussis. |
| Authentification | Inscription sur mobile/paysage/desktop et trois langues ; cinq parcours de changement imposé de mot de passe réussis. |
| Feedback | Réponses/statuts, auteur/date/catégorie, brouillons, délais, double envoi, pièces jointes invalides/quota, erreurs et nouvelle tentative réussis. |
| Pièces jointes Forum | 5 scénarios réussis : sélection/reprise, aperçu explicite, suppression autorisée, révocation et déconnexion pendant un envoi. |
| Toucher messagerie | 6 scénarios réussis : maintien/copie, relâchement sans clic parasite, fermeture extérieure, annulation du geste, menu défilable sur écran court et clavier desktop. |
| Campus rempli | 36 vues réussies : listes/détails Forum, CloseRoom, groupes, Study Match et Market dans les quatre facultés ; reprise après erreur, réponses tardives, pièces jointes et capacités de modération. |
| Clavier messagerie | 7 configurations Chromium réussies, dont 320 px FR/AR, tablette, paysage et desktop ; viewport redimensionné/déplacé, caret, focus, menu et historique. |
| Lecteur PDF | 6 groupes réussis, 28 mesures : PDF réel continu, recherche/notes/comparaison/focus, sélections, document de 100 pages, reprise et erreurs. |
| Repli du lecteur | 7 groupes réussis, 17 mesures : PDF image, extraction/couche texte, recherche partielle, indexation, reprise page et chargement retardé. |
| Labs en panne | Réussi à 320 px avec exécution JavaScript réelle, panne initiale, code conservé, reprise et sauvegarde unique après relancement. |
| Cohérence globale finale | **199 contrôles réussis** sur le build de production : 35 destinations authentifiées dans 5 configurations (175), puis 24 contrôles des pages publiques et étapes d’onboarding. Clair/sombre, français/anglais/arabe ; 320, 390, 768 et 1440 px. Aucun débordement détecté, destination respectée et dernière entrée de sidebar accessible. |
| Intégration routes réelles isolées | 10 parcours réussis : session et droits, documents/favoris/aperçus, upload et octets persistés, chat et pièces jointes/réactions, profil/préférences, contexte académique protégé, huit onglets propriétaire, inscription/admission, anciennes routes et périmètres administratifs. Aucun échec ni erreur JavaScript. Schéma temporaire nettoyé en fin de suite. |
| Notifications | 12 scénarios réussis sur le build : compteurs, événements administratifs, file d’attente, détails ciblés, absence de popup étudiant, lecture visible et pause derrière une fenêtre, reprise après indisponibilité de destination. |
| Organisation et upload | 8 scénarios réussis sur le build : modules anciens, pagination 24 cartes, dépôts multiples et uniques, chapitres requis/conflits, pièces jointes hors bibliothèque, reprise partielle et noms spéciaux. |
| `git diff --check` | Réussi. |

Les premières exécutions simultanées avaient provoqué des délais de chargement dans les suites, notamment du lecteur PDF. Les suites concernées ont été relancées après échauffement avec une concurrence limitée. Le défaut de fixture qui refusait le nouveau `/api/messages/read` a été corrigé ; il ne constituait pas un défaut de l’interface. Le redémarrage de Vite pendant les builds préparatoires a interrompu un autre passage : la matrice finale est exécutée sur un serveur de preview stable. Le premier passage d’intégration a révélé le véritable défaut Analytics décrit plus haut ; après correction et délai d’assertion adapté aux rechargements PostgreSQL, les dix parcours ont réussi sans erreur JavaScript.

Aucun échec ne reste dans les suites finales exécutées. Les passages interrompus ou défaillants ont été distingués des résultats finaux et les défauts révélés ont été corrigés.

Les preuves locales sont dans `test-results/` : `frontend-consistency/`, `frontend-shell-phase1/`, `frontend-admin-phase1/`, `library-phase1/`, `phase1/`, `labs-availability/`, `community-keyboard/`, ainsi que les rapports lecteur, Forum, intégration et upload. Le diagnostic de production est dans `static-analytics-diagnostic/report.json`. Les captures sont des artefacts locaux ignorés par Git. Certains screenshots pleine page recollent une barre fixe au milieu de l’image lorsque la page avait défilé ; les mesures portent sur le viewport réel.

## 7. Limites et points non validés

- Aucun essai avec compte réel, fournisseur Neon Auth réel, upload R2 réel ou données étudiantes réelles : choix explicite de l’utilisateur.
- Smartphones et tablettes émulés dans le navigateur ; le clavier système, Safari/iOS natif, appareils physiques et lecteurs d’écran réels ne sont pas certifiés par ces tests.
- Les anciennes suites du prototype basées sur une session localStorage ne représentent plus l’authentification actuelle. Leurs attentes de cartes/chapitres ont été adaptées là où nécessaire ; elles ne sont pas comptées comme suites fonctionnelles validées.
- Le build signale encore des directives de dépendances ignorées et un bloc Labs dépassant 500 ko. La préparation des moteurs est différée ; cette phase ne remplace pas l’architecture du moteur.
- Plusieurs dépôts d’un même utilisateur avec exactement le même chemin forment un même dossier logique, faute d’identité persistante du dépôt/dossier.
- Les nouvelles fonctions serveur demandées restent explicitement absentes ou inactives, comme décrit ci-dessous.

## 8. Dépendances backend pour une phase ultérieure

1. **Session Feedback attribuée exclusivement** : acceptation atomique par le premier administrateur autorisé, refus des acceptations concurrentes, identité du responsable et clôture. Les statuts de tickets existants ne constituent pas cette réservation.
2. **Réactions d’assistance** : persistance et droits des « J’aime » / « J’adore » sur les messages privés. Aucun compteur fictif n’a été ajouté.
3. **Délégation de validation des admissions** : le serveur réserve actuellement cette opération au propriétaire ; aucune capacité spécifique délégable n’existe dans le contrat courant. Les interfaces ne prétendent pas l’accorder.
4. **Dossiers persistants** : identité des dossiers et dépôts, dossiers vides, création de sous-dossiers, droits du propriétaire sur les ajouts et signalement d’un dossier comme entité. Le signalement d’un document mal classé utilise déjà le lecteur et son API existante.
5. **Lecture en masse des notifications** : définir l’action explicite et son endpoint, en cohérence avec le cycle de consultation actuel. La route actuelle refuse une lecture globale ; le bouton reste désactivé.

Aucun de ces points n’a été contourné avec une simulation présentée comme opérationnelle. La Phase 2 n’a pas été engagée.
