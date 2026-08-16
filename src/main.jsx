import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const fallbackConfig = {
  brandName: 'PromoShop',
  heroTitle: 'Ofertas boas não esperam.',
  heroText: 'Promoções selecionadas e verificadas para você economizar sem perder tempo.',
  primaryColor: '#1269f3',
  whatsappUrl: '#',
  disclosure: 'Podemos receber comissão pelas compras, sem custo adicional para você.'
};

const fallbackOffers = [
  { id: 'demo-1', title: 'Fone Bluetooth com cancelamento de ruído', store: 'Mercado Livre', category: 'Eletrônicos', price: 129.9, originalPrice: 219.9, image: 'https://http2.mlstatic.com/D_NQ_NP_2X_629644-MLA79812359049_102024-F.webp', affiliateUrl: '#', featured: true, freeShipping: true },
  { id: 'demo-2', title: 'Kit organizador para cozinha', store: 'Shopee', category: 'Casa', price: 49.9, originalPrice: 89.9, image: 'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=900&q=80', affiliateUrl: '#', featured: true, freeShipping: false },
  { id: 'demo-3', title: 'Smartwatch esportivo resistente à água', store: 'Mercado Livre', category: 'Tecnologia', price: 159.9, originalPrice: 299.9, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=80', affiliateUrl: '#', featured: false, freeShipping: true }
];

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!response.ok) {
    const error = new Error((await response.json().catch(() => ({}))).error || 'Falha na solicitação');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function discount(offer) {
  if (!offer.originalPrice || offer.originalPrice <= offer.price) return 0;
  return Math.round((1 - offer.price / offer.originalPrice) * 100);
}

function Logo({ name }) {
  return <a className="logo" href="/" aria-label={`${name} - início`}><span className="logo-mark">%</span>{name}</a>;
}

function PublicSite() {
  const [config, setConfig] = useState(fallbackConfig);
  const [offers, setOffers] = useState(fallbackOffers);
  const [query, setQuery] = useState('');
  const [store, setStore] = useState('Todas');
  const [sort, setSort] = useState('discount');
  const [visibleCount, setVisibleCount] = useState(24);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api('/config/public'), api('/offers')])
      .then(([configData, offerData]) => {
        setConfig({ ...fallbackConfig, ...configData });
        setOffers(offerData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--primary', config.primaryColor || fallbackConfig.primaryColor);
    document.title = `${config.brandName} — Ofertas de verdade`;
  }, [config]);

  const stores = ['Todas', ...new Set(offers.map((offer) => offer.store))];
  const filtered = useMemo(() => offers.filter((offer) => {
    const text = `${offer.title} ${offer.store} ${offer.category}`.toLowerCase();
    return text.includes(query.toLowerCase()) && (store === 'Todas' || offer.store === store);
  }).sort((a, b) => sort === 'price' ? Number(a.price) - Number(b.price) : sort === 'recent' ? new Date(b.createdAt || 0) - new Date(a.createdAt || 0) : discount(b) - discount(a)), [offers, query, store, sort]);
  const visibleOffers = filtered.slice(0, visibleCount);
  const topDiscount = Math.max(0, ...offers.map(discount));

  useEffect(() => setVisibleCount(24), [query, store, sort]);

  return <div className="site-shell">
    <header className="topbar">
      <div className="container nav-wrap">
        <Logo name={config.brandName} />
        <nav><a href="#ofertas">Ofertas</a><a href="#como-funciona">Como funciona</a></nav>
        <div className="nav-actions"><a className="nav-whatsapp" href={config.whatsappUrl || '#'} target="_blank" rel="noreferrer">Grupo no WhatsApp</a><a className="admin-link" href="/admin" aria-label="Área administrativa">Painel</a></div>
      </div>
    </header>

    <main>
      <section className="hero">
        <div className="container hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">CURADORIA DE OFERTAS TODOS OS DIAS</span>
            <h1>{config.heroTitle}</h1>
            <p>{config.heroText}</p>
            <div className="hero-actions"><a className="button light" href="#ofertas">Explorar ofertas</a><a className="button ghost" href={config.whatsappUrl || '#'} target="_blank" rel="noreferrer">Receber no WhatsApp</a></div>
            <div className="hero-metrics"><span><strong>{offers.length}</strong><small>ofertas disponíveis</small></span><span><strong>até {topDiscount}%</strong><small>de desconto</small></span><span><strong>3 lojas</strong><small>em um só lugar</small></span></div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="floating-card card-one"><span>HOJE</span><strong>Até 55% OFF</strong><small>em eletrônicos</small></div>
            <div className="phone"><div className="phone-head"><i></i><b>{config.brandName}</b></div><div className="mini-offer"><div></div><span><b>Oferta relâmpago</b><small>Preço caiu agora</small></span></div><div className="mini-offer"><div></div><span><b>Frete grátis</b><small>Selecionados</small></span></div><div className="phone-cta">VER OFERTA</div></div>
            <div className="floating-card card-two"><span>🔥</span><strong>Preço caiu!</strong></div>
          </div>
        </div>
      </section>

      <section className="search-panel container" aria-label="Filtros de ofertas">
        <label className="search-box"><span>⌕</span><span className="search-field"><small>O que você procura?</small><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Busque por produto, marca ou loja" /></span></label>
        <div className="store-filter"><small>Filtrar por loja</small><div>{stores.map((item) => <button type="button" className={store === item ? 'active' : ''} key={item} onClick={() => setStore(item)}>{item}</button>)}</div></div>
        <label className="sort-filter"><small>Ordenar por</small><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Ordenar ofertas"><option value="discount">Maior desconto</option><option value="recent">Mais recentes</option><option value="price">Menor preço</option></select></label>
        {(query || store !== 'Todas') && <button type="button" className="clear-filters" onClick={() => { setQuery(''); setStore('Todas'); }}>Limpar filtros</button>}
      </section>

      <section className="offers-section container" id="ofertas">
        <div className="section-heading"><div><span className="eyebrow dark">OPORTUNIDADES SELECIONADAS</span><h2>Ofertas que valem a pena</h2><p>Compare preços e escolha sua próxima economia.</p></div><span className="results-count"><strong>{filtered.length}</strong> ofertas encontradas</span></div>
        {loading && <p className="notice">Atualizando ofertas…</p>}
        <div className="offer-grid">
          {visibleOffers.map((offer) => <article className="offer-card" key={offer.id}>
            <div className="offer-image"><img src={offer.image} alt={offer.title} loading="lazy" />{discount(offer) > 0 && <span className="discount">{discount(offer)}% OFF</span>}<span className={`store-badge ${offer.store.toLowerCase().includes('shopee') ? 'shopee' : offer.store.toLowerCase().includes('aliexpress') ? 'aliexpress' : 'mercado'}`}>{offer.store}</span></div>
            <div className="offer-content"><div className="offer-meta"><small>{offer.category}</small>{offer.freeShipping && <span className="shipping">Frete grátis</span>}</div><h3>{offer.title}</h3><div className="prices"><s>{offer.originalPrice && offer.originalPrice > offer.price ? money.format(offer.originalPrice) : ''}</s><strong>{money.format(offer.price)}</strong><small>Preço sujeito a alteração</small></div><a className="button primary full" href={offer.affiliateUrl} target="_blank" rel="nofollow sponsored noreferrer">Ir para a oferta <span>↗</span></a></div>
          </article>)}
        </div>
        {visibleCount < filtered.length && <div className="load-more"><button className="button subtle" type="button" onClick={() => setVisibleCount((count) => count + 24)}>Mostrar mais ofertas</button><small>Exibindo {visibleOffers.length} de {filtered.length}</small></div>}
        {!filtered.length && <div className="empty"><strong>Nenhuma oferta encontrada</strong><p>Tente remover algum filtro.</p></div>}
      </section>

      <section className="how-section" id="como-funciona"><div className="container"><div className="section-heading centered"><div><span className="eyebrow dark">SIMPLES E TRANSPARENTE</span><h2>Economizar ficou mais fácil</h2><p>Nós reunimos as oportunidades. Você decide onde comprar.</p></div></div><div className="how-grid"><article><span>01</span><h3>Buscamos</h3><p>As ofertas são coletadas nas principais plataformas.</p></article><article><span>02</span><h3>Organizamos</h3><p>Você filtra por loja, preço ou desconto sem perder tempo.</p></article><article><span>03</span><h3>Você economiza</h3><p>Abra a oferta na loja oficial e conclua sua compra com segurança.</p></article></div></div></section>

      <section className="whatsapp-section" id="grupo"><div className="container whatsapp-card"><div><span className="whatsapp-icon">◉</span><span><small>OFERTAS EM PRIMEIRA MÃO</small><h2>As melhores promoções chegam até você</h2><p>Entre no grupo do WhatsApp e receba os alertas sem precisar ficar procurando.</p></span></div><a className="button whatsapp" href={config.whatsappUrl || '#'} target="_blank" rel="noreferrer">Quero receber ofertas</a></div></section>
    </main>

    <footer><div className="container footer-grid"><Logo name={config.brandName} /><p>{config.disclosure}</p><a href="/admin">Administrar</a></div></footer>
  </div>;
}

