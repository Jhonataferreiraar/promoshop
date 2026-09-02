import assert from 'node:assert/strict';
import {
  claimMonitoringAlert,
  enqueueMonitoringAlert,
  failMonitoringAlert,
  formatMonitoringAlert,
  markMonitoringAlertSent,
  monitoringEnabledForConfig,
  normalizeMonitoringRecipient,
  sanitizeMonitoringMessage
} from '../server/monitoring.js';

const config = {
  monitoringWhatsappEnabled: true,
  monitoringWhatsappRecipient: '5561999999999',
  monitoringWhatsappIncludeInfo: false,
  monitoringWhatsappDeployAlerts: true,
  monitoringWhatsappServerAlerts: true,
  monitoringWhatsappCooldownMinutes: 5
};
assert.equal(normalizeMonitoringRecipient('5561999999999'), '5561999999999@c.us');
assert.equal(normalizeMonitoringRecipient('120363000000000000-1234567890@g.us'), '120363000000000000-1234567890@g.us');
assert.equal(normalizeMonitoringRecipient('not-a-number'), '');
assert.equal(monitoringEnabledForConfig(config), true);
assert.match(sanitizeMonitoringMessage('apiKey=super-secret password:abc https://x.test/?token=secret'), /\[redacted\]/);
assert.doesNotMatch(sanitizeMonitoringMessage('{"apiKey":"super-secret","password":"abc"}'), /super-secret|"abc"/);

const data = { config, meta: { monitoring: { alerts: [], recent: {} } } };
const error = enqueueMonitoringAlert(data, { type: 'log', level: 'error', message: 'Falha ao conectar banco' });
assert.ok(error?.id);
assert.equal(enqueueMonitoringAlert(data, { type: 'log', level: 'error', message: 'Falha ao conectar banco' }), null);
assert.equal(enqueueMonitoringAlert(data, { type: 'log', level: 'info', message: 'Rotina concluída' }), null);
const deployment = enqueueMonitoringAlert(data, { type: 'deploy', level: 'success', message: 'Novo deploy iniciado.', force: true, dedupeKey: 'deploy:one' });
assert.ok(deployment?.id);

const claimed = claimMonitoringAlert(data);
assert.equal(claimed?.status, 'sending');
assert.equal(markMonitoringAlertSent(data, claimed.id), true);
assert.equal(data.meta.monitoring.alerts.find((entry) => entry.id === claimed.id)?.status, 'sent');

const failed = claimMonitoringAlert(data);
assert.ok(failed?.id);
assert.equal(failMonitoringAlert(data, failed.id, 'Falha temporária'), true);
assert.equal(data.meta.monitoring.alerts.find((entry) => entry.id === failed.id)?.status, 'pending');

const text = formatMonitoringAlert({ type: 'deploy', level: 'success', message: 'Deploy com apiKey=oculta', createdAt: '2026-09-02T12:00:00.000Z' }, { service: 'PromoShop', deployKey: 'abc123' });
assert.match(text, /Novo deploy/);
assert.match(text, /apiKey=\[redacted\]/);
assert.match(text, /abc123/);

console.log('Monitoramento operacional: testes passaram.');
