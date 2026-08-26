import React, { useMemo, useState } from 'react';
import './GroupDirectoryPanel.css';

function normalizedCodes(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((code) => String(code || '').toUpperCase()).filter(Boolean))];
}

export default function GroupDirectoryPanel({ data, setData, authApi, setMessage, load }) {
  const config = data.config || {};
  const audiences = useMemo(() => (config.whatsappAudiences || []).filter((audience) => audience.enabled !== false), [config.whatsappAudiences]);
  const linkableCodes = audiences.filter((audience) => audience.whatsappLink).map((audience) => String(audience.code).toUpperCase());
  const activeCodes = audiences.map((audience) => String(audience.code).toUpperCase());
  const [title, setTitle] = useState(config.whatsappDirectoryTitle || '📢 Encontre seu grupo PromoShop');
  const [intro, setIntro] = useState(config.whatsappDirectoryIntro || 'Escolha os assuntos que você mais gosta e entre nos grupos:');
  const [footer, setFooter] = useState(config.whatsappDirectoryFooter || '✅ Entre nos seus favoritos e acompanhe as próximas ofertas.');
  const [includedCodes, setIncludedCodes] = useState(() => {
    const saved = normalizedCodes(config.whatsappDirectoryIncludedCodes).filter((code) => linkableCodes.includes(code));
    return saved.length ? saved : linkableCodes;
  });
  const [targetCodes, setTargetCodes] = useState(() => {
    const saved = normalizedCodes(config.whatsappDirectoryTargetCodes).filter((code) => activeCodes.includes(code));
    return saved.length ? saved : activeCodes;
  });
  const [busy, setBusy] = useState('');

  const includedGroups = audiences.filter((audience) => includedCodes.includes(String(audience.code).toUpperCase()) && audience.whatsappLink);
  const preview = [`*${title || '📢 Encontre seu grupo PromoShop'}*`, intro,
    includedGroups.map((audience) => `• *${audience.name || audience.code}*\n${audience.whatsappLink}`).join('\n\n'), footer
  ].filter(Boolean).join('\n\n');

  function toggle(setter, codes, code, checked) {
    setter(checked ? [...new Set([...codes, code])] : codes.filter((entry) => entry !== code));
  }

  async function saveDraft(showMessage = true) {
    await authApi('/admin/config', { method: 'PUT', body: JSON.stringify({
      whatsappDirectoryTitle: title,
      whatsappDirectoryIntro: intro,
      whatsappDirectoryFooter: footer,
      whatsappDirectoryIncludedCodes: includedCodes,
      whatsappDirectoryTargetCodes: targetCodes
    }) });
    setData((current) => ({ ...current, config: { ...current.config,
      whatsappDirectoryTitle: title, whatsappDirectoryIntro: intro, whatsappDirectoryFooter: footer,
      whatsappDirectoryIncludedCodes: includedCodes, whatsappDirectoryTargetCodes: targetCodes
    } }));
    if (showMessage) setMessage('Modelo de divulgação salvo.');
  }

  async function submit(force) {
    if (!includedGroups.length) return setMessage('Selecione pelo menos um grupo com link para exibir na mensagem.');
    if (!targetCodes.length) return setMessage('Selecione pelo menos um grupo que receberá a divulgação.');
    setBusy(force ? 'force' : 'queue');
    try {
      await saveDraft(false);
      const result = await authApi('/admin/group-directory/queue', { method: 'POST', body: JSON.stringify({ title, intro, footer, includedCodes, targetCodes, force }) });
      await load();
      setMessage(force ? `Divulgação priorizada para ${result.targetCodes.length} grupo(s).` : `Divulgação adicionada à fila para ${result.targetCodes.length} grupo(s).`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  async function save() {
    setBusy('save');
    try { await saveDraft(true); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  }

  return <div className="group-directory-admin">
    <section className="panel group-directory-intro"><div><span className="section-step">DIVULGAÇÃO CRUZADA</span><h2>Apresente todos os grupos da PromoShop</h2><p>Monte uma mensagem com os links que desejar e escolha exatamente quais grupos receberão a divulgação.</p></div><div className="group-directory-badge"><strong>{includedGroups.length}</strong><span>links na mensagem</span></div></section>
    <div className="group-directory-grid">
      <section className="panel group-directory-editor">
        <div className="panel-heading"><div><h2>Conteúdo da mensagem</h2><p>Você pode mudar estes textos antes de cada publicação.</p></div></div>
        <div className="group-directory-fields">
          <label>Título<input maxLength="120" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Texto de abertura<textarea rows="3" maxLength="500" value={intro} onChange={(event) => setIntro(event.target.value)} /></label>
          <label>Texto de encerramento<textarea rows="3" maxLength="500" value={footer} onChange={(event) => setFooter(event.target.value)} /></label>
        </div>

        <div className="directory-selection-block"><div className="directory-selection-heading"><div><strong>1. Links exibidos na mensagem</strong><small>Somente grupos com link configurado podem ser incluídos.</small></div><div><button type="button" onClick={() => setIncludedCodes(linkableCodes)}>Todos</button><button type="button" onClick={() => setIncludedCodes([])}>Limpar</button></div></div>
          <div className="directory-group-list">{audiences.map((audience) => { const code = String(audience.code).toUpperCase(); const hasLink = Boolean(audience.whatsappLink); return <label className={!hasLink ? 'disabled' : ''} key={`include-${code}`}><input type="checkbox" disabled={!hasLink} checked={hasLink && includedCodes.includes(code)} onChange={(event) => toggle(setIncludedCodes, includedCodes, code, event.target.checked)} /><span><strong>{audience.name || 'Grupo sem nome'}</strong><small>{code}{hasLink ? '' : ' · link não configurado'}</small></span></label>; })}</div>
        </div>

        <div className="directory-selection-block"><div className="directory-selection-heading"><div><strong>2. Grupos que receberão</strong><small>Esses são os destinos da publicação.</small></div><div><button type="button" onClick={() => setTargetCodes(activeCodes)}>Todos</button><button type="button" onClick={() => setTargetCodes([])}>Limpar</button></div></div>
          <div className="directory-group-list">{audiences.map((audience) => { const code = String(audience.code).toUpperCase(); return <label key={`target-${code}`}><input type="checkbox" checked={targetCodes.includes(code)} onChange={(event) => toggle(setTargetCodes, targetCodes, code, event.target.checked)} /><span><strong>{audience.name || 'Grupo sem nome'}</strong><small>{code}</small></span></label>; })}</div>
        </div>

        <div className="group-directory-actions"><button className="button subtle" disabled={Boolean(busy)} type="button" onClick={save}>{busy === 'save' ? 'Salvando…' : 'Salvar modelo'}</button><button className="button subtle" disabled={Boolean(busy)} type="button" onClick={() => submit(false)}>{busy === 'queue' ? 'Adicionando…' : 'Adicionar à fila'}</button><button className="button primary" disabled={Boolean(busy)} type="button" onClick={() => submit(true)}>{busy === 'force' ? 'Priorizando…' : 'Enviar agora'}</button></div>
      </section>
      <aside className="panel group-directory-preview"><div><span className="section-step">PRÉVIA</span><h2>Mensagem no WhatsApp</h2><p>Será enviada para {targetCodes.length} grupo(s).</p></div><pre>{preview || 'Selecione os grupos que aparecerão na mensagem.'}</pre><small>Os asteriscos deixam o título e os nomes em negrito no WhatsApp.</small></aside>
    </div>
  </div>;
}
