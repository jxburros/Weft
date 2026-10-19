/**
 * Protected operations, credential residue checks, brokered sign-in and card fills, and term-bound payment submission (ADR 017, ADR 019).
 * Browser methods moved verbatim from src/browser.js (#119) and installed on Browser.prototype there, so
 * `this` is the Browser instance and every method keeps its name.
 */
import { OBSERVATION_WORLD, credentialScript, paymentScript } from './page-observation.js';
import { PROTECTED_ALLOWED, bounded, failure, isHuman, stale } from './browser-support.js';

export const browserCredentialMethods = {
  /** A credential broker or other protected flow can pause every observation route for automation. */
  setProtectedOperation(tabId, reason) {
    const tab = this.tab(tabId);
    tab.protectedOperation = reason ? String(reason).slice(0, 200) : null;
    if (reason) tab.protectionSerial = (tab.protectionSerial ?? 0) + 1;
  },
  /** Exclusive protected operation: active until ended, then a cooldown before automation may observe the tab again. */
  beginProtected(tab, token, reason) {
    clearTimeout(tab.protectionTimer);
    tab.protection = { token, reason: String(reason).slice(0, 200), active: true, until: null };
    tab.protectionSerial = (tab.protectionSerial ?? 0) + 1;
  },
  endProtected(tab, token, cooldownMs = this.protectedCooldownMs) {
    if (tab.protection?.token !== token) return;
    clearTimeout(tab.protectionTimer);
    if (!cooldownMs) { tab.protection = null; return; }
    tab.protection.active = false;
    tab.protection.until = Date.now() + cooldownMs;
    tab.protectionTimer = setTimeout(() => { if (tab.protection?.token === token) tab.protection = null; }, cooldownMs);
    tab.protectionTimer.unref?.();
  },
  protectedReason(tab) {
    if (tab.protectedOperation) return tab.protectedOperation;
    const protection = tab.protection;
    return protection && (protection.active || protection.until > Date.now()) ? protection.reason : null;
  },
  /** Every automation command aimed at a protected tab is refused, not only observation routes. */
  assertNotProtected(name, args) {
    if (PROTECTED_ALLOWED.has(name)) return;
    const tab = this.tabs.get(args.tabId ?? (name.startsWith('page.') ? this.activeId : null));
    const reason = tab && this.protectedReason(tab);
    if (reason) throw failure('permission_required', `This tab is in a protected operation (${reason}); automation may use only page.inspect until it and its cooldown end`, { credential: 'protected_operation' });
  },
  /** Run a frame-level credential script: isolated world for the top frame, the frame's own world for subframes. */
  credentialFrameScript(contents, frame, op, args = {}) {
    const top = !frame || frame === contents.mainFrame;
    const code = credentialScript(op, { ...args, isolated: top });
    if (!top) return frame.executeJavaScript(code, op === 'fill');
    return typeof contents.executeJavaScriptInIsolatedWorld === 'function'
      ? contents.executeJavaScriptInIsolatedWorld(OBSERVATION_WORLD, [{ code }], op === 'fill') : contents.executeJavaScript(code, op === 'fill');
  },
  /**
   * After a credential fill: page.evaluate (main-world code) is refused on the filled
   * document, and on any later document in this tab (for example a back/forward cache
   * restore) while a password or brokered field still holds a value.
   */
  async assertNoCredentialResidue(tab) {
    if (!tab.credentialFill) return;
    const refuse = () => failure('permission_required', 'page.evaluate is refused on a page that received a brokered credential while the value may still be present; navigate or reload first', { credential: 'credential_residue' });
    if (tab.credentialFill.document === (tab.documentSerial ?? 0)) throw refuse();
    const contents = tab.view.webContents;
    for (const frame of [contents.mainFrame, ...(contents.mainFrame?.framesInSubtree ?? []).filter(item => item !== contents.mainFrame)].filter(Boolean)) {
      let present = true;
      try { present = (await bounded(this.credentialFrameScript(contents, frame, 'residue'), 3000)) !== false; } catch { present = !frame.isDestroyed?.(); }
      if (present) throw refuse();
    }
  },
  /**
   * ADR 019: filling a card never authorizes a purchase. Once card details were filled, automation
   * page input (click, fill, press, coordinates) is refused on the filled document, and on any later
   * document of this tab (for example a back/forward restore) while a brokered field still holds a
   * value, so a pay button can only be pressed through payments.propose/payments.submit.
   */
  async assertNoFilledCard(tab, name) {
    if (tab.credentialFill?.kind !== 'payment_card') return;
    const refuse = () => Object.assign(failure('permission_required', `${name} is refused for automation on a page holding filled card details: a purchase needs its own approval. Use payments.propose, then payments.submit.`,
      { payment: 'card_filled', authority: { decision: 'deny', reason: 'card_filled' } }), { notStarted: true });
    if (tab.credentialFill.document === (tab.documentSerial ?? 0)) throw refuse();
    const contents = tab.view.webContents;
    for (const frame of [contents.mainFrame, ...(contents.mainFrame?.framesInSubtree ?? []).filter(item => item !== contents.mainFrame)].filter(Boolean)) {
      let present = true;
      try { present = (await bounded(this.credentialFrameScript(contents, frame, 'residue'), 3000)) !== false; } catch { present = !frame.isDestroyed?.(); }
      if (present) throw refuse();
    }
  },
  /**
   * Protected login operation (ADR-017). Serialized with other tab input and run as an
   * exclusive protected operation: automation cannot observe or act on the tab until it
   * and its cooldown end. The browser process verifies the top-level and target-frame
   * origins, asks `release` (the credential broker) for the secret only for those exact
   * origins, re-verifies nothing changed, and fills in the top frame's isolated world (or
   * the authorized subframe). Returns sanitized status only; refusals carry a fixed reason.
   */
  async credentialFill(args, context, { credential, release }) {
    const name = 'credentials.fill';
    this.admission.assertAutomationAdmitted(context.actor, name);
    const human = isHuman(context.actor);
    const tab = this.tab(args.tabId);
    if (args.workspaceId != null && tab.workspaceId !== args.workspaceId) throw failure('target_mismatch', 'Tab belongs to a different workspace');
    if (!human) this.assertNotProtected(name, args);
    // A suspended tab (#30) reloads before the origin and form checks; the checks then run against the live page.
    if (tab.suspended || tab.resuming) await this.resumeTab(tab, name);
    const refuse = (reason, message, code = 'target_mismatch') => Object.assign(failure(code, message, { credential: reason }), { notStarted: true });
    const slot = await this.acquireInput(tab, name, context.actor, human);
    const token = Symbol('credential fill');
    let released = false;
    try {
      this.checkControl(tab, args, context, name);
      this.beginProtected(tab, token, 'credential fill');
      const version = tab.version, epoch = tab.controlEpoch ?? 0;
      const contents = tab.view.webContents;
      if (tab.blocked) throw refuse('tab_blocked', 'The tab shows a blocked destination; nothing was filled');
      if (contents.isLoadingMainFrame?.()) throw refuse('navigation_in_progress', 'The page is still navigating; inspect it again when it has loaded', 'stale_state');
      if (contents.debugger?.isAttached?.() || contents.isDevToolsOpened?.()) throw refuse('debugger_attached', 'A debugger is attached to this tab; credentials are never filled while page internals can be observed', 'permission_required');
      const main = contents.mainFrame;
      let topOrigin = null;
      try { topOrigin = main?.origin && new URL(contents.getURL()).origin === main.origin ? main.origin : null; } catch { topOrigin = null; }
      if (!topOrigin || !credential.origins.includes(topOrigin)) throw refuse('origin_mismatch', 'This page is not on an origin authorized for this credential; nothing was filled');
      if (credential.kind === 'payment_card') return await this.fillCard(tab, contents, main, topOrigin, version, epoch, args, credential, release, () => { released = true; });
      let target;
      if (args.ref != null) {
        const probe = await bounded(this.credentialFrameScript(contents, null, 'probe', { ref: args.ref, origin: topOrigin }), 5000);
        if (!probe?.ok) throw refuse(probe?.reason === 'origin_mismatch' ? 'frame_origin_not_authorized' : 'not_login_field', 'The ref is not a visible login password field (or its form) on the authorized page', probe?.reason === 'origin_mismatch' ? 'target_mismatch' : 'not_found');
        target = { frame: main, origin: topOrigin, top: true };
      } else {
        const found = [];
        for (const frame of [main, ...(main.framesInSubtree ?? []).filter(item => item !== main)]) {
          if (frame.isDestroyed?.()) continue;
          const origin = frame.origin;
          let probe = null;
          try { probe = await bounded(this.credentialFrameScript(contents, frame, 'probe', { origin }), 5000); } catch { continue; }
          if (probe && (probe.ok || probe.count > 0)) found.push({ frame, origin, top: frame === main, count: probe.ok ? 1 : probe.count, authorized: origin === topOrigin || credential.frameOrigins.includes(origin) });
        }
        const authorized = found.filter(item => item.authorized);
        if (!authorized.length && found.length) throw refuse('frame_origin_not_authorized', 'The only login form is in a frame whose origin is not authorized for this credential; nothing was filled');
        if (!authorized.length) throw refuse('no_login_form', 'No visible login form (exactly one password field) was found on the authorized page', 'not_found');
        if (authorized.length > 1 || authorized[0].count > 1) throw refuse('ambiguous_login_form', 'Several login forms are present; pass ref with the password field from your latest page.snapshot', 'ambiguous_target');
        target = authorized[0];
      }
      // A caller deadline (ADR 018) that passed before the secret left the broker stops the fill with nothing filled.
      if (context.signal?.aborted) throw Object.assign(failure('cancelled', 'The request deadline passed before the fill; nothing was filled', { credential: 'interrupted' }), { notStarted: true });
      released = true;
      const secret = await release(topOrigin, target.origin);
      const unchanged = () => tab.version === version && contents.mainFrame === main && main.origin === topOrigin && !target.frame.isDestroyed?.() && target.frame.origin === target.origin
        && !contents.isLoadingMainFrame?.() && !contents.debugger?.isAttached?.();
      let result;
      let navigation = null;
      try {
        if ((tab.controlEpoch ?? 0) !== epoch) throw refuse('interrupted', 'Tab control changed before the fill; nothing was filled', 'action_interrupted');
        if (context.signal?.aborted) throw refuse('interrupted', 'The request deadline passed before the fill; nothing was filled', 'cancelled');
        if (!unchanged()) throw refuse('navigated', 'The page changed between the origin check and the fill; nothing was filled');
        navigation = this.watchNavigation(tab, tab.blocked);
        // From here the secret may be in the page: residue protections apply even if the script reports a failure.
        tab.credentialFill = { document: tab.documentSerial ?? 0, at: Date.now(), top: target.top };
        result = await bounded(this.credentialFrameScript(contents, target.frame, 'fill', { origin: target.origin, ref: args.ref ?? null, submit: args.submit === true,
          username: secret.username || '', password: secret.password }), 8000);
      } catch (error) { navigation?.cancel(); throw error; }
      finally { secret.password = ''; secret.username = ''; }
      if (!result?.ok) { navigation.cancel(); throw refuse(['navigated', 'no_login_form', 'ambiguous_login_form', 'not_login_field'].includes(result?.reason) ? result.reason : 'fill_failed', 'The login form changed before the fill; nothing was filled'); }
      const observed = await navigation.wait(result.submitted === 'requested' ? 1000 : 0);
      return { status: result.submitted === 'requested' ? 'submitted' : 'filled', fields: result.filled, submit: result.submitted, frame: target.top ? 'top' : 'subframe', origin: target.origin,
        navigation: !observed ? 'none' : observed.blocked ? 'blocked' : observed.download ? 'download' : observed.committed ? 'committed' : observed.committed === false && !observed.pending ? 'failed' : 'started',
        outcome: 'unverified', notice: 'Filled inside a protected operation. Whether sign-in succeeded is not verified; inspect the page after the protection cooldown.' };
    } finally {
      // The cooldown applies once a secret may have left the broker; a refusal before that ends the protection at once.
      this.endProtected(tab, token, released ? this.protectedCooldownMs : 0);
      this.releaseInput(tab, slot);
    }
  },
  /**
   * Payment-card fill (ADR 019) inside the same exclusive protected operation as a login fill.
   * Card fields may sit in the top frame or in payment-processor frames; every frame that holds
   * card fields must be the top origin or an authorized frame origin. Filling never submits:
   * purchase authorization is the separate payments.submit command with its own approval.
   */
  async fillCard(tab, contents, main, topOrigin, version, epoch, args, credential, release, markReleased) {
    const refuse = (reason, message, code = 'target_mismatch') => Object.assign(failure(code, message, { credential: reason }), { notStarted: true });
    if (args.submit === true) throw refuse('card_submit_separate', 'Card filling never submits a purchase; a person approves the payment and payments.submit clicks the pay control', 'invalid_arguments');
    if (args.ref != null) throw refuse('not_card_field', 'Card fills find the card fields themselves; omit ref', 'invalid_arguments');
    const found = [];
    for (const frame of [main, ...(main.framesInSubtree ?? []).filter(item => item !== main)]) {
      if (frame.isDestroyed?.()) continue;
      let probe = null;
      try { probe = await bounded(this.credentialFrameScript(contents, frame, 'cardProbe', { origin: frame.origin }), 5000); } catch { continue; }
      const fields = Object.fromEntries(Object.entries(probe?.fields ?? {}).filter(([kind, count]) => ['number', 'expiry', 'expMonth', 'expYear', 'cvc', 'name'].includes(kind) && count > 0));
      if (Object.keys(fields).length) found.push({ frame, origin: frame.origin, top: frame === main, fields, authorized: frame.origin === topOrigin || credential.frameOrigins.includes(frame.origin) });
    }
    if (found.some(item => !item.authorized)) throw refuse('frame_origin_not_authorized', 'Card fields are in a frame whose origin is not authorized for this card; nothing was filled');
    const totals = {};
    for (const item of found) for (const [kind, count] of Object.entries(item.fields)) totals[kind] = (totals[kind] ?? 0) + count;
    if (!totals.number) throw refuse('no_card_form', 'No visible card-number field was found on the authorized page', 'not_found');
    if (Object.values(totals).some(count => count > 1)) throw refuse('ambiguous_card_form', 'Several card forms are present; nothing was filled', 'ambiguous_target');
    markReleased();
    const secret = await release(topOrigin, found.map(item => item.origin));
    const unchanged = () => tab.version === version && contents.mainFrame === main && main.origin === topOrigin && !contents.isLoadingMainFrame?.() && !contents.debugger?.isAttached?.()
      && found.every(item => !item.frame.isDestroyed?.() && item.frame.origin === item.origin);
    const filled = [];
    try {
      if ((tab.controlEpoch ?? 0) !== epoch) throw refuse('interrupted', 'Tab control changed before the fill; nothing was filled', 'action_interrupted');
      if (!unchanged()) throw refuse('navigated', 'The page changed between the origin check and the fill; nothing was filled');
      // From here card details may be in the page: residue protections apply even if a frame script reports a failure.
      tab.credentialFill = { document: tab.documentSerial ?? 0, at: Date.now(), top: found.some(item => item.top), kind: 'payment_card' };
      for (const item of found) {
        // Each frame receives only the values for the fields it holds.
        const values = { origin: item.origin, number: item.fields.number ? secret.number : '', cvc: item.fields.cvc ? secret.cvc : '', name: item.fields.name ? secret.name || '' : '',
          expMonth: item.fields.expiry || item.fields.expMonth ? secret.expMonth : '', expYear: item.fields.expiry || item.fields.expYear ? secret.expYear : '' };
        const result = await bounded(this.credentialFrameScript(contents, item.frame, 'cardFill', values), 8000);
        if (!result?.ok) throw Object.assign(failure('command_failed', 'The card form changed during the fill; check the page before continuing', { credential: ['navigated', 'no_card_form', 'ambiguous_card_form'].includes(result?.reason) ? result.reason : 'fill_failed' }));
        filled.push(...result.filled);
      }
    } finally { for (const key of Object.keys(secret)) secret[key] = ''; }
    return { status: 'filled', kind: 'payment_card', fields: [...new Set(filled)], submit: 'not_requested', frame: found.length === 1 && found[0].top ? 'top' : 'subframes', frames: found.length, origin: topOrigin,
      navigation: 'none', outcome: 'unverified', notice: 'Card details were filled inside a protected operation. Nothing was submitted: the purchase needs a person to approve the payment terms, then payments.submit.' };
  },
  /** Run a payment script: isolated world for the top frame, the frame's own world for a checkout subframe (Electron offers no isolated world there). */
  paymentFrameScript(contents, frame, op, args = {}) {
    const code = paymentScript(op, args);
    if (frame && frame !== contents.mainFrame) return frame.executeJavaScript(code, op === 'click');
    return typeof contents.executeJavaScriptInIsolatedWorld === 'function'
      ? contents.executeJavaScriptInIsolatedWorld(OBSERVATION_WORLD, [{ code }], op === 'click') : contents.executeJavaScript(code, op === 'click');
  },
  /**
   * Read checkout terms (ADR 019): the top-level origin from the browser process (cross-checked
   * with the committed URL), the one checkout frame with the expected origin, and the rendered
   * text of each configured element. Page text is returned as data for the payment service to parse.
   */
  async readCheckout(tab, { frameOrigin = null, selectors }) {
    const contents = tab.view.webContents;
    const main = contents.mainFrame;
    let topOrigin = null;
    try { topOrigin = main?.origin && new URL(contents.getURL()).origin === main.origin ? main.origin : null; } catch { topOrigin = null; }
    let frame = main;
    if (frameOrigin && frameOrigin !== topOrigin) {
      const matches = (main?.framesInSubtree ?? []).filter(item => item !== main && !item.isDestroyed?.() && item.origin === frameOrigin);
      if (matches.length !== 1) return { topOrigin, url: contents.getURL(), frameOrigin: null, frameCount: matches.length, fields: {}, frame: null };
      frame = matches[0];
    }
    const read = await bounded(this.paymentFrameScript(contents, frame, 'read', { selectors }), 5000);
    const scriptOrigin = read?.origin ?? null;
    return { topOrigin, url: contents.getURL(), frameOrigin: frame?.origin && scriptOrigin === frame.origin ? frame.origin : null, frameUrl: read?.href ?? null, fields: read?.fields ?? {}, frame };
  },
  /** payments.propose: resolve snapshot refs to selectors (top frame only) and read the checkout as it is now. */
  async paymentObserve(args, context, { frameOrigin = null, targets }) {
    const name = 'payments.propose';
    this.admission.assertAutomationAdmitted(context.actor, name);
    const human = isHuman(context.actor);
    const tab = this.tab(args.tabId);
    if (args.workspaceId != null && tab.workspaceId !== args.workspaceId) throw failure('target_mismatch', 'Tab belongs to a different workspace');
    if (!human) this.assertNotProtected(name, args);
    // A suspended tab (#30) holds no page: inspecting it reloads the checkout, after which the terms can be read.
    if (tab.suspended || tab.resuming) throw stale('tab_suspended', 'The tab is suspended; inspect it (it reloads) and propose again');
    await this.assertObservable(tab, name, context);
    const contents = tab.view.webContents;
    if (tab.blocked) throw failure('site_blocked', 'The tab shows a blocked destination');
    if (contents.isLoadingMainFrame?.()) throw stale('navigation_in_progress', 'The checkout is still loading; inspect it again when it has loaded');
    if (args.expectedVersion != null && args.expectedVersion !== tab.version) throw stale('version', 'Stale tab version; inspect current state');
    const selectors = {};
    const refs = {};
    for (const [field, target] of Object.entries(targets)) { if (target?.selector) selectors[field] = target.selector; else if (target?.ref) refs[field] = target.ref; }
    if (Object.keys(refs).length) {
      if (frameOrigin) throw failure('invalid_arguments', 'Snapshot refs identify top-frame elements; use CSS selectors for a checkout inside a frame');
      if (!human) for (const ref of Object.values(refs)) this.assertRef(tab, { ref }, context.actor);
      const resolved = await bounded(this.paymentFrameScript(contents, contents.mainFrame, 'resolve', { refs }), 5000);
      for (const field of Object.keys(refs)) {
        const selector = resolved?.selectors?.[field];
        if (!selector) throw stale('ref_not_resolvable', `The ${field} ref is not an element of the top-level document (frames and shadow roots need a CSS selector)`);
        selectors[field] = selector;
      }
    }
    const { frame: _frame, ...observation } = await this.readCheckout(tab, { frameOrigin, selectors });
    return { ...observation, selectors, version: tab.version };
  },
  /**
   * payments.submit: the purchase click (ADR 019). Serialized with all tab input. Re-reads the
   * checkout immediately before the click and hands it to `verify` (which refuses changed
   * terms); `onAttempt` durably records the attempt before the click. Errors carry
   * `paymentStage`: not_clicked (provably nothing clicked) or click_unknown.
   */
  async paymentSubmit(args, context, { frameOrigin = null, selectors, verify, onAttempt }) {
    const name = 'payments.submit';
    const human = isHuman(context.actor);
    // Every refusal before the attempt is recorded precedes any effect: a one-time approval is given back.
    const before = work => { try { return work(); } catch (error) { if (error && typeof error === 'object' && !error.paymentChanged) error.notStarted = true; throw error; } };
    const tab = before(() => {
      this.admission.assertAutomationAdmitted(context.actor, name);
      const target = this.tab(args.tabId);
      if (args.workspaceId != null && target.workspaceId !== args.workspaceId) throw failure('target_mismatch', 'Tab belongs to a different workspace');
      if (!human) this.assertNotProtected(name, args);
      return target;
    });
    const refuse = (code, message, details) => Object.assign(failure(code, message, details), { notStarted: true });
    const slot = await this.acquireInput(tab, name, context.actor, human).catch(error => { error.notStarted = true; throw error; });
    try {
      this.checkControl(tab, args, context, name);
      const contents = tab.view.webContents;
      if (tab.blocked) throw refuse('site_blocked', 'The tab shows a blocked destination; nothing was submitted');
      if (contents.isLoadingMainFrame?.()) throw refuse('stale_state', 'The checkout is still loading; inspect it again when it has loaded', { reason: 'navigation_in_progress' });
      const version = tab.version, epoch = tab.controlEpoch ?? 0, main = contents.mainFrame;
      const observation = await this.readCheckout(tab, { frameOrigin, selectors }).catch(error => { error.notStarted = true; throw error; });
      const { frame } = observation;
      verify(observation);
      await onAttempt();
      const unchanged = tab.version === version && (tab.controlEpoch ?? 0) === epoch && contents.mainFrame === main && main?.origin === observation.topOrigin
        && frame && !frame.isDestroyed?.() && frame.origin === observation.frameOrigin && !contents.isLoadingMainFrame?.();
      if (!unchanged) throw Object.assign(failure('action_interrupted', 'The checkout changed while the attempt was being recorded; nothing was clicked'), { paymentStage: 'not_clicked' });
      const navigation = this.watchNavigation(tab, tab.blocked);
      let clicked;
      try { clicked = await bounded(this.paymentFrameScript(contents, frame, 'click', { selector: selectors.submit, origin: observation.frameOrigin }), 8000); }
      catch (error) { navigation.cancel(); throw Object.assign(error, { paymentStage: 'click_unknown' }); }
      if (!clicked?.ok) { navigation.cancel(); return { clicked: false, reason: ['navigated', 'missing', 'ambiguous', 'disabled'].includes(clicked?.reason) ? clicked.reason : 'missing' }; }
      const observed = await navigation.wait(1500);
      let url = null;
      try { url = contents.getURL(); } catch { url = null; }
      return { clicked: true, url, navigation: !observed ? 'none' : observed.blocked ? 'blocked' : observed.download ? 'download' : observed.committed ? 'committed' : observed.committed === false && !observed.pending ? 'failed' : 'started' };
    } finally { this.releaseInput(tab, slot); }
  },
};
