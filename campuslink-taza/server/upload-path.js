import { basename } from 'node:path';

const invalidPath = () => Object.assign(new Error('Chemin du fichier invalide.'), { status: 400 });
const safeFilename = name => basename(name).replace(/[\u0000-\u001f]/g, '').slice(0, 180);

// Busboy's default multipart filename encoding is Latin-1. Directory paths are
// ordinary UTF-8 fields, so accept a lossless UTF-8 filename decode when matching
// the path, without changing the established single-file upload behavior.
function utf8Filename(name) {
  if ([...name].some(character => character.codePointAt(0) > 255)) return null;
  const bytes = Buffer.from(name, 'latin1');
  const decoded = bytes.toString('utf8');
  return !decoded.includes('\ufffd') && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : null;
}

export function uploadFilePath(originalname, relativePath) {
  const filename = safeFilename(originalname);
  if (relativePath === undefined || relativePath === '') return { filename, relativePath: '' };
  if (typeof relativePath !== 'string' || relativePath.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(relativePath) || /^[a-z]:/i.test(relativePath)) throw invalidPath();
  const segments = relativePath.split('/');
  if (segments.length > 64 || segments.some(segment => !segment || segment.length > 255 || segment === '.' || segment === '..')) throw invalidPath();
  const leaf = segments.at(-1);
  if (leaf.length > 180) throw invalidPath();
  const decoded = utf8Filename(originalname);
  if (leaf !== filename && (!decoded || leaf !== safeFilename(decoded))) throw invalidPath();
  return { filename: leaf, relativePath };
}
