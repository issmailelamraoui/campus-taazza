// Apply the saved appearance before the application renders.
(() => {
  let theme = 'dark';
  try { if (localStorage.getItem('campus-theme') === 'light') theme = 'light'; } catch {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151412' : '#f6f4ef');
})();
