// Same-origin script: applies the existing preference without weakening the CSP.
(() => {
  try {
    const allowed = ['system', 'light', 'dark'];
    const saved = localStorage.getItem('promoshop_theme');
    const preference = allowed.includes(saved) ? saved : 'light';
    const dark = preference === 'dark'
      || (preference === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch { }
})();
