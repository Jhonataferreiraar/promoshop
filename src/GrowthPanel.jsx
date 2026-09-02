import React, { useEffect, useMemo, useState } from 'react';

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const emptyCampaign = {
  name: '',
  description: '',
  store: '',
  category: '',
  minDiscount: 0,
  maxItems: 20,
  scheduledFor: '',
  targetAudienceCodes: [],
  offerIds: []
};

const emptyMonitor = { offerId: '', targetPrice: '', alertOnDrop: true, alertOnTarget: true, enabled: true };

function localDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function displayDate(value) {
  if (!value) return 'Sem agendamento';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Data inválida' : date.toLocaleString('pt-BR');
}

function storeSlug(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export default function GrowthPanel({ data = {}, authApi, setMessage, load }) {
  const [state, setState] = useState({ campaigns: [], priceMonitors: [], calendar: [], stores: [], categories: [], stats: {} });
  const [campaign, setCampaign] = useState(emptyCampaign);
  const [editingCampaignId, setEditingCampaignId] = useState('');
  const [monitor, setMonitor] = useState(emptyMonitor);
  const [busy, setBusy] = useState('');
  const [offerSearch, setOfferSearch] = useState('');

  const audiences = (data.config?.whatsappAudiences || []).filter((item) => item.enabled !== false);
  const activeOffers = (data.offers || []).filter((offer) => offer.status === 'active' && Number(offer.price) > 0);
  const visibleOffers = useMemo(() => {
    const query = offerSearch.trim().toLocaleLowerCase('pt-BR');
    return activeOffers.filter((offer) => !query || `${offer.title} ${offer.store} ${offer.category}`.toLocaleLowerCase('pt-BR').includes(query)).slice(0, 80);
  }, [activeOffers, offerSearch]);

  async function refresh() {
    try {
      setState(await authApi('/admin/campaigns-state'));
    } catch (error) {
      setMessage(error.message);
    }
  }

  useEffect(() => { refresh(); }, []);

  function updateCampaign(key, value) { setCampaign((current) => ({ ...current, [key]: value })); }
  function toggleCampaignList(key, value) {
    setCampaign((current) => ({ ...current, [key]: current[key].includes(value) ? current[key].filter((item) => item !== value) : [...current[key], value] }));
  }

  async function saveCampaign(event) {
    event.preventDefault();
    if (!campaign.name.trim()) return setMessage('Informe um nome para a campanha.');
    setBusy('campaign-save');
    try {
      const payload = { ...campaign, scheduledFor: campaign.scheduledFor ? new Date(campaign.scheduledFor).toISOString() : null };
      await authApi(editingCampaignId ? `/admin/campaigns/${editingCampaignId}` : '/admin/campaigns', { method: editingCampaignId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      setCampaign(emptyCampaign);
      setEditingCampaignId('');
      setMessage(editingCampaignId ? 'Campanha atualizada.' : 'Campanha criada.');
      await refresh();
      await load?.();
    } catch (error) {
      setMessage(error.message);
    } finally { setBusy(''); }
  }

  function editCampaign(item) {
    setEditingCampaignId(item.id);
    setCampaign({ name: item.name, description: item.description || '', store: item.store || '', category: item.category || '', minDiscount: item.minDiscount || 0, maxItems: item.maxItems || 20, scheduledFor: localDateTime(item.scheduledFor), targetAudienceCodes: item.targetAudienceCodes || [], offerIds: item.offerIds || [] });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function queueCampaign(item) {
    if (!window.confirm(`Colocar a campanha “${item.name}” na fila? Apenas ofertas ativas e com link seguro serão incluídas.`)) return;
    setBusy(`queue-${item.id}`);
    try {
      const result = await authApi(`/admin/campaigns/${item.id}/queue`, { method: 'POST', body: '{}' });
      setMessage(`${result.queued || 0} oferta(s) colocada(s) na fila${result.scheduledFor ? ` para ${displayDate(result.scheduledFor)}` : ''}.`);
      await refresh();
      await load?.();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function toggleCampaignPause(item) {
    const nextStatus = item.status === 'paused' ? 'draft' : 'paused';
    if (!window.confirm(nextStatus === 'paused' ? `Pausar a campanha “${item.name}”?` : `Retomar a campanha “${item.name}”?`)) return;
    setBusy(`pause-${item.id}`);
    try {
      await authApi(`/admin/campaigns/${item.id}`, { method: 'PUT', body: JSON.stringify({ status: nextStatus }) });
      setMessage(nextStatus === 'paused' ? 'Campanha pausada.' : 'Campanha retomada.');
      await refresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function deleteCampaign(item) {
    if (!window.confirm(`Excluir a campanha “${item.name}”? Itens já enviados permanecem no histórico.`)) return;
    setBusy(`delete-${item.id}`);
    try { await authApi(`/admin/campaigns/${item.id}`, { method: 'DELETE' }); setMessage('Campanha excluída.'); await refresh(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function createMonitor(event) {
    event.preventDefault();
    if (!monitor.offerId || !(Number(monitor.targetPrice) > 0)) return setMessage('Selecione uma oferta e informe o preço-alvo.');
    setBusy('monitor-save');
    try { await authApi('/admin/price-monitors', { method: 'POST', body: JSON.stringify(monitor) }); setMonitor(emptyMonitor); setMessage('Monitoramento criado.'); await refresh(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function deleteMonitor(item) {
    if (!window.confirm(`Parar o monitoramento de “${item.offerTitle}”?`)) return;
    setBusy(`monitor-delete-${item.id}`);
    try { await authApi(`/admin/price-monitors/${item.id}`, { method: 'DELETE' }); setMessage('Monitoramento removido.'); await refresh(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function checkMonitors() {
    setBusy('monitor-check');
    try { const result = await authApi('/admin/price-monitors/check', { method: 'POST', body: '{}' }); setMessage(`${result.checked || 0} monitoramento(s) verificado(s).`); await refresh(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  const statusLabels = { draft: 'Rascunho', scheduled: 'Agendada', active: 'Ativa', paused: 'Pausada', completed: 'Concluída' };
  const monitorLabels = { watching: 'Acompanhando', changed: 'Preço caiu', 'below-target': 'Atingiu o alvo', unavailable: 'Oferta indisponível' };

  return <div className="growth-layout">
    <div className="stats growth-stats">
      <div><span><i>✦</i>Campanhas</span><strong>{state.stats?.campaigns || 0}</strong><small>{state.stats?.active || 0} ativa(s)</small></div>
      <div><span><i>◷</i>Agendadas</span><strong>{state.stats?.scheduled || 0}</strong><small>{state.stats?.scheduledPublications || 0} publicação(ões) na agenda</small></div>
      <div><span><i>⌁</i>Monitoramentos</span><strong>{state.stats?.monitored || 0}</strong><small>{state.stats?.belowTarget || 0} no preço-alvo</small></div>
      <div><span><i>✓</i>Ofertas ativas</span><strong>{activeOffers.length}</strong><small>Elegíveis para campanhas</small></div>
    </div>

    <section className="panel growth-form-panel">
      <div className="panel-heading"><div><span className="section-step">PLANEJAMENTO</span><h2>{editingCampaignId ? 'Editar campanha' : 'Criar campanha'}</h2><p>Escolha filtros, grupos e horário. Nada é publicado antes da hora definida.</p></div>{editingCampaignId && <button className="text-button" type="button" onClick={() => { setEditingCampaignId(''); setCampaign(emptyCampaign); }}>Cancelar edição</button>}</div>
      <form className="growth-form" onSubmit={saveCampaign}>
        <label>Nome da campanha<input required maxLength="120" value={campaign.name} onChange={(event) => updateCampaign('name', event.target.value)} placeholder="Ex.: Beleza em oferta" /></label>
        <label>Descrição (opcional)<input maxLength="500" value={campaign.description} onChange={(event) => updateCampaign('description', event.target.value)} placeholder="Contexto para sua organização" /></label>
        <label>Loja<select value={campaign.store} onChange={(event) => updateCampaign('store', event.target.value)}><option value="">Todas as lojas</option>{state.stores.map((store) => <option key={store}>{store}</option>)}</select></label>
        <label>Categoria<select value={campaign.category} onChange={(event) => updateCampaign('category', event.target.value)}><option value="">Todas as categorias</option>{state.categories.map((category) => <option key={category}>{category}</option>)}</select></label>
        <label>Desconto mínimo (%)<input type="number" min="0" max="99" value={campaign.minDiscount} onChange={(event) => updateCampaign('minDiscount', Number(event.target.value))} /></label>
        <label>Máximo de ofertas<input type="number" min="1" max="200" value={campaign.maxItems} onChange={(event) => updateCampaign('maxItems', Number(event.target.value))} /></label>
        <label>Publicar a partir de<input type="datetime-local" value={campaign.scheduledFor} onChange={(event) => updateCampaign('scheduledFor', event.target.value)} /><small>Deixe vazio para entrar na fila normal.</small></label>
        <div className="growth-fieldset"><strong>Grupos de destino</strong><small>Se não marcar, usa o roteamento seguro de cada oferta.</small><div className="growth-check-list">{audiences.map((audience) => <label key={audience.code}><input type="checkbox" checked={campaign.targetAudienceCodes.includes(String(audience.code).toUpperCase())} onChange={() => toggleCampaignList('targetAudienceCodes', String(audience.code).toUpperCase())} />{audience.code} — {audience.name || 'Grupo sem nome'}</label>)}</div></div>
        <div className="growth-fieldset growth-offers-fieldset"><strong>Ofertas específicas (opcional)</strong><small>Sem seleção, os filtros acima escolhem ofertas ativas no momento do enfileiramento.</small><input type="search" value={offerSearch} onChange={(event) => setOfferSearch(event.target.value)} placeholder="Filtrar ofertas…" /><div className="growth-check-list growth-offers-list">{visibleOffers.map((offer) => <label key={offer.id}><input type="checkbox" checked={campaign.offerIds.includes(offer.id)} onChange={() => toggleCampaignList('offerIds', offer.id)} /><span>{offer.title}<small>{offer.store} · {money.format(Number(offer.price))}</small></span></label>)}{!visibleOffers.length && <em>Nenhuma oferta ativa encontrada.</em>}</div></div>
        <div className="growth-form-actions"><button className="button primary" type="submit" disabled={busy === 'campaign-save'}>{busy === 'campaign-save' ? 'Salvando…' : editingCampaignId ? 'Salvar campanha' : 'Criar campanha'}</button></div>
      </form>
    </section>

    <section className="panel"><div className="panel-heading"><div><span className="section-step">CAMPANHAS</span><h2>Suas campanhas</h2><p>Enfileire uma campanha quando estiver pronta. A confirmação da loja continua obrigatória.</p></div></div>{state.campaigns.length ? <div className="growth-card-list">{state.campaigns.map((item) => <article className="growth-card" key={item.id}><div><span className={`growth-status ${item.status}`}>{statusLabels[item.status] || item.status}</span><h3>{item.name}</h3>{item.description && <p>{item.description}</p>}<small>{item.store || 'Todas as lojas'}{item.category ? ` · ${item.category}` : ''} · {item.queuedCount || 0} na fila · {item.sentCount || 0} enviada(s)</small>{item.scheduledFor && <small>Agendada para {displayDate(item.scheduledFor)}</small>}{item.targetAudienceCodes?.length > 0 && <small>Grupos: {item.targetAudienceCodes.join(', ')}</small>}</div><div className="growth-card-actions"><button className="button subtle" type="button" onClick={() => editCampaign(item)}>Editar</button><button className="button subtle" type="button" onClick={() => toggleCampaignPause(item)} disabled={busy === `pause-${item.id}`}>{busy === `pause-${item.id}` ? 'Atualizando…' : item.status === 'paused' ? 'Retomar' : 'Pausar'}</button><button className="button primary" type="button" onClick={() => queueCampaign(item)} disabled={busy === `queue-${item.id}` || item.status === 'paused'}>{busy === `queue-${item.id}` ? 'Enfileirando…' : 'Colocar na fila'}</button><button className="text-button danger-text" type="button" onClick={() => deleteCampaign(item)} disabled={busy === `delete-${item.id}`}>Excluir</button></div></article>)}</div> : <div className="empty"><strong>Nenhuma campanha criada</strong><p>Crie a primeira para organizar uma seleção por loja, categoria ou grupo.</p></div>}</section>

    <section className="panel growth-monitor-panel"><div className="panel-heading"><div><span className="section-step">PREÇO E DISPONIBILIDADE</span><h2>Monitorar ofertas</h2><p>O monitor usa o último preço coletado e avisa se a oferta deixar de estar ativa. Antes de comprar, confirme a condição na loja.</p></div><button className="button subtle" type="button" onClick={checkMonitors} disabled={busy === 'monitor-check'}>{busy === 'monitor-check' ? 'Verificando…' : 'Verificar agora'}</button></div><form className="growth-monitor-form" onSubmit={createMonitor}><label>Oferta<select required value={monitor.offerId} onChange={(event) => setMonitor({ ...monitor, offerId: event.target.value })}><option value="">Escolha uma oferta ativa</option>{activeOffers.map((offer) => <option key={offer.id} value={offer.id}>{offer.title} · {money.format(Number(offer.price))}</option>)}</select></label><label>Alertar quando chegar a (R$)<input required type="number" min="0.01" step="0.01" value={monitor.targetPrice} onChange={(event) => setMonitor({ ...monitor, targetPrice: event.target.value })} /></label><label className="growth-toggle"><input type="checkbox" checked={monitor.alertOnDrop} onChange={(event) => setMonitor({ ...monitor, alertOnDrop: event.target.checked })} /> Avisar se baixar</label><label className="growth-toggle"><input type="checkbox" checked={monitor.alertOnTarget} onChange={(event) => setMonitor({ ...monitor, alertOnTarget: event.target.checked })} /> Avisar ao atingir o alvo</label><button className="button primary" type="submit" disabled={busy === 'monitor-save'}>{busy === 'monitor-save' ? 'Salvando…' : 'Adicionar monitoramento'}</button></form>{state.priceMonitors.length ? <div className="growth-monitor-list">{state.priceMonitors.map((item) => <article className="growth-monitor-item" key={item.id}><div><strong>{item.offerTitle}</strong><small>{item.store} · Atual: {money.format(Number(item.currentPrice || item.lastPrice || 0))} · Alvo: {money.format(Number(item.targetPrice || 0))}</small><span className={`growth-monitor-status ${item.status}`}>{monitorLabels[item.status] || item.status}</span><small>{item.lastCheckedAt ? `Verificado em ${displayDate(item.lastCheckedAt)}` : 'Ainda não verificado'}</small></div><button className="text-button danger-text" type="button" onClick={() => deleteMonitor(item)} disabled={busy === `monitor-delete-${item.id}`}>Remover</button></article>)}</div> : <div className="empty"><strong>Nenhum preço monitorado</strong><p>Adicione uma oferta para receber um aviso quando o preço mudar.</p></div>}</section>

    <section className="panel growth-calendar-panel"><div className="panel-heading"><div><span className="section-step">CALENDÁRIO EDITORIAL</span><h2>Próximos agendamentos</h2><p>Campanhas e publicações marcadas aparecem na mesma linha do tempo.</p></div></div>{state.calendar.length ? <div className="growth-calendar">{state.calendar.slice(0, 20).map((entry) => <div key={entry.id}><time>{displayDate(entry.scheduledFor)}</time><span className={`growth-calendar-dot ${entry.type}`}></span><div><strong>{entry.title}</strong><small>{entry.type === 'campaign' ? 'Campanha' : 'Publicação'} · {entry.status} · {entry.count || 1} item(ns)</small></div></div>)}</div> : <div className="empty"><strong>Agenda vazia</strong><p>Agende uma campanha para visualizar o calendário.</p></div>}</section>

    <section className="panel growth-stores-panel"><div className="panel-heading"><div><span className="section-step">VITRINES</span><h2>Páginas das lojas</h2><p>Links públicos para recomendar uma loja sem transformar o catálogo em promoção específica.</p></div></div><div className="growth-store-links">{state.stores.map((store) => <a key={store} href={`/loja/${storeSlug(store)}`} target="_blank" rel="noreferrer"><span>{store}</span><small>Ofertas dessa loja todos os dias ↗</small></a>)}</div></section>
  </div>;
}
