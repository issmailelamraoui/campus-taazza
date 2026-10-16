import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './backend-helpers.mjs';
import { resolveModule } from '../server/modules.js';

// Real API + isolated PostgreSQL schema; auth and object storage remain injected.
export async function moduleSharingEnvironment({ appOrigin } = {}) {
  const env = await createTestApp({ demo: false, appOrigin });
  const users = {}, cookies = {};
  for (const [username, filiere, faculty = 'fsa'] of [
    ['share.sender', 'mathematics'], ['share.peer', 'mathematics'], ['share.program', 'physics'], ['share.faculty', 'economics', 'feg'],
  ]) {
    users[username] = await env.db.prepare('INSERT INTO users (username,name,faculty_id,filiere_id) VALUES (?,?,?,?) RETURNING *')
      .get(username, username, faculty, filiere);
    await env.auth.bindUser(users[username].id);
  }
  const server = env.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { user = 'share.sender', method = 'GET', body } = {}) => {
    const response = await fetch(origin + '/api' + path, {
      method, headers: { ...(cookies[user] ? { cookie: cookies[user] } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  try {
    for (const username of Object.keys(users)) {
      const result = await request('/login', { user: username, method: 'POST', body: { username, password: 'Campus2026!' } });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      cookies[username] = result.headers.getSetCookie().find(value => value.startsWith('campus_neon_test_session=')).split(';')[0];
    }
    const addResource = async ({ module = 'Probabilités et Statistiques', semester = 1, user = 'share.sender', visible = true } = {}) => {
      const author = users[user], stored = randomUUID();
      const folder = await resolveModule(env.db, { facultyId: author.faculty_id, filiereId: author.filiere_id, semester, name: module });
      return env.db.prepare(`INSERT INTO resources
        (faculty_id,filiere_id,title,filename,object_key,stored_name,sha256,category,resource_type,semester,module_id,module,author_id,created_at,size,mime,library_visible,part_number)
        VALUES (?,?,?,'cours.pdf',?,?,?,'courses','courses',?,?,?,?,?,5,'application/pdf',?,'complete') RETURNING *`)
        .get(author.faculty_id, author.filiere_id, module, stored, stored, stored, semester, folder.id, folder.name, author.id, new Date().toISOString(), visible ? 1 : 0);
    };
    return { ...env, origin, server, users, cookies, request, addResource, close: async () => {
      env.app.locals.endStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); await env.close();
    } };
  } catch (error) {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await env.close(); throw error;
  }
}
