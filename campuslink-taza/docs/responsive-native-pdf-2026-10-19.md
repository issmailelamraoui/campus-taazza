# CampusLink Taza — responsive, actions et ouverture native des PDF

## Corrections

Les détails d’un compte présentent maintenant l’identité et les informations dans une disposition compacte. Le pied de la fenêtre regroupe **Fermer** et **Modifier** ; les opérations de mot de passe, de nomination et de suppression restent accessibles dans **Autres actions sur le compte**, sans occuper plusieurs rangées en permanence. Les décisions de modération utilisent une grille régulière plutôt qu’un enchaînement de boutons de largeurs différentes. Les contrôles de permission et les confirmations existantes sont conservés.

Les boutons communs ont des espacements plus courts sur ordinateur. Les actions des formulaires de paramètres et des fenêtres ne sont plus étirées sans nécessité. Les pieds de fenêtres se replient sur toutes les largeurs et disposent d’un défilement limité si une erreur ou un libellé long occupe trop de place. Le contenu garde son propre défilement. Les actions de compte et les formulaires restent accessibles dans une fenêtre de seulement 320 × 300 pixels.

La gestion du clavier reste attachée à la fenêtre supérieure même si le navigateur retire le focus d’un bouton désactivé pendant l’enregistrement. **Escape** fonctionne alors encore, et **Tab** ramène le focus dans la fenêtre. Les listes de sélection gardent leur propre gestion d’Escape et les fenêtres sous-jacentes ne sont pas fermées simultanément.

Les régions tactiles des commandes concernées atteignent 44 pixels sur petit écran : cartes de documents, étude, pièces jointes du forum, compléments, propositions de correction, relations entre documents, recherche PDF, tableurs, administration et Labs. Les fenêtres des outils d’étude suivent également la hauteur réellement disponible quand le clavier réduit la zone visible. Les discussions conservent leur organisation compacte et leurs commandes existantes.

Le partage de fichiers utilise deux sélecteurs alignés sur téléphone. Dès que des fichiers sont choisis, la grande zone de dépôt devient une barre compacte : la liste et l’étape suivante restent plus proches des commandes. Les boutons conservent leurs noms accessibles et ouvrent toujours les sélecteurs de fichiers et de dossiers. L’indication de lecture des dossiers reste disponible pendant cette opération.

## PDF

L’ouverture courante d’un PDF utilise directement `/api/files/:id`, avec les cookies de session et les autorisations du serveur. Les cartes proposent de véritables liens, sans attribut `download`, pour conserver les comportements du navigateur. Les autres points d’ouverture passent par la même décision centrale. Aucune préparation PDF.js ni récupération préalable du fichier dans un blob n’est nécessaire pour une consultation normale.

Les liens vers une page et une version utilisent `/api/reading/:id/file?version=…#page=…`. Une destination directe dans l’application est remplacée par le fichier : elle ne provoque pas une série de fenêtres ni une boucle de retour. L’écriture de l’historique continue lors de cette navigation. Un téléchargement explicite reste distinct, avec `?download=1`. Le serveur conserve ses réponses `inline`, le cache privé, les requêtes par plages, le contrôle de faculté/filière et le refus des sessions non authentifiées.

Les notes, repères, comparaisons et outils existants restent accessibles sur demande par l’icône **Outils d’étude** d’une carte. Le paramètre explicite `mode=study` ouvre aussi ces outils. Les tests de ces fonctions ont été adaptés à cette entrée volontaire. Les formats autres que PDF conservent leur aperçu existant. Les positions et récompenses propres aux outils d’étude ne sont pas simulées à partir du lecteur natif.

En absence de connexion, l’ouverture habituelle utilise le mécanisme de lecture hors ligne existant pour les copies enregistrées explicitement. Elle n’ouvre pas un onglet réseau inutilisable. La durée d’accès locale de 24 heures et la séparation par compte restent appliquées par ce mécanisme.

Le rendu du PDF, ses commandes de zoom et son défilement sont confiés au lecteur du navigateur ou de l’appareil. L’application ne déclenche pas de téléchargement lors d’une consultation ; les préférences personnelles du navigateur restent applicables.

## Vérification

Les essais emploient des réponses API interceptées ou des schémas PostgreSQL jetables `campuslink_test_<uuid>` avec identité et stockage simulés. Aucun compte réel, fichier R2 réel, sauvegarde ou schéma ordinaire n’est modifié. Les modifications Campus Feedback déjà présentes ont été préservées.

Résultats validés :

| Vérification | Résultat |
| --- | --- |
| Frontend général, deux séries de configurations | 199 + 105 = **304 contrôles réussis** |
| API réelle avec métadonnées isolées, fenêtres et PDF | **19 scénarios réussis**, regroupés depuis les exécutions ciblées |
| Lecteur d’étude : défilement, notes, recherche, comparaison, reprise et erreurs | **6 scénarios réussis** |
| Relations entre documents et droits de validation | **3 scénarios réussis** |
| Signets, annonces, modération et mises à jour après mutation | **4 scénarios réussis** |
| Suppression Campus Feedback sur PC, téléphone et pour un invité | **4 scénarios réussis** |
| Compilation Vite avec Node 22 et `git diff --check` | **Réussite** |

Le récapitulatif local est `test-results/responsive-native-pdf/verified-summary.json`. Le passage final vérifie aussi le vrai choix d’un fichier et d’un dossier temporaire, l’enregistrement puis l’ouverture sans réseau d’un PDF, et la récupération du focus avec Tab/Escape. Les fichiers sélectionnés dans le test des fenêtres ne sont pas envoyés au serveur.

- Contrôle général : 35 destinations par configuration, incluant bibliothèque, communauté, annonces, profil, paramètres, sauvegardes, étude et ses onglets, campus, Labs, feedback, permissions et les huit onglets d’administration. Pages publiques, inscription, affectation, attente de validation et changement obligatoire de mot de passe inclus.
- Configurations : 320, 390, 768, 1024, 1440 et 1920 pixels ; thèmes clair/sombre ; français, anglais et arabe. Les formulaires administratifs sont également vérifiés en paysage à 640 × 360 et avec une hauteur réduite à 300 pixels.
- Scénarios avec la véritable API : toutes les actions des détails de compte, annulation de la suppression, accès aux formulaires, ouverture native sans téléchargement, confidentialité et plages de fichiers, versions/pages, historique après navigation, aperçu texte et accès volontaire aux notes.
- Le rendu natif fait l’objet d’un passage Chromium avec fenêtre sous Xvfb, en attendant `loadState_ = success` et une progression de 100 %, puis capture de la page. Ce contrôle complète les assertions HTTP : une navigation vers un PDF en mode headless comporte des limites documentées dans [Playwright](https://playwright.dev/docs/api/class-page#page-goto).
- Artefacts locaux : `test-results/frontend-consistency/`, `test-results/responsive-native-pdf/` et les résultats du lecteur d’étude. Les images diagnostiques intermédiaires ne constituent pas les captures finales `native-320.png`, `native-390.png`, etc.

Commandes : `npm run build`, `npm run test:frontend-design`, `CAMPUS_DESIGN_SCOPE=additional npm run test:frontend-design`, `CAMPUS_PDF_HEADED=1 xvfb-run -a npm run test:responsive-native-pdf`, `npm run test:reader-workspace`. Pour les scripts à fixtures, `CAMPUSLINK_TEST_URL` doit viser l’aperçu local isolé ; les appels API sont interceptés.

Ces vérifications portent sur le code et les données de test isolées ; elles ne valident pas l’état du déploiement en production.
