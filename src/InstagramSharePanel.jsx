import React, { useMemo, useState } from 'react';

function labelFor(item, kind) {
  if (kind === 'coupon') return `${item.title || 'Cupom'} · ${item.store || 'Loja'}`;
  return `${item.title || 'Oferta'} · ${item.store || 'Loja'}${item.price ? ` · R$ ${Number(item.price).toFixed(2).replace('.', ',')}` : ''}`;
}

export default function InstagramSharePanel({ data, authApi, setMessage }) {
  const [kind, setKind] = useState('offer');
  const [selectedId, setSelectedId] = useState('');
  const [profile, setProfile] = useState('');
  const [themeId, setThemeId] = useState('');
  const [ctaText, setCtaText] = useState('Acesse o link da bio');
  const [showQrCode, setShowQrCode] = useState(false);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const themes = Array.isArray(data.config?.instagramThemes) ? data.config.instagramThemes.filter((theme) => theme.enabled !== false) : [];
  const items = useMemo(() => kind === 'coupon'
    ? (data.coupons || []).filter((coupon) => coupon.active !== false)
    : (data.offers || []).filter((offer) => offer.status !== 'paused'), [data.coupons, data.offers, kind]);

  async function generate() {
    if (!selectedId) return setMessage('Escolha uma oferta ou cupom para gerar o compartilhamento.');
    setBusy(true);
    try {
      const result = await authApi('/admin/instagram/share-preview', {
        method: 'POST',
        body: JSON.stringify({ kind, id: selectedId, profile, themeId, ctaText, showQrCode })
      });
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
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Oferta PromoShop' });
      else await navigator.share({ title: 'Oferta PromoShop', url: preview });
    } catch (error) {
      if (error?.name !== 'AbortError') setMessage('Use o botão Baixar imagem para salvar e compartilhar manualmente.');
    }
  }

  return <div className="instagram-admin-layout personal-share-layout">
    <section className="panel instagram-settings personal-share-panel">
      <div className="panel-heading"><div><span className="section-step">COMPARTILHAMENTO MANUAL</span><h2>Template para seu Instagram pessoal</h2><p>Crie uma imagem pronta para baixar no celular e compartilhar nos seus Stories. Isso não publica automaticamente na sua conta pessoal.</p></div></div>
      <div className="settings-grid two-columns personal-share-form">
        <label>Perfil que aparecerá no template<input value={profile} onChange={(event) => setProfile(event.target.value)} placeholder="@seu perfil" /><small>Digite o usuário manualmente. A imagem mostrará “Siga @perfil”.</small></label>
        <label>Tipo de conteúdo<select value={kind} onChange={(event) => { setKind(event.target.value); setSelectedId(''); setPreview(''); }}><option value="offer">Oferta</option><option value="coupon">Cupom</option></select></label>
        <label className="wide-field">Escolha o conteúdo<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}><option value="">Selecione uma oferta ou cupom</option>{items.map((item) => <option key={item.id} value={item.id}>{labelFor(item, kind)}</option>)}</select></label>
        <label>Tema<select value={themeId} onChange={(event) => setThemeId(event.target.value)}><option value="">Automático pela data</option>{themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label>
        <label>Chamada no botão<input value={ctaText} onChange={(event) => setCtaText(event.target.value)} placeholder="Acesse o link da bio" /><small>A API do Instagram não cria botão clicável no Story.</small></label>
      </div>
      <label className="toggle-card"><input type="checkbox" checked={showQrCode} onChange={(event) => setShowQrCode(event.target.checked)} /><span><strong>Mostrar QR Code</strong><small>O QR Code é colocado separado do botão, no rodapé.</small></span></label>
      <div className="personal-share-actions"><button className="button primary" type="button" disabled={busy} onClick={generate}>{busy ? 'Gerando…' : 'Gerar template'}</button>{preview && <><a className="button subtle" href={preview} download="promoshop-instagram.jpg">Baixar imagem</a>{typeof navigator !== 'undefined' && navigator.share && <button className="button subtle" type="button" onClick={share}>Compartilhar</button>}</>}</div>
    </section>
    <section className="panel instagram-template-panel personal-share-preview-panel"><div className="panel-heading"><div><span className="section-step">PRÉVIA</span><h2>Imagem pronta para compartilhar</h2><p>O arquivo é vertical, no formato ideal para Stories.</p></div></div><div className="instagram-preview">{preview ? <img src={preview} alt="Template de compartilhamento da PromoShop" /> : <div><strong>Nenhuma prévia ainda</strong><p>Escolha o conteúdo, informe seu perfil e toque em “Gerar template”.</p></div>}<small>O botão Baixar imagem funciona no celular. Depois, abra o Instagram e compartilhe a imagem nos Stories.</small></div></section>
  </div>;
}
