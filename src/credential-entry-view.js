// Browser-owned credential entry dialog. The typed values go once to the main
// process (which forwards them to the credential broker) and are then cleared;
// this window is destroyed right after. No other renderer ever receives them.
(async () => {
  const $ = id => document.getElementById(id);
  const info = await window.weftCredentialEntry.info();
  if (info.theme === 'dark') document.documentElement.dataset.theme = 'dark';
  $('label').textContent = info.label;
  $('origins').textContent = info.origins.join(', ');
  const card = info.kind === 'payment_card';
  // Payment cards (ADR 019) use their own fields; the other set is removed so it cannot be submitted.
  (card ? $('login-fields') : $('card-fields')).remove();
  if (card) {
    document.title = 'Weft — save a payment card';
    $('title').textContent = 'Save a payment card';
    $('intro').textContent = 'Weft stores this card in its encrypted credential vault. Agents never see the number or security code: they can ask to fill it only on the merchant sites below, you approve each fill, and every purchase needs its own approval.';
    $('save').textContent = 'Save card to vault';
  }
  const inputs = () => [...document.querySelectorAll('input')];
  const clear = () => { for (const input of inputs()) input.value = ''; };
  $('cancel').addEventListener('click', () => { clear(); void window.weftCredentialEntry.cancel(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { clear(); void window.weftCredentialEntry.cancel(); } });
  $('entry').addEventListener('submit', event => {
    event.preventDefault();
    const value = card ? { kind: 'payment_card', number: $('number').value, expiry: $('expiry').value, cvc: $('cvc').value, name: $('cardholder').value }
      : { username: $('username').value, password: $('password').value };
    clear();
    void window.weftCredentialEntry.submit(value).then(accepted => { if (!accepted && card) $('card-error').textContent = 'Check the card number, expiry (MM/YY) and security code, then enter them again.'; });
  });
  (card ? $('number') : $('username')).focus();
})();
