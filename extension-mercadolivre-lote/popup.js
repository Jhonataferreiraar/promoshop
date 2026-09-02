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
const progressWrap = document.querySelector('.progress-wrap');
const progress = document.querySelector('#progress');
const progressText = document.querySelector('#progressText');
const progressCount = document.querySelector('#progressCount');
const report = document.querySelector('#report');
let candidates = [];
let batchRunning = false;

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
  selectedCount.textContent = `${count}/${Number(limit.value)} selecionados`;
  startButton.disabled = batchRunning || count === 0;
  selectAll.checked = candidates.length > 0 && count === candidates.length;
}

function renderCandidates() {
  results.innerHTML = candidates.map((candidate, index) => `
    <label class="candidate">
      <input type="checkbox" data-index="${index}" ${index < Number(limit.value) ? 'checked' : ''} />
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
      ? `${candidates.length} produto(s) encontrado(s). Selecione até ${limit.value} para capturar.`
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
  const selected = selectedCandidates().slice(0, Number(limit.value));
  if (!selected.length) return setStatus('Selecione pelo menos um produto.');
  if (selectedCandidates().length > selected.length) setStatus(`Serão capturados os primeiros ${selected.length} produtos selecionados.`);
  startButton.disabled = true;
  scanButton.disabled = true;
  cancelButton.hidden = false;
  report.hidden = false;
  report.textContent = 'Preparando as páginas individuais…';
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'START_ML_BATCH', candidates: selected, delayMs: 2200 });
  } catch {
    response = { error: 'Não foi possível iniciar a captura. Recarregue a extensão e tente novamente.' };
  }
  if (response?.error) {
    batchRunning = false;
    cancelButton.hidden = true;
    scanButton.disabled = false;
    updateSelectionCount();
    setStatus(response.error);
    return;
  }
  batchRunning = true;
  setStatus('Lote iniciado. Você pode continuar usando o navegador.');
  renderProgress(response.status || { total: selected.length, completed: 0, currentTitle: selected[0]?.title });
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
  report.hidden = false;
  report.textContent = `${summary}${state?.message ? `\n${state.message}` : ''}`;
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
cancelButton.addEventListener('click', cancelBatch);
limit.addEventListener('change', () => {
  const inputs = [...results.querySelectorAll('input[data-index]')];
  inputs.forEach((input, index) => { input.checked = index < Number(limit.value); });
  updateSelectionCount();
});
selectAll.addEventListener('change', () => {
  const inputs = [...results.querySelectorAll('input[data-index]')];
  inputs.forEach((input, index) => { input.checked = selectAll.checked && index < Number(limit.value); });
  updateSelectionCount();
});
load();
