const DEFAULT_ENDPOINT = 'https://promoshop.jhonatafaraujo.com.br';
const MAX_BATCH_SIZE = 20;
const UPLOAD_CHUNK_SIZE = 10;
const DEFAULT_DELAY_MS = 2200;

let batchState = null;

function cleanEndpoint(value) {
  try {
    const url = new URL(String(value || DEFAULT_ENDPOINT).trim());
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    return url.protocol === 'https:' || local ? url.origin.replace(/\/$/, '') : DEFAULT_ENDPOINT;
  } catch { return DEFAULT_ENDPOINT; }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSettings() {
  const settings = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, token: '' });
  return { ...settings, endpoint: cleanEndpoint(settings.endpoint) };
}

function validProductUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!/^https:$/.test(url.protocol) || !/(^|\.)mercadolivre\.com\.br$/i.test(url.hostname)) return '';
    if (!/MLB(?:U)?-?\d+/i.test(`${url.pathname}${url.search}`)) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizedCandidates(candidates) {
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const url = validProductUrl(candidate?.url || candidate?.productUrl);
      if (!url) return null;
      return {
        url,
        title: String(candidate?.title || 'Produto Mercado Livre').replace(/\s+/g, ' ').trim().slice(0, 300)
      };
    })
    .filter((candidate) => candidate && !seen.has(candidate.url) && seen.add(candidate.url))
    .slice(0, MAX_BATCH_SIZE);
}

function snapshot(state) {
  if (!state) return { status: 'idle' };
  return {
    batchId: state.batchId,
    status: state.status,
    total: state.candidates.length,
    completed: state.completed,
    currentTitle: state.currentTitle || '',
    capturedCount: state.captured.length,
    failedCount: state.failed.length,
    failures: state.failed.slice(-20),
    uploadedCount: state.uploadedCount,
    duplicateCount: state.duplicateCount,
    message: state.message || '',
    startedAt: state.startedAt,
    finishedAt: state.finishedAt || null
  };
}

async function notify(state) {
  const value = snapshot(state);
  await chrome.storage.local.set({ mlBatchStatus: value });
  try {
    await chrome.runtime.sendMessage({ type: 'ML_BATCH_PROGRESS', status: value });
  } catch {
    // O popup pode estar fechado durante a captura; o status fica salvo para a próxima abertura.
  }
}

function waitForTabReady(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(ready);
    };
    const onUpdated = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === 'complete') finish(true);
    };
    const onRemoved = (removedId) => {
      if (removedId === tabId) finish(false);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return finish(false);
      if (tab?.status === 'complete') finish(true);
    });
  });
}

