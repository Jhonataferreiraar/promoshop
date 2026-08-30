import React, { useMemo, useState } from 'react';

const statusText = { pending: 'Aguardando', publishing: 'Publicando', sent: 'Publicado', failed: 'Falhou', cancelled: 'Cancelado' };
const templateText = { classic: 'Original', editorial: 'Seleção PromoShop', spotlight: 'Destaque', split: 'Capa dividida', showcase: 'Vitrine', minimal: 'Essencial', flash: 'Oferta relâmpago' };
const feedDays = [
  { value: 1, label: 'Segunda' },
  { value: 2, label: 'Terça' },
  { value: 3, label: 'Quarta' },
  { value: 4, label: 'Quinta' },
  { value: 5, label: 'Sexta' },
  { value: 6, label: 'Sábado' },
  { value: 0, label: 'Domingo' }
];

function keyFor(kind, id) { return `${kind}:${id}`; }
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR');
}
function labelFor(item, kind) {
  const discount = kind === 'coupon'
    ? (item.discountType === 'percent' ? `${item.discountValue || 0}% OFF` : 'Cupom')
    : (item.discount ? `${Math.round(Number(item.discount))}% OFF` : 'oferta');
  return `${item.title || (kind === 'coupon' ? 'Cupom' : 'Oferta')} · ${item.store || 'Loja'} · ${discount}`;
}

