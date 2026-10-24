// Run before styles load so a saved dark preference never flashes light.
(() => {
  let preference = 'system';
  try {
    const saved = localStorage.getItem('onmyway-theme');
    if (['light', 'dark', 'system'].includes(saved)) preference = saved;
  } catch { /* Appearance still works when storage is unavailable. */ }
  const theme = preference === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#17231d' : '#f7f8f2');
})();
