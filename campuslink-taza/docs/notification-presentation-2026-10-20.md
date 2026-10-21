# Notifications : lisibilité et affichage responsive

Les notifications à l’arrivée partagent maintenant une surface opaque, une bordure visible et une ombre dédiée aux thèmes clair et sombre. Le contenu utilise une taille minimale de 14 px. Les boutons de fermeture ont une surface visible de 28 × 28 px et une icône de 16 px, avec une cible de 44 × 44 px sur écran tactile et 32 × 32 px sur PC. Leur couleur est neutre et s’accorde au thème. Le panneau de la cloche et la page des notifications bénéficient aussi du texte agrandi.

`NotificationCenter` regroupe les confirmations, les erreurs et les alertes administratives dans un portail global. Leur pile respecte la hauteur réellement visible, les encoches et le sens de lecture, y compris dans le chat avec le clavier ouvert et devant les fenêtres. Les textes longs et les alertes multiples défilent dans leur espace sans être supprimés du contenu. Les arrivées ne déplacent pas le focus de l’utilisateur.

Les confirmations restent au moins huit secondes, avec une durée adaptée au texte et une pause au survol, au focus ou lorsque l’onglet est masqué. Les erreurs restent affichées jusqu’à leur fermeture ou leur remplacement. Les messages temporaires sont effacés au changement de session.

Les droits, les critères d’éligibilité des alertes, les destinations et la politique de lecture des notifications restent ceux du serveur. Le scénario de régression historique a été actualisé pour simuler le contrat existant `POST /api/notifications/:id/read` lors d’un clic explicite ; il ne dépend plus des anciennes attentes de lecture au départ de la destination.

## Vérification

- `CAMPUSLINK_TEST_URL=http://127.0.0.1:5180 npm run test:notification-presentation` : **17 scénarios réussis**, couvrant les deux thèmes à 320, 390, 768 et 1440 px, l’arabe, le contenu long, les fenêtres, le chat/clavier, la durée de lecture, la navigation et les arrivées simultanées dans une petite fenêtre. Les **57 mesures de contraste** des textes contrôlés dépassent 4,5:1 ; le minimum mesuré est **5,20:1**.
- **4 scénarios réussis sur la compilation de production** : arrivée à 320 px sombre et 1440 px clair, erreur longue devant une fenêtre à 320 px, et chat avec clavier à 390 px. Le rapport distinct est `test-results/notification-presentation-production/report.json`.
- `CAMPUSLINK_TEST_URL=http://127.0.0.1:5180 npm run test:notifications-ui` : **12 groupes de scénarios réussis**, couvrant les destinations administratives, l’ouverture native du document source, la file d’alertes et les discussions.
- `npm run build` avec Node 22 et `git diff --check` : **réussite** ; avertissement existant sur la taille de certains bundles.

Toutes les requêtes API des scénarios navigateur sont interceptées et utilisent des données synthétiques. Aucun compte réel, aucune notification réelle ni aucun objet de stockage réel n’est modifié. Les rapports, mesures et captures sont des artefacts locaux dans `test-results/notification-presentation/` et `test-results/notifications/`.
