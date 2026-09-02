import assert from 'node:assert/strict';
import {
  claimMonitoringAlert,
  claimMonitoringAlertBatch,
  enqueueMonitoringAlert,
  failMonitoringAlert,
  formatMonitoringAlert,
  formatMonitoringInfoBatch,
  markMonitoringAlertSent,
  monitoringEnabledForConfig,
  normalizeMonitoringRecipient,
  monitoringQueueSummary,
  retryFailedMonitoringAlerts,
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
assert.equal(normalizeMonitoringRecipient('(61) 99999-9999'), '5561999999999@c.us');
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
const retryData = { config, meta: { monitoring: { alerts: [], recent: {} } } };
const retryAlert = enqueueMonitoringAlert(retryData, { type: 'log', level: 'error', message: 'Falha final', force: true });
assert.ok(retryAlert?.id);
const failedForRetry = claimMonitoringAlert(retryData);
assert.ok(failedForRetry?.id);
retryData.meta.monitoring.alerts.find((entry) => entry.id === failedForRetry.id).attempts = 3;
assert.equal(failMonitoringAlert(retryData, failedForRetry.id, 'Falha final'), true);
assert.equal(retryData.meta.monitoring.alerts.find((entry) => entry.id === failedForRetry.id)?.status, 'failed');
assert.equal(retryFailedMonitoringAlerts(retryData, Date.parse('2026-09-02T12:05:00.000Z')), 1);
assert.equal(retryData.meta.monitoring.alerts.find((entry) => entry.id === failedForRetry.id)?.status, 'pending');
assert.equal(monitoringQueueSummary(retryData).lastFailure, null);

const text = formatMonitoringAlert({ type: 'deploy', level: 'success', message: 'Deploy com apiKey=oculta', createdAt: '2026-09-02T12:00:00.000Z' }, { service: 'PromoShop', deployKey: 'abc123' });
assert.match(text, /Novo deploy/);
assert.match(text, /apiKey=\[redacted\]/);
assert.match(text, /abc123/);

const batchConfig = { ...config, monitoringWhatsappIncludeInfo: true };
const batchData = { batchConfig, config: batchConfig, meta: { monitoring: { alerts: [], recent: {} } } };
for (let index = 1; index <= 6; index += 1) {
  assert.ok(enqueueMonitoringAlert(batchData, {
    type: 'log',
    level: 'info',
    message: `Registro informativo ${index}`,
    force: true
  }));
}
assert.ok(enqueueMonitoringAlert(batchData, {
  type: 'log',
  level: 'error',
  message: 'Falha prioritária',
  force: true
}));
const importantBatch = claimMonitoringAlertBatch(batchData);
assert.equal(importantBatch?.informational, false);
assert.equal(importantBatch?.alerts?.[0]?.message, 'Falha prioritária');
markMonitoringAlertSent(batchData, importantBatch.alerts[0].id);
const infoBatch = claimMonitoringAlertBatch(batchData);
assert.equal(infoBatch?.informational, true);
assert.equal(infoBatch?.alerts?.length, 6);
const infoTexts = formatMonitoringInfoBatch(infoBatch.alerts);
assert.equal(infoTexts.length, 2);
assert.ok(infoTexts.every((entry) => entry.length <= 3400));
assert.match(infoTexts[0], /Parte|registros informativos/);
for (const entry of infoBatch.alerts) markMonitoringAlertSent(batchData, entry.id);

console.log('Monitoramento operacional: testes passaram.');
