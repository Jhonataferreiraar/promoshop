import React, { useEffect, useMemo, useState } from 'react';
import './InstagramHighlightsPanel.css';

const DEFAULT_ITEMS = [
  { id: 'offers', name: 'Ofertas', icon: 'bolt', description: 'Achados e promoções selecionadas todos os dias.', enabled: true },
  { id: 'coupons', name: 'Cupons', icon: 'ticket', description: 'Cupons ativos para você economizar ainda mais.', enabled: true },
  { id: 'groups', name: 'Grupos', icon: 'users', description: 'Entre nos grupos da PromoShop e receba as oportunidades.', enabled: true }
];

const ICONS = [
  ['bolt', '⚡', 'Oferta'], ['ticket', '🎟', 'Cupom'], ['users', '●●', 'Pessoas'], ['store', '▣', 'Loja'],
  ['info', 'i', 'Informação'], ['message', '✉', 'Mensagem'], ['star', '★', 'Estrela'], ['heart', '♥', 'Coração']
];

function uniqueId() {
  return `highlight-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function InstagramHighlightsPanel({ data, setData, authApi, setMessage, load }) {
  const [items, setItems] = useState(() => data.config.instagramHighlights?.length ? data.config.instagramHighlights : DEFAULT_ITEMS);
  const [selectedId, setSelectedId] = useState(() => (data.config.instagramHighlights?.[0] || DEFAULT_ITEMS[0]).id);
  const [themeId, setThemeId] = useState(data.config.instagramManualThemeId || 'default');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (Array.isArray(data.config.instagramHighlights) && data.config.instagramHighlights.length) setItems(data.config.instagramHighlights);
  }, [data.config.instagramHighlights]);

  const selected = useMemo(() => items.find((item) => item.id === selectedId) || items[0], [items, selectedId]);
  const themes = Array.isArray(data.config.instagramThemes) ? data.config.instagramThemes.filter((theme) => theme.enabled !== false) : [];

  function updateItem(id, field, value) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, [field]: value } : item));
  }

  async function save() {
    setBusy('save');
    try {
      const result = await authApi('/admin/config', { method: 'PUT', body: JSON.stringify({ instagramHighlights: items }) });
      const saved = result?.config?.instagramHighlights || items;
      setItems(saved);
      setData((current) => ({ ...current, config: { ...current.config, instagramHighlights: saved } }));
      setMessage('Destaques salvos.');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function generate(variant) {
    if (!selected) return;
    setBusy(variant);
    try {
      const result = await authApi('/admin/instagram/highlights/preview', {
        method: 'POST', body: JSON.stringify({ highlight: selected, themeId, variant })
      });
      setPreview({ ...result, name: selected.name });
      setMessage(variant === 'cover' ? 'Capa gerada.' : 'Story de apresentação gerado.');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function queueStory() {
    if (!selected) return;
    setBusy('queue');
    try {
      await authApi('/admin/instagram/highlights/queue', {
        method: 'POST', body: JSON.stringify({ highlight: selected, themeId })
      });
      await load();
      setMessage(`Story de “${selected.name}” adicionado à fila do Instagram.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function downloadPreview() {
    if (!preview?.imageUrl) return;
    try {
      const response = await fetch(preview.imageUrl);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `promoshop-destaque-${String(preview.name || 'capa').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${preview.variant}.jpg`;
      link.click();
      URL.revokeObjectURL(url);
    } catch { window.open(preview.imageUrl, '_blank', 'noopener,noreferrer'); }
  }

  function addItem() {
    const item = { id: uniqueId(), name: 'Novo destaque', icon: 'star', description: 'Escreva aqui uma apresentação curta para este Destaque.', enabled: true };
    setItems((current) => [...current, item]);
    setSelectedId(item.id);
    setPreview(null);
  }

  function removeItem(id) {
    if (items.length <= 1) return setMessage('Mantenha pelo menos um Destaque.');
    const next = items.filter((item) => item.id !== id);
    setItems(next);
    setSelectedId(next[0].id);
    setPreview(null);
  }

  return <div className="highlights-admin">
    <section className="panel highlights-intro">
      <div><span className="section-step">ORGANIZAÇÃO DO PERFIL</span><h2>Destaques com a identidade da PromoShop</h2><p>Crie capas e Stories de apresentação. A publicação do Story entra na automação; somente a criação final do Destaque é feita no aplicativo do Instagram.</p></div>
      <div className="highlights-limit"><strong>Leve por padrão</strong><span>Esta área só é carregada quando você abre a aba.</span></div>
    </section>

    <div className="highlights-workspace">
      <section className="panel highlights-editor">
        <div className="panel-heading"><div><h2>Categorias</h2><p>Edite o nome, símbolo e texto de cada Destaque.</p></div><button className="button subtle" type="button" onClick={addItem}>+ Novo Destaque</button></div>
        <div className="highlight-tabs" role="tablist">
          {items.map((item) => <button type="button" role="tab" aria-selected={selected?.id === item.id} className={selected?.id === item.id ? 'active' : ''} key={item.id} onClick={() => { setSelectedId(item.id); setPreview(null); }}>
            <span>{ICONS.find(([id]) => id === item.icon)?.[1] || '★'}</span>{item.name}<i className={item.enabled === false ? 'off' : ''}></i>
          </button>)}
        </div>
        {selected && <div className="highlight-form">
          <label>Nome do Destaque<input maxLength="30" value={selected.name} onChange={(event) => updateItem(selected.id, 'name', event.target.value)} /></label>
          <label>Ícone<select value={selected.icon} onChange={(event) => updateItem(selected.id, 'icon', event.target.value)}>{ICONS.map(([id, symbol, label]) => <option key={id} value={id}>{symbol} {label}</option>)}</select></label>
          <label className="wide">Texto do Story<textarea maxLength="180" rows="3" value={selected.description} onChange={(event) => updateItem(selected.id, 'description', event.target.value)} /><small>{selected.description.length}/180 caracteres</small></label>
          <label className="highlight-switch"><input type="checkbox" checked={selected.enabled !== false} onChange={(event) => updateItem(selected.id, 'enabled', event.target.checked)} /><span><strong>Mostrar esta categoria</strong><small>Desative sem apagar a configuração.</small></span></label>
          <label>Tema visual<select value={themeId} onChange={(event) => setThemeId(event.target.value)}>{themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label>
        </div>}
        <div className="highlight-actions">
          <button className="button primary" disabled={Boolean(busy)} type="button" onClick={() => generate('cover')}>{busy === 'cover' ? 'Gerando…' : 'Gerar capa'}</button>
          <button className="button subtle" disabled={Boolean(busy)} type="button" onClick={() => generate('story')}>{busy === 'story' ? 'Gerando…' : 'Ver Story'}</button>
          <button className="button subtle" disabled={Boolean(busy) || selected?.enabled === false} type="button" onClick={queueStory}>{busy === 'queue' ? 'Adicionando…' : 'Adicionar Story à fila'}</button>
          <button className="text-button danger-text" type="button" onClick={() => removeItem(selected.id)}>Excluir</button>
        </div>
        <div className="highlight-save"><span>Salve para manter as categorias no painel.</span><button className="button primary" type="button" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? 'Salvando…' : 'Salvar categorias'}</button></div>
      </section>

      <aside className="panel highlight-preview">
        <div><span className="section-step">PRÉVIA</span><h2>{preview?.variant === 'story' ? 'Story de apresentação' : 'Capa do Destaque'}</h2></div>
        {preview?.imageUrl ? <><div className="highlight-phone"><img src={preview.imageUrl} alt={`Prévia de ${preview.name}`} /></div><button className="button primary" type="button" onClick={downloadPreview}>Baixar imagem</button></> : <div className="highlight-empty"><span>◎</span><strong>Escolha uma categoria</strong><p>Gere a capa ou veja o Story antes de colocar na fila.</p></div>}
      </aside>
    </div>

    <section className="panel highlight-steps"><div><span>1</span><strong>Gere e baixe a capa</strong><p>A arte já respeita o recorte circular do Instagram.</p></div><div><span>2</span><strong>Publique o Story</strong><p>Use a fila para publicar automaticamente no horário configurado.</p></div><div><span>3</span><strong>Finalize no Instagram</strong><p>Abra o Story arquivado, toque em “Destacar” e escolha a capa baixada.</p></div></section>
  </div>;
}
