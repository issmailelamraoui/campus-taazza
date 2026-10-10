import { pathToFileURL } from 'node:url';
import { digest, openDatabase } from './db.js';
import { getFilieres, getChatSemester } from '../shared/studies.js';
import { applyStudentCommunityProfiles } from './community-profiles.js';
import { resolveModule } from './modules.js';

export const FACULTIES = [
  { id: 'flaa', code: 'FLAA', name: 'Faculté des Langues, des Lettres et des Arts', arabic: 'كلية اللغات والآداب والفنون تازة', description: 'Un espace privé pour les lettres, les langues et la création. Ensemble, étudions, partageons et préparons notre avenir.', icon: 'book', color: 'gold', members: 1248 },
  { id: 'feg', code: 'FEG', name: 'Faculté d’Économie et de Gestion', arabic: 'كلية الاقتصاد والتدبير تازة', description: 'Le rendez-vous des étudiants en économie et gestion : ressources, échanges et projets.', icon: 'chart', color: 'purple', members: 986 },
  { id: 'fsjp', code: 'FSJP', name: 'Faculté des Sciences Juridiques et Politiques', arabic: 'كلية العلوم القانونية والسياسية تازة', description: 'Des ressources et une communauté pour comprendre le droit et les sciences politiques.', icon: 'scale', color: 'gold', members: 1120 },
  { id: 'fsa', code: 'FSA', name: 'Faculté des Sciences Appliquées', arabic: 'كلية العلوم التطبيقية تازة', description: 'Sciences, expérimentation et entraide au sein de votre communauté étudiante.', icon: 'atom', color: 'green', members: 1432 },
];

// A small, valid PDF, generated locally. These are clearly labelled learning
// examples rather than attributed university course materials.
export function makePdf(title, lines) {
  const ascii = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '-').replace(/[\\()]/g, '\\$&');
  const content = `BT /F1 18 Tf 50 790 Td (${ascii(title).slice(0, 72)}) Tj /F1 11 Tf 0 -34 Td ` +
    ['CampusLink Taza - Document pedagogique de demonstration', ...lines, '', 'Ce support illustre la plateforme. Verifiez les consignes de votre enseignant.'].map((line, i) => `${i ? '0 -22 Td ' : ''}(${ascii(line).slice(0, 94)}) Tj`).join(' ') + ' ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function seedCommand() {
  const db = await openDatabase({ schema: process.env.CAMPUS_DB_SCHEMA || 'campuslink' });
  let storage;
  try {
    const demo = process.argv.includes('--demo');
    if (demo) storage = (await import('./storage.js')).createStorage();
    await seedDatabase(db, { demo, storage });
    console.log(JSON.stringify({ ok: true, referenceDataSeeded: true, demo }));
  } finally { await db.close(); storage?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedCommand().catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || 'SEED_FAILED' })); process.exitCode = 1; });
}

