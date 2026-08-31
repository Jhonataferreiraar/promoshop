import React from 'react';

export default function ConfirmationModal({
  open,
  eyebrow = 'CONFIRMAR AÇÃO',
  title,
  body,
  confirmLabel = 'Confirmar',
  busyLabel = 'Excluindo…',
  onCancel,
  onConfirm,
  busy = false
}) {
  if (!open) return null;

  return <div className="modal-backdrop" onMouseDown={busy ? undefined : onCancel}>
    <section className="app-modal danger-modal" role="dialog" aria-modal="true" aria-labelledby="confirmation-modal-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-icon delete-icon">×</div>
      <div className="modal-heading">
        <span>{eyebrow}</span>
        <h2 id="confirmation-modal-title">{title}</h2>
        <p>{body}</p>
      </div>
      <div className="modal-actions">
        <button className="button subtle" type="button" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button className="button danger-button" type="button" onClick={onConfirm} disabled={busy}>{busy ? busyLabel : confirmLabel}</button>
      </div>
    </section>
  </div>;
}
