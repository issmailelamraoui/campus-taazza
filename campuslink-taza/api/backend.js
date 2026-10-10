import { createApp } from '../server/app.js';
import { createVercelHandler } from '../server/vercel-handler.js';

export default createVercelHandler(() => {
  process.env.CAMPUS_STORAGE_PREFIX = 'campuslink-prj/';
  process.env.COOKIE_SECURE = 'true';
  return createApp({
    schema: 'campuslink_prj',
    migrate: false,
    seed: false,
    appOrigin: process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.APP_ORIGIN,
  });
});
