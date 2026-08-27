import assert from 'node:assert/strict';
import {
  getWhatsappPublicationIntervalState,
  getWhatsappRoundIntervalState,
  normalizeWhatsappIntervalMinutes
} from '../server/whatsappSchedule.js';

const now = Date.parse('2026-08-27T15:00:00.000Z');

assert.equal(normalizeWhatsappIntervalMinutes(5), 5);
assert.equal(normalizeWhatsappIntervalMinutes('20'), 20);
assert.equal(normalizeWhatsappIntervalMinutes(7), 15);

assert.equal(getWhatsappPublicationIntervalState([], 15, now).elapsed, true);
assert.equal(getWhatsappPublicationIntervalState([
  { status: 'sent', sentAt: '2026-08-27T14:50:01.000Z' }
], 15, now).elapsed, false);
assert.equal(getWhatsappPublicationIntervalState([
  { status: 'sent', sentAt: '2026-08-27T14:45:00.000Z' }
], 15, now).elapsed, true);
assert.equal(getWhatsappPublicationIntervalState([
  { status: 'failed', sentAt: '2026-08-27T14:59:00.000Z' },
  { status: 'sent', sentAt: '2026-08-27T14:30:00.000Z' }
], 15, now).elapsed, true);
assert.equal(getWhatsappPublicationIntervalState([
  {
    status: 'failed',
    failedAt: '2026-08-27T14:55:00.000Z',
    deliveryAttemptedDestinationIds: ['1201@g.us']
  }
], 10, now).elapsed, false);
assert.equal(getWhatsappPublicationIntervalState([
  {
    status: 'failed',
    failedAt: '2026-08-27T14:59:00.000Z',
    deliveryAttemptedDestinationIds: []
  }
], 10, now).elapsed, true);

const waiting = getWhatsappPublicationIntervalState([
  { status: 'sent', sentAt: '2026-08-27T14:50:00.000Z' }
], 15, now);
assert.equal(waiting.remainingMs, 5 * 60_000);

const activeRound = {
  id: 'round_1',
  pendingAudienceCodes: ['G02', 'G03']
};
const continuingRound = getWhatsappRoundIntervalState([
  { status: 'sent', sentAt: '2026-08-27T14:59:30.000Z', roundId: 'round_1' }
], 10, activeRound, now);
assert.equal(continuingRound.elapsed, true);
assert.equal(continuingRound.remainingMs, 0);
assert.equal(continuingRound.continuingRound, true);

const nextRound = getWhatsappRoundIntervalState([
  { status: 'sent', sentAt: '2026-08-27T14:59:30.000Z', roundId: 'round_1' }
], 10, null, now);
assert.equal(nextRound.elapsed, false);
assert.equal(nextRound.continuingRound, false);

console.log('WhatsApp: intervalo entre ofertas automáticas validado.');
