const MAX_ALERTS = 200;
const MAX_RECENT_KEYS = 300;
const DEFAULT_COOLDOWN_MINUTES = 5;
const STALE_SENDING_MS = 10 * 60 * 1000;
const INFO_BATCH_MAX_MESSAGES = 2;
const INFO_BATCH_MESSAGE_LENGTH = 3400;

const LEVELS = new Set(['info', 'success', 'warning', 'error']);

function compactText(value, maximum = 600) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function redact(value) {
  return compactText(value)
    .replace(/(bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/(["']?(?:api[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|password|cookie|csrf|authorization)["']?\s*[:=]\s*["']?)([^"',; }\]]+)(["']?)/gi, '$1[redacted]$3')
    .replace(/([?&](?:token|key|secret|password|access_token|refresh_token)=)[^&#\s]+/gi, '$1[redacted]');
}

export function sanitizeMonitoringMessage(value, fallback = 'Evento operacional sem detalhes.') {
  const sanitized = redact(value);
  return sanitized || fallback;
}

export function normalizeMonitoringRecipient(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^[a-z0-9_-]{8,80}@[a-z.]+$/i.test(raw) && /@(c\.us|g\.us|newsletter)$/i.test(raw)) return raw.toLowerCase();
  let digits = raw.replace(/\D/g, '');
  // O painel é brasileiro e muitos usuários informam o celular apenas com
  // DDD. Complete o código do país nesse caso para evitar um JID inválido.
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
  if (/^\d{10,15}$/.test(digits)) return `${digits}@c.us`;
  return '';
}

export function monitoringRecipientForConfig(config = {}, environment = process.env) {
  return normalizeMonitoringRecipient(
    config.monitoringWhatsappRecipient || environment.MONITORING_WHATSAPP_RECIPIENT || ''
  );
}

export function monitoringEnabledForConfig(config = {}, environment = process.env) {
  return config.monitoringWhatsappEnabled === true && Boolean(monitoringRecipientForConfig(config, environment));
}

function shouldNotify(config = {}, type, level) {
  if (type === 'test') return true;
  if (type === 'deploy') return config.monitoringWhatsappDeployAlerts !== false;
  if (['server', 'recovery'].includes(type)) return config.monitoringWhatsappServerAlerts !== false;
  if (level === 'info' || level === 'success') return config.monitoringWhatsappIncludeInfo === true;
  return ['warning', 'error'].includes(level);
}

function pruneRecent(recent, now) {
  for (const [key, timestamp] of Object.entries(recent || {})) {
    if (!Number.isFinite(Number(timestamp)) || now - Number(timestamp) > 24 * 60 * 60 * 1000) delete recent[key];
  }
  const keys = Object.keys(recent || {});
  if (keys.length > MAX_RECENT_KEYS) {
    keys.sort((left, right) => Number(recent[left] || 0) - Number(recent[right] || 0));
    keys.slice(0, keys.length - MAX_RECENT_KEYS).forEach((key) => delete recent[key]);
  }
}

function eventKey(type, level, message, dedupeKey = '') {
  if (dedupeKey) return compactText(dedupeKey, 180);
  return `${type}:${level}:${compactText(message, 220).toLocaleLowerCase('pt-BR')}`;
}

function initializeMonitoring(data) {
  data.meta ||= {};
  data.meta.monitoring ||= {};
  const monitoring = data.meta.monitoring;
  monitoring.alerts = Array.isArray(monitoring.alerts) ? monitoring.alerts : [];
  monitoring.recent = monitoring.recent && typeof monitoring.recent === 'object' ? monitoring.recent : {};
  return monitoring;
}

function isInformationalAlert(alert) {
  return alert?.type === 'log' && ['info', 'success'].includes(alert?.level);
}

function claimAlertEntry(alert, now) {
  if (!alert) return null;
  alert.status = 'sending';
  alert.attempts = Number(alert.attempts || 0) + 1;
  alert.claimedAt = new Date(now).toISOString();
  alert.lastAttemptAt = alert.claimedAt;
  return { ...alert };
}

export function enqueueMonitoringAlert(data, {
  type = 'log',
  level = 'error',
  message = '',
  dedupeKey = '',
  force = false,
  createdAt = new Date().toISOString(),
  metadata = null
} = {}) {
  const config = data?.config || {};
  const normalizedType = ['log', 'deploy', 'server', 'recovery', 'test'].includes(type) ? type : 'log';
  const normalizedLevel = LEVELS.has(level) ? level : 'info';
  const text = sanitizeMonitoringMessage(message);
  if (!monitoringEnabledForConfig(config)) return null;
  if (!shouldNotify(config, normalizedType, normalizedLevel)) return null;

  const monitoring = initializeMonitoring(data);
  const now = Date.now();
  pruneRecent(monitoring.recent, now);
  const key = eventKey(normalizedType, normalizedLevel, text, dedupeKey);
  const cooldownMs = Math.max(1, Number(config.monitoringWhatsappCooldownMinutes || DEFAULT_COOLDOWN_MINUTES)) * 60_000;
  if (!force && Number(monitoring.recent[key] || 0) + cooldownMs > now) return null;
  monitoring.recent[key] = now;

  const alert = {
    id: `monitor_${now}_${Math.random().toString(16).slice(2, 10)}`,
    type: normalizedType,
    level: normalizedLevel,
    message: text,
    metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
    status: 'pending',
    attempts: 0,
    createdAt,
    availableAt: new Date(now).toISOString(),
    sentAt: null,
    lastError: null
  };
  monitoring.alerts.push(alert);
  monitoring.alerts = monitoring.alerts.slice(-MAX_ALERTS);
  return alert;
}

function reclaimStaleSending(alert, now) {
  if (alert?.status !== 'sending') return false;
  const claimedAt = new Date(alert.claimedAt || 0).getTime();
  if (!Number.isFinite(claimedAt) || now - claimedAt < STALE_SENDING_MS) return false;
  alert.status = 'pending';
  alert.availableAt = new Date(now).toISOString();
  alert.claimedAt = null;
  return true;
}

export function hasMonitoringAlertReady(data, now = Date.now()) {
  const alerts = Array.isArray(data?.meta?.monitoring?.alerts) ? data.meta.monitoring.alerts : [];
  return alerts.some((alert) => {
    if (alert?.status === 'pending') {
      const availableAt = new Date(alert.availableAt || alert.createdAt || 0).getTime();
      return Number.isFinite(availableAt) && availableAt <= now;
    }
    if (alert?.status === 'sending') {
      const claimedAt = new Date(alert.claimedAt || 0).getTime();
      return !Number.isFinite(claimedAt) || now - claimedAt >= STALE_SENDING_MS;
    }
    return false;
  });
}

export function claimMonitoringAlert(data, now = Date.now()) {
  const monitoring = initializeMonitoring(data);
  for (const alert of monitoring.alerts) reclaimStaleSending(alert, now);
  const alert = monitoring.alerts.find((entry) => (
    entry?.status === 'pending' &&
    new Date(entry.availableAt || entry.createdAt || 0).getTime() <= now
  ));
  return claimAlertEntry(alert, now);
}

/**
 * Claims one important alert or all ready informational records as a batch.
 * Informational records remain individually stored in the activity log, but
 * the WhatsApp worker can deliver their digest in at most two messages.
 */
export function claimMonitoringAlertBatch(data, now = Date.now()) {
  const monitoring = initializeMonitoring(data);
  for (const alert of monitoring.alerts) reclaimStaleSending(alert, now);

  const ready = monitoring.alerts.filter((entry) => (
    entry?.status === 'pending' &&
    new Date(entry.availableAt || entry.createdAt || 0).getTime() <= now
  ));
  if (!ready.length) return null;

  // Warnings, errors, deploys and lifecycle events always go first. They are
  // never hidden inside an informational digest.
  const important = ready.find((entry) => !isInformationalAlert(entry));
  if (important) {
    return {
      informational: false,
      alerts: [claimAlertEntry(important, now)]
    };
  }

  const informational = ready.filter(isInformationalAlert);
  return {
    informational: true,
    alerts: informational.map((entry) => claimAlertEntry(entry, now)).filter(Boolean)
  };
}

export function markMonitoringAlertSent(data, id, now = new Date()) {
  const monitoring = initializeMonitoring(data);
  const alert = monitoring.alerts.find((entry) => entry.id === String(id));
  if (!alert) return false;
  alert.status = 'sent';
  alert.sentAt = now.toISOString();
  alert.claimedAt = null;
  alert.lastError = null;
  return true;
}

export function failMonitoringAlert(data, id, error, now = Date.now()) {
  const monitoring = initializeMonitoring(data);
  const alert = monitoring.alerts.find((entry) => entry.id === String(id));
  if (!alert) return false;
  const attempts = Number(alert.attempts || 0);
  alert.lastError = sanitizeMonitoringMessage(error, 'Falha ao entregar o alerta.').slice(0, 240);
  alert.failedAt = new Date(now).toISOString();
  alert.claimedAt = null;
  if (attempts >= 3) {
    alert.status = 'failed';
    alert.availableAt = null;
  } else {
    alert.status = 'pending';
    alert.availableAt = new Date(now + Math.min(15 * 60_000, 30_000 * (2 ** Math.max(0, attempts - 1)))).toISOString();
  }
  return true;
}

/**
 * Recoloca somente os alertas que já esgotaram as tentativas na fila.
 * Alertas pendentes não são alterados, para não mudar a ordem de entrega.
 */
export function retryFailedMonitoringAlerts(data, now = Date.now()) {
  const monitoring = initializeMonitoring(data);
  let retried = 0;
  for (const alert of monitoring.alerts) {
    if (alert?.status !== 'failed') continue;
    alert.status = 'pending';
    alert.attempts = 0;
    alert.availableAt = new Date(now).toISOString();
    alert.claimedAt = null;
    alert.sentAt = null;
    alert.failedAt = null;
    alert.lastAttemptAt = null;
    alert.lastError = null;
    retried += 1;
  }
  return retried;
}

export function formatMonitoringAlert(alert = {}, context = {}) {
  const labels = {
    log: 'Registro do servidor',
    deploy: 'Novo deploy',
    server: 'Servidor iniciado',
    recovery: 'Servidor recuperado',
    test: 'Teste de monitoramento'
  };
  const levelLabels = { info: 'informação', success: 'sucesso', warning: 'atenção', error: 'erro' };
  const date = new Date(alert.createdAt || Date.now()).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const lines = [
    '🔔 PromoShop · monitoramento',
    `Tipo: ${labels[alert.type] || 'Evento operacional'}${alert.level ? ` (${levelLabels[alert.level] || alert.level})` : ''}`,
    `Horário: ${date}`,
    `Mensagem: ${sanitizeMonitoringMessage(alert.message, 'Sem detalhes.')}`
  ];
  if (context.service) lines.push(`Serviço: ${compactText(context.service, 100)}`);
  if (context.deployKey) lines.push(`Versão: ${compactText(context.deployKey, 100)}`);
  if (context.downtimeMinutes != null) lines.push(`Indisponibilidade estimada: ${Math.max(0, Math.round(Number(context.downtimeMinutes) || 0))} min`);
  return lines.join('\n').slice(0, 3500);
}

function formatInfoLine(alert) {
  const date = new Date(alert?.createdAt || Date.now()).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short'
  });
  return `• ${date} — ${compactText(sanitizeMonitoringMessage(alert?.message, 'Sem detalhes.'), 260)}`;
}

/**
 * Formats an informational digest into one or two WhatsApp-safe messages.
 * Older entries that do not fit are explicitly counted; the full records
 * remain available in the panel activity log.
 */
export function formatMonitoringInfoBatch(alerts = []) {
  const entries = Array.isArray(alerts) ? alerts.filter(isInformationalAlert) : [];
  if (!entries.length) return [];
  if (entries.length === 1) return [formatMonitoringAlert(entries[0], entries[0].metadata || {})];

  const headerLength = 80;
  const messageCapacity = INFO_BATCH_MESSAGE_LENGTH - headerLength;
  const totalCapacity = messageCapacity * INFO_BATCH_MAX_MESSAGES;
  const allLines = entries.map(formatInfoLine);
  const shownLines = [];
  let used = 0;
  let omitted = 0;

  // Keep the newest records when a large backlog cannot fit in two messages.
  for (let index = allLines.length - 1; index >= 0; index -= 1) {
    const line = allLines[index];
    const lineLength = line.length + 1;
    if (used + lineLength <= totalCapacity) {
      shownLines.unshift(line);
      used += lineLength;
    } else {
      omitted += 1;
    }
  }

  const summary = omitted
    ? `Total: ${entries.length}. Exibindo os ${shownLines.length} mais recentes; ${omitted} anterior(es) continuam no histórico do painel.`
    : `Total: ${entries.length}.`;
  const availablePerMessage = Math.max(200, INFO_BATCH_MESSAGE_LENGTH - summary.length - 55);
  const targetFirstLength = Math.ceil(used / INFO_BATCH_MAX_MESSAGES);
  const parts = [[], []];
  let firstLength = 0;
  for (let index = 0; index < shownLines.length; index += 1) {
    const line = shownLines[index];
    const remaining = shownLines.length - index;
    const fitsFirst = firstLength + line.length + 1 <= availablePerMessage;
    if (parts[0].length && (!fitsFirst || (firstLength >= targetFirstLength && remaining > 1))) break;
    parts[0].push(line);
    firstLength += line.length + 1;
  }
  parts[1] = shownLines.slice(parts[0].length);
  if (!parts[1].length && parts[0].length > 1) {
    parts[1].unshift(parts[0].pop());
  }

  return parts.map((part, index) => (
    [
      `🔔 PromoShop · registros informativos (${index + 1}/${INFO_BATCH_MAX_MESSAGES})`,
      summary,
      '',
      part.join('\n') || 'Nenhum registro adicional nesta parte.'
    ].join('\n').slice(0, INFO_BATCH_MESSAGE_LENGTH)
  ));
}

export function monitoringQueueSummary(data = {}) {
  const alerts = Array.isArray(data.meta?.monitoring?.alerts) ? data.meta.monitoring.alerts : [];
  const latestFailure = alerts
    .filter((alert) => alert?.lastError)
    .sort((a, b) => new Date(b.failedAt || b.lastAttemptAt || b.createdAt || 0) - new Date(a.failedAt || a.lastAttemptAt || a.createdAt || 0))[0];
  return {
    pending: alerts.filter((alert) => ['pending', 'sending'].includes(alert?.status)).length,
    sent: alerts.filter((alert) => alert?.status === 'sent').length,
    failed: alerts.filter((alert) => alert?.status === 'failed').length,
    total: alerts.length,
    lastSentAt: alerts.filter((alert) => alert?.status === 'sent').sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))[0]?.sentAt || null,
    lastFailure: latestFailure
      ? {
        message: sanitizeMonitoringMessage(latestFailure.lastError, 'Falha ao entregar o alerta.'),
        status: latestFailure.status || 'pending',
        attempts: Number(latestFailure.attempts || 0),
        at: latestFailure.failedAt || latestFailure.lastAttemptAt || latestFailure.createdAt || null
      }
      : null
  };
}
