import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMUNITY_YEAR_CHANNELS, normalizeCommunityChannel, matchesCommunityScope, migrateCommunityMessages, canonicalCommunityMessageId } from '../src/lib/community.js';

const selection = { facultyId: 'fsa', filiereId: 'information_systems', semester: 6 };
const message = { id: 'student-message', facultyId: 'fsa', filiereId: 'information_systems', channel: 'general', content: 'Message réel local', author: 'Sara', date: '2026-10-08T09:00:00Z' };

test('Community has three combined academic years accessible from either semester', () => {
  assert.deepEqual(COMMUNITY_YEAR_CHANNELS.map(item => item.label), ['S1–S2', 'S3–S4', 'S5–S6']);
  for (let semester = 1; semester <= 6; semester++) assert.equal(normalizeCommunityChannel(`semester-${semester}`), `year-${semester % 2 ? semester : semester - 1}`);
  assert.equal(normalizeCommunityChannel('filiere'), 'year-1');
  assert.equal(normalizeCommunityChannel('help'), 'general');
  assert.equal(normalizeCommunityChannel('life'), 'general');
  for (const channel of COMMUNITY_YEAR_CHANNELS) assert.ok(matchesCommunityScope({ ...message, channel: channel.id }, selection));
});

test('General chat shares the whole faculty while year and important chats retain their program scope', () => {
  assert.ok(matchesCommunityScope({ ...message, filiereId: 'data_science' }, selection));
  assert.equal(matchesCommunityScope({ ...message, facultyId: 'feg' }, selection), false);
  assert.equal(matchesCommunityScope({ ...message, filiereId: 'data_science', channel: 'year-1' }, selection), false);
  assert.equal(matchesCommunityScope({ ...message, filiereId: 'data_science', channel: 'important' }, selection), false);
  assert.equal(matchesCommunityScope({ ...message, deleted: true }, selection), false);
  assert.equal(matchesCommunityScope(message, null), false);
});

test('Faculty seed migration retains tombstones and actual posts without repeating examples for each program', () => {
  const seeds = [{ ...message, id: 'seed-a' }, { ...message, id: 'seed-b', filiereId: 'data_science' }];
  const data = migrateCommunityMessages([
    { ...seeds[0], deleted: true }, seeds[1],
    { ...message, id: 'real-other-program', filiereId: 'data_science' },
    { ...message, id: 'old-semester', channel: 'semester-2' },
  ], seeds);
  assert.equal(data.length, 4);
  assert.ok(data[0].deleted);
  assert.ok(data[1].communityHiddenSeed);
  assert.ok(matchesCommunityScope(data[2], selection));
  assert.equal(data[3].channel, 'year-1');
  assert.equal(migrateCommunityMessages(data, seeds), data, 'Migration must settle without repeated state updates');
});

test('older seed links resolve while saved and customized messages remain visible', () => {
  const seeds = [{ ...message, id: 'primary' }, { ...message, id: 'duplicate', filiereId: 'data_science' }];
  const data = migrateCommunityMessages(seeds, seeds);
  assert.equal(canonicalCommunityMessageId('duplicate', data), 'primary');
  for (const patch of [{ pinned: true }, { reactions: { heart: ['sara.demo'] } }, { attachments: [{ name: 'Notes.txt' }] }, { replyTo: 'local-post' }]) {
    const customized = migrateCommunityMessages([seeds[0], { ...seeds[1], ...patch }], seeds);
    assert.ok(matchesCommunityScope(customized[1], selection));
  }
  const saved = migrateCommunityMessages(seeds, seeds, ['duplicate']);
  assert.ok(matchesCommunityScope(saved[1], selection));
});
