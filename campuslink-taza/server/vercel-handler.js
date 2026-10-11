import express from 'express';

function rewriteRequest(req) {
  const queryStart = req.url.indexOf('?');
  if (queryStart === -1) return;

  const rawQuery = req.url.slice(queryStart + 1);
  const query = new URLSearchParams(rawQuery);
  if (!query.has('__path')) return;

  // Keep the original encoding, order, and repeated query parameters.
  const remaining = rawQuery.split('&')
    .filter(part => !new URLSearchParams(part).has('__path'))
    .join('&');
  req.url = `/api/${query.get('__path')}${remaining ? `?${remaining}` : ''}`;
}

export function createVercelHandler(createBackend) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  let backendPromise;

  function getBackend() {
    if (!backendPromise) {
      // Initialization starts only during a request; synchronous failures also
      // reach the request's error response rather than an unhandled rejection.
      backendPromise = Promise.resolve().then(createBackend).then(backend => {
        backend.set('trust proxy', 1);
        return backend;
      }).catch(error => {
        backendPromise = undefined;
        throw error;
      });
    }
    return backendPromise;
  }

  app.use(async (req, res, next) => {
    let backend;
    try {
      backend = await getBackend();
    } catch {
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ error: 'Le service est temporairement indisponible. Réessayez.' });
    }

    rewriteRequest(req);
    // Vercel defines its own cached query getter using the original URL.
    // Express must parse the URL above with its request prototype getter.
    if (Object.getOwnPropertyDescriptor(req, 'query')?.configurable) delete req.query;
    return backend(req, res, next);
  });

  return app;
}
