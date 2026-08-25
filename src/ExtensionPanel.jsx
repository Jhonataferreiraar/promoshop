import React, { useMemo, useState } from 'react';

const stores = ['Mercado Livre', 'Shopee'];

export default function ExtensionPanel({ data, setData, authApi, setMessage, load, audiences = [] }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const config = data.config || {};
  const pendingCoupons = useMemo(() => (data.coupons || []).filter((coupon) => coupon.source === 'extension' && coupon.approvalStatus === 'pending'), [data.coupons]);
  const setConfig = (changes) => setData((current) => ({ ...current, config: { ...current.config, ...changes } }));

  async function run(name, callback) {
    setBusy(name);
    try { await callback(); } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  const save = () => run('save', async () => {
    await authApi('/admin/config', { method: 'PUT', body: JSON.stringify(config) });
    await load();
    setMessage('Configurações da extensão salvas.');
  });

  const generateToken = () => run('generate', async () => {
    const result = await authApi('/admin/extension/token', { method: 'POST', body: '{}' });
    setToken(result.token || '');
    await load();
    setMessage('Token gerado. Copie-o agora e guarde em local seguro.');
  });

  const revokeToken = () => run('revoke', async () => {
    await authApi('/admin/extension/token', { method: 'DELETE' });
    setToken('');
    await load();
    setMessage('Token da extensão revogado.');
  });

  const reviewCoupon = (id, decision) => run(`${decision}-${id}`, async () => {
    await authApi(`/admin/extension/coupons/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: '{}' });
    await load();
    setMessage(decision === 'approve' ? 'Cupom aprovado.' : 'Cupom recusado.');
  });

  const queueCoupon = (id) => run(`queue-${id}`, async () => {
    await authApi(`/admin/extension/coupons/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' });
    await authApi(`/admin/coupons/${encodeURIComponent(id)}/queue`, { method: 'POST', body: '{}' });
    setMessage('Cupom enviado para a fila de publicação.');
    await load();
  });

  return <div className="extension-admin-layout">
    <section className="panel extension-hero">
      <div><span className="section-step">CAPTURA NO NAVEGADOR</span><h2>Extensão PromoShop — Cupons</h2><p>Leia cupons visíveis no Mercado Livre ou Shopee e envie-os para o painel sem compartilhar sua senha ou cookies.</p></div>
      <div className="extension-status"><span className={`status-dot ${data.secrets?.extensionTokenConfigured ? 'active' : ''}`}></span><strong>{data.secrets?.extensionTokenConfigured ? `Token ativo · final ${data.secrets.extensionTokenEnding || '----'}` : 'Token ainda não gerado'}</strong></div>
    </section>

    <div className="extension-grid">
      <section className="panel extension-settings-card">
        <div className="panel-heading"><div><span className="section-step">CONFIGURAÇÃO</span><h2>Como os cupons entram</h2><p>As alterações valem depois de salvar.</p></div></div>
        <label className="toggle-card"><input type="checkbox" checked={config.extensionEnabled !== false} onChange={(event) => setConfig({ extensionEnabled: event.target.checked })} /><span><strong>Ativar recebimento</strong><small>Permite que a extensão envie cupons para o PromoShop.</small></span></label>
        <label className="toggle-card"><input type="checkbox" checked={config.extensionAutoApprove === true} onChange={(event) => setConfig({ extensionAutoApprove: event.target.checked })} /><span><strong>Aprovar automaticamente</strong><small>Quando desligado, cada cupom fica aguardando sua revisão.</small></span></label>
        <label>Máximo de cupons por envio<input type="number" min="1" max="50" value={config.extensionMaxCouponsPerRequest ?? 10} onChange={(event) => setConfig({ extensionMaxCouponsPerRequest: Number(event.target.value) })} /><small>Limite de segurança por envio da extensão.</small></label>
        <div className="extension-choice"><strong>Lojas permitidas</strong><div className="extension-store-list">{stores.map((store) => <label key={store}><input type="checkbox" checked={(config.extensionStores || []).includes(store)} onChange={(event) => { const current = config.extensionStores || []; setConfig({ extensionStores: event.target.checked ? [...new Set([...current, store])] : current.filter((entry) => entry !== store) }); }} />{store}</label>)}</div></div>
        <div className="extension-choice"><strong>Grupos padrão para cupons</strong><small>Usados quando o cupom não informar um grupo.</small><div className="extension-audience-list">{audiences.filter((audience) => audience.enabled !== false).map((audience) => <label key={audience.code}><input type="checkbox" checked={(config.extensionAudienceCodes || []).includes(audience.code)} onChange={(event) => { const current = config.extensionAudienceCodes || []; setConfig({ extensionAudienceCodes: event.target.checked ? [...new Set([...current, audience.code])] : current.filter((entry) => entry !== audience.code) }); }} /><span>{audience.name}<small>{audience.code}</small></span></label>)}</div></div>
      </section>

      <section className="panel extension-token-card">
        <div className="panel-heading"><div><span className="section-step">ACESSO DA EXTENSÃO</span><h2>Token exclusivo</h2><p>Ele não é a senha do painel. Gere novamente para revogar o token anterior.</p></div></div>
        {token ? <div className="extension-token-result"><textarea readOnly value={token} onFocus={(event) => event.target.select()} /><small>Copie agora. Por segurança, o token completo não será mostrado novamente.</small></div> : <div className="extension-token-empty">{data.secrets?.extensionTokenConfigured ? 'Já existe um token ativo. Gere outro para substituí-lo.' : 'Gere um token para conectar a extensão.'}</div>}
        <div className="extension-token-actions"><button className="button primary" type="button" disabled={Boolean(busy)} onClick={generateToken}>{busy === 'generate' ? 'Gerando…' : token || !data.secrets?.extensionTokenConfigured ? 'Gerar token' : 'Gerar novo token'}</button>{data.secrets?.extensionTokenConfigured && <button className="button danger" type="button" disabled={Boolean(busy)} onClick={revokeToken}>Revogar token</button>}</div>
      </section>
    </div>

    <section className="panel extension-review-card">
      <div className="panel-heading"><div><span className="section-step">REVISÃO</span><h2>Cupons recebidos</h2><p>{pendingCoupons.length} aguardando revisão. Cupons recusados não aparecem no site.</p></div><button className="button subtle" type="button" onClick={() => load()}>Atualizar</button></div>
      <div className="extension-coupon-list">{pendingCoupons.map((coupon) => <article className="extension-coupon-row" key={coupon.id}><div><strong>{coupon.title}</strong><span>{coupon.store}{coupon.code ? ` · ${coupon.code}` : ''}{coupon.discountValue ? ` · ${coupon.discountValue}${coupon.discountType === 'percent' ? '% OFF' : ' OFF'}` : ''}</span><small>{coupon.description || 'Sem descrição'} · recebido em {coupon.importedAt ? new Date(coupon.importedAt).toLocaleString('pt-BR') : '—'}</small></div><div className="extension-coupon-actions"><button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => reviewCoupon(coupon.id, 'approve')}>Aprovar</button><button className="button subtle" type="button" disabled={Boolean(busy)} onClick={() => queueCoupon(coupon.id)}>Aprovar e disparar</button><button className="button danger" type="button" disabled={Boolean(busy)} onClick={() => reviewCoupon(coupon.id, 'reject')}>Recusar</button></div></article>)}{!pendingCoupons.length && <div className="empty"><strong>Nenhum cupom aguardando revisão</strong><p>Quando a extensão enviar um cupom, ele aparecerá aqui.</p></div>}</div>
    </section>

    <section className="panel extension-install-card"><div><span className="section-step">INSTALAÇÃO</span><h2>Como conectar</h2><p>Baixe o projeto do GitHub, abra a pasta <code>extension</code> e carregue-a em <code>chrome://extensions</code> com o modo do desenvolvedor. Depois, cole o endereço do site e o token no popup da extensão.</p></div><div className="extension-install-steps"><span>1. Gerar token</span><span>2. Carregar a pasta extension</span><span>3. Colar o token</span><span>4. Ler e revisar cupons</span></div></section>

    <div className="settings-save-bar"><div><strong>Extensão e cupons</strong><span>Salve as regras antes de instalar ou testar.</span></div><button className="button primary" type="button" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? 'Salvando…' : 'Salvar configuração'}</button></div>
  </div>;
}
