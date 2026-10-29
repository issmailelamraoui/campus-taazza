import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { academicYear } from './academic-years.js';
import { assessPDFText, PDF_TEXT_EXTRACTION_OPTIONS } from '../shared/pdf-text.js';

const failure = (status, message, code) => Object.assign(new Error(message), { status, code });
export const DOCUMENT_INDEX_POLICY = Object.freeze({ maxFileBytes: 20 * 1024 * 1024, maxPages: 500, maxPageCharacters: 50000, maxTextBytes: 5 * 1024 * 1024, timeoutMs: 20000, maxConcurrent: 2, resultLimit: 25, candidateLimit: 500 });
const identifier = value => { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'Référence de document invalide.'); return id; };
export const normalizeDocumentText = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
const cleanText = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/gu, ' ').trim();
export function documentSearchTerms(value) {
  if (typeof value !== 'string' || value.length > 160) throw failure(400, 'La recherche doit contenir au maximum 160 caractères.');
  const terms = [...new Set(normalizeDocumentText(value).match(/[\p{L}\p{N}]{2,}/gu) || [])];
  if (!terms.length || terms.length > 8) throw failure(400, 'Saisissez entre un et huit mots de deux caractères minimum.');
  return terms;
}
function assertPdf(resource) {
  if (resource.mime !== 'application/pdf' || !/\.pdf$/i.test(resource.filename || '')) throw failure(415, 'Seuls les PDF peuvent être indexés.');
  if (!Number.isSafeInteger(resource.size) || resource.size < 1 || resource.size > DOCUMENT_INDEX_POLICY.maxFileBytes) throw failure(413, 'Ce PDF dépasse la limite de 20 Mo.');
}
function sameSource(a, b) { return a.id === b.id && a.version === b.version && a.sha256 === b.sha256 && a.object_key === b.object_key && a.faculty_id === b.faculty_id && a.filiere_id === b.filiere_id && a.library_visible === b.library_visible && a.message_id === b.message_id && !b.removed; }
function statusDTO(resource, row) {
  return { resourceId: resource.id, version: resource.version, status: row?.status || 'not_indexed', pageCount: row?.page_count ?? null, textBytes: row?.text_bytes ?? null, indexedAt: row?.indexed_at || null, searchable: row?.status === 'ready', ...(row?.status === 'no_text' ? { message: 'Aucun texte extractible. Ce PDF peut nécessiter un OCR, qui n’est pas disponible ici.' } : {}) };
}
async function currentIndex(db, resource) {
  return db.prepare(`SELECT i.* FROM document_text_indexes i JOIN resources r ON r.id=i.resource_id
    WHERE i.resource_id=? AND i.document_version=? AND i.source_sha256=? AND r.removed=0
      AND r.version=i.document_version AND r.sha256=i.source_sha256 AND r.mime='application/pdf'`).get(resource.id, resource.version, resource.sha256);
}
// Authorization remains the caller's responsibility. A verified count applies
// only to this exact current PDF version and hash, including image-only PDFs.
export async function verifiedIndexedPageCount(db, resource) {
  if (resource.removed || resource.mime !== 'application/pdf') return null;
  const row = await currentIndex(db, resource);
  return row ? row.page_count : null;
}

async function readPdf(storage, resource) {
  const file = await storage.get(resource.object_key);
  if (file.contentLength !== undefined && file.contentLength > DOCUMENT_INDEX_POLICY.maxFileBytes) { file.body?.destroy?.(); throw failure(413, 'Ce PDF dépasse la limite de 20 Mo.'); }
  const chunks = []; let size = 0, timer;
  try {
    const reading = (async () => {
      for await (const chunk of file.body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
        if (size > DOCUMENT_INDEX_POLICY.maxFileBytes) throw failure(413, 'Ce PDF dépasse la limite de 20 Mo.');
        chunks.push(bytes);
      }
      const data = Buffer.concat(chunks, size);
      if (size !== resource.size || createHash('sha256').update(data).digest('hex') !== resource.sha256) throw failure(409, 'Le fichier stocké ne correspond plus à cette version du document.');
      return data;
    })();
    return await Promise.race([reading, new Promise((_, reject) => { timer = setTimeout(() => { file.body?.destroy?.(); reject(failure(504, 'Le stockage a mis trop de temps à répondre. Réessayez.', 'INDEX_TIMEOUT')); }, DOCUMENT_INDEX_POLICY.timeoutMs); })]);
  } finally { clearTimeout(timer); file.body?.destroy?.(); }
}