function Login({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setError('');
    try { const result = await api('/auth/login', { method: 'POST', body: JSON.stringify(form) }); localStorage.setItem('promoshop_token', result.token); onLogin(result.token); }
    catch (err) { setError(err.message); }
  }
  return <div className="login-page"><form className="login-card" onSubmit={submit}><Logo name="PromoShop" /><div><span className="eyebrow dark">ÁREA RESTRITA</span><h1>Painel administrativo</h1><p>Entre para gerenciar ofertas e automações.</p></div><label>Usuário<input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label><label>Senha<input required type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>{error && <p className="error">{error}</p>}<button className="button primary full">Entrar</button><a className="back-link" href="/">← Voltar para o site</a></form></div>;
}

const defaultNewOffer = { title: '', store: 'Mercado Livre', category: 'Eletrônicos', price: '', originalPrice: '', image: '', affiliateUrl: '', freeShipping: false, featured: true, status: 'active' };

function AdminApp() {
  const [token, setToken] = useState(localStorage.getItem('promoshop_token'));
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState({ offers: [], queue: [], config: fallbackConfig, logs: [], meta: { whatsapp: {} }, secrets: {} });
  const [newOffer, setNewOffer] = useState(defaultNewOffer);
  const [secretForm, setSecretForm] = useState({ adminUser: 'admin', adminPassword: '', mercadoLivreAccessToken: '', shopeeAppId: '', shopeeAppSecret: '', aliexpressAppKey: '', aliexpressAppSecret: '', aliexpressAppSignature: '', aiApiKey: '' });
  const [phoneNumber, setPhoneNumber] = useState('55');
  const [message, setMessage] = useState('');
  const [aiPreview, setAiPreview] = useState('');
  const [adminOfferQuery, setAdminOfferQuery] = useState('');
  const [adminOfferStore, setAdminOfferStore] = useState('Todas');
  const authApi = (path, options = {}) => api(path, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });

  async function load({ preserveConfig = false } = {}) {
    try {
      const result = await authApi('/admin/dashboard');
      setData((current) => preserveConfig ? { ...result, config: current.config } : result);
      if (!preserveConfig) {
        setSecretForm((current) => ({ ...current, adminUser: result.secrets?.adminUser || current.adminUser, shopeeAppId: result.secrets?.shopeeAppId || current.shopeeAppId, aliexpressAppKey: result.secrets?.aliexpressAppKey || current.aliexpressAppKey }));
      }
    }
    catch (error) {
      if (error.status === 401) {
        localStorage.removeItem('promoshop_token');
        setToken(null);
      }
    }
  }
  useEffect(() => { if (token) load(); }, [token]);
  useEffect(() => {
    if (!token || tab !== 'whatsapp') return undefined;
    const interval = window.setInterval(() => load({ preserveConfig: true }), 4000);
    return () => window.clearInterval(interval);
  }, [token, tab]);
  if (!token) return <Login onLogin={setToken} />;

  async function saveConfig(event) {
    event.preventDefault();
    await Promise.all([
      authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) }),
      authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ aiApiKey: secretForm.aiApiKey }) })
    ]);
    setSecretForm((current) => ({ ...current, aiApiKey: '' }));
    await load();
    setMessage('Configurações salvas.');
    setTimeout(() => setMessage(''), 2500);
  }
  async function saveSources(event) {
    event.preventDefault();
    await Promise.all([
      authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) }),
      authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ mercadoLivreAccessToken: secretForm.mercadoLivreAccessToken, shopeeAppId: secretForm.shopeeAppId, shopeeAppSecret: secretForm.shopeeAppSecret, aliexpressAppKey: secretForm.aliexpressAppKey, aliexpressAppSecret: secretForm.aliexpressAppSecret, aliexpressAppSignature: secretForm.aliexpressAppSignature }) })
    ]);
    setSecretForm((current) => ({ ...current, mercadoLivreAccessToken: '', shopeeAppSecret: '', aliexpressAppSecret: '', aliexpressAppSignature: '' }));
    await load();
    setMessage('Fontes e credenciais salvas com segurança.');
  }
  async function testShopee() {
    setMessage('Testando a Open API da Shopee…');
    try {
      await Promise.all([
        authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) }),
        authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ shopeeAppId: secretForm.shopeeAppId, shopeeAppSecret: secretForm.shopeeAppSecret }) })
      ]);
      const result = await authApi('/admin/sources/shopee/test', { method: 'POST', body: '{}' });
      setSecretForm((current) => ({ ...current, shopeeAppSecret: '' }));
      await load();
      setMessage(`Shopee conectada: ${result.count} ofertas encontradas${result.sample ? `, incluindo “${result.sample}”` : ''}.`);
    } catch (error) { setMessage(error.message); }
  }
  async function testAliexpress() {
    setMessage('Testando a Open API do AliExpress…');
    try {
      await Promise.all([
        authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) }),
        authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ aliexpressAppKey: secretForm.aliexpressAppKey, aliexpressAppSecret: secretForm.aliexpressAppSecret, aliexpressAppSignature: secretForm.aliexpressAppSignature }) })
      ]);
      const result = await authApi('/admin/sources/aliexpress/test', { method: 'POST', body: '{}' });
      setSecretForm((current) => ({ ...current, aliexpressAppSecret: '', aliexpressAppSignature: '' }));
      await load();
      setMessage(`AliExpress conectado: ${result.count} ofertas encontradas${result.sample ? `, incluindo “${result.sample}”` : ''}.`);
    } catch (error) { setMessage(error.message); }
  }
  async function testAi() {
    setMessage('A IA está criando um texto de teste…');
    setAiPreview('');
    try {
      await Promise.all([
        authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) }),
        authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ aiApiKey: secretForm.aiApiKey }) })
      ]);
      const result = await authApi('/admin/ai/test', { method: 'POST', body: '{}' });
      setSecretForm((current) => ({ ...current, aiApiKey: '' }));
      await load();
      setAiPreview(result.message);
      setMessage(`IA funcionando. Texto criado para “${result.offerTitle}”.`);
    } catch (error) { setMessage(error.message); }
  }
  async function saveSecurity(event) {
    event.preventDefault();
    await authApi('/admin/secrets', { method: 'PUT', body: JSON.stringify({ adminUser: secretForm.adminUser || data.secrets?.adminUser || 'admin', adminPassword: secretForm.adminPassword }) });
    setSecretForm((current) => ({ ...current, adminPassword: '' }));
    setMessage('Acesso administrativo atualizado. Use os novos dados no próximo login.');
  }
  async function addOffer(event) { event.preventDefault(); await authApi('/admin/offers', { method: 'POST', body: JSON.stringify(newOffer) }); setNewOffer(defaultNewOffer); await load(); setMessage('Oferta adicionada.'); }
  async function removeOffer(id) { if (!window.confirm('Remover esta oferta?')) return; await authApi(`/admin/offers/${id}`, { method: 'DELETE' }); await load(); }
  async function queueOffer(id, force = false) { await authApi(`/admin/offers/${id}/queue`, { method: 'POST', body: JSON.stringify({ force }) }); await load(); setMessage(force ? 'Publicação priorizada. O envio será feito em alguns segundos.' : 'Oferta colocada na fila do WhatsApp.'); }
  async function forceQueueItem(id) { await authApi(`/admin/queue/${id}/force`, { method: 'POST', body: '{}' }); await load(); setMessage('Publicação priorizada. O envio será feito em alguns segundos.'); }
  async function retryQueueItem(id) { await authApi(`/admin/queue/${id}/retry`, { method: 'POST', body: '{}' }); await load(); setMessage('Nova tentativa priorizada. O envio será feito em alguns segundos.'); }
  async function removeQueueItem(id) { await authApi(`/admin/queue/${id}`, { method: 'DELETE' }); await load(); setMessage('Item removido da fila.'); }
  async function activateOffer(offer) { const affiliateUrl = window.prompt('Cole o link de afiliado gerado pela ferramenta oficial:', offer.affiliateUrl || offer.productUrl || ''); if (!affiliateUrl) return; await authApi(`/admin/offers/${offer.id}`, { method: 'PUT', body: JSON.stringify({ affiliateUrl, status: 'active' }) }); await load(); setMessage('Link confirmado e oferta publicada.'); }
  async function collect() { setMessage('Buscando novas ofertas…'); try { const result = await authApi('/admin/collect', { method: 'POST' }); await load(); setMessage(`${result.imported} novas ofertas encontradas.`); } catch (err) { setMessage(err.message); } }
  async function startWhatsapp(mode = 'qr') { try { await authApi('/admin/config', { method: 'PUT', body: JSON.stringify(data.config) }); const result = await authApi('/admin/whatsapp/start', { method: 'POST', body: JSON.stringify({ mode, phoneNumber: mode === 'phone' ? phoneNumber : undefined }) }); setMessage(result.message); window.setTimeout(load, 1500); } catch (error) { setMessage(error.message); } }
  async function stopWhatsapp() { await authApi('/admin/whatsapp/stop', { method: 'POST', body: '{}' }); await load(); setMessage('Publicador parado.'); }
  function logout() { localStorage.removeItem('promoshop_token'); setToken(null); }

  const tabLabels = { overview: 'Visão geral', offers: 'Ofertas', queue: 'Fila de publicação', sources: 'Fontes de ofertas', whatsapp: 'WhatsApp', settings: 'Aparência do site', security: 'Segurança', logs: 'Atividades' };
  const tabDescriptions = { overview: 'Acompanhe o que está ativo e o que será publicado.', offers: 'Consulte e publique as ofertas disponíveis.', queue: 'Controle a ordem e o estado das publicações.', sources: 'Configure cada plataforma e as regras de coleta.', whatsapp: 'Gerencie conexão, grupos e horários de publicação.', settings: 'Personalize os textos e as cores do site público.', security: 'Altere o acesso ao painel administrativo.', logs: 'Consulte as ações e os erros recentes do sistema.' };
  const navIcons = { overview: '⌂', offers: '◇', queue: '↗', sources: '⌁', whatsapp: '◉', settings: '✦', security: '⌾', logs: '≡' };
  const navGroups = [
    { label: 'Operação', items: ['overview', 'offers', 'queue'] },
    { label: 'Automação', items: ['sources', 'whatsapp'] },
    { label: 'Sistema', items: ['settings', 'security', 'logs'] }
  ];
  const whatsapp = data.meta?.whatsapp || {};
  const statusLabels = { offline: 'Desconectado', starting: 'Iniciando', qr: 'Aguardando leitura do QR Code', pairing: 'Código gerado', authenticated: 'Autenticado', connected: 'Conectado', error: 'Erro' };
  const formattedPairingCode = String(whatsapp.pairingCode || '').replace(/\s/g, '').match(/.{1,4}/g)?.join(' ') || '';
  const adminStores = ['Todas', ...new Set(data.offers.map((offer) => offer.store))];
  const adminFilteredOffers = data.offers.filter((offer) => `${offer.title} ${offer.store} ${offer.category}`.toLowerCase().includes(adminOfferQuery.toLowerCase()) && (adminOfferStore === 'Todas' || offer.store === adminOfferStore));

  return <div className="admin-shell"><aside><div className="sidebar-brand"><Logo name={data.config.brandName || 'PromoShop'} /><small>Painel administrativo</small></div><nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><span>{group.label}</span>{group.items.map((id) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}><i>{navIcons[id]}</i>{tabLabels[id]}</button>)}</div>)}</nav><div className="sidebar-footer"><a href="/">Ver site <span>↗</span></a><button className="logout" onClick={logout}>Sair</button></div></aside><main className="admin-main"><header><div><span className="eyebrow dark">CENTRAL DE CONTROLE</span><h1>{tabLabels[tab]}</h1><p>{tabDescriptions[tab]}</p></div><div className="header-actions"><span className={`header-status ${whatsapp.status === 'connected' ? 'online' : ''}`}><i></i>WhatsApp {whatsapp.status === 'connected' ? 'ativo' : 'inativo'}</span>{['overview','offers','sources'].includes(tab) && <button className="button primary" onClick={collect}>Atualizar ofertas</button>}</div></header>{message && <div className="toast">{message}</div>}
    {tab === 'overview' && <div className="overview-layout"><section className="welcome-panel"><div><span className="eyebrow">RESUMO DA AUTOMAÇÃO</span><h2>{whatsapp.status === 'connected' ? 'Tudo pronto para publicar' : 'WhatsApp precisa de atenção'}</h2><p>{whatsapp.status === 'connected' ? `O publicador está conectado a ${(data.config.whatsappGroups || []).length} grupo(s) e segue a agenda configurada.` : 'Conecte o WhatsApp para que as ofertas da fila sejam enviadas automaticamente.'}</p></div><button className="button light" onClick={() => setTab('whatsapp')}>{whatsapp.status === 'connected' ? 'Ver configuração' : 'Conectar WhatsApp'}</button></section><div className="stats"><div><span><i>◇</i>Ofertas ativas</span><strong>{data.offers.filter((o) => o.status === 'active').length}</strong><small>Disponíveis no site</small></div><div><span><i>↗</i>Na fila</span><strong>{data.queue.filter((q) => q.status === 'pending').length}</strong><small>Aguardando publicação</small></div><div><span><i>✓</i>Enviadas</span><strong>{data.queue.filter((q) => q.status === 'sent').length}</strong><small>Publicações concluídas</small></div><div><span><i>⌁</i>Fontes ativas</span><strong>{Number(data.config.enableMercadoLivre) + Number(data.config.enableShopee) + Number(data.config.enableAliexpress)}</strong><small>Plataformas conectadas</small></div></div><section className="panel table-panel"><div className="panel-heading"><div><h2>Próximas publicações</h2><p>Itens que serão enviados primeiro.</p></div><button className="text-button" onClick={() => setTab('queue')}>Ver fila completa →</button></div><QueueTable queue={data.queue.filter((item) => item.status === 'pending').slice(0, 5)} /></section></div>}
    {tab === 'offers' && <div className="admin-columns"><form className="panel form-grid create-offer-panel" onSubmit={addOffer}><div className="panel-heading"><div><span className="section-step">CADASTRO MANUAL</span><h2>Adicionar oferta</h2><p>Use quando quiser incluir uma promoção específica.</p></div></div>{[['title','Produto'],['category','Categoria'],['price','Preço atual'],['originalPrice','Preço anterior'],['image','URL da imagem'],['affiliateUrl','Link de afiliado']].map(([key,label]) => <label key={key}>{label}<input required={!['originalPrice'].includes(key)} type={key.includes('Price') || key === 'price' ? 'number' : 'text'} step="0.01" value={newOffer[key]} onChange={(event) => setNewOffer({ ...newOffer, [key]: event.target.value })} /></label>)}<label>Loja<select value={newOffer.store} onChange={(event) => setNewOffer({ ...newOffer, store: event.target.value })}><option>Mercado Livre</option><option>Shopee</option><option>AliExpress</option><option>Outra</option></select></label><label className="check"><input type="checkbox" checked={newOffer.freeShipping} onChange={(event) => setNewOffer({ ...newOffer, freeShipping: event.target.checked })} /> Frete grátis</label><button className="button primary full">Adicionar oferta</button></form><section className="panel table-panel offers-manager"><div className="panel-heading"><div><h2>Ofertas cadastradas</h2><p>{adminFilteredOffers.length} de {data.offers.length} ofertas</p></div></div><div className="admin-toolbar"><label className="admin-search"><span>⌕</span><input value={adminOfferQuery} onChange={(event) => setAdminOfferQuery(event.target.value)} placeholder="Buscar oferta" /></label><select value={adminOfferStore} onChange={(event) => setAdminOfferStore(event.target.value)} aria-label="Filtrar ofertas por loja">{adminStores.map((item) => <option key={item}>{item}</option>)}</select></div><div className="offer-admin-list">{adminFilteredOffers.map((offer) => <div key={offer.id}><img src={offer.image} alt="" /><span><strong>{offer.title}</strong><small>{offer.store} · {money.format(Number(offer.price))} · {offer.status === 'active' ? 'Publicada' : 'Aguardando link'}</small></span><div className="offer-row-actions">{offer.status === 'active' ? <><button onClick={() => queueOffer(offer.id)}>Agendar</button><button className="force" onClick={() => queueOffer(offer.id, true)}>Publicar agora</button></> : <button onClick={() => activateOffer(offer)}>Vincular</button>}<button className="danger" onClick={() => removeOffer(offer.id)}>Excluir</button></div></div>)}</div></section></div>}
    {tab === 'queue' && <section className="panel table-panel"><div className="panel-heading"><div><h2>Fila de publicação</h2><p>{data.queue.filter((item) => item.status === 'pending').length} aguardando · {data.queue.filter((item) => item.status === 'failed').length} com falha</p></div></div><QueueTable queue={data.queue} onRemove={removeQueueItem} onForce={forceQueueItem} onRetry={retryQueueItem} /></section>}
    {tab === 'sources' && <form className="settings-form source-layout" onSubmit={saveSources}>
      <section className="panel compact-panel">
        <div className="section-title"><div><span className="section-step">REGRAS GERAIS</span><h2>Como selecionar as ofertas</h2><p>Estas regras valem para todas as plataformas ativas.</p></div></div>
        <div className="settings-grid three-columns">
          <label>Desconto mínimo (%)<input type="number" min="0" max="95" value={data.config.minDiscount ?? 20} onChange={(event) => setData({ ...data, config: { ...data.config, minDiscount: event.target.value } })} /></label>
          <label>Buscar a cada quantos minutos<input type="number" min="5" value={data.config.collectionIntervalMinutes ?? 15} onChange={(event) => setData({ ...data, config: { ...data.config, collectionIntervalMinutes: event.target.value } })} /></label>
          <label className="toggle-card"><input type="checkbox" checked={Boolean(data.config.autoQueue)} onChange={(event) => setData({ ...data, config: { ...data.config, autoQueue: event.target.checked } })} /><span><strong>Fila automática</strong><small>Adicionar ofertas com link confirmado à fila.</small></span></label>
        </div>
      </section>
      <div className="source-cards">
        <section className="panel source-card">
          <div className="source-card-head"><div className="source-brand mercado">ML</div><div><h2>Mercado Livre</h2><p>Buscas públicas e token opcional.</p></div><label className="switch"><input type="checkbox" checked={Boolean(data.config.enableMercadoLivre)} onChange={(event) => setData({ ...data, config: { ...data.config, enableMercadoLivre: event.target.checked } })} /><span></span></label></div>
          <div className="source-card-body"><label>Assuntos para buscar<textarea value={data.config.mercadoLivreQueries ?? ''} onChange={(event) => setData({ ...data, config: { ...data.config, mercadoLivreQueries: event.target.value } })} placeholder="smartphone, notebook, air fryer" /><small>Separe por vírgula.</small></label><label>Token de acesso<input type="password" value={secretForm.mercadoLivreAccessToken} onChange={(event) => setSecretForm({ ...secretForm, mercadoLivreAccessToken: event.target.value })} placeholder={data.secrets?.mercadoLivreAccessTokenConfigured ? 'Token configurado — digite para substituir' : 'Opcional: cole o token'} autoComplete="off" /></label></div>
        </section>
        <section className="panel source-card">
          <div className="source-card-head"><div className="source-brand shopee">S</div><div><h2>Shopee</h2><p>Open API de afiliados.</p></div><label className="switch"><input type="checkbox" checked={Boolean(data.config.enableShopee)} onChange={(event) => setData({ ...data, config: { ...data.config, enableShopee: event.target.checked } })} /><span></span></label></div>
          <div className="source-card-body"><label>Assuntos para buscar<textarea value={data.config.shopeeQueries ?? ''} onChange={(event) => setData({ ...data, config: { ...data.config, shopeeQueries: event.target.value } })} placeholder="eletrônicos, casa, beleza, moda" /><small>Separe por vírgula.</small></label><label>App ID<input value={secretForm.shopeeAppId} onChange={(event) => setSecretForm({ ...secretForm, shopeeAppId: event.target.value.trim() })} placeholder={data.secrets?.shopeeAppIdConfigured ? 'App ID configurado' : 'Cole o App ID'} autoComplete="off" /></label><label>App Secret<input type="password" value={secretForm.shopeeAppSecret} onChange={(event) => setSecretForm({ ...secretForm, shopeeAppSecret: event.target.value })} placeholder={data.secrets?.shopeeAppSecretConfigured ? 'Secret configurado — digite para substituir' : 'Cole o App Secret'} autoComplete="new-password" /></label><button className="button subtle full" type="button" onClick={testShopee}>Testar conexão da Shopee</button></div>
        </section>
        <section className="panel source-card">
          <div className="source-card-head"><div className="source-brand aliexpress">AE</div><div><h2>AliExpress</h2><p>Standard API para Publishers.</p></div><label className="switch"><input type="checkbox" checked={Boolean(data.config.enableAliexpress)} onChange={(event) => setData({ ...data, config: { ...data.config, enableAliexpress: event.target.checked } })} /><span></span></label></div>
          <div className="source-note"><strong>Campanhas automáticas</strong><span>Coleta as campanhas ativas. Busca livre exige Advanced API.</span></div>
          <div className="source-card-body"><label>Tracking ID<input value={data.config.aliexpressTrackingId ?? 'promoshop'} onChange={(event) => setData({ ...data, config: { ...data.config, aliexpressTrackingId: event.target.value.trim() } })} placeholder="promoshop" /></label><label>App Key<input value={secretForm.aliexpressAppKey} onChange={(event) => setSecretForm({ ...secretForm, aliexpressAppKey: event.target.value.trim() })} placeholder={data.secrets?.aliexpressAppKeyConfigured ? 'App Key configurada' : 'Cole a App Key'} autoComplete="off" /></label><label>App Secret<input type="password" value={secretForm.aliexpressAppSecret} onChange={(event) => setSecretForm({ ...secretForm, aliexpressAppSecret: event.target.value })} placeholder={data.secrets?.aliexpressAppSecretConfigured ? 'Secret configurado — digite para substituir' : 'Cole o App Secret'} autoComplete="new-password" /></label><label>App Signature <small>(opcional)</small><input type="password" value={secretForm.aliexpressAppSignature} onChange={(event) => setSecretForm({ ...secretForm, aliexpressAppSignature: event.target.value })} placeholder={data.secrets?.aliexpressAppSignatureConfigured ? 'Signature configurada — digite para substituir' : 'Pode deixar vazio'} autoComplete="new-password" /></label><button className="button subtle full" type="button" onClick={testAliexpress}>Testar conexão do AliExpress</button></div>
        </section>
      </div>
      <div className="form-footer"><span>As credenciais são armazenadas de forma protegida.</span><button className="button primary">Salvar todas as fontes</button></div>
    </form>}
    {tab === 'whatsapp' && <div className="whatsapp-admin-grid">
      <section className="panel connection-panel">
        <div className="connection-head"><div className="connection-summary"><span className={`connection-dot ${whatsapp.status || 'offline'}`}></span><div><small>STATUS DO PUBLICADOR</small><h2>{statusLabels[whatsapp.status] || 'Desconectado'}</h2><p>{whatsapp.message}</p></div></div><div className="connection-meta"><span><strong>{(whatsapp.groups || []).length}</strong> grupos encontrados</span><span><strong>{data.queue.filter((item) => item.status === 'pending').length}</strong> aguardando na fila</span></div><button className="button subtle" type="button" onClick={stopWhatsapp}>Desconectar</button></div>
        {whatsapp.status !== 'connected' && <div className="phone-pairing"><label>Número com país e DDD<input inputMode="numeric" autoComplete="tel" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value.replace(/\D/g, ''))} placeholder="5511999999999" /><small>Exemplo: 55 + DDD + número. Ele não será salvo.</small></label><div className="connection-actions"><button className="button primary" type="button" onClick={() => startWhatsapp('phone')}>Conectar pelo número</button><button className="button subtle" type="button" onClick={() => startWhatsapp('qr')}>Usar QR Code</button></div></div>}
        {whatsapp.pairingCode && <div className="pairing-box"><span className="pairing-code">{formattedPairingCode}</span><div><strong>Digite este código no WhatsApp</strong><p>No celular: Aparelhos conectados → Conectar aparelho → Conectar com número de telefone.</p></div></div>}
        {whatsapp.qrDataUrl && <div className="qr-box"><img src={whatsapp.qrDataUrl} alt="QR Code para conectar o WhatsApp" /><div><strong>Leia este QR Code</strong><p>No celular, abra WhatsApp → Aparelhos conectados → Conectar aparelho.</p></div></div>}
      </section>
      <form className="settings-form whatsapp-settings" onSubmit={saveConfig}>
        <div className="whatsapp-settings-grid">
          <section className="panel setting-section groups-section"><div className="section-title"><div><span className="section-step">DESTINOS</span><h2>Grupos de publicação</h2><p>Marque todos os grupos que receberão cada oferta.</p></div></div>{whatsapp.status !== 'connected' && !(whatsapp.groups || []).length && <div className="setup-hint"><strong>Conecte o WhatsApp primeiro</strong><p>Depois da conexão, seus grupos aparecerão aqui.</p></div>}<div className="group-selector"><div className="group-options">{(whatsapp.groups || []).map((group) => { const configured = Array.isArray(data.config.whatsappGroups) && data.config.whatsappGroups.length ? data.config.whatsappGroups : (data.config.whatsappGroupId ? [{ id: data.config.whatsappGroupId, name: data.config.whatsappGroupName }] : []); const checked = configured.some((selected) => selected.id === group.id); return <label className="group-option" key={group.id}><input type="checkbox" checked={checked} onChange={(event) => { const current = configured.filter((selected) => selected.id !== group.id); const next = event.target.checked ? [...current, group] : current; setData({ ...data, config: { ...data.config, whatsappGroups: next, whatsappGroupId: next[0]?.id || '', whatsappGroupName: next[0]?.name || '' } }); }} /><span>{group.name}</span></label>; })}{!(whatsapp.groups || []).length && <small>Os grupos serão carregados após a conexão.</small>}</div><small>{(() => { const count = (Array.isArray(data.config.whatsappGroups) && data.config.whatsappGroups.length ? data.config.whatsappGroups : (data.config.whatsappGroupId ? [{ id: data.config.whatsappGroupId }] : [])).length; return `${count} de ${(whatsapp.groups || []).length} grupo${(whatsapp.groups || []).length === 1 ? '' : 's'} selecionado${count === 1 ? '' : 's'}`; })()}</small></div><label className="field-separator">Link público do grupo<input type="url" value={data.config.whatsappUrl === '#' ? '' : data.config.whatsappUrl ?? ''} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappUrl: event.target.value } })} placeholder="https://chat.whatsapp.com/..." /><small>Usado somente no botão do site público.</small></label></section>
          <section className="panel setting-section"><div className="section-title"><div><span className="section-step">AGENDA</span><h2>Horários e frequência</h2><p>Defina quando a fila automática pode publicar.</p></div></div><div className="settings-grid"><label>Começar às<input type="time" value={data.config.publishingStart ?? '08:00'} onChange={(event) => setData({ ...data, config: { ...data.config, publishingStart: event.target.value } })} /></label><label>Parar às<input type="time" value={data.config.publishingEnd ?? '23:00'} onChange={(event) => setData({ ...data, config: { ...data.config, publishingEnd: event.target.value } })} /></label><label>Intervalo<select value={data.config.whatsappIntervalMinutes ?? 15} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappIntervalMinutes: Number(event.target.value) } })}>{[5, 10, 15, 20, 25, 30].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutos</option>)}</select><small>Não afeta “Publicar agora”.</small></label><label>Máximo por hora<input type="number" min="1" value={data.config.whatsappMaxPerHour ?? 10} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappMaxPerHour: event.target.value } })} /></label><label>Máximo por dia<input type="number" min="1" value={data.config.maxPostsPerDay ?? 10} onChange={(event) => setData({ ...data, config: { ...data.config, maxPostsPerDay: event.target.value } })} /></label><label className="toggle-card"><input type="checkbox" checked={Boolean(data.config.whatsappHeadless)} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappHeadless: event.target.checked } })} /><span><strong>Modo oculto</strong><small>Publicar sem abrir a janela do WhatsApp.</small></span></label><label className="toggle-card"><input type="checkbox" checked={data.config.whatsappAutoStart !== false} onChange={(event) => setData({ ...data, config: { ...data.config, whatsappAutoStart: event.target.checked } })} /><span><strong>Iniciar automaticamente</strong><small>Reconectar o publicador quando o servidor reiniciar.</small></span></label></div></section>
        </div>
        <section className="panel setting-section message-section"><div className="section-title"><div><span className="section-step">INTELIGÊNCIA ARTIFICIAL</span><h2>Texto exclusivo para cada oferta</h2><p>A IA externa cria a mensagem somente quando o produto estiver prestes a ser publicado.</p></div></div><div className="ai-settings-grid"><label className="toggle-card ai-toggle"><input type="checkbox" checked={Boolean(data.config.aiEnabled)} onChange={(event) => setData({ ...data, config: { ...data.config, aiEnabled: event.target.checked } })} /><span><strong>Criar textos com IA</strong><small>Se a IA falhar, o texto padrão abaixo será usado automaticamente.</small></span></label><label>Provedor<select value={data.config.aiProvider ?? 'groq'} onChange={(event) => { const preset = event.target.value === 'groq' ? { aiModel: 'openai/gpt-oss-20b' } : { aiModel: 'qwen2.5:3b' }; setData({ ...data, config: { ...data.config, aiProvider: event.target.value, ...preset } }); }}><option value="groq">Groq (externa)</option><option value="ollama">Ollama local</option></select><small>A chave fica criptografada no servidor.</small></label><label>Modelo<input value={data.config.aiModel ?? 'openai/gpt-oss-20b'} onChange={(event) => setData({ ...data, config: { ...data.config, aiModel: event.target.value } })} /><small>Modelo recomendado: openai/gpt-oss-20b.</small></label>{data.config.aiProvider !== 'ollama' && <label>Chave da Groq<input type="password" value={secretForm.aiApiKey} onChange={(event) => setSecretForm({ ...secretForm, aiApiKey: event.target.value })} placeholder={data.secrets?.aiApiKeyConfigured ? 'Chave configurada — digite para substituir' : 'Cole a chave da API'} autoComplete="new-password" /></label>}<label>Estilo do texto<select value={data.config.aiTone ?? 'varied'} onChange={(event) => setData({ ...data, config: { ...data.config, aiTone: event.target.value } })}><option value="varied">Variado automaticamente</option><option value="seller">Vendedor e confiável</option><option value="direct">Direto e objetivo</option><option value="friendly">Amigável e natural</option><option value="urgent">Urgência responsável</option><option value="premium">Elegante e premium</option><option value="playful">Divertido e descontraído</option><option value="story">Mini-história cotidiana</option><option value="minimal">Minimalista</option></select></label><label className="ai-instructions">Instruções para a IA<textarea value={data.config.aiInstructions ?? ''} onChange={(event) => setData({ ...data, config: { ...data.config, aiInstructions: event.target.value } })} placeholder="Ex.: Use poucos emojis e destaque a economia." /></label>{data.config.aiProvider === 'ollama' && <details className="advanced-ai"><summary>Configuração avançada</summary><label>Endereço do Ollama<input value={data.config.aiOllamaUrl ?? 'http://127.0.0.1:11434'} onChange={(event) => setData({ ...data, config: { ...data.config, aiOllamaUrl: event.target.value } })} /></label></details>}<button className="button subtle" type="button" onClick={testAi}>Salvar e testar IA</button></div>{aiPreview && <div className="ai-preview"><span>PRÉVIA DA MENSAGEM</span><pre>{aiPreview}</pre></div>}<div className="fallback-template"><div><strong>Texto de segurança</strong><small>Usado somente se a IA estiver desligada ou indisponível.</small></div><label>Modelo da mensagem<textarea value={data.config.messageTemplate ?? ''} onChange={(event) => setData({ ...data, config: { ...data.config, messageTemplate: event.target.value } })} /><small>Campos disponíveis: {'{title}'}, {'{originalPrice}'}, {'{price}'}, {'{discount}'}, {'{shipping}'} e {'{link}'}.</small></label></div></section>
        <div className="form-footer"><span>As alterações entram em vigor após salvar.</span><button className="button primary">Salvar grupos e regras</button></div>
      </form>
    </div>}
    {tab === 'settings' && <form className="panel settings-form" onSubmit={saveConfig}><h2>Identidade do site</h2><div className="settings-grid">{[['brandName','Nome do site'],['heroTitle','Título principal'],['heroText','Texto principal'],['primaryColor','Cor principal'],['disclosure','Aviso de afiliado']].map(([key,label]) => <label key={key}>{label}{['heroText','disclosure'].includes(key) ? <textarea value={data.config[key] ?? ''} onChange={(event) => setData({ ...data, config: { ...data.config, [key]: event.target.value } })} /> : <input type={key === 'primaryColor' ? 'color' : 'text'} value={data.config[key] ?? ''} onChange={(event) => setData({ ...data, config: { ...data.config, [key]: event.target.value } })} />}</label>)}</div><button className="button primary">Salvar aparência</button></form>}
    {tab === 'security' && <form className="panel settings-form narrow-panel" onSubmit={saveSecurity}><h2>Acesso administrativo</h2><p className="panel-intro">As credenciais são criptografadas no computador e nunca são enviadas ao navegador público.</p><div className="settings-grid"><label>Usuário administrador<input required value={secretForm.adminUser || data.secrets?.adminUser || 'admin'} onChange={(event) => setSecretForm({ ...secretForm, adminUser: event.target.value })} autoComplete="off" /></label><label>Nova senha<input type="password" minLength="8" value={secretForm.adminPassword} onChange={(event) => setSecretForm({ ...secretForm, adminPassword: event.target.value })} placeholder="Deixe vazio para manter a atual" autoComplete="new-password" /></label></div><button className="button primary">Atualizar acesso</button></form>}
    {tab === 'logs' && <section className="panel"><h2>Registro de atividades</h2><div className="logs">{data.logs.map((log) => <div key={log.id}><time>{new Date(log.createdAt).toLocaleString('pt-BR')}</time><span className={log.level}>{log.message}</span></div>)}</div></section>}
  </main></div>;
}