async function captureCandidateInTab(state, candidate, active) {
  const tab = await chrome.tabs.create({ url: candidate.url, active });
  state.activeTabId = tab.id;
  try {
    const ready = await waitForTabReady(tab.id, 30000);
    if (!ready) throw new Error('A página do Mercado Livre não terminou de carregar.');
    await wait(1200);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_ML_OFFER' });
    if (response?.error) throw new Error(response.error);
    if (!response?.offer) throw new Error('A extensão não encontrou uma oferta válida nesta página.');
    return response.offer;
  } finally {
    state.activeTabId = null;
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

async function captureCandidate(state, candidate) {
  try {
    return await captureCandidateInTab(state, candidate, false);
  } catch (error) {
    const message = String(error?.message || '');
    if (!/barra de afiliados|não concluiu a geração|não terminou de carregar|receiving end|message port closed/i.test(message)) throw error;
    // Algumas instalações da Barra de Afiliados só exibem o botão em uma aba visível.
    // Tente uma vez com foco e feche a aba ao terminar, sem alterar a aba original.
    return captureCandidateInTab(state, candidate, true);
  }
}

async function uploadChunk(state, chunk, settings) {
  if (!chunk.length) return;
  const response = await fetch(`${settings.endpoint}/api/extension/mercadolivre/offers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-promoshop-extension-token': settings.token
    },
    body: JSON.stringify({ offers: chunk })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.errors?.join(' · ') || `O PromoShop recusou o lote (${response.status}).`);
  state.uploadedCount += Number(payload.imported?.length || 0);
  state.duplicateCount += Number(payload.duplicates?.length || 0);
  const rejected = Array.isArray(payload.errors) ? payload.errors : [];
  if (rejected.length) state.uploadErrors.push(...rejected.slice(0, 10));
  state.message = `${state.uploadedCount} oferta(s) confirmada(s) pelo PromoShop.`;
  await notify(state);
}

async function runBatch(state, settings) {
  const capturedOffers = [];
  try {
    for (let index = 0; index < state.candidates.length; index += 1) {
      if (state.cancelRequested) break;
      const candidate = state.candidates[index];
      state.currentTitle = candidate.title;
      state.message = 'Abrindo a página individual e gerando o link oficial…';
      await notify(state);
      try {
        const offer = await captureCandidate(state, candidate);
        state.captured.push({ title: offer.title || candidate.title, url: candidate.url });
        capturedOffers.push(offer);
        state.message = 'Link oficial gerado. Aguardando o próximo produto…';
      } catch (error) {
        state.failed.push({ title: candidate.title, error: error.message || 'Falha ao capturar.' });
        state.message = `Falha ignorada: ${error.message || 'não foi possível capturar.'}`;
      }
      state.completed = index + 1;
      await notify(state);

      if (capturedOffers.length >= UPLOAD_CHUNK_SIZE) {
        const chunk = capturedOffers.splice(0, UPLOAD_CHUNK_SIZE);
        try {
          await uploadChunk(state, chunk, settings);
        } catch (error) {
          state.failed.push(...chunk.map((offer) => ({ title: offer.title, error: `Falha ao enviar ao PromoShop: ${error.message}` })));
          state.message = error.message || 'Falha ao enviar o lote ao PromoShop.';
          await notify(state);
        }
      }
      if (!state.cancelRequested && index < state.candidates.length - 1) await wait(state.delayMs);
    }

    if (capturedOffers.length) {
      const finalChunk = capturedOffers.splice(0, UPLOAD_CHUNK_SIZE);
      try {
        await uploadChunk(state, finalChunk, settings);
      } catch (error) {
        state.failed.push(...finalChunk.map((offer) => ({ title: offer.title, error: `Falha ao enviar ao PromoShop: ${error.message}` })));
        state.message = error.message || 'Falha ao enviar o lote ao PromoShop.';
      }
    }
    state.status = state.cancelRequested ? 'cancelled' : 'completed';
    state.currentTitle = '';
    state.finishedAt = new Date().toISOString();
    state.message = state.cancelRequested
      ? 'Captura cancelada. Os produtos já confirmados foram mantidos.'
      : `${state.uploadedCount} oferta(s) enviada(s); ${state.failed.length} falha(s).`;
  } catch (error) {
    state.status = 'completed';
    state.currentTitle = '';
    state.finishedAt = new Date().toISOString();
    state.message = error.message || 'O lote foi interrompido.';
  } finally {
    state.activeTabId = null;
    await notify(state);
  }
}

async function startBatch(message) {
  if (batchState?.status === 'running') throw new Error('Já existe um lote em andamento.');
  const settings = await getSettings();
  if (!settings.token) throw new Error('Informe o token da extensão no popup.');
  const candidates = normalizedCandidates(message.candidates);
  if (!candidates.length) throw new Error('Nenhum produto individual válido foi selecionado.');
  batchState = {
    batchId: globalThis.crypto?.randomUUID?.() || `ml-batch-${Date.now()}`,
    status: 'running',
    candidates,
    completed: 0,
    currentTitle: '',
    captured: [],
    failed: [],
    uploadErrors: [],
    uploadedCount: 0,
    duplicateCount: 0,
    cancelRequested: false,
    activeTabId: null,
    delayMs: Math.max(1200, Math.min(Number(message.delayMs) || DEFAULT_DELAY_MS, 10000)),
    startedAt: new Date().toISOString(),
    message: 'Lote iniciado.'
  };
  await notify(batchState);
  runBatch(batchState, settings).catch(() => {});
  return snapshot(batchState);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'START_ML_BATCH') {
    startBatch(message).then((status) => sendResponse({ ok: true, status })).catch((error) => sendResponse({ error: error.message || 'Não foi possível iniciar o lote.' }));
    return true;
  }
  if (message?.type === 'CANCEL_ML_BATCH') {
    if (!batchState || batchState.status !== 'running') {
      sendResponse({ error: 'Não existe um lote em andamento.' });
      return false;
    }
    batchState.cancelRequested = true;
    if (batchState.activeTabId) chrome.tabs.remove(batchState.activeTabId).catch(() => {});
    batchState.message = 'Cancelamento solicitado…';
    notify(batchState).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'GET_ML_BATCH_STATUS') {
    if (batchState) {
      sendResponse({ status: snapshot(batchState) });
      return false;
    }
    chrome.storage.local.get({ mlBatchStatus: { status: 'idle' } }).then((value) => sendResponse({ status: value.mlBatchStatus })).catch(() => sendResponse({ status: { status: 'idle' } }));
    return true;
  }
  return false;
});
