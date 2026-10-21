# CampusLink Taza — aperçu intégré et ouverture externe

Cette règle remplace la politique d’ouverture native systématique décrite dans le rapport du 19 octobre.

## Comportement

- Sur ordinateur et tablette, l’ouverture habituelle affiche le **lecteur natif du navigateur dans une iframe**, à l’intérieur du site. Les commandes PDF appartiennent au navigateur ; aucun canvas PDF.js ni outil de notre lecteur ne se charge pour cette ouverture. Le bouton **Ouvrir dans un nouvel onglet** reste visible et conserve la version ainsi que la page initialement demandée. Les déplacements effectués ensuite dans la barre privée du navigateur ne sont pas accessibles à l’application.
- Sur téléphone, y compris en paysage avec un pointeur tactile, l’ouverture habituelle passe directement au fichier externe. Un lien direct vers une page/version remplace la destination courante sans multiplier les onglets.
- Les pièces jointes des discussions suivent la même règle : lecteur du navigateur intégré et bouton externe sur ordinateur/tablette, ouverture externe automatique sur téléphone. La barre native du PDF reste disponible.
- L’action volontaire **Outils d’étude** conserve le lecteur d’étude existant avec notes et comparaisons sur tous les appareils. Sans connexion, les PDF explicitement enregistrés restent accessibles dans le lecteur privé existant ; aucun onglet réseau inutilisable n’est ouvert.

Une lecture des métadonnées contrôle l’accès et le format de la version sélectionnée avant d’intégrer le fichier. Les PDF et images compatibles sont chargés directement depuis l’endpoint authentifié. Le texte et le code utilisent le lecteur texte du navigateur dans une iframe sandboxée, avec un Blob `text/plain;charset=utf-8` limité à 2 Mo et révoqué à la fermeture. Les formats bureautiques non pris en charge proposent l’ouverture externe ou le téléchargement, sans lancer de téléchargement automatique dans une iframe.

Les points d’ouverture de la bibliothèque, de la recherche, des annonces, des compléments et des sources passent par la décision partagée. Les cartes gardent de véritables liens pour les actions du navigateur, notamment Ctrl/Cmd + clic. L’historique reste enregistré.

L’ouverture externe utilise les endpoints authentifiés `/api/files/:id` et `/api/reading/:id/file?version=…#page=…`. Les contrôles d’accès, plages HTTP, versions, durées d’accès hors ligne et téléchargements explicites restent appliqués. Les formats servis en pièce jointe par le serveur, notamment certains fichiers texte/code ou bureautiques, peuvent être téléchargés par le navigateur au lieu d’être affichés ; les en-têtes du serveur n’ont pas été affaiblis pour forcer leur affichage.

Pour les fichiers locaux sélectionnés dans une discussion, le Blob de prévisualisation reçoit un type déterminé par l’extension. HTML, SVG et les sources sont affichés comme texte inerte ; PDF et images matricielles gardent leur type de prévisualisation. Le fichier original, ses octets et son type restent disponibles sans modification pour l’envoi.

## Vérification

Tous les essais utilisent des API interceptées ou des schémas PostgreSQL jetables avec identité et stockage simulés. Aucun compte réel, objet de stockage réel ou sauvegarde n’a été modifié.

| Vérification | Résultat |
| --- | --- |
| Routage navigateur isolé, thèmes clair/sombre, tablette, téléphone portrait/paysage, texte, discussions et hors ligne | 13 scénarios réussis |
| Fichiers locaux HTML/SVG inertes et PDF avec un type déclaré incorrect | 3 scénarios réussis |
| Refus des métadonnées puis reprise, HTML historique inerte, DOCX sans téléchargement automatique et accès clavier au lecteur | 3 scénarios réussis |
| Liens vers une page/version précise : même source dans l’iframe et le nouvel onglet | Réussite |
| Véritable API isolée et Chromium avec fenêtre : 320, 390, 768, 1024 et 1920 px, liens directs, droits, plages, téléchargements, texte et hors ligne | 11 scénarios réussis, aucune erreur navigateur |
| Lecteur intégré : défilement, recherche, notes, comparaison, reprise et erreurs | 6 scénarios réussis |
| Replis du lecteur : PDF scannés, texte indisponible, RTL et reprise après échec | 7 scénarios réussis |
| Compilation Vite sous Node 22 et `git diff --check` | Réussite |

Le lecteur natif Chromium a atteint 100 % de chargement pour les cinq largeurs : en ouverture externe sur téléphone et directement dans l’iframe sur tablette/ordinateur. Les captures du cadre ont aussi été examinées sur ordinateur sombre et tablette claire. Les ouvertures habituelles ne chargent pas PDF.js et n’écrivent pas de position d’étude. Le scénario des pièces jointes sur téléphone a été rejoué après la normalisation des Blobs locaux.

Commandes : `npm run test:document-preview-routing`, `CAMPUS_PDF_HEADED=1 xvfb-run -a npm run test:responsive-native-pdf`, `npm run test:reader-workspace`, `npm run test:reader-fallback`, `npm run build`. Les scripts à API interceptées utilisent `CAMPUSLINK_TEST_URL` pour viser Vite local. Le script avec API réelle crée et supprime son schéma de test isolé.

Artefacts locaux : `test-results/document-preview-routing/verified-summary.json`, les rapports ciblés du même dossier et `test-results/responsive-native-pdf/results-PDF-opens-Deep-PDF-Non-PDF-PDF-permissions-Notes-and-study-offline-PDFs.json`. Ces vérifications ne constituent pas une validation du déploiement en production.