export default function InstagramFeedPanel({ data, setData, authApi, setMessage }) {
  const config = data.config || {};
  const [postType, setPostType] = useState('single');
  const [selected, setSelected] = useState([]);
  const [format, setFormat] = useState(config.instagramFeedFormat || 'portrait');
  const [themeId, setThemeId] = useState('');
  const [caption, setCaption] = useState(config.instagramFeedCaption || '🔥 Ofertas selecionadas do dia\n\n{offers}\n\n🔗 Acesse a bio do perfil\n\n#PromoShop #Ofertas #Promoção');
  const [scheduledFor, setScheduledFor] = useState('');
  const [previewUrls, setPreviewUrls] = useState([]);
  const [previewTemplates, setPreviewTemplates] = useState([]);
  const [busy, setBusy] = useState('');
  const themes = Array.isArray(config.instagramThemes) ? config.instagramThemes.filter((theme) => theme.enabled !== false) : [];
  const queue = useMemo(() => [...(data.instagramFeedQueue || [])].reverse(), [data.instagramFeedQueue]);
  const sources = useMemo(() => [
    ...(data.offers || []).filter((offer) => offer.status !== 'paused').map((offer) => ({ ...offer, kind: 'offer' })),
    ...(data.coupons || []).filter((coupon) => coupon.active !== false).map((coupon) => ({ ...coupon, kind: 'coupon' }))
  ], [data.offers, data.coupons]);
  const selectedSources = selected.map((key) => sources.find((item) => keyFor(item.kind, item.id) === key)).filter(Boolean);
  const templateMode = ['rotating', 'classic', 'editorial', 'spotlight', 'split', 'showcase', 'minimal', 'flash'].includes(config.instagramFeedTemplateMode) ? config.instagramFeedTemplateMode : 'rotating';
  const rateLimitedUntil = data.meta?.instagramFeedRateLimitedUntil;
  const rateLimited = rateLimitedUntil && new Date(rateLimitedUntil).getTime() > Date.now();

  const setConfig = (changes) => setData((current) => ({ ...current, config: { ...current.config, ...changes } }));
  async function refreshFeedState() {
    const result = await authApi('/admin/instagram-state');
    setData((current) => ({
      ...current,
      ...result,
      meta: result.meta ? { ...(current.meta || {}), ...result.meta } : current.meta
    }));
  }
  const toggle = (item) => {
    const key = keyFor(item.kind, item.id);
    if (selected.includes(key)) return setSelected((current) => current.filter((entry) => entry !== key));
    if (postType === 'single') return setSelected([key]);
    if (selected.length >= 10) return setMessage('Um carrossel pode ter no máximo 10 itens.');
    setSelected((current) => [...current, key]);
  };

  async function saveSettings() {
    setBusy('save');
    try {
      await authApi('/admin/config', { method: 'PUT', body: JSON.stringify({
        instagramFeedEnabled: Boolean(config.instagramFeedEnabled), instagramFeedAutoFromWhatsapp: Boolean(config.instagramFeedAutoFromWhatsapp),
        instagramFeedPostType: config.instagramFeedPostType === 'carousel' ? 'carousel' : 'single', instagramFeedFormat: format,
        instagramFeedTemplateMode: ['rotating', 'classic', 'editorial', 'spotlight', 'split', 'showcase', 'minimal', 'flash'].includes(config.instagramFeedTemplateMode) ? config.instagramFeedTemplateMode : 'rotating',
        instagramFeedCarouselFrequency: config.instagramFeedCarouselFrequency === 'weekly' ? 'weekly' : 'daily',
        instagramFeedCarouselsPerDay: config.instagramFeedCarouselsPerDay ?? 1, instagramFeedCarouselsPerWeek: config.instagramFeedCarouselsPerWeek ?? 3,
        instagramFeedPublishingDays: Array.isArray(config.instagramFeedPublishingDays) && config.instagramFeedPublishingDays.length ? config.instagramFeedPublishingDays : [1, 3, 5],
        instagramFeedPublishingStart: config.instagramFeedPublishingStart || '09:00', instagramFeedPublishingEnd: config.instagramFeedPublishingEnd || '21:00',
        instagramFeedIntervalMinutes: config.instagramFeedIntervalMinutes ?? 120, instagramFeedMaxPerDay: config.instagramFeedMaxPerDay ?? 3,
        instagramFeedMinimumDiscount: config.instagramFeedMinimumDiscount ?? 20, instagramFeedDuplicateDays: config.instagramFeedDuplicateDays ?? 7,
        instagramFeedCarouselSize: config.instagramFeedCarouselSize ?? 4, instagramFeedCaption: caption
      }) });
      setMessage('Configurações do Feed salvas.');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function preview() {
    if (!selectedSources.length) return setMessage('Selecione uma oferta ou cupom para gerar a prévia.');
    if (postType === 'carousel' && selectedSources.length < 2) return setMessage('Selecione pelo menos 2 itens para o carrossel.');
    setBusy('preview');
    try {
      const result = await authApi('/admin/instagram/feed/preview', { method: 'POST', body: JSON.stringify({
        items: selectedSources.map((item) => ({ kind: item.kind, id: item.id })), themeId, format, templateMode
      }) });
      const version = Date.now();
      setPreviewUrls((result.imageUrls || [result.imageUrl]).filter(Boolean).map((url) => `${url}?v=${version}`));
      setPreviewTemplates(result.templates || []);
      const generated = [...new Set((result.templates || []).map((item) => templateText[item] || item))].filter(Boolean).join(', ');
      setMessage(generated ? `Prévia criada com o modelo: ${generated}.` : 'Prévia do Feed criada.');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function addToQueue() {
    if (!selectedSources.length) return setMessage('Selecione uma oferta ou cupom.');
    if (postType === 'carousel' && selectedSources.length < 2) return setMessage('Selecione pelo menos 2 itens para o carrossel.');
    setBusy('queue');
    try {
      await authApi('/admin/instagram/feed/queue', { method: 'POST', body: JSON.stringify({
        postType, format, themeId, templateMode, caption, scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
        items: selectedSources.map((item) => ({ kind: item.kind, id: item.id }))
      }) });
      setSelected([]); setPreviewUrls([]); setPreviewTemplates([]); setScheduledFor('');
      setMessage('Publicação adicionada à fila do Feed.');
      await refreshFeedState();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function queueAction(id, type) {
    setBusy(`${type}-${id}`);
    try {
      const endpoint = `/admin/instagram/feed/queue/${encodeURIComponent(id)}${type === 'delete' ? '' : `/${type}`}`;
      await authApi(endpoint, { method: type === 'delete' ? 'DELETE' : 'POST', body: type === 'delete' ? undefined : '{}' });
      setMessage(type === 'publish' ? 'Publicação do Feed iniciada.' : type === 'retry' ? 'Publicação devolvida para a fila.' : 'Publicação excluída.');
      await refreshFeedState();
      if (type === 'publish') {
        window.setTimeout(() => refreshFeedState().catch(() => {}), 2500);
        window.setTimeout(() => refreshFeedState().catch(() => {}), 8000);
      }
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  function togglePublishingDay(day, checked) {
    const current = Array.isArray(config.instagramFeedPublishingDays) && config.instagramFeedPublishingDays.length ? config.instagramFeedPublishingDays : [1, 3, 5];
    const next = checked ? [...new Set([...current, day])] : current.filter((entry) => Number(entry) !== day);
    if (!next.length) return setMessage('Selecione pelo menos um dia para publicar no Feed.');
    setConfig({ instagramFeedPublishingDays: next.sort((a, b) => a - b) });
  }

  return <section className="panel instagram-feed-panel">
    <div className="panel-heading"><div><span className="section-step">FEED DO INSTAGRAM</span><h2>Posts e carrosséis automáticos</h2><p>O Feed fica separado dos Stories e, na automação, usa as promoções mais recentes que foram publicadas nos grupos.</p></div></div>
    {rateLimited && <div className="instagram-feed-auto-summary"><span>!</span><div><strong>Publicações pausadas pela Meta</strong><p>A Meta detectou excesso de ações. A automação não fará novas tentativas até aproximadamente {formatDate(rateLimitedUntil)}, evitando repetição e novos bloqueios.</p></div></div>}
    <div className="instagram-toggle-grid">
      <label className="toggle-card"><input type="checkbox" checked={Boolean(config.instagramFeedEnabled)} onChange={(event) => setConfig({ instagramFeedEnabled: event.target.checked })} /><span><strong>Ativar Feed</strong><small>Liga ou pausa a publicação automática.</small></span></label>
      <label className="toggle-card"><input type="checkbox" checked={Boolean(config.instagramFeedAutoFromWhatsapp)} onChange={(event) => setConfig({ instagramFeedAutoFromWhatsapp: event.target.checked })} /><span><strong>Após o WhatsApp</strong><small>Escolhe as promoções mais recentes após o envio confirmado nos grupos.</small></span></label>
    </div>
    <div className={`instagram-feed-auto-summary ${config.instagramFeedEnabled && config.instagramFeedAutoFromWhatsapp ? 'active' : ''}`}>
      <span>{config.instagramFeedEnabled && config.instagramFeedAutoFromWhatsapp ? '✓' : '!'}</span>
      <div><strong>{config.instagramFeedEnabled && config.instagramFeedAutoFromWhatsapp ? 'Automação do Feed ativa' : 'Automação do Feed pausada'}</strong><p>Nos dias e horários escolhidos, o sistema recupera as últimas promoções já enviadas aos grupos e monta a publicação. Ofertas abaixo de {Number(config.instagramFeedMinimumDiscount || 0)}% de desconto ficam de fora.</p></div>
    </div>
    <div className="settings-grid three-columns">
      <label>Formato padrão<select value={config.instagramFeedFormat || 'portrait'} onChange={(event) => { setFormat(event.target.value); setConfig({ instagramFeedFormat: event.target.value }); }}><option value="portrait">Vertical 4:5</option><option value="square">Quadrado 1:1</option></select></label>
      <label>Modelo visual<select value={templateMode} onChange={(event) => { setConfig({ instagramFeedTemplateMode: event.target.value }); setPreviewUrls([]); setPreviewTemplates([]); }}><option value="rotating">Rotação PromoShop (recomendado)</option><option value="classic">Original (modelo anterior)</option><option value="editorial">Seleção PromoShop (lado a lado)</option><option value="spotlight">Destaque (preço em foco)</option><option value="split">Capa dividida (marca + oferta)</option><option value="showcase">Vitrine (produto em evidência)</option><option value="minimal">Essencial (visual limpo)</option><option value="flash">Oferta relâmpago (alto impacto)</option></select><small>A rotação alterna sete composições diferentes, mantendo as cores e a identidade da PromoShop.</small></label>
      <label>Automação padrão<select value={config.instagramFeedPostType || 'single'} onChange={(event) => setConfig({ instagramFeedPostType: event.target.value })}><option value="single">Posts individuais</option><option value="carousel">Carrosséis</option></select></label>
      <label>Itens por carrossel<input type="number" min="2" max="10" value={config.instagramFeedCarouselSize ?? 4} onChange={(event) => setConfig({ instagramFeedCarouselSize: event.target.value })} /></label>
      <label>Frequência dos carrosséis<select value={config.instagramFeedCarouselFrequency || 'daily'} onChange={(event) => setConfig({ instagramFeedCarouselFrequency: event.target.value })}><option value="daily">Todos os dias</option><option value="weekly">Por semana</option></select><small>Define o limite para publicações de carrossel.</small></label>
      <label>Carrosséis por dia<input type="number" min="1" max="10" value={config.instagramFeedCarouselsPerDay ?? 1} onChange={(event) => setConfig({ instagramFeedCarouselsPerDay: event.target.value })} /><small>Usado no modo diário.</small></label>
      <label>Carrosséis por semana<input type="number" min="1" max="21" value={config.instagramFeedCarouselsPerWeek ?? 3} onChange={(event) => setConfig({ instagramFeedCarouselsPerWeek: event.target.value })} /><small>Usado no modo semanal.</small></label>
      <label>Começar às<input type="time" value={config.instagramFeedPublishingStart || '09:00'} onChange={(event) => setConfig({ instagramFeedPublishingStart: event.target.value })} /></label>
      <label>Terminar às<input type="time" value={config.instagramFeedPublishingEnd || '21:00'} onChange={(event) => setConfig({ instagramFeedPublishingEnd: event.target.value })} /></label>
      <div className="instagram-feed-days wide-field"><strong>Dias para publicar</strong><small>Escolha em quais dias a automação poderá publicar. Padrão: segunda, quarta e sexta.</small><div className="instagram-feed-day-list">{feedDays.map((day) => <label key={day.value} className="instagram-feed-day"><input type="checkbox" checked={(Array.isArray(config.instagramFeedPublishingDays) && config.instagramFeedPublishingDays.length ? config.instagramFeedPublishingDays : [1, 3, 5]).map(Number).includes(day.value)} onChange={(event) => togglePublishingDay(day.value, event.target.checked)} /><span>{day.label}</span></label>)}</div></div>
      <label>Intervalo entre posts<input type="number" min="5" max="1440" value={config.instagramFeedIntervalMinutes ?? 120} onChange={(event) => setConfig({ instagramFeedIntervalMinutes: event.target.value })} /><small>Minutos.</small></label>
      <label>Máximo por dia<input type="number" min="1" max="30" value={config.instagramFeedMaxPerDay ?? 3} onChange={(event) => setConfig({ instagramFeedMaxPerDay: event.target.value })} /></label>
      <label>Desconto mínimo<input type="number" min="0" max="99" value={config.instagramFeedMinimumDiscount ?? 20} onChange={(event) => setConfig({ instagramFeedMinimumDiscount: event.target.value })} /></label>
      <label>Não repetir por<input type="number" min="1" max="365" value={config.instagramFeedDuplicateDays ?? 7} onChange={(event) => setConfig({ instagramFeedDuplicateDays: event.target.value })} /><small>Dias.</small></label>
    </div>
    <div className="instagram-feed-builder">
      <div className="instagram-feed-builder-form">
        <div className="personal-share-section-title"><span>1</span><div><strong>Monte uma publicação</strong><small>Escolha uma oferta ou selecione de 2 a 10 para carrossel.</small></div></div>
        <div className="settings-grid two-columns">
          <label>Tipo<select value={postType} onChange={(event) => { setPostType(event.target.value); setSelected([]); }}><option value="single">Post único</option><option value="carousel">Carrossel</option></select></label>
          <label>Tema<select value={themeId} onChange={(event) => setThemeId(event.target.value)}><option value="">Automático pela data</option>{themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label>
          <label className="wide-field">Publicar em (opcional)<input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} /><small>Deixe vazio para deixar aguardando na fila.</small></label>
          <label className="wide-field">Descrição do post<textarea rows={6} value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={2200} /><small>Use <code>{'{offers}'}</code> para inserir a lista. Links são trocados por “acesse a bio do perfil”.</small></label>
        </div>
        <div className="instagram-feed-item-list">{sources.slice(0, 150).map((item) => <label key={keyFor(item.kind, item.id)} className={`instagram-feed-item ${selected.includes(keyFor(item.kind, item.id)) ? 'selected' : ''}`}><input type="checkbox" checked={selected.includes(keyFor(item.kind, item.id))} onChange={() => toggle(item)} /><span>{labelFor(item, item.kind)}</span></label>)}{!sources.length && <div className="empty">Nenhuma oferta ou cupom ativo disponível.</div>}</div>
        <div className="personal-share-actions"><button className="button subtle" type="button" disabled={Boolean(busy)} onClick={preview}>{busy === 'preview' ? 'Gerando…' : 'Gerar prévia'}</button><button className="button primary" type="button" disabled={Boolean(busy)} onClick={addToQueue}>{busy === 'queue' ? 'Adicionando…' : 'Adicionar à fila'}</button><button className="button subtle" type="button" disabled={Boolean(busy)} onClick={saveSettings}>{busy === 'save' ? 'Salvando…' : 'Salvar configurações'}</button></div>
      </div>
      <div className="instagram-preview instagram-feed-preview">{previewUrls.length ? <><div className="instagram-feed-preview-grid">{previewUrls.map((url) => <img key={url} src={url} alt="Prévia do post do Feed" />)}</div>{previewTemplates.length > 0 && <strong>Modelo gerado: {[...new Set(previewTemplates.map((item) => templateText[item] || item))].join(', ')}</strong>}</> : <div><strong>Prévia do Feed</strong><p>Selecione os itens e gere uma prévia antes de colocar na fila.</p></div>}<small>O post usa “Acesse a bio do perfil” e não exibe links diretos na descrição.</small></div>
    </div>
    <div className="instagram-queue-panel instagram-feed-queue"><div className="panel-heading"><div><span className="section-step">FILA DO FEED</span><h2>Posts recentes</h2><p>{queue.filter((item) => item.status === 'pending').length} aguardando · {queue.filter((item) => item.status === 'failed').length} com falha · {queue.filter((item) => item.status === 'sent').length} publicados</p></div></div><div className="instagram-queue-list">{queue.slice(0, 100).map((item) => <article key={item.id} className={`instagram-queue-row ${item.status}`}><div className="instagram-queue-thumb">{item.assetFileNames?.[0] ? <img src={`/media/instagram/${item.assetFileNames[0]}`} alt="" /> : item.postType === 'carousel' ? '▦' : '◇'}</div><div><strong>{item.title}</strong><span>{item.postType === 'carousel' ? `Carrossel · ${item.items?.length || 0} itens` : 'Post único'}</span><small>{statusText[item.status] || item.status} · {formatDate(item.publishedAt || item.scheduledFor || item.createdAt)}</small>{item.error && <em>{item.error}</em>}</div><div className="instagram-queue-actions">{item.status === 'pending' && <button type="button" disabled={Boolean(busy)} onClick={() => queueAction(item.id, 'publish')}>Publicar agora</button>}{item.status === 'failed' && <button type="button" disabled={Boolean(busy)} onClick={() => queueAction(item.id, 'retry')}>Tentar novamente</button>}{item.status !== 'publishing' && item.status !== 'sent' && <button className="danger" type="button" disabled={Boolean(busy)} onClick={() => queueAction(item.id, 'delete')}>Excluir</button>}</div></article>)}{!queue.length && <div className="empty"><strong>A fila do Feed está vazia</strong><p>As publicações automáticas e manuais aparecerão aqui.</p></div>}</div></div>
  </section>;
}
