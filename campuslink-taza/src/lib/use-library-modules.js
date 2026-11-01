import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { mergeLibraryModuleFolders } from './library-browse.js';
import { normalizeModule } from './resources.js';

// Catalogues belong to one account and academic scope. A late reply from a
// previous semester must never populate the current semester's selector.
export function useLibraryModules(resources, userId, facultyId, filiereId, semester) {
  const key = JSON.stringify([userId, facultyId, filiereId, semester]);
  const membership = useMemo(() => JSON.stringify(resources.map(item => [String(item.id), normalizeModule(item.module)]).sort((a, b) => a[0].localeCompare(b[0]))), [resources]);
  const [request, setRequest] = useState({ key: '', status: 'idle', entries: [] });
  const [revision, setRevision] = useState(0);
  const ready = Boolean(userId && facultyId && filiereId);
  useEffect(() => {
    // Some modules only have chat attachments, absent from Library resources.
    // Their last-file removal must invalidate this catalogue as well.
    const synchronize = event => {
      if (event.detail?.presence || event.detail?.discussionReads) return;
      setRevision(value => value + 1);
    };
    window.addEventListener('campus-live-update', synchronize);
    return () => window.removeEventListener('campus-live-update', synchronize);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let active = true;
    setRequest({ key, status: 'loading', entries: [] });
    const params = new URLSearchParams({ filiere_id: filiereId, semester: String(semester) });
    api(`/modules?${params}`, { signal: controller.signal }).then(data => {
      if (!Array.isArray(data.modules)) throw new Error('Invalid module catalogue');
      if (active) setRequest({ key, status: 'ready', entries: data.modules });
    }).catch(error => {
      if (active && error.name !== 'AbortError') setRequest({ key, status: 'error', entries: [] });
    });
    return () => { active = false; controller.abort(); };
  }, [key, ready, filiereId, semester, membership, revision]);
  const current = request.key === key ? request : { status: ready ? 'loading' : 'idle', entries: [] };
  const folders = useMemo(() => mergeLibraryModuleFolders(resources, current.entries, { facultyId, filiereId, semester }),
    [resources, current.entries, facultyId, filiereId, semester]);
  return { folders, status: current.status, retry: () => setRevision(value => value + 1) };
}
