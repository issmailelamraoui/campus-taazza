import { filiereBelongsToFaculty } from '../data/studies.js';
import { normalizeCommunityChannel } from './community.js';

// Only canonical academic IDs belong here; never infer a theme from a chat
// title, a message author, or a translated label. To add a theme, add its SVG
// under public/chat-backgrounds and register its ID in the appropriate map.
export const FACULTY_CHAT_BACKGROUNDS = Object.freeze({
  fsa: 'fsa',
  flaa: 'flaa',
  feg: 'feg',
  fsjp: 'fsjp',
});

export const FILIERE_CHAT_BACKGROUNDS = Object.freeze({
  information_systems: 'information_systems',
  data_science: 'data_science',
  mathematics: 'mathematics',
  geology: 'geology',
  biology: 'biology',
  physics: 'physics',
  mechanics: 'mechanics',
  chemistry: 'chemistry',
  french_studies: 'french_studies',
  arabic_studies: 'arabic_studies',
  history_civilization: 'history_civilization',
  geography: 'geography',
  economics: 'economics',
  management: 'management',
  public_law: 'public_law',
  private_law: 'private_law',
  political_international_studies: 'political_international_studies',
});

const theme = (id, scope) => Object.freeze({ id, scope, image: `/chat-backgrounds/${id}.svg` });
export const CHAT_BACKGROUND_THEMES = Object.freeze(Object.fromEntries([
  ['academic', theme('academic', 'academic')],
  ...Object.values(FACULTY_CHAT_BACKGROUNDS).map(id => [id, theme(id, 'faculty')]),
  ...Object.values(FILIERE_CHAT_BACKGROUNDS).map(id => [id, theme(id, 'filiere')]),
]));

const registered = (registry, id) => typeof id === 'string' && Object.hasOwn(registry, id);

/** Resolve the same authenticated academic scope used by the message list. */
export function resolveChatBackground({ channel, facultyId, filiereId } = {}) {
  const activeChannel = typeof channel === 'string' ? normalizeCommunityChannel(channel) : null;
  if (!activeChannel || !registered(FACULTY_CHAT_BACKGROUNDS, facultyId)) {
    return CHAT_BACKGROUND_THEMES.academic;
  }

  const facultyTheme = CHAT_BACKGROUND_THEMES[FACULTY_CHAT_BACKGROUNDS[facultyId]];
  // Both general and important discussions are shared across the faculty.
  if (activeChannel === 'general' || activeChannel === 'important') return facultyTheme;

  return registered(FILIERE_CHAT_BACKGROUNDS, filiereId) && filiereBelongsToFaculty(facultyId, filiereId)
    ? CHAT_BACKGROUND_THEMES[FILIERE_CHAT_BACKGROUNDS[filiereId]]
    : facultyTheme;
}
