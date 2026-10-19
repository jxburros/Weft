/**
 * Page captures, resource archives and the offline archive preview (ADR 012).
 * Browser methods moved verbatim from src/browser.js (#119) and installed on Browser.prototype there, so
 * `this` is the Browser instance and every method keeps its name.
 */
import { ARCHIVE_CSP, ARCHIVE_FORMAT, ARCHIVE_FORMAT_VERSION, ARCHIVE_LIMITS, CID_HOST, FALLBACK_DOCUMENT_URL, archiveKey, buildArchive } from './archive.js';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sanitizeUrl } from './workspace.js';
import { scrubFile } from './components.js';
import { tmpdir } from 'node:os';
import { RESOURCE_SCAN_SCRIPT, bounded, chromeShortcut, delay, failure, isHuman } from './browser-support.js';

export const browserCaptureMethods = {
  /** While headless, attach a tab long enough to render one capture. */
  async renderForCapture(tab) {
    if (!this.hidden || this.isAttached(tab.view)) return () => {};
    if ((tab.renderMode ?? 'onscreen') !== 'offscreen') await this.convertRenderMode(tab, 'offscreen capture');
    this.renderingFor.add(tab);
    this.layout();
    await bounded(this.observe(tab.view.webContents, null, {}, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'), 3000).catch(() => {});
    return () => { this.renderingFor.delete(tab); this.layout(); };
  },
  async captureArtifact({ tabId, kind, workspaceId, readyTimeoutMs, maxDurationMs, maxResourceBytes }, context = { actor: 'human' }) {
    const tab = this.tab(tabId);
    if (tab.workspaceId !== (workspaceId ?? context.workspaceId ?? this.workspaceId)) throw new Error('Capture tab belongs to a different workspace');
    // A capturing tab is never suspended (#30); a suspended one reloads first so every capture kind (#16 archives too) reads a live page.
    if (tab.suspended || tab.resuming) await this.resumeTab(tab, 'capture');
    tab.capturing = (tab.capturing ?? 0) + 1;
    try { return await this.captureTab(tab, { kind, readyTimeoutMs, maxDurationMs, maxResourceBytes }, context); }
    finally { tab.capturing -= 1; }
  },
  async captureTab(tab, { kind, readyTimeoutMs, maxDurationMs, maxResourceBytes }, context) {
    if (kind === 'archive') return this.captureArchive(tab, { readyTimeoutMs, maxDurationMs, maxResourceBytes }, context);
    const version = tab.version;
    const readable = await this.execute('page.readable', { tabId: tab.id }, context);
    let screenshot;
    let captureError;
    if (kind !== 'text') {
      try { screenshot = await this.execute('page.screenshot', { tabId: tab.id }, context); }
      catch (error) { if (kind === 'screenshot') throw error; captureError = error.message; }
    }
    return { ...readable, pngBase64: screenshot?.data, navigationVersion: version,
      limitations: ['Reference capture is not an offline replay. Dynamic, authenticated, and cross-origin embedded content may be incomplete.',
        ...(captureError ? [`Screenshot unavailable: ${captureError}`] : []),
        ...(version !== tab.version ? ['The page changed during capture.'] : [])] };
  },
  /** Temporary folder for MHTML serialization; stale folders from interrupted captures are removed first. */
  captureTempDirectory() {
    const root = join(this.directory ?? tmpdir(), 'capture-temp');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(root)) {
      try { if (Date.now() - statSync(join(root, name)).mtimeMs > 3600_000) rmSync(join(root, name), { recursive: true, force: true }); } catch { /* in use or gone */ }
    }
    return mkdtempSync(join(root, 'mhtml-'));
  },
  /**
   * Resource archive capture with bounded readiness and duration. Records the original and final URL,
   * timing, viewport, navigation during capture, request failures, virtualization hints and every reason
   * the capture is incomplete. The serialized page comes from Chromium's MHTML generator, which reads
   * the renderer's loaded resources instead of fetching them again.
   */
  async captureArchive(tab, options, context) {
    // Automation may not archive a tab in (or entering) a protected operation: the serialized DOM, coverage scan and
    // screenshot bypass the per-command checks, so protection is checked before capture, before serialization and after.
    const agent = !isHuman(context.actor);
    if (agent) await this.assertObservable(tab, 'page.snapshot', context);
    // A caller deadline (ADR 018) stops the capture between steps; nothing is saved because the record transaction then rolls back.
    const signal = context.signal ?? null;
    const assertRunning = () => { if (signal?.aborted) throw failure('cancelled', 'Archive capture stopped: the request deadline passed; nothing was saved'); };
    const stopping = new Promise((_, reject) => { if (signal) signal.addEventListener('abort', () => reject(failure('cancelled', 'Archive capture stopped: the request deadline passed; nothing was saved')), { once: true }); });
    stopping.catch(() => {});
    const abortable = promise => signal ? Promise.race([promise, stopping]) : promise;
    const protectionAtStart = tab.protectionSerial ?? 0;
    const fillAtStart = tab.credentialFill ?? null;
    const assertUnprotected = () => {
      if (!agent) return;
      const reason = this.protectedReason(tab) ?? ((tab.protectionSerial ?? 0) !== protectionAtStart || (tab.credentialFill ?? null) !== fillAtStart ? 'a protected operation ran during capture' : null);
      if (reason) throw failure('permission_required', `Archive capture is unavailable to automation during a protected operation: ${reason}`, { credential: 'protected_operation' });
    };
    const contents = tab.view.webContents;
    const startedAt = new Date();
    const maxDuration = options.maxDurationMs ?? 30000;
    const deadline = startedAt.getTime() + maxDuration;
    const remaining = () => Math.max(250, deadline - Date.now());
    const originalUrl = sanitizeUrl(contents.getURL()) || null;
    const startVersion = tab.version;
    const stateChanges = [];
    const incomplete = [];
    const note = (kind, url) => { if (stateChanges.length < 100) stateChanges.push({ at: new Date().toISOString(), kind, url: sanitizeUrl(url || '') || null }); };
    const listeners = {
      'did-start-navigation': details => { if (details?.isMainFrame && !details.isSameDocument) note('navigation-started', details.url); },
      'did-navigate': (_event, url) => note('navigated', url),
      'did-navigate-in-page': (_event, url, isMainFrame) => { if (isMainFrame !== false) note('in-page-navigation', url); },
    };
    for (const [event, listener] of Object.entries(listeners)) contents.on(event, listener);
    const limitations = ['The resource archive is Chromium’s serialization of the rendered page. Scripts are removed and never replayed; script-initiated data, closed shadow roots, canvas and media streams are not archived.',
      'Values of password, payment-card, one-time-code, hidden and secret-named form fields are removed from archived HTML.',
      'SHA-256 digests show the stored bytes are unchanged since capture; they do not prove what a website served or when.'];
    let readable = null, screenshot = null, coverage = null, scan = null, archive = null;
    const readyStart = Date.now();
    let readiness;
    try {
      // Bounded readiness: wait for load completion, but never past readyTimeoutMs or the capture deadline.
      const readyLimit = Math.min(options.readyTimeoutMs ?? 5000, Math.max(0, deadline - Date.now()));
      for (;;) {
        let complete = false;
        try { complete = !contents.isLoading() && (await bounded(this.observe(contents, null, {}, 'document.readyState'), 1000)) === 'complete'; } catch { complete = false; }
        assertRunning();
        if (complete) { readiness = { state: 'ready', waitedMs: Date.now() - readyStart, timeoutMs: readyLimit }; break; }
        if (Date.now() - readyStart >= readyLimit) { readiness = { state: 'timeout', waitedMs: Date.now() - readyStart, timeoutMs: readyLimit }; incomplete.push('page-not-ready'); break; }
        await delay(100);
      }
      readable = await abortable(bounded(this.execute('page.readable', { tabId: tab.id }, context), remaining()));
      try {
        const raw = await bounded(this.observe(contents, 'snapshot', { maxNodes: 3000, includeBoxes: false }), remaining());
        coverage = { virtualized: raw.virtualized ?? [], lazyImages: raw.counts?.lazyImages ?? 0, busyRegions: raw.counts?.busy ?? 0, inaccessibleFrames: raw.counts?.inaccessibleFrames ?? 0,
          openShadowRoots: raw.counts?.openShadowRoots ?? 0, opaque: raw.counts?.opaque ?? 0, truncated: Boolean(raw.truncated) };
      } catch (error) { incomplete.push('coverage-unavailable'); coverage = { error: String(error.message).slice(0, 200) }; }
      scan = await bounded(this.observe(contents, null, {}, RESOURCE_SCAN_SCRIPT), remaining()).catch(() => null);
      try { screenshot = await bounded(this.execute('page.screenshot', { tabId: tab.id }, context), remaining()); }
      catch (error) { incomplete.push('screenshot-unavailable'); limitations.push(`Screenshot unavailable: ${String(error.message).slice(0, 200)}`); }
      assertUnprotected();
      assertRunning();
      const temp = this.captureTempDirectory();
      const file = join(temp, 'page.mhtml');
      const maxResourceBytes = options.maxResourceBytes ?? ARCHIVE_LIMITS.maxResourceBytes;
      try {
        await abortable(bounded(contents.savePage(file, 'MHTML'), remaining()));
        const size = statSync(file).size;
        // Base64 and quoted-printable inflate the file; refuse files far beyond what the archive could store.
        if (size > ARCHIVE_LIMITS.maxArchiveBytes * 2) throw Object.assign(new Error(`Serialized page is ${size} bytes, beyond the archive limit`), { code: 'archive_too_large' });
        const log = [...(tab.resourceLog?.values() ?? [])];
        // Requests seen by the session are references too: script-initiated loads are reported as not archived.
        const requestKinds = { xhr: 'fetch', webSocket: 'fetch', ping: 'beacon', cspReport: 'beacon', script: 'script', subFrame: 'frame', stylesheet: 'stylesheet', image: 'image', font: 'font', media: 'media', object: 'object' };
        const references = [...(scan?.references ?? []), ...log.map(item => ({ url: item.url, kind: requestKinds[item.resourceType] ?? 'resource' }))];
        archive = buildArchive({ mhtml: readFileSync(file), references, resourceLog: log, limits: { maxResourceBytes } });
        if (!archive.complete) incomplete.push('resources-not-stored');
      } catch (error) {
        if (signal?.aborted) throw error;
        incomplete.push(/timed out/i.test(error.message) ? 'archive-timeout' : 'archive-failed');
        archive = { format: ARCHIVE_FORMAT, formatVersion: ARCHIVE_FORMAT_VERSION, status: 'failed', reason: String(error.message).slice(0, 300), resources: [], counts: {}, complete: false };
      } finally {
        // An encrypted profile (ADR 014) overwrites Chromium's transient plaintext serialization before removing it.
        if (this.workspaceService?.storage?.encrypted) { try { scrubFile(file); } catch { /* removed below regardless */ } }
        rmSync(temp, { recursive: true, force: true });
      }
    } finally {
      for (const [event, listener] of Object.entries(listeners)) contents.removeListener(event, listener);
    }
    assertUnprotected();
    assertRunning();
    const finishedAt = new Date();
    if (finishedAt.getTime() > deadline) incomplete.push('capture-time-limit');
    if (tab.version !== startVersion || stateChanges.some(item => item.kind !== 'in-page-navigation')) incomplete.push('page-changed-during-capture');
    else if (stateChanges.length) incomplete.push('in-page-state-changed');
    if (coverage?.virtualized?.length) incomplete.push('virtualized-content');
    if (coverage?.lazyImages) incomplete.push('lazy-content-pending');
    if (coverage?.busyRegions) incomplete.push('busy-regions');
    if (coverage?.inaccessibleFrames) incomplete.push('inaccessible-frames');
    const failures = [...(tab.resourceLog?.values() ?? [])].filter(item => item.error || item.statusCode >= 400).slice(0, 200)
      .map(item => ({ url: sanitizeUrl(item.url) || null, resourceType: item.resourceType, ...(item.statusCode ? { httpStatus: item.statusCode } : {}), ...(item.error ? { error: String(item.error).slice(0, 200) } : {}) }));
    const viewport = screenshot?.capture ? { width: screenshot.capture.viewport.width, height: screenshot.capture.viewport.height, devicePixelRatio: screenshot.capture.devicePixelRatio,
      scrollX: screenshot.capture.scroll.x, scrollY: screenshot.capture.scroll.y, documentWidth: screenshot.capture.document.width, documentHeight: screenshot.capture.document.height } : scan?.viewport ?? null;
    const ratio = viewport?.devicePixelRatio || 1;
    // Cross-origin frames whose pixels may appear in the screenshot but whose content is not in the archive.
    const inaccessibleRegions = (scan?.frames ?? []).filter(frame => !frame.accessible).slice(0, 50).map(frame => ({ x: Math.max(0, Math.round(frame.box.x * ratio)), y: Math.max(0, Math.round(frame.box.y * ratio)),
      width: Math.round(frame.box.width * ratio), height: Math.round(frame.box.height * ratio), units: 'image-pixels', reason: 'cross-origin frame (content not archived)', origin: frame.origin ?? null })).filter(item => item.width > 0 && item.height > 0);
    const unique = [...new Set(incomplete)];
    const capture = { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt - startedAt, maxDurationMs: maxDuration, readiness,
      originalUrl, finalUrl: sanitizeUrl(contents.getURL()) || null, navigationVersion: { start: startVersion, end: tab.version }, viewport, stateChanges, resourceFailures: failures,
      coverage, complete: unique.length === 0, incomplete: unique };
    if (unique.length) limitations.push(`Incomplete capture: ${unique.join(', ')}.`);
    return { ...readable, pngBase64: screenshot?.data, navigationVersion: startVersion, archive, capture, inaccessibleRegions, limitations };
  },
  previewSession() {
    if (this.previewSessionInstance) return this.previewSessionInstance;
    // In-memory partition with no network: every http(s) request is answered from the open archive or refused.
    const session = this.electron.session.fromPartition('weft-archive-preview');
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on('will-download', (event, item) => { event.preventDefault?.(); item.cancel?.(); if (this.preview) this.preview.stats.downloadsBlocked++; });
    const handler = request => this.servePreview(request);
    for (const scheme of ['https', 'http']) {
      // A later Browser in the same process takes over the shared preview partition.
      if (session.protocol.isProtocolHandled?.(scheme)) session.protocol.unhandle(scheme);
      session.protocol.handle(scheme, handler);
    }
    session.webRequest?.onBeforeRequest((details, callback) => {
      const allowed = /^(?:https?:|data:)/i.test(details.url);
      if (!allowed) this.previewRefused(details.url);
      callback({ cancel: !allowed });
    });
    this.previewSessionInstance = session;
    return session;
  },
  previewRefused(url) {
    if (!this.preview) return;
    this.preview.stats.refused++;
    if (this.preview.stats.refusedUrls.length < 50) this.preview.stats.refusedUrls.push(sanitizeUrl(url) || String(url).split(/[?#]/)[0].slice(0, 200));
  },
  /** Archive-only responses. Nothing in the preview session reaches the network. */
  servePreview(request) {
    const state = this.preview;
    if (!state) return new Response('', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) { this.previewRefused(request.url); return new Response('', { status: 405 }); }
    let entry = null;
    try {
      const url = new URL(request.url);
      entry = url.hostname === CID_HOST ? state.byCid.get(decodeURIComponent(url.pathname.slice(1))) : state.byUrl.get(archiveKey(request.url));
    } catch { entry = null; }
    if (!entry) { this.previewRefused(request.url); return new Response('', { status: 404, headers: { 'content-type': 'text/plain' } }); }
    state.stats.served++;
    const headers = { 'content-type': entry.mimeType || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'content-security-policy': ARCHIVE_CSP };
    return new Response(request.method === 'HEAD' ? null : entry.bytes, { status: 200, headers });
  },
  /** Open an archived version with JavaScript disabled, all network refused and navigation, popups, downloads and form submission blocked. */
  async openArchivePreview({ artifactId, versionId, title, documentUrl, resources, workspaceId = null }) {
    if (!this.electron.WebContentsView) throw failure('unsupported', 'The offline preview needs the Weft browser window');
    if (this.preview) this.closeArchivePreview();
    const session = this.previewSession();
    const byUrl = new Map(), byCid = new Map();
    for (const resource of resources) { if (resource.contentId) byCid.set(resource.contentId, resource); if (!byUrl.has(resource.url)) byUrl.set(resource.url, resource); }
    const document = resources.find(item => item.role === 'document');
    if (!document) throw failure('invalid_arguments', 'The archive has no stored document');
    const view = new this.electron.WebContentsView({ webPreferences: { session, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      webgl: false, plugins: false, spellcheck: false, navigateOnDragDrop: false, disableDialogs: true, autoplayPolicy: 'document-user-activation-required', images: true } });
    const contents = view.webContents;
    const stats = { served: 0, refused: 0, refusedUrls: [], navigationsBlocked: 0, popupsBlocked: 0, downloadsBlocked: 0 };
    // The preview shows in the window whose rail holds the capture's workspace (#100).
    this.preview = { id: `preview_${randomUUID().slice(0, 12)}`, workspaceId, artifactId, versionId, title: String(title || '').slice(0, 240), view, byUrl, byCid, stats, openedAt: new Date().toISOString() };
    contents.on('will-navigate', event => { event.preventDefault(); stats.navigationsBlocked++; });
    contents.on('before-input-event', (event, input) => { const shortcut = chromeShortcut(input); if (shortcut) { event.preventDefault(); this.onChromeShortcut?.({ shortcut, preview: true }); } });
    contents.on('will-redirect', event => { event.preventDefault(); stats.navigationsBlocked++; });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(() => { stats.popupsBlocked++; return { action: 'deny' }; });
    let url = document.url;
    try { if (!/^https?:$/.test(new URL(url).protocol)) url = FALLBACK_DOCUMENT_URL; } catch { url = FALLBACK_DOCUMENT_URL; }
    if (url === FALLBACK_DOCUMENT_URL) byUrl.set(archiveKey(url), document);
    this.layout();
    let committed = false;
    contents.once('did-navigate', () => { committed = true; });
    try { await bounded(contents.loadURL(url), 15000); }
    catch (error) {
      // The archived document is shown, but an embedded resource (e.g. an <object>) never finished loading. The preview is
      // static and script-free, so keep it open, stop loading, and say it is incomplete instead of failing.
      if (committed && this.preview?.view === view && /timed out/.test(error.message)) {
        contents.stop();
        this.preview.loadIncomplete = 'An embedded resource did not finish loading within 15 seconds; loading was stopped.';
      } else if (!/ERR_ABORTED/.test(error.message)) { this.closeArchivePreview(); throw error; }
    }
    return this.describePreview();
  },
  describePreview() {
    const state = this.preview;
    if (!state) return { open: false };
    return { open: true, previewId: state.id, artifactId: state.artifactId, versionId: state.versionId, title: state.title, url: state.view.webContents.getURL(), openedAt: state.openedAt,
      resources: state.byUrl.size, javascript: 'disabled', network: 'refused (archive-only responses)', navigation: 'blocked', forms: 'blocked', popups: 'blocked', downloads: 'blocked', stats: structuredClone(state.stats),
      ...(state.loadIncomplete && { complete: false, incomplete: state.loadIncomplete }) };
  },
  closeArchivePreview() {
    const state = this.preview;
    if (!state) return { open: false, closed: false };
    const summary = this.describePreview();
    this.preview = null;
    this.detachView(state.view);
    const contents = state.view.webContents;
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    this.layout();
    return { ...summary, open: false, closed: true };
  },
};
