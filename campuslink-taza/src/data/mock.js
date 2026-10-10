import { FILIERES_BY_FACULTY } from './studies.js';
// Exact names extracted from the existing project's server/seed.js.
// No server module is imported or executed by this frontend.
export const FACULTIES = [
  {id:'flaa',code:'FLAA',name:'Faculté des Langues, des Lettres et des Arts',arabic:'كلية اللغات والآداب والفنون تازة'},
  {id:'feg',code:'FEG',name:'Faculté d’Économie et de Gestion',arabic:'كلية الاقتصاد والتدبير تازة'},
  {id:'fsjp',code:'FSJP',name:'Faculté des Sciences Juridiques et Politiques',arabic:'كلية العلوم القانونية والسياسية تازة'},
  {id:'fsa',code:'FSA',name:'Faculté des Sciences Appliquées',arabic:'كلية العلوم التطبيقية تازة'}
];
const moduleEntries = [
  ['flaa','french_studies',1,'Méthodologie'],['flaa','french_studies',1,'Linguistique'],
  ['flaa','french_studies',2,'Littérature française'],['flaa','french_studies',3,'Poésie'],
  ['flaa','french_studies',4,'Théâtre'],['flaa','french_studies',5,'Critique littéraire'],
  ['flaa','french_studies',6,'Projet de fin d’études'],['feg','economics',1,'Comptabilité'],
  ['fsjp','public_law',1,'Droit constitutionnel'],['fsa','information_systems',3,'Analyse numérique']
];
export const MODULES = moduleEntries.map(([facultyId,filiereId,semester,name],i)=>({id:`module-${i}`,facultyId,filiereId,semester,name}));
export const CHANNELS = [{id:'general',name:'Chat général'},{id:'important',name:'Discussions importantes'},{id:'filiere',name:'Chat de filière'}];
const resourceEntries = [
  ['Méthodologie de l’analyse littéraire',0,'courses',1,'Équipe pédagogique'],
  ['Introduction à la linguistique',1,'courses',1,'Équipe pédagogique'],
  ['Introduction à la linguistique',1,'courses',2,'Équipe pédagogique'],
  ['Exercices de phonétique · série 01',1,'exercises',null,'Sara Benali'],
  ['Examen de linguistique · 2025',1,'exams',null,'Équipe pédagogique'],
  ['Rattrapage · méthodologie 2025',0,'rattrapage',null,'Équipe pédagogique'],
  ['Méthodologie · travaux dirigés',0,'td',null,'Yassine El Amrani'],
  ['Phonétique · travaux pratiques',1,'tp',null,'Équipe pédagogique'],
  ['Exercices de phonétique · corrigé',1,'corrections',null,'Équipe pédagogique'],
  ['Résumé du romantisme',2,'courses',1,'Sara Benali'],
  ['Commentaire composé · corrigé',2,'corrections',null,'Yassine El Amrani'],
  ['Littérature française · sujet 2025',2,'exams',null,'Équipe pédagogique'],
  ['La poésie moderne : formes et voix',3,'courses',1,'Équipe pédagogique'],
  ['Figures de style · entraînement',3,'exercises',null,'Équipe pédagogique'],
  ['Théâtre : texte et représentation',4,'courses',1,'Équipe pédagogique'],
  ['Rattrapage · théâtre 2025',4,'rattrapage',null,'Équipe pédagogique'],
  ['Critique littéraire : les approches',5,'courses',1,'Équipe pédagogique'],
  ['Guide du projet de fin d’études',6,'courses',1,'Équipe pédagogique'],
  ['Comptabilité générale · notions',7,'courses',1,'Équipe pédagogique'],
  ['Introduction au droit',8,'courses',1,'Équipe pédagogique'],
  ['Analyse numérique · introduction',9,'courses',1,'Équipe pédagogique']
];
export const INITIAL_RESOURCES = resourceEntries.map(([title,index,category,part,author],i)=>{
  const m=MODULES[index];return {id:`doc-${i+1}`,title,originalName:`${title}${part ? ` · ${part}` : ''}.pdf`,module:m.name,semester:m.semester,category,part:part == null ? 'complete' : String(part),author,date:`2026-10-${String(7-(i%6)).padStart(2,'0')}T09:00:00Z`,size:`${(0.4+i%5*0.3).toFixed(1)} Mo`,fileType:'PDF',facultyId:m.facultyId,filiereId:m.filiereId,status:'approved',sample:true};
});
export const INITIAL_ANNOUNCEMENTS = FACULTIES.flatMap((f,i)=>[
  {id:`ann-${i}-1`,facultyId:f.id,filiereId:null,title:'Inscriptions pédagogiques · la campagne est ouverte',content:'Les inscriptions pédagogiques sont ouvertes pour les étudiants de S1, S3 et S5. Préparez votre carte étudiante et votre justificatif d’inscription. Rendez-vous auprès du service de scolarité avant le 12 octobre.\n\nCette annonce est un exemple de démonstration et ne constitue pas une consigne officielle de l’université.',author:'Service de scolarité',date:'2026-10-07T09:00:00Z',pinned:true,channel:'important',kind:'administration'},
  {id:`ann-${i}-2`,facultyId:f.id,filiereId:null,title:'Un nouvel espace pour réviser ensemble',content:'Retrouvez les groupes de révision dans le Chat de filière. Choisissez S1–S2, S3–S4 ou S5–S6 pour échanger sur votre année.\n\nInformation illustrative pour explorer le prototype.',author:'Équipe CampusLink',date:'2026-10-06T14:00:00Z',pinned:false,channel:'year-1',kind:'community'},
  {id:`ann-${i}-3`,facultyId:f.id,filiereId:null,title:'La bibliothèque vous accueille',content:'Les espaces de travail vous accueillent de 8 h 30 à 18 h. Pensez à présenter votre carte étudiante et à respecter les zones de silence.\n\nHoraires d’exemple : veuillez consulter les informations officielles de votre établissement.',author:'Bibliothèque universitaire',date:'2026-10-05T10:00:00Z',pinned:false,channel:'important',kind:'resources'}
]);
const sampleChat = [
  ['Sara Benali','sara','Bienvenue dans notre espace d’échange ! Vous pouvez retrouver les derniers documents dans la bibliothèque.','general',true],
  ['Yassine El Amrani','yassine','Quelqu’un souhaite préparer les révisions de cette semaine ensemble ?','help',false],
  ['Meryem Alaoui','meryem','Avec plaisir ! On peut commencer par comparer nos notes et les points à revoir.','help',false],
  ['Sara Benali','sara','J’ai partagé mes notes dans la bibliothèque. N’hésitez pas à poser vos questions ici.','help',false],
  ['Service de scolarité','scolarite','Pensez à consulter l’annonce sur les inscriptions pédagogiques. Ceci est un message de démonstration.','important',true],
  ['Yassine El Amrani','yassine','Une rencontre pour échanger autour de nos lectures, ça vous dit ?','life',false],
  ['Meryem Alaoui','meryem','Bienvenue dans le groupe de ce semestre. Partageons nos questions et nos méthodes de révision.','semester-1',true],
  ['Sara Benali','sara','Pour les étudiants de ce semestre, quels sujets souhaitez-vous approfondir ?','semester-3',false],
  ['Yassine El Amrani','yassine','Cet espace nous permet d’échanger et de préparer la suite de notre parcours.','semester-5',false]
];
// Preserve the original IDs: saved messages, notifications and old deep links
// continue to refer to the same conversations after the community redesign.
const LEGACY_MESSAGES = FACULTIES.flatMap(f=>FILIERES_BY_FACULTY[f.id].flatMap(p=>sampleChat.map(([author,username,content,channel,pinned],i)=>({id:`msg-${f.id}-${p.id}-${i}`,facultyId:f.id,filiereId:p.id,author,username,content,channel,pinned,date:`2026-10-07T${String(9+i).padStart(2,'0')}:15:00Z`}))));

