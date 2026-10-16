const unavailableBody = JSON.stringify({
  error: 'Le serveur est temporairement indisponible. Réessayez dans quelques instants.',
  code: 'API_UNAVAILABLE',
});

export function configureApiProxy(proxy) {
  // Vite registers its default error handler after configure(). Ending the HTTP
  // response here prevents its empty 500, while keeping its diagnostic logging.
  proxy.on('error', (_error, _request, response) => {
    if (!response || typeof response.writeHead !== 'function' ||
      response.headersSent || response.writableEnded || response.destroyed) return;
    response.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(unavailableBody);
  });
}
