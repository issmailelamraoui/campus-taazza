import { setTimeout as sleep } from 'node:timers/promises';

// createApp releases its owned resources after a failed attempt. Retry only
// transport failures; configuration and schema errors need an explicit fix.
export async function initializeWithRetry(initialize, { wait = sleep, log = console.error } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await initialize(); }
    catch (error) {
      if (error?.code !== 'DATABASE_UNAVAILABLE' || attempt === 3) throw error;
      const delay = attempt * 1000;
      log(`CampusLink API: database temporarily unavailable; retrying startup (${attempt + 1}/3) in ${delay}ms.`);
      await wait(delay);
    }
  }
}