// PDF programs, scripts, actions and XFA are never evaluated. Extraction occurs
// in its own worker with bounded V8 memory and a hard wall-clock deadline.
export async function extractPdfText(data, { timeoutMs = DOCUMENT_INDEX_POLICY.timeoutMs } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DOCUMENT_INDEX_POLICY.timeoutMs) throw failure(400, 'Délai d’extraction invalide.');
  if (!data?.byteLength || data.byteLength > DOCUMENT_INDEX_POLICY.maxFileBytes) throw failure(413, 'Ce PDF dépasse la limite de 20 Mo.');
  const bytes = Uint8Array.from(data);
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'campus-pdf-text', data: bytes }, transferList: [bytes.buffer], resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 }, execArgv: [] });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(failure(504, 'Ce PDF n’a pas pu être extrait dans le délai autorisé.', 'INDEX_TIMEOUT')), timeoutMs);
      worker.once('message', message => message.ok ? resolve(message.result) : reject(failure(message.status || 422, message.error || 'Ce PDF ne peut pas être extrait.', message.code)));
      worker.once('error', () => reject(failure(422, 'L’extraction de ce PDF a dépassé les ressources disponibles.', 'INDEX_WORKER_FAILED')));
      worker.once('exit', code => { if (code !== 0) reject(failure(422, 'L’extraction de ce PDF a été interrompue.', 'INDEX_WORKER_FAILED')); });
    });
  } finally { clearTimeout(timer); await worker.terminate(); }
}
async function extractInsideWorker(data) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const packageUrl=import.meta.resolve('pdfjs-dist/package.json');
  // PDF.js requires a '/' suffix even on Windows. Node's fileURLToPath uses
  // backslashes there; normalize the asset-directory separator, not PDF text.
  const assetDirectory=name=>fileURLToPath(new URL('./'+name+'/',packageUrl)).replaceAll('\\','/');
  const loading = getDocument({ data, cMapUrl:assetDirectory('cmaps'), cMapPacked:true, standardFontDataUrl:assetDirectory('standard_fonts'), isEvalSupported: false, enableXfa: false, useWorkerFetch: false, useWasm: false, disableFontFace: true, useSystemFonts: false, maxImageSize: 0, stopAtErrors: true, verbosity: 0 });
  let document;
  try {
    document = await loading.promise;
    if (!Number.isInteger(document.numPages) || document.numPages < 1 || document.numPages > DOCUMENT_INDEX_POLICY.maxPages) throw failure(413, 'L’indexation est limitée à 500 pages.');
    const pages = [], unreliablePages=[]; let textBytes = 0, scannedBytes=0;
    for (let page = 1; page <= document.numPages; page++) {
      const pdfPage = await document.getPage(page), content = await pdfPage.getTextContent(PDF_TEXT_EXTRACTION_OPTIONS);
      let raw = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        if (raw.length + item.str.length + 1 > DOCUMENT_INDEX_POLICY.maxPageCharacters) throw failure(413, 'Une page dépasse la limite de texte extractible.');
        raw += item.str + (item.hasEOL ? '\n' : ' ');
      }
      scannedBytes+=Buffer.byteLength(raw);
      if(scannedBytes>DOCUMENT_INDEX_POLICY.maxTextBytes)throw failure(413,'Ce PDF dépasse la limite de 5 Mo de texte extractible.');
      // Test the original strings before cleanText could erase glyph codes.
      // A mathematically unreliable page is never offered as a text snippet.
      const quality=assessPDFText(content);
      if(!quality.reliable){unreliablePages.push(page);pdfPage.cleanup();continue;}
      const text = cleanText(raw), normalized = normalizeDocumentText(text);
      textBytes += Buffer.byteLength(text);
      if (textBytes > DOCUMENT_INDEX_POLICY.maxTextBytes) throw failure(413, 'Ce PDF dépasse la limite de 5 Mo de texte extractible.');
      if (text) pages.push({ page, text, normalized });
      pdfPage.cleanup();
    }
    return { pageCount: document.numPages, pages, textBytes, status: pages.length ? 'ready' : 'no_text',unreliablePages };
  } catch (error) {
    if (error.status) throw error;
    throw failure(422, error.name === 'PasswordException' ? 'Ce PDF est protégé par un mot de passe.' : 'Ce PDF est endommagé ou son texte ne peut pas être extrait.');
  } finally { await loading.destroy(); }
}
if (!isMainThread && workerData?.kind === 'campus-pdf-text') {
  try { parentPort.postMessage({ ok: true, result: await extractInsideWorker(workerData.data) }); }
  catch (error) { parentPort.postMessage({ ok: false, status: error.status || 422, error: error.message, code: error.code }); }
}