const communityAuthors = {
 sara: { author: 'Sara Benali', username: 'sara.demo' },
 yassine: { author: 'Yassine El Amrani', username: 'yassine.demo' },
 meryem: { author: 'Meryem Alaoui', username: 'meryem.demo' },
 amine: { author: 'Amine Berrada', username: 'amine.demo' },
};
// These student exchanges describe everyday study habits, not an invented
// curriculum or official university instructions. Dates use Casablanca time.
const communityConversations = [
 { key: 'general-01', person: 'yassine', channel: 'general', date: '2026-10-06T17:32:00+01:00', content: 'Salut tout le monde ! Comment vous organisez vos révisions cette semaine ? J’essaie de trouver un rythme qui tient dans la durée.' },
 { key: 'general-02', person: 'yassine', channel: 'general', date: '2026-10-06T17:33:00+01:00', content: 'Pour l’instant, je garde trente minutes chaque soir pour relire mes notes. Ça m’évite de tout reprendre le week-end.' },
 { key: 'general-03', person: 'meryem', channel: 'general', date: '2026-10-06T17:35:00+01:00', replyKey: 'general-01', content: 'Même objectif ici ! Je note d’abord les trois points que je veux comprendre, puis je travaille sans changer de document toutes les cinq minutes.' },
 { key: 'general-04', person: 'sara', channel: 'general', date: '2026-10-06T17:36:00+01:00', content: 'J’ai commencé à faire des fiches très courtes : une idée, un exemple et une question à vérifier. C’est plus facile à relire.' },
 { key: 'general-05', person: 'sara', channel: 'general', date: '2026-10-06T17:37:00+01:00', content: '@yassine.demo On peut comparer nos méthodes demain. Pas besoin d’avoir des notes parfaites pour poser une question 🙂' },
 { key: 'general-06', person: 'amine', channel: 'general', date: '2026-10-06T17:39:00+01:00', replyKey: 'general-04', content: 'Bonne idée. Je vais essayer les fiches courtes aussi. Mes résumés finissent toujours par être aussi longs que mes notes…' },
 { key: 'general-07', person: 'yassine', channel: 'general', date: '2026-10-07T10:22:00+01:00', content: 'Bonjour à tous ! Petit retour : j’ai essayé de revoir mes notes avant de commencer les exercices. Je repère beaucoup mieux ce qui me bloque.' },
 { key: 'general-08', person: 'meryem', channel: 'general', date: '2026-10-07T10:23:00+01:00', content: '@sara.demo Tu gardes toutes tes fiches dans un seul document ou tu les sépares par thème ?' },
 { key: 'general-09', person: 'sara', channel: 'general', date: '2026-10-07T10:25:00+01:00', replyKey: 'general-08', content: 'Je les sépare par thème et j’ajoute un titre clair. Comme ça, je retrouve directement ce que je cherche au moment de réviser.' },
 { key: 'general-10', person: 'sara', channel: 'general', date: '2026-10-07T10:26:00+01:00', content: 'Et je garde une petite liste « à revoir » à la fin. Si une question reste ouverte, je la pose dans le Chat de filière plutôt que de la laisser de côté.' },
 { key: 'general-11', person: 'amine', channel: 'general', date: '2026-10-07T10:28:00+01:00', content: 'Je termine mes notes de ce matin. Je peux partager ma façon de les classer si ça intéresse quelqu’un.' },
 { key: 'general-12', person: 'yassine', channel: 'general', date: '2026-10-07T10:31:00+01:00', replyKey: 'general-09', content: 'Merci, je vais faire pareil. Ça fait plaisir de pouvoir échanger ici, même pour les petites questions du quotidien.' },

 { key: 'help-01', person: 'amine', channel: 'help', date: '2026-10-07T14:20:00+01:00', content: 'Vous auriez une méthode pour vérifier qu’on a vraiment compris une notion ? En relisant, tout me paraît clair, mais c’est moins évident sans mes notes.' },
 { key: 'help-02', person: 'meryem', channel: 'help', date: '2026-10-07T14:23:00+01:00', replyKey: 'help-01', content: 'Essaie de l’expliquer à voix haute avec un exemple, sans regarder ton cours. Les passages où tu hésites te montrent ce qu’il faut revoir.' },
 { key: 'help-03', person: 'sara', channel: 'help', date: '2026-10-07T14:25:00+01:00', replyKey: 'help-02', content: 'Je fais ça aussi, puis je compare avec mes notes. Si tu veux, tu peux poster ton explication ici et on la relit ensemble.' },
 { key: 'help-04', person: 'yassine', channel: 'help', date: '2026-10-07T14:28:00+01:00', content: '@sara.demo Je suis partant. On peut aussi se poser une question chacun et expliquer comment on arrive à la réponse.' },

 { key: 'life-01', person: 'meryem', channel: 'life', date: '2026-10-07T16:04:00+01:00', content: 'Petite pause entre deux révisions : quel est votre endroit préféré pour travailler au calme à Taza ?' },
 { key: 'life-02', person: 'amine', channel: 'life', date: '2026-10-07T16:06:00+01:00', replyKey: 'life-01', content: 'La bibliothèque quand j’ai besoin de me concentrer. Pour échanger sur nos notes, je préfère un endroit où on peut parler sans déranger.' },
 { key: 'life-03', person: 'sara', channel: 'life', date: '2026-10-07T16:08:00+01:00', content: 'Même avis ! Et une courte marche après une séance de travail aide à repartir. On pourrait organiser une rencontre entre étudiants de notre filière.' },
 { key: 'life-04', person: 'yassine', channel: 'life', date: '2026-10-07T16:10:00+01:00', replyKey: 'life-03', content: 'Avec plaisir. Proposons un créneau ici une fois que chacun a vérifié son emploi du temps.' },

 { key: 'important-01', person: 'sara', channel: 'important', date: '2026-10-07T15:00:00+01:00', pinned: true, content: 'Pour les dates et les démarches universitaires, pensez à consulter les annonces officielles de votre établissement. Les messages de cette démo sont des exemples.' },
 { key: 'important-02', person: 'yassine', channel: 'important', date: '2026-10-07T15:02:00+01:00', content: 'Quand vous partagez un document, indiquez un titre précis et vérifiez son classement. Ça aide tout le monde à le retrouver dans la bibliothèque.' },
 { key: 'important-03', person: 'meryem', channel: 'important', date: '2026-10-07T15:04:00+01:00', replyKey: 'important-02', content: 'Et si vous repérez une erreur dans un document ou une information, signalez-la avec un peu de contexte pour que l’administration puisse la vérifier.' },
 { key: 'important-04', person: 'amine', channel: 'important', date: '2026-10-07T15:06:00+01:00', content: 'Merci pour le rappel. Évitons aussi de partager nos identifiants ou des documents personnels dans les discussions.' },
];
const semesterPrompts = [
 ['Qui découvre encore ses habitudes de travail en S1 ? On peut comparer nos méthodes pour prendre des notes et préparer la semaine.', 'Je commence par ranger mes notes après chaque séance. Je note aussi les questions que je veux poser la prochaine fois.', '@sara.demo Bonne idée. Je peux partager une petite liste pour préparer ses révisions sans se disperser.'],
 ['Pour les révisions de S2, vous préférez travailler un peu chaque jour ou réserver une séance plus longue ?', 'Un peu chaque jour me convient mieux. Je garde les séances longues pour les exercices et les points qui demandent plus de temps.', 'Je vais essayer ce rythme. Si quelqu’un veut faire le point en fin de semaine, je suis disponible ici.'],
 ['Bienvenue dans les échanges de S3. Quel objectif vous êtes-vous fixé cette semaine ?', 'Reprendre mes notes et repérer les notions que je ne sais pas encore expliquer avec mes propres mots.', '@sara.demo Je me fixe le même objectif. On pourra comparer nos questions dans le Chat de filière.'],
 ['En S4, comment vous organisez-vous pour garder du temps pour les révisions et pour souffler ?', 'Je prévois des séances courtes avec de vraies pauses. Un planning trop chargé ne tient jamais longtemps pour moi.', 'C’est un bon rappel. Je vais laisser une marge dans mon planning plutôt que de remplir chaque créneau.'],
 ['Un espace pour les étudiants de S5 : partageons nos méthodes pour rester réguliers et préparer la suite du parcours.', 'J’essaie de faire un bilan chaque semaine : ce que j’ai compris, ce qui reste à revoir et une priorité pour la semaine suivante.', '@sara.demo Ce bilan pourrait être utile à plusieurs d’entre nous. On peut partager nos objectifs ici sans se comparer.'],
];
const semesterConversations = semesterPrompts.flatMap((contents, index) => contents.map((content, messageIndex) => ({
 key: `semester-${index + 1}-${String(messageIndex + 1).padStart(2, '0')}`,
 person: ['sara', 'meryem', 'amine'][messageIndex],
 channel: `semester-${index + 1}`,
 date: `2026-10-07T${String(10 + index).padStart(2, '0')}:${['00', '03', '05'][messageIndex]}:00+01:00`,
 content,
 ...(messageIndex === 1 ? { replyKey: `semester-${index + 1}-01` } : {}),
})));
// Replies receive IDs from their own academic scope, so conversations cannot
// accidentally refer to students or messages from another faculty/filière.
export const COMMUNITY_V2_MESSAGES = FACULTIES.flatMap(f => FILIERES_BY_FACULTY[f.id].flatMap(p => {
 const messageId = key => `community-v2-${f.id}-${p.id}-${key}`;
 return [...communityConversations, ...semesterConversations].map(({ key, person, replyKey, pinned = false, ...message }) => ({
  id: messageId(key), facultyId: f.id, filiereId: p.id,
  ...communityAuthors[person], ...message, pinned,
  ...(replyKey ? { replyTo: messageId(replyKey) } : {}),
 }));
}));
// S6 intentionally starts empty to demonstrate a welcoming first-message state.
export const INITIAL_MESSAGES = [...LEGACY_MESSAGES, ...COMMUNITY_V2_MESSAGES];
export const INITIAL_NOTIFICATIONS = [...FACULTIES.flatMap((f,i)=>[
 {id:`n-${f.id}-1`,facultyId:f.id,type:'announcement',title:'Les inscriptions pédagogiques sont ouvertes',description:'Une nouvelle annonce de votre établissement.',date:'2026-10-07T09:00:00Z',read:false,targetId:`ann-${i}-1`},
 {id:`n-${f.id}-2`,facultyId:f.id,type:'discussion',title:'Des étudiants préparent une séance de révision',description:'Rejoignez le Chat général de votre faculté.',date:'2026-10-06T15:00:00Z',read:false,channel:'general'},
 {id:`n-${f.id}-3`,facultyId:f.id,type:'administration',title:'Bienvenue sur CampusLink',description:'Votre compte de démonstration est prêt.',date:'2026-10-05T10:00:00Z',read:true}
]),...FACULTIES.flatMap(f=>FILIERES_BY_FACULTY[f.id].flatMap(p=>{
 const resource=INITIAL_RESOURCES.find(r=>r.facultyId===f.id&&r.filiereId===p.id);
 return [
  ...(resource?[{id:`n-resource-${f.id}-${p.id}`,facultyId:f.id,filiereId:p.id,type:'document',title:'Un nouveau document dans votre bibliothèque',description:resource.title,date:'2026-10-07T10:00:00Z',read:false,targetId:resource.id}]:[]),
  {id:`n-mention-${f.id}-${p.id}`,facultyId:f.id,filiereId:p.id,type:'mention',title:'Yassine vous invite à participer aux révisions',description:'Retrouvez la discussion dans le Chat général de votre faculté.',date:'2026-10-07T11:00:00Z',read:false,channel:'general',targetId:`msg-${f.id}-${p.id}-1`}
 ];
}))];
export const INITIAL_ACCOUNTS = [
 {id:'u1',username:'sara.demo',name:'Sara Benali',role:'student',facultyId:'flaa',filiereId:'french_studies',status:'active'},
 {id:'u2',username:'yassine.demo',name:'Yassine El Amrani',role:'student',facultyId:'feg',filiereId:'economics',status:'active'},
 {id:'u3',username:'meryem.demo',name:'Meryem Alaoui',role:'student',facultyId:'fsa',filiereId:'information_systems',status:'disabled'},
 {id:'u4',username:'admin.demo',name:'Issmail',role:'admin',facultyId:'flaa',filiereId:'french_studies',status:'active'}
];
export const INITIAL_REPORTS = [{id:'report-1',author:'Meryem Alaoui',reason:'Document mal classé',content:'Vérifier le classement du document.',type:'resource',status:'pending',date:'2026-10-07T10:00:00Z'},{id:'report-2',author:'Sara Benali',reason:'Message hors sujet',content:'Discussion à déplacer dans Vie étudiante.',type:'message',status:'pending',date:'2026-10-06T11:00:00Z'}];
