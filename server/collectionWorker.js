import 'dotenv/config';

import { parentPort } from 'node:worker_threads';

import { collectOfferCandidates } from './collectors.js';

try {
  const result = await collectOfferCandidates();
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: String(error?.message || error).slice(0, 500)
  });
}