export async function seedDatabase(db, options = {}) {
  await db.transaction(async () => {
    const addFaculty = db.prepare('INSERT INTO faculties (id,code,name,arabic,description,icon,color,members) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
    for (const f of FACULTIES) await addFaculty.run(f.id, f.code, f.name, f.arabic, f.description, f.icon, f.color, f.members);
    for (const faculty of FACULTIES) for (const filiere of getFilieres(faculty.id)) {
      await db.prepare('INSERT INTO filieres (id,faculty_id,name) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING').run(filiere.id, faculty.id, filiere.name);
    }
    for (let semester = 1; semester <= 6; semester++) await db.prepare('INSERT INTO semesters (id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING').run(semester, `S${semester}`);
    const channels = {
      general: ['Chat général', 'Échanges autour des cours et de la vie universitaire.'],
      filiere: ['Chats de filière', 'Échanges de votre filière par semestre.'],
      important: ['Discussions importantes', 'Informations prioritaires et échéances à retenir.'],
    };
    for (const faculty of FACULTIES) for (const [id, [name, description]] of Object.entries(channels)) {
      await db.prepare('INSERT INTO channels (id,faculty_id,name,description) VALUES (?,?,?,?) ON CONFLICT(id,faculty_id) DO NOTHING').run(id, faculty.id, name, description);
    }
  });
  if (!options.demo || (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n) return;
  if (!options.storage) throw new Error('Demo resources require configured private storage.');
  const { resourceObjectKey } = await import('./storage.js');
  const uploaded = [];
  try {
  await db.transaction(async () => {
    const addUser = db.prepare('INSERT INTO users (id,username,name,role,faculty_id,last_seen,filiere_id,current_semester,disabled) VALUES (?,?,?,?,?,?,?,?,?)');
    const people = [
      [1, 'ismail', 'Ismail', 'student', null],
      [2, 'admin', 'Issmail', 'global_admin', 'fsa'],
      [3, 'yassine', 'Yassine', 'student', 'flaa'],
      [4, 'sara', 'Sara', 'student', 'flaa'],
      [5, 'omar', 'Omar', 'student', 'flaa'],
      [6, 'amina', 'Amina', 'moderator', 'flaa'],
      [7, 'professeure', 'Ancien membre', 'faculty_admin', 'flaa'],
      [8, 'nour', 'Nour', 'student', 'flaa'],
      [9, 'hamza', 'Hamza', 'student', 'feg'],
      [10, 'salma', 'Salma', 'faculty_admin', 'feg'],
      [11, 'soufiane', 'Soufiane', 'student', 'fsjp'],
      [12, 'meryem', 'Meryem', 'student', 'fsa'],
    ];
    for (const [id, username, name, role, faculty] of people) {
      const filiere=faculty?(username==='admin'?'data_science':username==='nour'?'arabic_studies':getFilieres(faculty)[0].id):null;
      await addUser.run(id, username, name, role, faculty, faculty === 'flaa' ? '2026-10-02T10:15:00.000Z' : '2026-10-01T08:00:00.000Z',filiere,username==='nour'?3:1,username==='professeure'?1:0);
      if (['ismail', 'yassine', 'sara', 'omar', 'admin'].includes(username)) await db.prepare('UPDATE users SET avatar=? WHERE id=?').run(`/avatars/${username}.jpg`, id);
    }
    const insertMessage = db.prepare('INSERT INTO messages (faculty_id,channel,content,author_id,created_at,reply_to,pinned,filiere_id,semester) VALUES (?,?,?,?,?,?,?,?,?)');
    const msg = async (faculty, channel, content, author, date, reply = null, pinned = 0,semester=1) => (await insertMessage.run(faculty, channel, content, author, date, reply, pinned,channel==='filiere'?(await db.prepare('SELECT filiere_id FROM users WHERE id=?').get(author)).filiere_id:null,channel==='filiere'?getChatSemester(semester):null)).lastInsertRowid;
    const welcome = await msg('flaa', 'general', 'Bienvenue dans l’espace de la Faculté des Langues, des Lettres et des Arts ! Cet espace est réservé aux étudiants de la FLAA. Pour toute question, contactez l’administration.', 2, '2026-10-02T08:12:00.000Z', null, 1);
    const yassine = await msg('flaa', 'general', 'Salut tout le monde ! Est-ce que quelqu’un peut m’expliquer comment construire le plan d’une analyse littéraire ? Je ne comprends pas bien la différence entre thème et problématique.', 3, '2026-10-02T09:24:00.000Z');
    const sara = await msg('flaa', 'general', 'Je partage ici un résumé du chapitre sur le mouvement romantique. Bon courage à tous !', 4, '2026-10-02T10:03:00.000Z');
    await msg('flaa', 'general', 'Merci beaucoup Sara ! Ça m’aide vraiment. Pour le plan : commence par une problématique, puis relie chaque argument à une citation.', 5, '2026-10-02T10:28:00.000Z', sara);
    const reminder = await msg('flaa', 'general', 'Rappel important : les cours, exercices et examens sont disponibles dans la section Ressources. Pour toute question liée à l’accès ou à la sortie de cet espace, veuillez contacter l’administration.', 2, '2026-10-02T11:01:00.000Z', null, 1);
    await msg('flaa', 'important', 'Examens normaux S1 : la session commence le 15 octobre. Pensez à vérifier votre convocation et à apporter votre carte étudiante. Consultez les annonces de la faculté.', 7, '2026-10-01T14:00:00.000Z', null, 1);
    await msg('flaa', 'important', 'Les groupes de travail pour la méthodologie sont ouverts. Déposez votre proposition de sujet avant le 12 octobre, à 18 h.', 6, '2026-10-02T07:30:00.000Z');
    await msg('flaa', 'help', 'Quelqu’un souhaite réviser la linguistique avec moi vendredi à la bibliothèque ? Nous pourrions comparer nos exercices de phonétique.', 8, '2026-10-01T15:40:00.000Z');
    await msg('flaa', 'help', 'Je peux venir à 15 h. J’apporterai les fiches de transcription phonétique.', 4, '2026-10-02T08:05:00.000Z');
    await msg('flaa', 'life', 'Le club de lecture reprend mercredi ! Au programme : poésie et rencontres littéraires. Rendez-vous dans la salle des associations à 16 h.', 6, '2026-10-01T16:00:00.000Z');
    await msg('feg', 'general', 'Bienvenue dans notre espace économie et gestion. Les supports de comptabilité sont disponibles en S1.', 10, '2026-10-01T08:00:00.000Z');
    await msg('fsjp', 'general', 'Échangeons autour de la méthodologie juridique et du droit constitutionnel.', 11, '2026-10-01T08:00:00.000Z');
    await msg('fsa', 'general', 'Bienvenue aux nouveaux étudiants des sciences appliquées.', 12, '2026-10-01T08:00:00.000Z');
    const entries = [
      ['flaa', 'Résumé du romantisme', 'courses', 2, 'Littérature française', 4, sara, ['Le romantisme valorise la sensibilite, la nature et le moi.', 'Reperez les images, le rythme et les contrastes dans le texte.', 'Question : comment le paysage reflete-t-il la voix poetique ?']],
      ['flaa', 'Méthodologie de l’analyse littéraire', 'courses', 1, 'Méthodologie', 7, yassine, ['1. Situer le texte et son auteur.', '2. Formuler une problematique et un plan en deux ou trois axes.', '3. Appuyer chaque argument sur une citation commentee.']],
      ['flaa', 'Introduction à la linguistique', 'courses', 1, 'Linguistique', 7, null, ['Langue, parole et signe linguistique : trois notions essentielles.', 'Le signifiant designe la forme, le signifie le concept.', 'Exemple : comparez un mot, son contexte et son referent.']],
      ['flaa', 'La poésie moderne : formes et voix', 'courses', 3, 'Poésie', 7, null, ['Le vers libre renouvelle le rythme poetique.', 'Etudiez les repetitions, les silences et les ruptures.', 'Proposez une lecture de la relation entre forme et sens.']],
      ['flaa', 'Théâtre : texte et représentation', 'courses', 4, 'Théâtre', 7, null, ['Les didascalies orientent le jeu et la mise en scene.', 'Relevez les rapports de force dans un dialogue.', 'Comparez votre analyse a une representation en classe.']],
      ['flaa', 'Critique littéraire : les approches', 'courses', 5, 'Critique littéraire', 7, null, ['Approches historique, thematique et narratologique.', 'Identifiez les outils utiles a votre corpus.', 'Explicitez toujours les limites de votre interpretation.']],
      ['flaa', 'Guide du projet de fin d’études', 'courses', 6, 'Projet de fin d’études', 7, null, ['Definir un corpus limite et une question precise.', 'Construire une bibliographie et citer les sources.', 'Planifier les etapes de recherche avec votre encadrant.']],
      ['flaa', 'Exercices de phonétique · série 01', 'exercises', 1, 'Linguistique', 4, null, ['Exercice 1 : distinguez voyelles orales et nasales.', 'Exercice 2 : proposez une transcription phonetique.', 'Corrige : justifiez chaque symbole a partir de votre prononciation.']],
      ['flaa', 'Commentaire composé · corrigé', 'exercises', 2, 'Littérature française', 6, null, ['Sujet : analyser une description de paysage romantique.', 'Construisez une problematique et deux axes argumentes.', 'Corrige indicatif : paysage sensible puis expression du moi.']],
      ['flaa', 'Figures de style · entraînement', 'exercises', 3, 'Poésie', 7, null, ['Reperez metaphore, comparaison et anaphore.', 'Expliquez leur effet dans un court passage poetique.', 'Le nom de la figure seul ne suffit pas : interpretez son usage.']],
      ['flaa', 'Examen de linguistique · 2025', 'exams', 1, 'Linguistique', 7, null, ['Sujet d entrainement - session illustrative 2025.', '1. Definissez langue et parole. 2. Analysez un signe linguistique.', '3. Proposez une transcription et justifiez vos choix.']],
      ['flaa', 'Littérature française · sujet 2025', 'exams', 2, 'Littérature française', 7, null, ['Sujet d entrainement : commentaire d un extrait romantique.', 'Duree conseillee : 2 heures.', 'Construisez une introduction, un developpement et une conclusion.']],
      ['flaa', 'Rattrapage · méthodologie 2025', 'rattrapage', 1, 'Méthodologie', 7, null, ['Sujet de rattrapage illustratif.', 'Proposez une problematique a partir d un extrait litteraire.', 'Presentez un plan detaille en justifiant vos axes.']],
      ['flaa', 'Rattrapage · théâtre 2025', 'rattrapage', 4, 'Théâtre', 7, null, ['Sujet de rattrapage illustratif : dialogue et conflit.', 'Analysez les enjeux d une scene de confrontation.', 'Comment les didascalies participent-elles au sens ?']],
      ['feg', 'Comptabilité générale · notions', 'courses', 1, 'Comptabilité', 10, null, ['Actif, passif et resultat : les bases du bilan.', 'Exercice : classez cinq operations comptables.', 'Document de demonstration pour cette faculte uniquement.']],
      ['fsjp', 'Introduction au droit', 'courses', 1, 'Droit constitutionnel', 11, null, ['La regle de droit et ses caracteres.', 'Sources du droit et hierarchie des normes.', 'Document de demonstration pour cette faculte uniquement.']],
      ['fsa', 'Analyse numérique · introduction', 'courses', 3, 'Analyse numérique', 12, null, ['Approximation et erreurs numeriques.', 'La methode de dichotomie pour chercher une racine.', 'Document de demonstration pour cette faculte uniquement.']],
    ];
    const addResource = db.prepare('INSERT INTO resources (faculty_id,title,filename,stored_name,object_key,sha256,category,semester,module,module_id,author_id,created_at,size,mime,downloads,views,message_id,channel,status,filiere_id,resource_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const [i, [faculty, title, category, semester, module, author, existingMessage, lines]] of entries.entries()) {
      const date = existingMessage===sara ? '2026-10-02T10:03:00.000Z' : `2026-09-${String(21 + i % 10).padStart(2, '0')}T${String(8 + i % 7).padStart(2, '0')}:00:00.000Z`;
      const messageId = existingMessage || await msg(faculty, 'general', `Je partage « ${title} » pour les révisions. Vous le retrouverez aussi dans les ressources de S${semester}.`, author, date,null,0,semester);
      const filename = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '_') + '.pdf';
      const pdf = makePdf(title, lines);
      const filiere = getFilieres(faculty)[0].id;
      const { id: moduleId } = await resolveModule(db, { facultyId: faculty, filiereId: filiere, semester, name: module });
      const stored = resourceObjectKey({ filiereId: filiere, semester, moduleId, filename });
      uploaded.push(stored);
      await options.storage.put(stored, pdf, 'application/pdf');
      const id = (await addResource.run(faculty, title, filename, stored, stored, digest(pdf), category, semester, module, moduleId, author, date, pdf.length, 'application/pdf', 8 + i * 3, 22 + i * 4, messageId, 'general', i === 8 ? 'corrected' : i < 3 ? 'new' : 'popular',filiere,category)).lastInsertRowid;
      await db.prepare('UPDATE messages SET resource_id=? WHERE id=?').run(id, messageId);
    }
    await msg('flaa','filiere','Bienvenue dans les échanges de votre filière pour S1. Partageons nos questions et nos méthodes de révision.',3,'2026-10-02T09:00:00.000Z',null,0,1);
    await msg('flaa','filiere','Qui souhaite comparer ses notes de lecture dans le chat S3 ?',4,'2026-10-02T09:30:00.000Z',null,0,3);
    await msg('flaa','filiere','Le chat S5 permet de discuter des projets et de préparer la fin du parcours.',3,'2026-10-02T10:00:00.000Z',null,0,5);
    const addAnnouncement = db.prepare('INSERT INTO announcements (faculty_id,content,message_id,channel,author_id,created_at,resource_id,pinned) VALUES (?,?,?,?,?,?,?,?)');
    for (const id of [welcome, reminder, 6]) {
      const row = await db.prepare('SELECT * FROM messages WHERE id=?').get(id);
      await addAnnouncement.run(row.faculty_id, row.content, id, row.channel, row.author_id, row.created_at, row.resource_id, 1);
    }
    await addAnnouncement.run('flaa', 'La bibliothèque universitaire ouvre ses espaces de travail de 8 h 30 à 18 h. Pensez à respecter les zones de silence et à présenter votre carte étudiante.', null, 'important', 7, '2026-10-01T09:00:00.000Z', null, 0);
    const addReaction = db.prepare('INSERT INTO reactions VALUES (?,?,?)');
    for (const reaction of [[yassine,4,'like'],[yassine,5,'like'],[yassine,6,'heart'],[sara,3,'like'],[sara,5,'heart'],[sara,6,'like'],[sara,8,'like'],[reminder,3,'like'],[reminder,4,'like'],[reminder,5,'heart']]) await addReaction.run(...reaction);
    await db.prepare("SELECT setval(pg_get_serial_sequence('users','id'), (SELECT MAX(id) FROM users))").get();
    await applyStudentCommunityProfiles(db);
  });
  } catch (error) {
    await Promise.allSettled(uploaded.map(key => options.storage.delete(key)));
    throw error;
  }
}
