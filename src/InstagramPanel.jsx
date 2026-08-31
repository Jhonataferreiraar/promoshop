import React, { useMemo, useState } from 'react';

const stores = ['Mercado Livre', 'Shopee', 'AliExpress', 'Magalu'];
const statusText = { pending: 'Aguardando', publishing: 'Publicando', sent: 'Publicado', failed: 'Falhou' };

function arrayToggle(values, value, checked) {
  const current = Array.isArray(values) ? values : [];
  return checked ? [...new Set([...current, value])] : current.filter((entry) => entry !== value);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR');
}

// Os temas continuam armazenados como MM-DD para a seleção automática.
// No painel, porém, mostramos o intervalo no formato usado no Brasil (DD-MM).
function formatThemeDate(value) {
  const match = /^(\d{2})-(\d{2})$/.exec(String(value || ''));
  return match ? `${match[2]}-${match[1]}` : value || '—';
}

export default function InstagramPanel({ data, setData, secretForm, setSecretForm, authApi, setMessage, load, audiences = [] }) {
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState('');
  const config = data.config || {};
  const secrets = data.secrets || {};
  const queue = useMemo(() => [...(data.instagramQueue || [])].reverse(), [data.instagramQueue]);
  const themes = Array.isArray(config.instagramThemes) ? config.instagramThemes : [];
  const connected = Boolean(secrets.instagramConnected);
  const rateLimitedUntil = data.meta?.instagramRateLimitedUntil;
  const rateLimited = rateLimitedUntil && new Date(rateLimitedUntil).getTime() > Date.now();

  const setConfig = (changes) => setData((current) => ({ ...current, config: { ...current.config, ...changes } }));
  const updateTheme = (index, changes) => setConfig({ instagramThemes: themes.map((theme, themeIndex) => themeIndex === index ? { ...theme, ...changes } : theme) });

  async function refreshInstagramState() {
    const result = await authApi('/admin/instagram-state');
    setData((current) => ({
      ...current,
      ...result,
      meta: result.meta ? { ...(current.meta || {}), ...result.meta } : current.meta
    }));
  }

  async function save(showMessage = true) {
    await authApi('/admin/config', { method: 'PUT', body: JSON.stringify(config) });
    await authApi('/admin/secrets', {
      method: 'PUT',
      body: JSON.stringify({ instagramAppId: secretForm.instagramAppId, instagramAppSecret: secretForm.instagramAppSecret })
    });
    setSecretForm((current) => ({ ...current, instagramAppSecret: '' }));
    if (showMessage) setMessage('Configurações do Instagram salvas.');
    await load();
  }

  async function action(name, callback) {
    setBusy(name);
    try { await callback(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  const connect = () => action('connect', async () => {
    await save(false);
    const result = await authApi('/admin/instagram/connect', { method: 'POST', body: '{}' });
    window.location.href = result.authorizationUrl;
  });

  const test = () => action('test', async () => {
    const result = await authApi('/admin/instagram/test', { method: 'POST', body: '{}' });
    setMessage(`Instagram conectado${result.username ? ` como @${result.username}` : ''}.`);
  });

  const refresh = () => action('refresh', async () => {
    await authApi('/admin/instagram/refresh', { method: 'POST', body: '{}' });
    setMessage('Acesso do Instagram renovado.');
    await load();
  });

  const disconnect = () => action('disconnect', async () => {
    await authApi('/admin/instagram/disconnect', { method: 'POST', body: '{}' });
    setMessage('Instagram desconectado. O App ID e a chave foram mantidos.');
    await load();
  });

  const generatePreview = (themeId = '') => action('preview', async () => {
    await authApi('/admin/config', { method: 'PUT', body: JSON.stringify(config) });
    const result = await authApi('/admin/instagram/preview', { method: 'POST', body: JSON.stringify({ themeId }) });
    setPreview(`${result.imageUrl}?v=${Date.now()}`);
    setMessage(`Prévia criada com o tema ${themes.find((theme) => theme.id === result.themeId)?.name || result.themeId}.`);
  });

  const queueAction = (id, type) => action(`${type}-${id}`, async () => {
    await authApi(`/admin/instagram/queue/${encodeURIComponent(id)}${type === 'delete' ? '' : `/${type}`}`, { method: type === 'delete' ? 'DELETE' : 'POST', body: type === 'delete' ? undefined : '{}' });
    setData((current) => ({
      ...current,
      instagramQueue: type === 'delete'
        ? (current.instagramQueue || []).filter((item) => item.id !== id)
        : (current.instagramQueue || []).map((item) => item.id === id
          ? { ...item, status: type === 'publish' ? 'publishing' : 'pending', error: type === 'retry' ? null : item.error, retryAt: type === 'retry' ? null : item.retryAt }
          : item)
    }));
    setMessage(type === 'publish' ? 'Publicação iniciada.' : type === 'retry' ? 'Item devolvido para a fila.' : 'Item excluído da fila.');
    await refreshInstagramState();
    if (type === 'publish') {
      window.setTimeout(() => refreshInstagramState().catch(() => {}), 2500);
      window.setTimeout(() => refreshInstagramState().catch(() => {}), 8000);
    }
  });

  const retryAllFailed = () => action('retry-all', async () => {
    const result = await authApi('/admin/instagram/queue/retry-failed', { method: 'POST', body: '{}' });
    setData((current) => ({
      ...current,
      instagramQueue: (current.instagramQueue || []).map((item) => item.status === 'failed'
        ? { ...item, status: 'pending', attempts: 0, retryAt: null, error: null, instagramRateLimited: false, metaPublishingStartedAt: null }
        : item)
    }));
    setMessage(`${result.retried || 0} Story(s) devolvido(s) para a fila.`);
    await refreshInstagramState();
  });

  const deleteAllFailed = () => {
    const failedCount = queue.filter((item) => item.status === 'failed').length;
    if (!failedCount || !window.confirm(`Excluir permanentemente ${failedCount} Story(s) com falha da fila? As demais publicações não serão alteradas.`)) return;
    action('delete-all-failed', async () => {
      const result = await authApi('/admin/instagram/queue/failed/all', { method: 'DELETE' });
      setData((current) => ({
        ...current,
        instagramQueue: (current.instagramQueue || []).filter((item) => item.status !== 'failed')
      }));
      setMessage(`${result.deleted || 0} Story(s) com falha excluído(s) da fila.`);
      await refreshInstagramState();
    });
  };

  return <div className="instagram-admin-layout">
    <section className={`panel instagram-status-card ${connected ? 'connected' : ''}`}>
      <div className="instagram-account">
        <div className="instagram-avatar">{secrets.instagramProfilePictureUrl ? <img src={secrets.instagramProfilePictureUrl} alt="" /> : '◎'}</div>
        <div><span className="section-step">CONTA PROFISSIONAL</span><h2>{connected ? `@${secrets.instagramUsername || 'Instagram conectado'}` : 'Conecte o Instagram da PromoShop'}</h2><p>{connected ? `Token válido até ${formatDate(secrets.instagramTokenExpiresAt)}.` : 'Use a conexão oficial da Meta. A senha do Instagram nunca é salva no PromoShop.'}</p></div>
      </div>
      <div className="instagram-account-actions">
        {connected ? <><button className="button subtle" type="button" disabled={Boolean(busy)} onClick={test}>Testar</button><button className="button subtle" type="button" disabled={Boolean(busy)} onClick={refresh}>Renovar acesso</button><button className="button danger" type="button" disabled={Boolean(busy)} onClick={disconnect}>Desconectar</button></> : <button className="button primary" type="button" disabled={Boolean(busy)} onClick={connect}>{busy === 'connect' ? 'Abrindo Meta…' : 'Conectar Instagram'}</button>}
      </div>
    </section>

    <section className="panel instagram-settings">
      <div className="panel-heading"><div><span className="section-step">PUBLICAÇÃO AUTOMÁTICA</span><h2>Quando e o que publicar</h2><p>O Story entra na fila somente depois que a mesma promoção for enviada com sucesso no WhatsApp.</p></div></div>
      {rateLimited && <div className="instagram-feed-auto-summary"><span>!</span><div><strong>Publicações pausadas pela Meta</strong><p>A Meta detectou excesso de ações. A automação aguardará até aproximadamente {formatDate(rateLimitedUntil)} antes de tentar novamente.</p></div></div>}
      <div className="instagram-toggle-grid">
        <label className="toggle-card"><input type="checkbox" checked={Boolean(config.instagramEnabled)} onChange={(event) => setConfig({ instagramEnabled: event.target.checked })} /><span><strong>Ativar Stories</strong><small>Liga ou pausa toda a automação.</small></span></label>
        <label className="toggle-card"><input type="checkbox" checked={config.instagramAutoFromWhatsapp !== false} onChange={(event) => setConfig({ instagramAutoFromWhatsapp: event.target.checked })} /><span><strong>Após o WhatsApp</strong><small>Cria o Story depois de um envio confirmado.</small></span></label>
        <label className="toggle-card"><input type="checkbox" checked={config.instagramIncludeCoupons !== false} onChange={(event) => setConfig({ instagramIncludeCoupons: event.target.checked })} /><span><strong>Incluir cupons</strong><small>Cupons com imagem também podem virar Story.</small></span></label>
        <label className="toggle-card"><input type="checkbox" checked={Boolean(config.instagramShowQrCode)} onChange={(event) => setConfig({ instagramShowQrCode: event.target.checked })} /><span><strong>Mostrar QR Code</strong><small>Facilita abrir a oferta em outro aparelho.</small></span></label>
      </div>
      <div className="settings-grid three-columns">
        <label>Começar às<input type="time" value={config.instagramPublishingStart || '08:00'} onChange={(event) => setConfig({ instagramPublishingStart: event.target.value })} /></label>
        <label>Terminar às<input type="time" value={config.instagramPublishingEnd || '22:30'} onChange={(event) => setConfig({ instagramPublishingEnd: event.target.value })} /></label>
        <label>Intervalo entre Stories<input type="number" min="1" max="1440" value={config.instagramIntervalMinutes ?? 20} onChange={(event) => setConfig({ instagramIntervalMinutes: event.target.value })} /><small>Em minutos.</small></label>
        <label>Máximo por dia<input type="number" min="1" max="1500" value={config.instagramMaxPerDay ?? 15} onChange={(event) => setConfig({ instagramMaxPerDay: event.target.value })} /><small>Até 1.500 Stories por dia.</small></label>
        <label>Desconto mínimo<input type="number" min="0" max="99" value={config.instagramMinimumDiscount ?? 20} onChange={(event) => setConfig({ instagramMinimumDiscount: event.target.value })} /><small>Use 0 para não filtrar.</small></label>
        <label>Não repetir por<input type="number" min="1" max="365" value={config.instagramDuplicateDays ?? 7} onChange={(event) => setConfig({ instagramDuplicateDays: event.target.value })} /><small>Dias.</small></label>
      </div>
      <div className="instagram-filter-grid">
        <div><strong>Lojas permitidas</strong><div className="instagram-check-list">{stores.map((store) => <label key={store}><input type="checkbox" checked={(config.instagramStores || []).includes(store)} onChange={(event) => setConfig({ instagramStores: arrayToggle(config.instagramStores, store, event.target.checked) })} />{store}</label>)}</div></div>
        <div><strong>Grupos que podem originar Stories</strong><small>Sem seleção significa todos os grupos.</small><div className="instagram-check-list audiences">{audiences.filter((audience) => audience.enabled !== false).map((audience) => <label key={audience.code}><input type="checkbox" checked={(config.instagramAudienceCodes || []).includes(audience.code)} onChange={(event) => setConfig({ instagramAudienceCodes: arrayToggle(config.instagramAudienceCodes, audience.code, event.target.checked) })} /><span>{audience.name}<small>{audience.code}</small></span></label>)}</div></div>
      </div>
    </section>

    <section className="panel instagram-credentials">
      <div className="panel-heading"><div><span className="section-step">META FOR DEVELOPERS</span><h2>Credenciais protegidas</h2><p>O App Secret e o token ficam criptografados no servidor e nunca são devolvidos ao navegador.</p></div></div>
      <div className="settings-grid two-columns">
        <label>ID do aplicativo<input value={secretForm.instagramAppId || ''} onChange={(event) => setSecretForm({ ...secretForm, instagramAppId: event.target.value.trim() })} placeholder={secrets.instagramAppIdConfigured ? 'ID configurado' : 'Cole o App ID'} /></label>
        <label>Chave secreta do aplicativo<input type="password" value={secretForm.instagramAppSecret || ''} onChange={(event) => setSecretForm({ ...secretForm, instagramAppSecret: event.target.value })} placeholder={secrets.instagramAppSecretConfigured ? 'Configurada — deixe vazio para manter' : 'Cole o App Secret'} autoComplete="new-password" /></label>
        <label>URL de retorno<input value={config.instagramRedirectUri || ''} onChange={(event) => setConfig({ instagramRedirectUri: event.target.value })} /><small>Copie exatamente esta URL para o aplicativo da Meta.</small></label>
        <label>Versão da API<input value={config.instagramApiVersion || 'v25.0'} onChange={(event) => setConfig({ instagramApiVersion: event.target.value })} /></label>
      </div>
    </section>

    <section className="panel instagram-template-panel">
      <div className="panel-heading"><div><span className="section-step">TEMPLATE 1080 × 1920</span><h2>Identidade dos Stories</h2><p>O modo automático escolhe o tema pela data. No modo manual, você fixa uma campanha até alterar novamente.</p></div><button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => generatePreview(config.instagramThemeMode === 'manual' ? config.instagramManualThemeId : '')}>Gerar prévia</button></div>
      <div className="instagram-template-layout">
        <div className="instagram-theme-settings">
          <div className="settings-grid two-columns"><label>Escolha do tema<select value={config.instagramThemeMode || 'automatic'} onChange={(event) => setConfig({ instagramThemeMode: event.target.value })}><option value="automatic">Automática pela data</option><option value="manual">Manual</option></select></label>{config.instagramThemeMode === 'manual' && <label>Tema atual<select value={config.instagramManualThemeId || 'default'} onChange={(event) => setConfig({ instagramManualThemeId: event.target.value })}>{themes.filter((theme) => theme.enabled !== false).map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label>}<label>Chamada principal<input value={config.instagramCtaText || ''} onChange={(event) => setConfig({ instagramCtaText: event.target.value })} /><small>A API oficial não cria botão clicável no Story. Use “Acesse o link da bio”.</small></label><label>Transparência<input value={config.instagramDisclosureText || ''} onChange={(event) => setConfig({ instagramDisclosureText: event.target.value })} /></label></div>
          <div className="instagram-theme-list">{themes.map((theme, index) => <details key={theme.id} className="instagram-theme-card"><summary><span className="instagram-color-dot" style={{ background: `linear-gradient(135deg, ${theme.background}, ${theme.background2})` }}></span><strong>{theme.name}</strong><small>{theme.automatic ? `${formatThemeDate(theme.start)} a ${formatThemeDate(theme.end)}` : 'Tema base'}</small></summary><div className="instagram-theme-fields"><label>Nome<input value={theme.name} onChange={(event) => updateTheme(index, { name: event.target.value })} /></label><label>Início<input type="text" value={theme.start || ''} placeholder="MM-DD" onChange={(event) => updateTheme(index, { start: event.target.value })} /></label><label>Fim<input type="text" value={theme.end || ''} placeholder="MM-DD" onChange={(event) => updateTheme(index, { end: event.target.value })} /></label><label>Fundo<input type="color" value={theme.background} onChange={(event) => updateTheme(index, { background: event.target.value })} /></label><label>Segundo fundo<input type="color" value={theme.background2} onChange={(event) => updateTheme(index, { background2: event.target.value })} /></label><label>Destaque<input type="color" value={theme.accent} onChange={(event) => updateTheme(index, { accent: event.target.value })} /></label><label>Texto<input type="color" value={theme.text} onChange={(event) => updateTheme(index, { text: event.target.value })} /></label><label>Prioridade<input type="number" min="0" max="100" value={theme.priority ?? 0} onChange={(event) => updateTheme(index, { priority: event.target.value })} /></label><label className="theme-enabled"><input type="checkbox" checked={theme.enabled !== false} onChange={(event) => updateTheme(index, { enabled: event.target.checked })} /> Tema ativo</label><button className="button subtle" type="button" onClick={() => generatePreview(theme.id)}>Ver este tema</button></div></details>)}</div>
        </div>
        <div className="instagram-preview">{preview ? <img src={preview} alt="Prévia do Story da PromoShop" /> : <div><strong>Prévia do Story</strong><p>Clique em “Gerar prévia” para ver o resultado com uma oferta real.</p></div>}<small>A API oficial não oferece botão ou adesivo de link clicável no Story. O template usa “Acesse o link da bio” e pode mostrar um QR Code separado no rodapé.</small></div>
      </div>
    </section>

    <section className="panel instagram-queue-panel">
      <div className="panel-heading"><div><span className="section-step">FILA DO INSTAGRAM</span><h2>Stories recentes</h2><p>{queue.filter((item) => item.status === 'pending').length} aguardando · {queue.filter((item) => item.status === 'failed').length} com falha · {queue.filter((item) => item.status === 'sent').length} publicados</p></div>{queue.some((item) => item.status === 'failed') && <div className="instagram-queue-bulk-actions"><button className="button subtle" type="button" disabled={Boolean(busy)} onClick={retryAllFailed}>{busy === 'retry-all' ? 'Recolocando…' : 'Tentar novamente todos'}</button><button className="button danger" type="button" disabled={Boolean(busy)} onClick={deleteAllFailed}>{busy === 'delete-all-failed' ? 'Excluindo…' : 'Excluir todas as falhas'}</button></div>}</div>
      <div className="instagram-queue-list">{queue.slice(0, 100).map((item) => <article key={item.id} className={`instagram-queue-row ${item.status}`}><div className="instagram-queue-thumb">{item.image ? <img src={item.image} alt="" /> : '◇'}</div><div><strong>{item.title}</strong><span>{item.store} · {item.discount ? `${Math.round(item.discount)}% OFF` : 'oferta'}</span><small>{statusText[item.status] || item.status} · {formatDate(item.publishedAt || item.createdAt)}</small>{item.error && <em>{item.error}</em>}</div><div className="instagram-queue-actions">{item.status === 'pending' && <button type="button" disabled={Boolean(busy)} onClick={() => queueAction(item.id, 'publish')}>Publicar agora</button>}{item.status === 'failed' && <button type="button" disabled={Boolean(busy)} onClick={() => queueAction(item.id, 'retry')}>Tentar novamente</button>}{item.status !== 'publishing' && item.status !== 'sent' && <button className="danger" type="button" disabled={Boolean(busy)} onClick={() => queueAction(item.id, 'delete')}>Excluir</button>}</div></article>)}{!queue.length && <div className="empty"><strong>A fila do Instagram está vazia</strong><p>Depois da conexão, as promoções enviadas no WhatsApp entrarão aqui automaticamente.</p></div>}</div>
    </section>

    <div className="instagram-save-bar"><div><strong>Importante</strong><span>Salve antes de conectar ou sair desta aba.</span></div><button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => action('save', () => save())}>{busy === 'save' ? 'Salvando…' : 'Salvar configurações do Instagram'}</button></div>
  </div>;
}
