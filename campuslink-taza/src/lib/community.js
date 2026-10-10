export const COMMUNITY_YEAR_CHANNELS = [
  { id: 'year-1', label: 'S1–S2' },
  { id: 'year-3', label: 'S3–S4' },
  { id: 'year-5', label: 'S5–S6' },
];

// Old conversation URLs and saved message IDs still lead to the whole year.
export function normalizeCommunityChannel(value) {
  if (value === 'help' || value === 'life') return 'general';
  if (value === 'filiere') return 'year-1';
  if (value === 'help' || value === 'life') return 'general';
  const semester = /^semester-([1-6])$/.exec(value || '');
  if (semester) return `year-${Number(semester[1]) % 2 ? semester[1] : Number(semester[1]) - 1}`;
  return ['general', 'important', ...COMMUNITY_YEAR_CHANNELS.map(item => item.id)].includes(value) ? value : null;
}

export function matchesCommunityScope(message, selection) {
  if (!selection || message.deleted || message.communityHiddenSeed || message.facultyId !== selection.facultyId) return false;
  const channel = normalizeCommunityChannel(message.channel);
  return Boolean(channel && (channel === 'general' || message.filiereId === selection.filiereId));
}

export function migrateCommunityMessages(messages, seeds = [], protectedIds = []) {
  const seedsById = new Map(seeds.map(message => [message.id, message]));
  const protectedMessages = new Set(protectedIds);
  const facultySeedProgram = new Map();
  for (const message of seeds) {
    if (message.channel === 'general' && !facultySeedProgram.has(message.facultyId)) {
      facultySeedProgram.set(message.facultyId, message.filiereId);
    }
  }
  let changed = false;
  const migrated = messages.map(message => {
    const channel = normalizeCommunityChannel(message.channel) || message.channel;
    const seed = seedsById.get(message.id);
    // General examples were repeated for every program. Keep their IDs and
    // tombstones, but present one faculty sample. Actual student posts remain.
    const customized = seed && (Boolean(message.pinned) !== Boolean(seed.pinned)
      || message.replyTo !== seed.replyTo || message.username !== seed.username
      || Boolean(message.attachment) || Boolean(message.attachments?.length)
      || Object.values(message.reactions || {}).some(value => Array.isArray(value) ? value.length > 0 : Boolean(value)));
    const hiddenSeed = Boolean(seed && !customized && !protectedMessages.has(message.id) && channel === 'general' &&
      seed.filiereId !== facultySeedProgram.get(seed.facultyId) &&
      message.content === seed.content && message.author === seed.author && message.date === seed.date);
    if (channel === message.channel && Boolean(message.communityHiddenSeed) === hiddenSeed) return message;
    changed = true;
    return { ...message, channel, communityHiddenSeed: hiddenSeed };
  });
  return changed ? migrated : messages;
}

// Duplicate demonstration IDs remain resolvable through older copied URLs.
export function canonicalCommunityMessageId(id, messages) {
  const source = messages.find(message => message.id === id);
  if (!source?.communityHiddenSeed || source.deleted) return id;
  return messages.find(message => !message.communityHiddenSeed && !message.deleted
    && message.facultyId === source.facultyId
    && normalizeCommunityChannel(message.channel) === normalizeCommunityChannel(source.channel)
    && message.content === source.content && message.author === source.author && message.date === source.date)?.id || id;
}
