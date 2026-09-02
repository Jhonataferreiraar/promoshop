import React, { useMemo, useState } from 'react';

const stores = ['Mercado Livre', 'Shopee', 'AliExpress', 'Magalu'];

export default function ExtensionPanel({ mode = 'coupons', data, setData, authApi, setMessage, load, audiences = [], onGoCoupons, onGoOffers }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const config = data.config || {};
  const isOffers = mode === 'offers';
  const tokenRoute = isOffers ? '/admin/extension/mercadolivre/token' : '/admin/extension/coupons/token';
  const tokenConfigured = isOffers ? data.secrets?.extensionOfferTokenConfigured : data.secrets?.extensionCouponTokenConfigured;
  const tokenEnding = isOffers ? data.secrets?.extensionOfferTokenEnding : data.secrets?.extensionCouponTokenEnding;
  const pendingCoupons = useMemo(() => (data.coupons || []).filter((coupon) => coupon.source === 'extension' && coupon.approvalStatus === 'pending'), [data.coupons]);
  const capturedOffers = useMemo(() => (data.offers || []).filter((offer) => offer.source === 'mercado-livre-extension').slice(0, 12), [data.offers]);
  const setConfig = (changes) => setData((current) => ({ ...current, config: { ...current.config, ...changes } }));

  async function run(name, callback) {
    setBusy(name);
    try { await callback(); } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  const save = () => run('save', async () => {
    await authApi('/admin/config', { method: 'PUT', body: JSON.stringify(config) });
    await load();
    setMessage(`Configurações da extensão de ${isOffers ? 'ofertas do Mercado Livre' : 'cupons'} salvas.`);
  });

  const generateToken = () => run('generate', async () => {
    const result = await authApi(tokenRoute, { method: 'POST', body: '{}' });
    setToken(result.token || '');
    await load();
    setMessage('Token gerado. Copie-o agora e guarde em local seguro.');
  });

  const revokeToken = () => run('revoke', async () => {
    await authApi(tokenRoute, { method: 'DELETE' });
    setToken('');
    await load();
    setMessage('Token da extensão revogado.');
  });

  const reviewCoupon = (id, decision) => run(`${decision}-${id}`, async () => {
    await authApi(`/admin/extension/coupons/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: '{}' });
    await load();
    setMessage(decision === 'approve' ? 'Cupom aprovado.' : 'Cupom recusado.');
  });

  const rejectAll = () => run('reject-all', async () => {
    const result = await authApi('/admin/extension/coupons/reject-all', { method: 'POST', body: '{}' });
    await load();
    setMessage(`${Number(result.rejected || 0)} cupom(ns) recusado(s).`);
  });

  const approveAll = () => run('approve-all', async () => {
    const result = await authApi('/admin/extension/coupons/approve-all', { method: 'POST', body: '{}' });
    await load();
    setMessage(`${Number(result.approved || 0)} cupom(ns) aprovado(s). Eles já estão disponíveis na aba Cupons.`);
    if (typeof onGoCoupons === 'function') onGoCoupons();
  });

  const queueCoupon = (id) => run(`queue-${id}`, async () => {
    await authApi(`/admin/extension/coupons/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' });
    await authApi(`/admin/coupons/${encodeURIComponent(id)}/queue`, { method: 'POST', body: '{}' });
    setMessage('Cupom enviado para a fila de publicação.');
    await load();
  });

  return <div className="extension-admin-layout">
    <section className="panel extension-hero">
      <div><span className="section-step">{isOffers ? 'OFERTAS COM LINK DE AFILIADO' : 'CUPONS NO NAVEGADOR'}</span><h2>{isOffers ? 'Extensão Mercado Livre' : 'Extensão de cupons'}</h2><p>{isOffers ? 'Capture promoções individuais do Mercado Livre com o link meli.la gerado pela Barra de Afiliados oficial.' : 'Capture cupons visíveis no Mercado Livre e na Shopee e revise cada um antes da publicação.'}</p></div>
      <div className="extension-status"><span className={`status-dot ${tokenConfigured ? 'active' : ''}`}></span><strong>{tokenConfigured ? `Token ativo · final ${tokenEnding || '----'}` : 'Token ainda não gerado'}</strong></div>
    </section>

    <div className="extension-grid">
      <section className="panel extension-settings-card">
        <div className="panel-heading"><div><span className="section-step">CONFIGURAÇÃO</span><h2>{isOffers ? 'Como as ofertas entram' : 'Como os cupons entram'}</h2><p>As alterações valem depois de salvar.</p></div></div>
        <label className="toggle-card"><input type="checkbox" checked={config.extensionEnabled !== false} onChange={(event) => setConfig({ extensionEnabled: event.target.checked })} /><span><strong>Ativar recebimento</strong><small>Permite que as extensões enviem cupons e ofertas para o PromoShop.</small></span></label>
        {isOffers ? <div className="extension-flow-note"><strong>Entrada direta em Ofertas</strong><p>A promoção só é aceita com preço promocional, imagem oficial do Mercado Livre e link de afiliado <code>meli.la</code>. Produtos já existentes são atualizados, sem duplicação.</p></div> : <>
          <label className="toggle-card"><input type="checkbox" checked={config.extensionAutoApprove === true} onChange={(event) => setConfig({ extensionAutoApprove: event.target.checked })} /><span><strong>Aprovar automaticamente</strong><small>Quando desligado, cada cupom fica aguardando sua revisão.</small></span></label>
          <label>Máximo de cupons por envio<input type="number" min="1" max="50" value={config.extensionMaxCouponsPerRequest ?? 10} onChange={(event) => setConfig({ extensionMaxCouponsPerRequest: Number(event.target.value) })} /><small>Limite de segurança por envio da extensão.</small></label>
          <div className="extension-choice"><strong>Lojas permitidas</strong><div className="extension-store-list">{stores.map((store) => <label key={store}><input type="checkbox" checked={(config.extensionStores || []).includes(store)} onChange={(event) => { const current = config.extensionStores || []; setConfig({ extensionStores: event.target.checked ? [...new Set([...current, store])] : current.filter((entry) => entry !== store) }); }} />{store}</label>)}</div></div>
          <div className="extension-choice"><strong>Grupos padrão para cupons</strong><small>Usados quando o cupom não informar um grupo.</small><div className="extension-audience-list">{audiences.filter((audience) => audience.enabled !== false).map((audience) => <label key={audience.code}><input type="checkbox" checked={(config.extensionAudienceCodes || []).includes(audience.code)} onChange={(event) => { const current = config.extensionAudienceCodes || []; setConfig({ extensionAudienceCodes: event.target.checked ? [...new Set([...current, audience.code])] : current.filter((entry) => entry !== audience.code) }); }} /><span>{audience.name}<small>{audience.code}</small></span></label>)}</div></div>
        </>}
      </section>

      <section className="panel extension-token-card">
        <div className="panel-heading"><div><span className="section-step">ACESSO DA EXTENSÃO</span><h2>Token exclusivo</h2><p>Ele não é a senha do painel. Gere novamente para revogar o token anterior.</p></div></div>
        {token ? <div className="extension-token-result"><textarea readOnly value={token} onFocus={(event) => event.target.select()} /><small>Copie agora. Por segurança, o token completo não será mostrado novamente.</small></div> : <div className="extension-token-empty">{tokenConfigured ? 'Já existe um token ativo para esta extensão. Gere outro para substituí-lo.' : 'Gere um token exclusivo para conectar esta extensão.'}</div>}
        <div className="extension-token-actions"><button className="button primary" type="button" disabled={Boolean(busy)} onClick={generateToken}>{busy === 'generate' ? 'Gerando…' : token || !tokenConfigured ? 'Gerar token' : 'Gerar novo token'}</button>{tokenConfigured && <button className="button danger" type="button" disabled={Boolean(busy)} onClick={revokeToken}>Revogar token</button>}</div>
      </section>
    </div>

    {!isOffers && <section className="panel extension-review-card">
      <div className="panel-heading"><div><span className="section-step">REVISÃO</span><h2>Cupons recebidos</h2><p>{pendingCoupons.length} aguardando revisão. Só cupons aprovados aparecem na área de Cupons.</p></div><div className="extension-review-heading-actions"><button className="button subtle" type="button" onClick={() => load()}>Atualizar</button>{pendingCoupons.length > 0 && <><button className="button primary" type="button" disabled={Boolean(busy)} onClick={approveAll}>{busy === 'approve-all' ? 'Aprovando…' : 'Aprovar todos'}</button><button className="button danger" type="button" disabled={Boolean(busy)} onClick={rejectAll}>Recusar todos</button></>}</div></div>
      <div className="extension-coupon-list">{pendingCoupons.map((coupon) => <article className="extension-coupon-row" key={coupon.id}><div><strong>{coupon.title}</strong><span>{coupon.store}{coupon.code ? ` · ${coupon.code}` : ''}{coupon.discountValue ? ` · ${coupon.discountValue}${coupon.discountType === 'percent' ? '% OFF' : ' OFF'}` : ''}</span><small>{coupon.description || 'Sem descrição'} · recebido em {coupon.importedAt ? new Date(coupon.importedAt).toLocaleString('pt-BR') : '—'}</small></div><div className="extension-coupon-actions"><button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => reviewCoupon(coupon.id, 'approve')}>Aprovar</button><button className="button subtle" type="button" disabled={Boolean(busy)} onClick={() => queueCoupon(coupon.id)}>Aprovar e disparar</button><button className="button danger" type="button" disabled={Boolean(busy)} onClick={() => reviewCoupon(coupon.id, 'reject')}>Recusar</button></div></article>)}{!pendingCoupons.length && <div className="empty"><strong>Nenhum cupom aguardando revisão</strong><p>Quando a extensão enviar um cupom, ele aparecerá aqui.</p></div>}</div>
    </section>}

    {isOffers && <section className="panel extension-review-card">
      <div className="panel-heading"><div><span className="section-step">CAPTURAS RECENTES</span><h2>Ofertas recebidas</h2><p>{capturedOffers.length} oferta(s) recente(s) desta extensão. Elas entram diretamente na área de Ofertas.</p></div><div className="extension-review-heading-actions"><button className="button subtle" type="button" onClick={() => load()}>Atualizar</button><button className="button primary" type="button" onClick={onGoOffers}>Abrir Ofertas</button></div></div>
      <div className="extension-coupon-list">{capturedOffers.map((offer) => <article className="extension-coupon-row" key={offer.id}><div><strong>{offer.title}</strong><span>Mercado Livre · {Number(offer.discount || 0)}% OFF</span><small>{offer.affiliateUrl || 'Link de afiliado indisponível'} · atualizado em {offer.updatedAt ? new Date(offer.updatedAt).toLocaleString('pt-BR') : '—'}</small></div></article>)}{!capturedOffers.length && <div className="empty"><strong>Nenhuma oferta capturada ainda</strong><p>Abra um produto em promoção no Mercado Livre e use a extensão dedicada.</p></div>}</div>
    </section>}

    <section className="panel extension-install-card"><div><span className="section-step">INSTALAÇÃO{isOffers ? ' · VERSÃO INDIVIDUAL 0.1.1' : ''}</span><h2>{isOffers ? 'Instalar a extensão Mercado Livre' : 'Instalar a extensão de cupons'}</h2><p>Em <code>chrome://extensions</code>, ative o modo do desenvolvedor e carregue sem compactação a pasta <code>{isOffers ? 'extension-mercadolivre' : 'extension'}</code>.</p><p>{isOffers ? 'Depois, cole o token no popup, abra uma página individual de produto e use “Gerar link e capturar oferta”. Se ela já estava instalada, clique em Recarregar após atualizar os arquivos.' : 'Depois, cole o token no popup e capture os cupons visíveis nas páginas compatíveis.'}</p></div><div className="extension-install-steps"><span>1. Gerar token</span><span>2. Carregar <code>{isOffers ? 'extension-mercadolivre' : 'extension'}</code></span><span>3. Colar o token</span><span>4. {isOffers ? 'Capturar oferta' : 'Capturar cupons'}</span></div></section>

    {isOffers && <section className="panel extension-batch-card">
      <div className="extension-batch-content"><span className="section-step">VERSÃO EM LOTE · 0.1.0</span><h2>Capturar várias promoções de uma vez</h2><p>Use esta versão quando estiver em uma busca, categoria ou página de ofertas do Mercado Livre. Ela seleciona até 20 produtos, abre cada página individual e gera os links oficiais <code>meli.la</code> antes de enviar ao painel.</p><div className="extension-batch-note"><strong>Extensão independente</strong><span>A versão individual acima continua instalada e funcionando. A versão em lote usa o mesmo token de ofertas.</span></div><a className="button primary extension-batch-link" href="https://github.com/Jhonataferreiraar/promoshop/tree/master/extension-mercadolivre-lote" target="_blank" rel="noreferrer">Abrir versão em lote no GitHub ↗</a></div><div className="extension-install-steps"><span>1. Carregar <code>extension-mercadolivre-lote</code></span><span>2. Abrir uma busca no Mercado Livre</span><span>3. Ler e selecionar os produtos</span><span>4. Capturar lote</span></div>
    </section>}

    <div className="settings-save-bar"><div><strong>{isOffers ? 'Extensão Mercado Livre' : 'Extensão de cupons'}</strong><span>Salve as regras antes de instalar ou testar.</span></div><button className="button primary" type="button" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? 'Salvando…' : 'Salvar configuração'}</button></div>
  </div>;
}
