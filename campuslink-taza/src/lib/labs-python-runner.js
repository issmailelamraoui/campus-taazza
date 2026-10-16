import { pythonFramePolicy } from '../../shared/labs-security.js';

// A sandboxed frame owns the Python Worker. Its opaque origin denies private
// origin storage even if Python reaches JavaScript through Pyodide's ffi.
export function createPythonWorker(version) {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.referrerPolicy = 'no-referrer';
  const origin = location.origin;
  // srcdoc inherits the creator's network address space while retaining the
  // sandbox's opaque origin. This also works on local development servers.
  frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${pythonFramePolicy(origin).replaceAll('"', '&quot;')}"><script type="module" src="${origin}/labs-runtime/python-frame.js?v=${encodeURIComponent(version)}"></script>`;
  let ready = false, pending, terminated = false;
  const worker = {
    onmessage: null,
    onerror: null,
    postMessage(data) {
      pending = data;
      if (ready && !terminated) frame.contentWindow.postMessage({ channel: 'campus-labs-python', type: 'start', data }, '*');
    },
    terminate() {
      if (terminated) return;
      terminated = true;
      window.removeEventListener('message', receive);
      frame.contentWindow?.postMessage({ channel: 'campus-labs-python', type: 'stop' }, '*');
      // Removing its owning document also disposes the dedicated Worker.
      frame.remove();
      pending = undefined;
    },
  };
  function receive(event) {
    if (terminated || event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.channel !== 'campus-labs-python') return;
    if (event.data.type === 'ready') {
      if (ready) return;
      ready = true;
      if (pending) worker.postMessage(pending);
    } else if (event.data.type === 'message') worker.onmessage?.({ data: event.data.data });
    else if (event.data.type === 'error') worker.onerror?.({ message: event.data.message, preventDefault() {} });
  }
  window.addEventListener('message', receive);
  (document.body || document.documentElement).append(frame);
  return worker;
}
