# Récupération du mot de passe — 25 octobre 2026

`/forgot-password` propose Google ou un code envoyé au courrier universitaire. Le profil d’un compte académique utilise le même formulaire, avec une adresse liée au compte et non modifiable. L’écran de mot de passe temporaire permet également la récupération par code. Les comptes classiques avec une autre adresse conservent le changement avec le mot de passe actuel. Les mots de passe choisis acceptent au moins 8 caractères, y compris uniquement des chiffres ; le parcours OTP plafonne à 128 caractères. Aucune composition supplémentaire n’est imposée.

Le serveur valide exactement les domaines `ALLOWED_ACADEMIC_EMAIL_DOMAINS`, l’adresse du profil et son identité canonique. Un demandeur authentifié ne peut pas sélectionner un autre destinataire. Le démarrage renvoie la même réponse pour un compte inconnu ou désactivé, sans créer d’identité ni lui envoyer un email. Les limites par IP/adresse s’ajoutent aux protections du fournisseur. Les codes, mots de passe et tokens ne figurent ni dans les journaux, ni dans les opérations locales, ni dans les stockages du navigateur.

Le transport utilise les endpoints officiels Managed Neon `email-otp/request-password-reset`, `email-otp/check-verification-otp` et `email-otp/reset-password`. Le schéma OpenAPI du service configuré a été vérifié par GET. Aucun cookie applicatif n’est envoyé à ces endpoints et aucun cookie fournisseur n’est publié au navigateur. Le fournisseur vérifie et consomme le code ; une simple confirmation par email ne crée pas de session CampusLink.

Après validation préalable du code, une réservation est enregistrée dans `password_reset_operations` et la coupure des sessions locales est validée avant la mutation distante. Le verrou existant sérialise les demandes concurrentes et les réinitialisations administratives. Seul un succès explicite libère le compte et termine l’opération. Une réponse perdue ou un échec de finalisation conserve la restriction et la coupure : l’interface indique une issue incertaine, n’effectue aucune répétition automatique et propose de se reconnecter. Un nouveau code peut reprendre une réservation interrompue après deux minutes. Aucune migration supplémentaire n’est nécessaire.

Validation isolée, sans email ni modification d’un compte réel :

- 224 tests de transport Auth/Google/récupération réussis, sans échec ni test ignoré.
- 15 tests des routes de récupération réussis dans un schéma jetable d’une base de test indépendante, y compris un échec de base après succès du fournisseur.
- 57 tests Google réussis avec une base isolée, dont les drapeaux historiques faux, preuves falsifiées, domaines et conflits.
- 12 scénarios UI avec API simulée : 18 combinaisons de largeur (320/768/1280), langue (fr/en/ar) et thème, plus erreurs, doubles clics, restrictions, réponses perdues et changement des comptes classiques. Une régression supplémentaire confirme la redirection avec statut même si la fermeture de session démonte le formulaire avant sa réponse.
- Quatre contrôles du parcours réel navigateur → API Express → schéma PostgreSQL jetable : code incorrect sans mutation, choix d’un mot de passe de huit chiffres, opération confirmée, refus de l’ancien cookie/mot de passe et connexion avec le nouveau jusqu’à `/app`. Le changement depuis le profil confirme aussi la redirection après révocation vers une page de connexion avec message de succès persistant au rechargement. Seuls l’identité distante et l’envoi d’email sont simulés.
- Build Vite réussi sous Node 22.

Commandes : `npm run test:password-recovery-unit`, `npm run test:password-recovery-ui`, `npm run test:password-recovery-e2e`. Les tests d’intégration exigent `CAMPUS_TEST_DATABASE_URL` pointant vers une base indépendante ; ils ne doivent jamais utiliser la base de production. Les captures et journaux restent dans `test-results/`, exclus de Git.

Le blocage de certains premiers accès Google par Managed Neon reste distinct et documenté dans [le diagnostic Google](google-direct-login-2026-10-25.md). Les parcours simulés ne prouvent pas la livraison réelle d’un email ou l’accès Google de tous les comptes de production.

Référence : [Better Auth Email OTP](https://better-auth.com/docs/plugins/email-otp).
