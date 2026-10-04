// Existing faculty IDs determine the available majors. Labels are intentionally
// the exact labels supplied for account setup and academic resource uploads.
export const FILIERES_BY_FACULTY = {
  fsa: [
    { id: 'information_systems', name: 'Filière Ingénierie des Systèmes d’Information' },
    { id: 'data_science', name: 'Filière Sciences de Données' },
    { id: 'mathematics', name: 'Filière Sciences Mathématiques' },
    { id: 'geology', name: 'Filière Géologie' },
    { id: 'biology', name: 'Filière Biologie' },
    { id: 'physics', name: 'Filière Physique' },
    { id: 'mechanics', name: 'Filière Mécanique' },
    { id: 'chemistry', name: 'Filière Chimie' },
  ],
  flaa: [
    { id: 'french_studies', name: 'مسلك الدراسات الفرنسية (S1, S3, S5)' },
    { id: 'arabic_studies', name: 'شعبة اللغة العربية والآداب والفنون' },
    { id: 'history_civilization', name: 'شعبة التاريخ والحضارة' },
    { id: 'geography', name: 'شعبة الجغرافيا' },
  ],
  feg: [
    { id: 'economics', name: 'Filière Économie' },
    { id: 'management', name: 'Filière Gestion' },
  ],
  fsjp: [
    { id: 'public_law', name: 'شعبة القانون العام' },
    { id: 'private_law', name: 'شعبة القانون الخاص' },
    { id: 'political_international_studies', name: 'مسار التميز في الدراسات السياسية والدولية (S5)' },
  ],
};

export const getFilieres = facultyId => FILIERES_BY_FACULTY[facultyId] || [];
export const getFiliere = id => Object.values(FILIERES_BY_FACULTY).flat().find(f => f.id === id) || null;
export const filiereBelongsToFaculty = (facultyId, id) => getFilieres(facultyId).some(f => f.id === id);

export const SEMESTER_CHAT_GROUPS = [
  { id: 1, label: 'S1 / S2', semesters: [1, 2] },
  { id: 3, label: 'S3 / S4', semesters: [3, 4] },
  { id: 5, label: 'S5 / S6', semesters: [5, 6] },
];
// Academic resources retain their exact semester. Only chat scopes use the
// first semester of the academic year, including links created before grouping.
export function getChatSemester(value) {
  const semester=Number(String(value??'').replace(/^s/i,''));
  return Number.isInteger(semester)&&semester>=1&&semester<=6 ? semester-(semester%2===0?1:0) : null;
}
export const getChatSemesterLabel = value => SEMESTER_CHAT_GROUPS.find(group=>group.id===getChatSemester(value))?.label || '';
