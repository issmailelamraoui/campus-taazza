import './env.js';
import { randomUUID } from 'node:crypto';
import { createStorage, storageObjectKey } from './storage.js';

const storage = createStorage();
const key = storageObjectKey(`_integration-tests/campuslink-${randomUUID()}.txt`);
const content = Buffer.from('CampusLink bounded R2 integration check.\n');
let attempted = false;
try {
  attempted = true;
  await storage.put(key, content, 'text/plain');
  const metadata = await storage.head(key);
  if (metadata.contentLength !== content.length) throw new Error('R2 metadata size mismatch.');
  const result = await storage.get(key);
  const retrieved = Buffer.from(await result.body.transformToByteArray());
  if (!content.equals(retrieved)) throw new Error('R2 retrieved bytes mismatch.');
  console.log('R2: upload, authenticated head and authenticated retrieval passed.');
} finally {
  try {
    if (attempted) {
      await storage.delete(key);
      let removed = false;
      try { await storage.head(key); } catch (error) { if (error.status === 404) removed = true; else throw error; }
      if (!removed) throw new Error('R2 test object still exists after deletion.');
      console.log('R2: temporary test object deleted and absence confirmed.');
    }
  } finally { storage.close(); }
}
