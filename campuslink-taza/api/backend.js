import express from 'express';
import { createApp } from '../server/app.js';

const backendPromise = createApp();

const app = express();

app.use(async (req, res, next) => {
  try {
    const backend = await backendPromise;

    const capturedPath = req.query.__path;

    if (typeof capturedPath === 'string') {
      const query = new URLSearchParams();

      for (const [key, value] of Object.entries(req.query)) {
        if (key === '__path') continue;

        if (Array.isArray(value)) {
          for (const item of value) query.append(key, item);
        } else if (value !== undefined) {
          query.append(key, String(value));
        }
      }

      req.url =
        `/api/${capturedPath}` +
        (query.toString() ? `?${query.toString()}` : '');
    }

    return backend(req, res);
  } catch (error) {
    next(error);
  }
});

export default app;
