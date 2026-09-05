const endpoint = document.querySelector('#endpoint');
const token = document.querySelector('#token');
const status = document.querySelector('#status');
const selection = document.querySelector('#selection');
const results = document.querySelector('#results');
const limit = document.querySelector('#limit');
const selectAll = document.querySelector('#selectAll');
const selectedCount = document.querySelector('#selectedCount');
const scanButton = document.querySelector('#scan');
const startButton = document.querySelector('#start');
const cancelButton = document.querySelector('#cancel');
const retryButton = document.querySelector('#retry');
const progressWrap = document.querySelector('.progress-wrap');
const progress = document.querySelector('#progress');
const progressText = document.querySelector('#progressText');
const progressCount = document.querySelector('#progressCount');
const report = document.querySelector('#report');
let candidates = [];
let batchRunning = false;
const DEFAULT_DELAY_MS = 10000;
const allProducts = () => limit.value === 'all';
const selectedLimit = () => allProducts() ? candidates.length : Number(limit.value);
const selectedLimitLabel = () => allProducts() ? 'todos os produtos encontrados' : `até ${limit.value} produtos`;

const setStatus = (message) => { status.textContent = message; };
const escapeHtml = (value) => String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const money = (value) => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function load() {
  const saved = await chrome.storage.local.get({ endpoint: 'https://promoshop.jhonatafaraujo.com.br', token: '' });
  endpoint.value = saved.endpoint;
  token.value = saved.token;
  await loadBatchStatus();
}

async function save() {
  await chrome.storage.local.set({ endpoint: endpoint.value.trim(), token: token.value.trim() });
  setStatus('Conexão salva somente nesta extensão.');
}

function selectedCandidates() {
  return [...results.querySelectorAll('input[data-index]:checked')]
    .map((input) => candidates[Number(input.dataset.index)])
    .filter(Boolean);
}

function updateSelectionCount() {
  const count = selectedCandidates().length;
  selectedCount.textContent = `${count}/${allProducts() ? candidates.length : Number(limit.value)} selecionados`;
  startButton.disabled = batchRunning || count === 0;
  selectAll.checked = candidates.length > 0 && count === candidates.length;
}

function renderCandidates() {
  results.innerHTML = candidates.map((candidate, index) => `
    <label class="candidate">
      <input type="checkbox" data-index="${index}" ${allProducts() || index < Number(limit.value) ? 'checked' : ''} />
      <img src="${escapeHtml(candidate.image)}" alt="" loading="lazy" />
      <span><strong>${escapeHtml(candidate.title || 'Produto Mercado Livre')}</strong><small>${escapeHtml(candidate.discount ? `${candidate.discount}% OFF` : 'Verificação no produto')}</small></span>
    </label>
  `).join('');
  selection.hidden = !candidates.length;
  results.querySelectorAll('input[data-index]').forEach((input) => input.addEventListener('change', updateSelectionCount));
  updateSelectionCount();
}

async function scanPage() {
  scanButton.disabled = true;
  setStatus('Lendo os produtos visíveis na página…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Não encontrei uma página ativa.');
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_ML_PRODUCTS' });
    if (response?.error) throw new Error(response.error);
    candidates = Array.isArray(response?.products) ? response.products : [];
    renderCandidates();
    setStatus(candidates.length
      ? `${candidates.length} produto(s) encontrado(s). Selecione ${selectedLimitLabel()} para capturar.`
      : 'Nenhum produto individual encontrado. Abra uma busca ou categoria do Mercado Livre.');
  } catch (error) {
    candidates = [];
    renderCandidates();
    setStatus(error.message || 'Atualize a página do Mercado Livre e tente novamente.');
  } finally {
    scanButton.disabled = batchRunning;
  }
}

async function startBatch() {
  const selected = selectedCandidates().slice(0, selectedLimit());
  if (!selected.length) return setStatus('Selecione pelo menos um produto.');
  if (selectedCandidates().length > selected.length) setStatus(`Serão capturados os primeiros ${selected.length} produtos selecionados.`);
  startButton.disabled = true;
  scanButton.disabled = true;
  cancelButton.hidden = false;
  retryButton.disabled = true;
  report.hidden = false;
  report.textContent = 'Preparando as páginas individuais…';
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'START_ML_BATCH', candidates: selected, delayMs: DEFAULT_DELAY_MS });
  } catch {
    response = { error: 'Não foi possível iniciar a captura. Recarregue a extensão e tente novamente.' };
  }
  if (response?.error) {
    batchRunning = false;
    cancelButton.hidden = true;
    retryButton.disabled = false;
    scanButton.disabled = false;
    updateSelectionCount();
    setStatus(response.error);
    return;
  }
  batchRunning = true;
  setStatus('Lote iniciado. Você pode continuar usando o navegador.');
  renderProgress(response.status || { total: selected.length, completed: 0, currentTitle: selected[0]?.title });
}

