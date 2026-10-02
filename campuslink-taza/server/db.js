import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const hashPassword = (password, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
export function verifyPassword(password, hashed) {
  try {
    const [salt, hash] = hashed.split(':');
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}
export const digest = value => createHash('sha256').update(value).digest('hex');

export function openDatabase(dataDir) {
  mkdirSync(join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'campuslink.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS faculties (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, arabic TEXT NOT NULL,
      description TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL, members INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, avatar TEXT DEFAULT '', role TEXT NOT NULL DEFAULT 'student',
      faculty_id TEXT REFERENCES faculties(id), language TEXT DEFAULT 'fr',
      preferences TEXT DEFAULT '{"resources":true,"announcements":true,"important":true,"admin":true,"calendar":true}',
      disabled INTEGER DEFAULT 0, last_seen TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, faculty_id TEXT REFERENCES faculties(id), channel TEXT NOT NULL,
      content TEXT NOT NULL, author_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
      resource_id INTEGER, reply_to INTEGER REFERENCES messages(id), pinned INTEGER DEFAULT 0, removed INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, faculty_id TEXT REFERENCES faculties(id), title TEXT NOT NULL,
      filename TEXT NOT NULL, stored_name TEXT NOT NULL, sha256 TEXT NOT NULL, category TEXT NOT NULL,
      semester INTEGER, module TEXT DEFAULT '', author_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
      size INTEGER NOT NULL, mime TEXT NOT NULL, downloads INTEGER DEFAULT 0, views INTEGER DEFAULT 0,
      message_id INTEGER REFERENCES messages(id), channel TEXT NOT NULL DEFAULT 'general', status TEXT DEFAULT 'new',
      version INTEGER DEFAULT 1, removed INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS resource_faculty ON resources(faculty_id);
    CREATE INDEX IF NOT EXISTS message_faculty ON messages(faculty_id);
    CREATE TABLE IF NOT EXISTS resource_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, resource_id INTEGER REFERENCES resources(id),
      version INTEGER, filename TEXT, stored_name TEXT, sha256 TEXT, size INTEGER, mime TEXT, updated_at TEXT, editor_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS reactions (message_id INTEGER REFERENCES messages(id), user_id INTEGER REFERENCES users(id), reaction TEXT, PRIMARY KEY(message_id,user_id,reaction));
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, faculty_id TEXT REFERENCES faculties(id), content TEXT NOT NULL,
      message_id INTEGER UNIQUE REFERENCES messages(id), channel TEXT DEFAULT 'general', author_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL, resource_id INTEGER, pinned INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      faculty_id TEXT REFERENCES faculties(id), type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      path TEXT NOT NULL, created_at TEXT NOT NULL, read INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, faculty_id TEXT REFERENCES faculties(id), title TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, type TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channels (id TEXT NOT NULL, faculty_id TEXT REFERENCES faculties(id), name TEXT NOT NULL, description TEXT DEFAULT '', read_only INTEGER DEFAULT 0, PRIMARY KEY(id,faculty_id));
    CREATE TABLE IF NOT EXISTS saved (user_id INTEGER REFERENCES users(id), type TEXT, target_id INTEGER, PRIMARY KEY(user_id,type,target_id));
    CREATE TABLE IF NOT EXISTS history (user_id INTEGER REFERENCES users(id), resource_id INTEGER REFERENCES resources(id), opened_at TEXT NOT NULL, PRIMARY KEY(user_id,resource_id));
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, faculty_id TEXT REFERENCES faculties(id), reporter_id INTEGER REFERENCES users(id),
      target_type TEXT NOT NULL, target_id INTEGER NOT NULL, reason TEXT NOT NULL, details TEXT DEFAULT '',
      status TEXT DEFAULT 'open', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, faculty_id TEXT REFERENCES faculties(id), user_id INTEGER REFERENCES users(id),
      name TEXT, email TEXT, subject TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT DEFAULT 'open'
    );
  `);
  return db;
}
