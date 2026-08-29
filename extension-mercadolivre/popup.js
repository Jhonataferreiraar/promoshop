const endpoint = document.querySelector('#endpoint');
const token = document.querySelector('#token');
const status = document.querySelector('#status');
const preview = document.querySelector('#preview');
const captureButton = document.querySelector('#capture');
const sendButton = document.querySelector('#send');
let offer = null;
const money = (value) => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const setStatus = (message) => { status.textContent = message; };

async function load() {
  const saved = await chrome.storage.local.get({ endpoint: 'https://promoshop.jhonatafaraujo.com.br', token: '' });
  endpoint.value = saved.endpoint;
  token.value = saved.token;
}
async function save() {
  await chrome.storage.local.set({ endpoint: endpoint.value.trim(), token: token.value.trim() });
  setStatus('Conexão salva somente nesta extensão.');
}
async function capture() {
  captureButton.disabled = true;
  sendButton.disabled = true;
  setStatus('Gerando o link oficial e lendo a oferta…');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    if (!tab?.id) throw new Error('Não encontrei a aba do Mercado Livre.');
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_ML_OFFER' });
    if (response?.error) throw new Error(response.error);
    offer = response.offer;
    document.querySelector('#image').src = offer.image;
    document.querySelector('#image').alt = offer.title;
    document.querySelector('#title').textContent = offer.title;
    document.querySelector('#prices').textContent = `${money(offer.price)} · ${offer.discount}% OFF`;
    preview.hidden = false;
    sendButton.disabled = false;
    setStatus('Oferta pronta. Confira e envie ao PromoShop.');
  } catch (error) {
    offer = null;
    preview.hidden = true;
    setStatus(error.message || 'Não foi possível ler esta página. Atualize a aba e tente novamente.');
  } finally { captureButton.disabled = false; }
}
async function send() {
  if (!offer) return;
  sendButton.disabled = true;
  setStatus('Enviando ao PromoShop…');
  const response = await chrome.runtime.sendMessage({ type: 'SEND_ML_OFFER', offer });
  setStatus(response?.error || response?.message || 'Oferta enviada.');
  sendButton.disabled = false;
}
document.querySelector('#save').addEventListener('click', save);
captureButton.addEventListener('click', capture);
sendButton.addEventListener('click', send);
load();
