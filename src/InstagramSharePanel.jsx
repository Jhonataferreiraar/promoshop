import React, { useMemo, useState } from 'react';

function labelFor(item, kind) {
  if (kind === 'coupon') return `${item.title || 'Cupom'} · ${item.store || 'Loja'}`;
  return `${item.title || 'Oferta'} · ${item.store || 'Loja'}${item.price ? ` · R$ ${Number(item.price).toFixed(2).replace('.', ',')}` : ''}`;
}

export default function InstagramSharePanel({ data, authApi, setMessage }) {
  const [contentType, setContentType] = useState('offer');
  const [selectedId, setSelectedId] = useState('');
  const [profile, setProfile] = useState('sonapromoshop');
  const [groupCode, setGroupCode] = useState('');
  const [bio, setBio] = useState('Ofertas e cupons selecionados\nDescontos de cair o queixo\nSó oferta boa de verdade');
  const [themeId, setThemeId] = useState('');
  const [ctaText, setCtaText] = useState('Acesse o link da bio');
  const [showQrCode, setShowQrCode] = useState(false);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const themes = Array.isArray(data.config?.instagramThemes) ? data.config.instagramThemes.filter((theme) => theme.enabled !== false) : [];
  const audiences = Array.isArray(data.config?.whatsappAudiences) ? data.config.whatsappAudiences.filter((audience) => audience.enabled !== false) : [];
  const items = useMemo(() => contentType === 'coupon'
    ? (data.coupons || []).filter((coupon) => coupon.active !== false)
    : (data.offers || []).filter((offer) => offer.status !== 'paused'), [data.coupons, data.offers, contentType]);
  const isTemplate = contentType === 'profile' || contentType === 'group';

  function changeType(value) {
    setContentType(value);
    setSelectedId('');
    setGroupCode('');
    setPreview('');
    if (value === 'profile') setCtaText('Conheça o perfil');
    else if (value === 'group') setCtaText('Conheça este grupo');
    else setCtaText('Acesse o link da bio');
  }

  async function generate() {
    if (!isTemplate && !selectedId) return setMessage('Escolha uma oferta ou cupom para gerar o compartilhamento.');
    if (contentType === 'group' && !groupCode) return setMessage('Escolha o grupo do WhatsApp para gerar o template.');
    setBusy(true);
    try {
      const endpoint = isTemplate ? '/admin/instagram/share-template' : '/admin/instagram/share-preview';
      const body = isTemplate
        ? { templateType: contentType, profile, groupCode, bio, themeId, ctaText, showQrCode }
        : { kind: contentType, id: selectedId, profile, themeId, ctaText, showQrCode };
      const result = await authApi(endpoint, { method: 'POST', body: JSON.stringify(body) });
      setPreview(`${result.imageUrl}?v=${Date.now()}`);
      setMessage('Template criado. Agora você pode baixar e compartilhar no seu Instagram.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    if (!preview || !navigator.share) return;
    try {
      const response = await fetch(preview);
      const blob = await response.blob();
      const file = new File([blob], 'promoshop-instagram.jpg', { type: 'image/jpeg' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'PromoShop' });
      else await navigator.share({ title: 'PromoShop', url: preview });
    } catch (error) {
      if (error?.name !== 'AbortError') setMessage('Use o botão Baixar imagem para salvar e compartilhar manualmente.');
    }
  }

  const typeLabel = contentType === 'profile' ? 'Perfil PromoShop' : contentType === 'group' ? 'Grupo do WhatsApp' : contentType === 'coupon' ? 'Cupom' : 'Oferta';
  return <div className="instagram-admin-layout personal-share-layout">
    <section className="panel instagram-settings personal-share-panel">
      <div className="panel-heading"><div><span className="section-step">COMPARTILHAMENTO MANUAL</span><h2>Templates para Stories e Destaques</h2><p>Crie uma arte vertical, baixe no celular e compartilhe manualmente. As promoções do perfil oficial continuam sendo publicadas automaticamente pela integração.</p></div></div>
      <div className="settings-grid two-columns personal-share-form">
        <label>Modelo<select value={contentType} onChange={(event) => changeType(event.target.value)}><option value="profile">Perfil PromoShop</option><option value="group">Grupo do WhatsApp</option><option value="offer">Oferta</option><option value="coupon">Cupom</option></select><small>Use Perfil e Grupo para criar capas dos Destaques.</small></label>
        <label>Perfil que aparecerá na arte<input value={profile} onChange={(event) => setProfile(event.target.value)} placeholder="sonapromoshop" /><small>A imagem exibirá “Siga @perfil”.</small></label>
        {contentType === 'group' && <label className="wide-field">Grupo do WhatsApp<select value={groupCode} onChange={(event) => setGroupCode(event.target.value)}><option value="">Selecione um grupo</option>{audiences.map((audience) => <option key={audience.code} value={audience.code}>{audience.name} · {audience.code}</option>)}</select><small>O grupo deve estar cadastrado nas regras do WhatsApp.</small></label>}
        {(contentType === 'offer' || contentType === 'coupon') && <label className="wide-field">{contentType === 'offer' ? 'Oferta' : 'Cupom'}<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}><option value="">Selecione {contentType === 'offer' ? 'uma oferta' : 'um cupom'}</option>{items.map((item) => <option key={item.id} value={item.id}>{labelFor(item, contentType)}</option>)}</select></label>}
        {contentType === 'profile' && <label className="wide-field">Bio do perfil<textarea rows="3" value={bio} onChange={(event) => setBio(event.target.value)} /><small>Uma frase por linha. Você pode editar para ficar igual à bio do Instagram.</small></label>}
        <label>Tema<select value={themeId} onChange={(event) => setThemeId(event.target.value)}><option value="">Automático pela data</option>{themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label>
        <label>Chamada principal<input value={ctaText} onChange={(event) => setCtaText(event.target.value)} /><small>O Instagram não cria botão clicável no Story.</small></label>
      </div>
      {contentType === 'group' && <label className="toggle-card"><input type="checkbox" checked={showQrCode} onChange={(event) => setShowQrCode(event.target.checked)} /><span><strong>Mostrar QR Code do grupo</strong><small>Só aparece quando o grupo possui um link HTTPS cadastrado.</small></span></label>}
      <div className="personal-share-actions"><button className="button primary" type="button" disabled={busy} onClick={generate}>{busy ? 'Gerando…' : `Gerar template de ${typeLabel}`}</button>{preview && <><a className="button subtle" href={preview} download="promoshop-instagram.jpg">Baixar imagem</a>{typeof navigator !== 'undefined' && navigator.share && <button className="button subtle" type="button" onClick={share}>Compartilhar</button>}</>}</div>
    </section>
    <section className="panel instagram-template-panel personal-share-preview-panel"><div className="panel-heading"><div><span className="section-step">PRÉVIA</span><h2>Imagem pronta para compartilhar</h2><p>Use a arte nos Stories ou adicione-a aos Destaques do perfil.</p></div></div><div className="instagram-preview">{preview ? <img src={preview} alt="Template de compartilhamento da PromoShop" /> : <div><strong>Nenhuma prévia ainda</strong><p>Escolha Perfil, Grupo, Oferta ou Cupom e toque em “Gerar template”.</p></div>}<small>O botão Baixar imagem funciona no celular. A API oficial não adiciona imagens diretamente aos Destaques; depois do download, use “Novo destaque” no Instagram.</small></div></section>
  </div>;
}
