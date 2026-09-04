import React from 'react';

/**
 * Ícones vetoriais pequenos e consistentes para a interface.
 * Eles substituem símbolos que poderiam ser renderizados como emojis
 * diferentes conforme o dispositivo ou o navegador.
 */
export default function Icon({ name, size = 18, className = '', strokeWidth = 1.8, filled = false }) {
  const classes = ['ui-icon', className].filter(Boolean).join(' ');
  const props = {
    className: classes,
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    'data-icon': name
  };

  switch (name) {
    case 'theme-system':
      return <svg {...props}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
    case 'theme-light':
      return <svg {...props}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>;
    case 'theme-dark':
      return <svg {...props}><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.7 8.7 0 1 0 20.5 14.2Z" /></svg>;
    case 'sparkles':
      return <svg {...props}><path d="m12 2.5-1.45 5.8L4.75 9.75l5.8 1.45L12 17l1.45-5.8 5.8-1.45-5.8-1.45L12 2.5Z" fill="currentColor" stroke="none" /><path d="m19 15-.65 2.35L16 18l2.35.65L19 21l.65-2.35L22 18l-2.35-.65L19 15Z" fill="currentColor" stroke="none" /></svg>;
    case 'assistant':
      return <svg {...props}><rect x="5" y="7" width="14" height="12" rx="3" /><path d="M12 3v4M9 12h.01M15 12h.01M8.5 16h7M3 11v3M21 11v3" /></svg>;
    case 'search':
      return <svg {...props}><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg>;
    case 'heart':
      return <svg {...props} fill={filled ? 'currentColor' : 'none'}><path d="M20.8 8.7c0 5-8.8 10.3-8.8 10.3S3.2 13.7 3.2 8.7A4.7 4.7 0 0 1 12 6.3a4.7 4.7 0 0 1 8.8 2.4Z" /></svg>;
    case 'instagram':
      return <svg {...props}><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" /><circle cx="12" cy="12" r="4" /><circle cx="17.6" cy="6.6" r=".8" fill="currentColor" stroke="none" /></svg>;
    case 'whatsapp':
      return <svg {...props}><path d="M20.2 11.6a8.2 8.2 0 0 1-12.1 7.2L3.5 20l1.2-4.4a8.2 8.2 0 1 1 15.5-4Z" /><path d="M8.5 8.6c.2-.5.5-.6.8-.6h.5c.2 0 .4.1.5.4l.7 1.7c.1.3.1.5-.1.7l-.5.6c.6 1.2 1.5 2.1 2.7 2.7l.6-.5c.2-.2.4-.2.7-.1l1.7.7c.3.1.4.3.4.5v.5c0 .3-.1.6-.6.8-.4.2-1.4.2-2.8-.4-1.4-.7-2.6-1.8-3.5-3.1-.9-1.3-1.3-2.5-1.1-3.1Z" /></svg>;
    case 'bolt':
      return <svg {...props}><path d="m13.2 2.5-8 11h6.3l-.7 8 8-11h-6.3l.7-8Z" /></svg>;
    case 'ticket':
      return <svg {...props}><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5V9a2.5 2.5 0 0 0 0 6v2.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5V15a2.5 2.5 0 0 0 0-6V6.5Z" /><path d="M12 6.5v2M12 15.5v2" /></svg>;
    case 'users':
      return <svg {...props}><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.9M16 14a5 5 0 0 1 4.5 5" /></svg>;
    case 'store':
      return <svg {...props}><path d="M4 10v10h16V10M3 10l2-6h14l2 6M3 10a3 3 0 0 0 5 2 3 3 0 0 0 4 0 3 3 0 0 0 4 0 3 3 0 0 0 5-2M9 20v-5h6v5" /></svg>;
    case 'info':
      return <svg {...props}><circle cx="12" cy="12" r="9" /><path d="M12 10.5v5M12 7.5h.01" /></svg>;
    case 'message':
      return <svg {...props}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.8 4v-4.1a2.5 2.5 0 0 1-2.2-2.4v-7Z" /></svg>;
    case 'star':
      return <svg {...props} fill={filled ? 'currentColor' : 'none'}><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" /></svg>;
    case 'settings':
      return <svg {...props}><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 15 .1.1a2 2 0 0 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4v.2a2 2 0 0 1-4 0v-.2a2 2 0 0 0-3.4-1.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A2 2 0 0 0 1.6 11h-.2a2 2 0 0 1 0-4h.2A2 2 0 0 0 3 3.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A2 2 0 0 0 9.2 0h.2a2 2 0 0 1 4 0h.2a2 2 0 0 0 3.4 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A2 2 0 0 0 21.2 7h.2a2 2 0 0 1 0 4h-.2a2 2 0 0 0-1.8 4Z" transform="translate(0 1) scale(.96)" /></svg>;
    case 'check':
      return <svg {...props}><path d="m5 12 4.5 4.5L19 7" /></svg>;
    case 'arrow-up-right':
      return <svg {...props}><path d="M7 17 17 7M8 7h9v9" /></svg>;
    case 'home':
      return <svg {...props}><path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Z" /><path d="M9 21v-6h6v6" /></svg>;
    case 'tag':
      return <svg {...props}><path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-7 7-9-9a2 2 0 0 1-2-1.4Z" /><path d="M7.5 7.5h.01" /></svg>;
    case 'activity':
      return <svg {...props}><path d="M3 12h4l2-6 4 12 2-6h6" /></svg>;
    case 'shield':
      return <svg {...props}><path d="M12 3 20 6v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-3Z" /><path d="m8.5 12 2.3 2.3 4.8-4.8" /></svg>;
    case 'database':
      return <svg {...props}><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" /></svg>;
    case 'lock':
      return <svg {...props}><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" /></svg>;
    case 'menu':
      return <svg {...props}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
    case 'close':
      return <svg {...props}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    default:
      return <svg {...props}><circle cx="12" cy="12" r="8" /></svg>;
  }
}