async function retryFailedBatch() {
  if (batchRunning) return;
  retryButton.disabled = true;
  startButton.disabled = true;
  scanButton.disabled = true;
  cancelButton.hidden = false;
  report.hidden = false;
  report.textContent = 'Reprocessando somente os produtos que falharam…';
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'RETRY_ML_BATCH' });
  } catch {
    response = { error: 'Não foi possível iniciar a nova tentativa. Recarregue a extensão e tente novamente.' };
  }
  if (response?.error) {
    retryButton.disabled = false;
    cancelButton.hidden = true;
    scanButton.disabled = false;
    updateSelectionCount();
    setStatus(response.error);
    return;
  }
  batchRunning = true;
  setStatus('Nova tentativa iniciada somente para as falhas.');
  renderProgress(response.status || { total: 0, completed: 0 });
}

async function cancelBatch() {
  cancelButton.disabled = true;
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'CANCEL_ML_BATCH' });
  } catch {
    response = { error: 'Não foi possível solicitar o cancelamento.' };
  }
  if (response?.error) cancelButton.disabled = false;
  setStatus(response?.error || 'Cancelamento solicitado. A página atual será encerrada com segurança.');
}

function renderProgress(state) {
  const total = Number(state?.total || 0);
  const completed = Number(state?.completed || 0);
  progressWrap.hidden = false;
  progress.max = Math.max(total, 1);
  progress.value = Math.min(completed, total);
  progressCount.textContent = `${Math.min(completed, total)}/${total}`;
  progressText.textContent = state?.currentTitle ? `Capturando: ${state.currentTitle}` : (state?.message || 'Preparando…');
  const summary = `Capturados: ${Number(state?.capturedCount || 0)} · Falhas: ${Number(state?.failedCount || 0)} · Enviados: ${Number(state?.uploadedCount || 0)}`;
  const failures = Array.isArray(state?.failures) && state.failures.length
    ? `\n\n${state.failures.map((failure) => `• ${failure.title}: ${failure.error}`).join('\n')}`
    : '';
  const retryable = Array.isArray(state?.retryableCandidates) ? state.retryableCandidates.length : 0;
  retryButton.hidden = state?.status === 'running' || retryable === 0;
  retryButton.disabled = false;
  retryButton.textContent = retryable ? `Tentar ${retryable} falha(s) novamente` : 'Tentar falhas novamente';
  report.hidden = false;
  report.textContent = `${summary}${state?.message ? `\n${state.message}` : ''}${failures}`;
}

async function loadBatchStatus() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'GET_ML_BATCH_STATUS' });
  } catch {
    return;
  }
  if (!response?.status || response.status === 'idle') return;
  renderProgress(response.status);
  if (response.status.status === 'running') {
    batchRunning = true;
    scanButton.disabled = true;
    startButton.disabled = true;
    cancelButton.hidden = false;
    setStatus('Existe um lote em andamento.');
  } else {
    batchRunning = false;
    cancelButton.hidden = true;
    scanButton.disabled = false;
    updateSelectionCount();
    setStatus(response.status.status === 'completed' ? 'Lote concluído.' : 'Lote cancelado.');
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ML_BATCH_PROGRESS') return;
  renderProgress(message.status || message);
  batchRunning = message.status?.status === 'running';
  if (!batchRunning) {
    cancelButton.hidden = true;
    cancelButton.disabled = false;
    scanButton.disabled = false;
    updateSelectionCount();
    setStatus(message.status?.status === 'completed' ? 'Lote concluído. Confira as ofertas no painel.' : 'Lote cancelado.');
  } else {
    startButton.disabled = true;
    scanButton.disabled = true;
    cancelButton.hidden = false;
  }
});

document.querySelector('#save').addEventListener('click', save);
scanButton.addEventListener('click', scanPage);
startButton.addEventListener('click', startBatch);
retryButton.addEventListener('click', retryFailedBatch);
cancelButton.addEventListener('click', cancelBatch);
limit.addEventListener('change', () => {
  const inputs = [...results.querySelectorAll('input[data-index]')];
  inputs.forEach((input, index) => { input.checked = allProducts() || index < Number(limit.value); });
  updateSelectionCount();
});
selectAll.addEventListener('change', () => {
  const inputs = [...results.querySelectorAll('input[data-index]')];
  if (selectAll.checked) limit.value = 'all';
  inputs.forEach((input) => { input.checked = selectAll.checked; });
  updateSelectionCount();
});
load();
