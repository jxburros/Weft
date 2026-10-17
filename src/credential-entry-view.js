// Browser-owned credential entry dialog. The typed values go once to the main
// process (which forwards them to the credential broker) and are then cleared;
// this window is destroyed right after. No other renderer ever receives them.
(async () => {
  const $ = id => document.getElementById(id);
  const info = await window.weftCredentialEntry.info();
  if (info.theme === 'dark') document.documentElement.dataset.theme = 'dark';
  $('label').textContent = info.label;
  $('origins').textContent = info.origins.join(', ');
  const clear = () => { $('username').value = ''; $('password').value = ''; };
  $('cancel').addEventListener('click', () => { clear(); void window.weftCredentialEntry.cancel(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { clear(); void window.weftCredentialEntry.cancel(); } });
  $('entry').addEventListener('submit', event => {
    event.preventDefault();
    const value = { username: $('username').value, password: $('password').value };
    clear();
    void window.weftCredentialEntry.submit(value);
  });
  $('username').focus();
})();