function QueueTable({ queue, onRemove, onForce, onRetry }) {
  if (!queue.length) return <div className="empty"><strong>A fila está vazia</strong><p>Envie uma oferta pelo painel.</p></div>;
  return <div className="queue-table">{queue.map((item) => <div key={item.id}><span><strong>{item.offerTitle}</strong><small>{item.store}{item.force && item.status === 'pending' ? ' · envio imediato' : ''}{item.error ? ` · ${item.error}` : ''}</small></span><span className={`status ${item.status}`}>{item.status === 'pending' ? (item.force ? 'Prioridade' : 'Aguardando') : item.status === 'sent' ? 'Enviada' : item.status === 'failed' ? 'Falhou' : item.status}</span><time>{new Date(item.createdAt).toLocaleString('pt-BR')}</time><div className="queue-actions">{onRetry && item.status === 'failed' && <button className="queue-force" onClick={() => onRetry(item.id)}>Tentar novamente</button>}{onForce && item.status === 'pending' && !item.force && <button className="queue-force" onClick={() => onForce(item.id)}>Publicar agora</button>}{onRemove && item.status !== 'sent' && <button className="queue-remove" onClick={() => onRemove(item.id)}>Remover</button>}</div></div>)}</div>;
}

const isAdmin = window.location.pathname.startsWith('/admin');
createRoot(document.getElementById('root')).render(<React.StrictMode>{isAdmin ? <AdminApp /> : <PublicSite />}</React.StrictMode>);
