# CampusLink — UX et fiabilité, 16 octobre 2026

## Dépôts de 3 à 20 Mio

Le serveur acceptait 20 Mio via Multer mais les fonctions Vercel limitent le corps de chaque requête à 4,5 Mo. Augmenter Multer ne suffit donc pas. Le nouveau transport garde les petites requêtes multipart et découpe les plus gros fichiers en objets privés de 2 Mio, deux requêtes au maximum simultanément. Il couvre la bibliothèque, les pièces de discussion, les remplacements administratifs, le feedback, les corrections privées, les compléments et le forum. La photo de profil conserve son circuit dédié.

La création possède un identifiant client stable ; la même pièce peut être renvoyée sans créer un nouvel objet. Les morceaux reçus sont contrôlés par taille et SHA-256. Un morceau corrompu est invalidé puis renvoyé lors de la reprise. Le serveur assemble au maximum 20 Mio et repasse dans la route d’origine, avec les contrôles de permissions et de session rafraîchis après l’assemblage. Les signatures de fichiers, quotas, restrictions de faculté/filière et règles propres à chaque destination restent appliqués.

La publication et son reçu sont dans la même transaction PostgreSQL. Les appels de finalisation concurrents se sérialisent sur le dépôt et renvoient le reçu enregistré. En cas d’acquittement COMMIT perdu, le serveur reprend le verrou pour déterminer le résultat avant de supprimer un objet. Les événements de rafraîchissement ne sont envoyés qu’après le COMMIT. Les créations de fichiers compensées après un échec ne laissent aucune métadonnée publiée. Un échec terminal permet une nouvelle tentative explicite ; une réussite reste rejouable sans second dépôt.

Les morceaux privés expirent après une heure ; les reçus sont conservés 24 heures. Le nettoyage est opportuniste au prochain démarrage d’un dépôt, avec un petit lot borné et reprise des suppressions ratées. Il ne constitue pas un nettoyage planifié en l’absence de trafic. Les connexions R2 ont une échéance de 30 secondes ; la lecture de chaque morceau est limitée à 15 secondes et l’assemblage complet à 30 secondes. Une lecture bloquée détruit son flux et libère la transaction.

Sources de la contrainte d’hébergement : [Vercel FUNCTION_PAYLOAD_TOO_LARGE](https://vercel.com/docs/errors/function_payload_too_large), [limites des fonctions](https://vercel.com/docs/functions/limitations).

## Navigation et lecture

Le bref « Réessayer » venait du composant de session utilisé comme fallback des pages différées, alors que l’authentification avait fini de charger. Une attente de page possède désormais son propre état neutre. Un Suspense interne conserve l’en-tête et la navigation pendant le chargement du module de page. Les véritables erreurs de session gardent leur récupération.

Le lecteur PDF défile naturellement entre les pages, avec des emplacements stables et des canevas montés uniquement près de la zone visible. Les flèches précédent/suivant ont disparu. L’icône de réglages rassemble zoom, notes, recherche, confort, fichiers et actions secondaires. La reprise conserve le numéro de page et son décalage local ; les annotations gardent la page réellement sélectionnée. Les changements rapides entre fermeture des notes et défilement ne réappliquent plus une ancienne restauration différée.

Les contrôles de fermeture utilisent un fond rouge discret. Les variables du thème clair donnent davantage de séparation au fond, aux panneaux et aux fichiers, en gardant la palette chaude existante.

## Modules et Labs

Le partage d’un module est accessible au clavier et par bouton, ainsi que par appui long tactile annulé lors d’un défilement. La discussion choisie reçoit une référence amovible dans son compositeur, indépendante du texte personnel. La référence persistée renvoie au bon semestre, y compris un semestre pair partagé dans un chat annuel. Le serveur valide les droits d’écriture et la provenance du document ; il refuse les métadonnées de portée fournies par le navigateur. Un destinataire d’une autre filière voit une référence indisponible sans obtenir d’accès aux fichiers.

Labs fournit une exécution réelle et une console pour JavaScript, Python, C et C++, ainsi qu’un formatage JSON. Voir [l’architecture, les limites et les licences](labs-runtime.md). Les moteurs n’augmentent pas la charge de la fonction serveur ; ils sont téléchargés à la première exécution du langage. Les compilations C++ et le premier téléchargement restent plus lourds sur les téléphones modestes.

## Vérification

Les suites API utilisent un PostgreSQL local avec schémas temporaires, identité et stockage explicitement injectés. Les tests de dépôts traversent un véritable proxy HTTP limité à 4,5 Mo : 3 Mio + 1 octet, 7 Mio et exactement 20 Mio, dépassement de limite, Unicode, corruption, permissions révoquées pendant l’assemblage, reprise après réponses perdues, finalisations concurrentes, acquittement COMMIT perdu, idempotence de création et événement SSE après reçu.

Les suites navigateur vérifient le lecteur dans Chromium et Firefox, les écrans de 320, 390, tablette, paysage et bureau, les thèmes clair/sombre et l’arabe. Un PDF de 60 pages reprend page 35 tout en gardant moins de huit canevas. La suite de partage utilise le vrai backend isolé et vérifie en plus le contraste des références envoyées. Les suites Labs vérifient de véritables stdout/stderr, erreurs, boucles infinies, arrêt, et le confinement de Python. Les rapports et captures sont dans `test-results/` (ignoré par Git).

Résultat de la suite complète : **391 tests réussis, aucun échec ni test ignoré**. Les migrations 029 et 030 ont également été appliquées au schéma configuré `campuslink_prj` ; l’inspection de disponibilité est prête, sans migration ou colonne manquante, et les nombres de comptes, messages et ressources existants sont inchangés.

Le serveur local démarre avec migration et seed désactivés après cette préparation, et `/api/health` renvoie `200 {"ok":true}` sur la base configurée. Les suites de permissions, d’identité et de fichiers continuent à utiliser uniquement les doubles et la base de test locale.