let activeExtractions = 0;
const inFlight = new Set();
export async function indexDocument(resource, { db, storage, assertCurrent, indexedBy }) {
  assertPdf(resource);
  const existing = await currentIndex(db, resource);
  if (existing) return { ...statusDTO(resource, existing), reused: true };
  const key = `${resource.id}:${resource.version}:${resource.sha256}`;
  if (inFlight.has(key) || activeExtractions >= DOCUMENT_INDEX_POLICY.maxConcurrent) throw failure(429, 'Une indexation est déjà en cours. Réessayez dans quelques instants.');
  inFlight.add(key); activeExtractions++;
  try {
    const result = await extractPdfText(await readPdf(storage, resource));
    if(result.unreliablePages.length)throw failure(422,'Le texte de ce PDF contient des correspondances de caractères non fiables. Consultez l’original et conservez les formules en image.','PDF_TEXT_UNRELIABLE');
    // Re-check access after the expensive asynchronous work, then serialize with
    // replacement/deletion. No stale text can become a current-version result.
    const authorized = await assertCurrent();
    if (!sameSource(resource, authorized)) throw failure(409, 'Le document a changé. Indexez sa version actuelle.');
    return await db.transaction(async () => {
      const locked = await db.prepare('SELECT * FROM resources WHERE id=? FOR UPDATE').get(resource.id);
      if (!locked || !sameSource(resource, locked)) throw failure(409, 'Le document a changé. Indexez sa version actuelle.');
      const repeated = await currentIndex(db, resource);
      if (repeated) return { ...statusDTO(resource, repeated), reused: true };
      const indexedAt = new Date().toISOString();
      const row = await db.prepare('INSERT INTO document_text_indexes(resource_id,document_version,source_sha256,status,page_count,text_bytes,indexed_by,indexed_at) VALUES(?,?,?,?,?,?,?,?) RETURNING *').get(resource.id, resource.version, resource.sha256, result.status, result.pageCount, result.textBytes, indexedBy || null, indexedAt);
      for (const page of result.pages) await db.prepare('INSERT INTO document_text_pages(resource_id,document_version,page,text,normalized_text) VALUES(?,?,?,?,?)').run(resource.id, resource.version, page.page, page.text, page.normalized);
      return { ...statusDTO(resource, row), reused: false };
    });
  } finally { inFlight.delete(key); activeExtractions--; }
}
function excerpt(text, terms) {
  const normalized = normalizeDocumentText(text), positions = terms.map(term => normalized.indexOf(term)).filter(pos => pos >= 0), around = positions.length ? Math.min(...positions) : 0;
  // Normalization can change offsets; this remains a plain-text excerpt rather
  // than claiming exact character highlighting in the source PDF.
  const start = Math.max(0, around - 80), end = Math.min(text.length, start + 320);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
export function installDocumentSearchRoutes(app, { db, requireFaculty, assertResource, storage }) {
  app.get('/api/document-index/:id', requireFaculty, async (req, res) => {
    const resource = await assertResource(identifier(req.params.id), req); assertPdf(resource);
    res.set('Cache-Control', 'private, no-store').json({ index: statusDTO(resource, await currentIndex(db, resource)), policy: DOCUMENT_INDEX_POLICY });
  });
  app.post('/api/document-index/:id', requireFaculty, async (req, res) => {
    const resource = await assertResource(identifier(req.params.id), req);
    const index = await indexDocument(resource, { db, storage, indexedBy: req.user.id, assertCurrent: () => assertResource(resource.id, req) });
    res.set('Cache-Control', 'private, no-store').status(index.reused ? 200 : 201).json({ index });
  });
  app.get('/api/document-search', requireFaculty, async (req, res) => {
    const terms = documentSearchTerms(req.query.q), resourceId = req.query.resourceId === undefined ? null : identifier(req.query.resourceId);
    let resourceIds=null;
    if(req.query.resource_ids!==undefined){
      if(typeof req.query.resource_ids!=='string'||req.query.resource_ids.length>20000||!/^\d+(?:,\d+)*$|^$/.test(req.query.resource_ids))throw failure(400,'Périmètre de recherche invalide.');
      resourceIds=req.query.resource_ids===''?[]:[...new Set(req.query.resource_ids.split(',').map(identifier))];
      if(resourceIds.length>2000)throw failure(400,'Périmètre de recherche trop large.');
    }
    const currentYear = req.user.current_academic_year || academicYear(process.env.CAMPUS_ACADEMIC_YEAR);
    if (resourceId) { const resource = await assertResource(resourceId, req); assertPdf(resource); }
    const rows = await db.prepare(`SELECT p.resource_id,p.document_version,p.page,p.text,i.source_sha256
      FROM document_text_pages p JOIN document_text_indexes i ON i.resource_id=p.resource_id AND i.document_version=p.document_version
      JOIN resources r ON r.id=p.resource_id
      WHERE r.removed=0 AND r.faculty_id=? AND r.mime='application/pdf' AND r.version=p.document_version AND r.sha256=i.source_sha256
        AND ${resourceId ? 'r.id=?' : 'r.library_visible=1'} ${resourceIds===null?'':'AND r.id=ANY(?)'} AND p.search_vector @@ plainto_tsquery('simple',?)
      ORDER BY CASE WHEN r.academic_year=? OR r.academic_years @> ?::jsonb THEN 0 WHEN r.academic_year IS NULL THEN 2 ELSE 1 END,
        r.academic_year DESC NULLS LAST,r.id DESC,p.page ASC LIMIT ${DOCUMENT_INDEX_POLICY.candidateLimit}`)
      .all(req.user.faculty_id, ...(resourceId ? [resourceId] : []), ...(resourceIds===null?[]:[resourceIds]), terms.join(' '), currentYear || '', JSON.stringify(currentYear ? [currentYear] : ['__no_configured_year__']));
    const resources = new Map(), matches = [];let unreliableTextSkipped=0;
    for (const row of rows) {
      if (!resources.has(row.resource_id)) {
        try { resources.set(row.resource_id, await assertResource(row.resource_id, req)); }
        catch (error) { if (![403, 404].includes(error.status)) throw error; resources.set(row.resource_id, null); }
      }
      const resource = resources.get(row.resource_id);
      if (!resource || resource.removed || resource.version !== row.document_version || resource.sha256 !== row.source_sha256) continue;
      // Existing indexes and student data are preserved. Strong corruption
      // evidence in a historical snippet is suppressed without rewriting it.
      if(!assessPDFText(row.text).reliable){unreliableTextSkipped++;continue;}
      const query = new URLSearchParams({ document: String(resource.id), page: String(row.page), version: String(row.document_version) });
      matches.push({ resourceId: resource.id, version: row.document_version, page: row.page, title: resource.title, filename: resource.filename, module: resource.module, semester: resource.semester, academicYear: resource.academic_year || null, excerpt: excerpt(row.text, terms), href: `/app/library?${query}#resource-${resource.id}` });
      if (matches.length >= DOCUMENT_INDEX_POLICY.resultLimit) break;
    }
    res.set('Cache-Control', 'private, no-store').json({ matches, terms, limit: DOCUMENT_INDEX_POLICY.resultLimit, mode: 'keyword',unreliableTextSkipped, message: 'Recherche par mots dans les PDF explicitement indexés. Aucun OCR ni rapprochement automatique.' });
  });
}
