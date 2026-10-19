# Campus Feedback — suppression des sessions résolues

Le bouton **Clôturer la conversation** conserve l’historique. Un bouton distinct **Terminer et supprimer**, ou **Supprimer la conversation** après clôture, permet désormais de libérer les données d’une session choisie. Une confirmation explicite précède cette opération irréversible.

## Comportement livré

- Suppression de la demande, des réponses, des réactions, des métadonnées et objets des pièces jointes détenus par l’application, ainsi que des notifications liées et de leurs visites.
- Remplacement des événements administratifs de la demande par un seul reçu sans contenu : acteur, identifiant de demande et nombres de messages/fichiers. Les conversations ne sont donc pas conservées dans le journal d’audit.
- Autorisation vérifiée côté serveur : administrateur assigné ayant encore `feedback.manage` dans le périmètre concerné, ou propriétaire. Le propriétaire peut également supprimer une ancienne demande sans assignation. Un étudiant ou un autre administrateur ne peut pas l’effacer.
- Mise à jour des autres sessions sans rechargement. Une conversation supprimée affiche un état indisponible ; un invité revient au formulaire d’assistance et son ancien accès ne récupère plus la demande.
- Bouton et confirmation adaptés aux petits écrans ; erreur de nettoyage conservée à l’écran pour permettre une nouvelle tentative.

## Échec du stockage et limites

La clôture est validée avant le nettoyage. Si le stockage échoue, la demande reste clôturée, ses clés sont conservées et le serveur renvoie une erreur. Une suppression partielle de fichiers peut rendre un premier fichier indisponible avant la fin du nettoyage ; réessayer termine la suppression, y compris si un objet a déjà disparu. Aucune réussite n’est annoncée avant la fin de l’opération.

Les protections existantes des objets importés restent actives : les objets appartenant au stockage d’origine ne sont pas effacés. Cette action retire les données actives de l’application ; elle ne réécrit pas les sauvegardes préexistantes du fournisseur ou les fichiers de sauvegarde locaux. Aucune migration supplémentaire ni purge automatique n’est ajoutée.

## Vérifications

- `npm run test:feedback-deletion` : 6 scénarios API réussis, couvrant nettoyage complet, isolation des droits, panne partielle et nouvelle tentative, demandes interfacultés, assistance publique et concurrence entre réponse et suppression.
- Nouvelle exécution ciblée du scénario des droits après ajout du nettoyage des anciennes demandes résolues sans assignation : réussite.
- Régression ciblée de `backend-audit-next.test.mjs` et `backend-core-permissions.test.mjs` : 6 scénarios réussis, couvrant acceptation exclusive, reprise d’une demande publique, identité connectée, lectures explicites, confidentialité des fichiers et revalidation des droits lors du stockage. Exécution séquentielle terminée avec code 0.
- `npm run build` : réussite ; avertissement existant sur la taille de certains bundles.
- `npm run test:feedback-deletion-ui` : 4 scénarios réussis avec la véritable API et le frontend compilé, dont annulation, suppression active et clôturée, synchronisation de l’étudiant, erreur de stockage et récupération d’un invité.
- Captures examinées à 320 et 390 pixels ; scénario PC à 1280 pixels. Résultats et captures : `test-results/feedback-deletion/` (artefacts locaux).

Les tests créent uniquement des schémas PostgreSQL aléatoires `campuslink_test_<uuid>`, avec identité et stockage simulés, puis les suppriment. Aucun compte réel, objet R2 réel ou fichier de sauvegarde réel n’est modifié par ces tests.

L’aperçu isolé a été relancé avec le serveur à jour sur `http://localhost:5190` ; la page répond HTTP 200. Ces vérifications ne valident pas l’état du déploiement en production.
