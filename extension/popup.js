const endpointInput = document.querySelector('#endpoint');
const tokenInput = document.querySelector('#token');
const autoSendInput = document.querySelector('#autoSend');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const sendButton = document.querySelector('#send');
const resendButton = document.querySelector('#resend');
let candidates = [];
const setStatus = (message) => { status.textContent = message; };

async function loadSettings() {
  const saved = await chrome.storage.local.get({ endpoint: 'https://promoshop.jhonatafaraujo.com.br', token: '', autoSend: false });
  endpointInput.value = saved.endpoint; tokenInput.value = saved.token; autoSendInput.checked = saved.autoSend === true;
}
async function saveSettings() { await chrome.storage.local.set({ endpoint: endpointInput.value.trim(), token: tokenInput.value.trim(), autoSend: autoSendInput.checked }); setStatus('Configuração salva nesta extensão.'); }
function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function renderCandidates() {
  results.innerHTML = candidates.map((candidate, index) => `<label class="candidate"><input type="checkbox" data-index="${index}" checked /><span><strong>${escapeHtml(candidate.title)}</strong><small>${escapeHtml(candidate.store)}${candidate.code ? ` · código ${escapeHtml(candidate.code)}` : ''}${candidate.discountValue ? ` · ${candidate.discountValue}${candidate.discountType === 'percent' ? '%' : ' OFF'}` : ''}</small></span></label>`).join('');
  sendButton.disabled = !candidates.length;
  resendButton.hidden = true;
}
async function scanPage() {
  setStatus('Lendo a página aberta…');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return setStatus('Não encontrei uma página ativa.');
  try { const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_COUPONS' }); candidates = response?.coupons || []; renderCandidates(); setStatus(candidates.length ? `${candidates.length} cupom(ns) encontrado(s). Confira antes de enviar.` : 'Nenhum cupom encontrado nesta página.'); }
  catch { setStatus('Abra uma página do Mercado Livre ou Shopee e atualize a aba.'); }
}
async function sendSelected({ allowDuplicate = false } = {}) {
  const selected = [...results.querySelectorAll('input[data-index]:checked')].map((input) => candidates[Number(input.dataset.index)]).filter(Boolean);
  if (!selected.length) return setStatus('Selecione pelo menos um cupom.');
  sendButton.disabled = true; resendButton.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'SEND_COUPONS', coupons: selected, allowDuplicate });
  if (response?.duplicates && !response.sent && !allowDuplicate) {
    resendButton.hidden = false;
    setStatus(response.message || 'Estes cupons já foram enviados.');
  } else {
    resendButton.hidden = true;
    setStatus(response?.error || response?.message || 'Enviado. Confira a revisão no painel.');
  }
  sendButton.disabled = false; resendButton.disabled = false;
}
async function resendSelected() {
  const confirmed = window.confirm('Os cupons selecionados já foram enviados. Deseja enviá-los novamente para o PromoShop?');
  if (confirmed) await sendSelected({ allowDuplicate: true });
}
document.querySelector('#save').addEventListener('click', saveSettings); document.querySelector('#scan').addEventListener('click', scanPage); sendButton.addEventListener('click', () => sendSelected()); resendButton.addEventListener('click', resendSelected); loadSettings();
