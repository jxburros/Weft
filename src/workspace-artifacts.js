/**
 * Artifact capture versions: recording, reading, verification, comparison, review, redacted derivatives and previews (ADR 012).
 * WorkspaceService methods moved verbatim from src/workspace.js (#119) and installed on WorkspaceService.prototype there, so
 * `this` is the service and every method keeps its name.
 */
import { DETECTION_SCOPE, redactText, reduceUrl, resolveSpans, reviewText, reviewUrl } from './redaction.js';
import { archiveManifest, diffResources, diffText } from './archive.js';
import { canonicalJson } from './store.js';
import { clipRects, decodePng, diffImages, encodePng, fillRects } from './png.js';
import { originFor } from './provenance.js';
import { PNG, RESTRICTED_NOTICE, artifactSummary, clone, createRecord, digest, fail, isAgent, now, sanitizeUrl, uuid, versionMetadata } from './workspace-support.js';

export const workspaceArtifactMethods = {
  async mutateArtifact(action, args, workspaceId, actor, context) {
    if (action === 'redact') {
      const record = this.record('artifacts', args.id, context);
      const source = this.artifactVersion(record, args.versionId);
      const derived = this.buildDerivative(record, source, args, actor, context);
      const version = { id: uuid('version'), number: record.versions.length + 1, createdAt: now(), actor, ...derived.version, previousVersionId: record.versions.at(-1)?.id || null };
      const titleRedacted = derived.recordTitle !== record.title;
      if (titleRedacted) record.title = derived.recordTitle;
      record.versions.push(version); this.touch(record);
      this.log('artifacts.redact', record.workspaceId, record.id, actor, `Version ${version.number} derived from version ${source.number}: ${derived.version.redactions.length} redactions`);
      return { ...artifactSummary(record, { agent: isAgent(context) }), derivative: { versionId: version.id, number: version.number, derivedFrom: source.id, redactions: derived.version.redactions.length, unmatchedSelectors: derived.unmatched,
        artifactTitleRedacted: titleRedacted, remainingMatches: derived.remainingMatches, originalAccess: source.access === 'restricted' ? 'restricted' : 'standard',
        next: source.access === 'restricted' ? null : 'The original remains readable by agents until a person restricts it (artifacts.setAccess).' } };
    }
    if (action === 'setAccess') {
      const record = this.record('artifacts', args.id, context);
      const version = this.artifactVersion(record, args.versionId);
      const previous = version.access === 'restricted' ? 'restricted' : 'standard';
      if (args.access === 'restricted') version.access = 'restricted'; else delete version.access;
      version.accessChangedAt = now(); version.accessChangedBy = actor;
      this.touch(record);
      this.log('artifacts.setAccess', record.workspaceId, record.id, actor, `Version ${version.number}: ${previous} → ${args.access}`);
      return { id: record.id, versionId: version.id, access: args.access, previous, derivatives: record.versions.filter(item => item.derivedFrom === version.id).map(item => item.id),
        effects: args.access === 'restricted' ? ['Agents and model readers receive a withheld stub instead of this version.', 'The version is removed from the local search index.', 'Exports leave it out unless a person chooses to include restricted originals.']
          : ['Agents can read this version again and it is searchable.'] };
    }
    if (action === 'purgeContent') {
      const record = this.record('artifacts', args.id, context);
      const version = this.artifactVersion(record, args.versionId);
      if (version.purged) throw fail('invalid_arguments', 'This version\u2019s content was already purged');
      const hashes = new Set((version.components || []).map(item => item.sha256));
      for (const resource of version.archive?.resources || []) if (resource.sha256 && resource.status === 'stored') hashes.add(resource.sha256);
      // Assigning undefined (not delete) detaches component-backed fields; a deleted lazy field would be re-attached on commit.
      for (const key of ['text', 'pngBase64']) if (Object.hasOwn(version, key)) version[key] = undefined;
      for (const resource of version.archive?.resources || []) if (resource.status === 'stored') { resource.bodyBase64 = undefined; resource.status = 'purged'; }
      version.purged = { at: now(), by: actor };
      this.touch(record);
      this.log('artifacts.purgeContent', record.workspaceId, record.id, actor, `Version ${version.number} content purged; metadata and hashes kept`);
      return { id: record.id, versionId: version.id, purged: true, componentHashes: [...hashes] };
    }
    const expect = record => { if (args.expectedRevision !== undefined && args.expectedRevision !== record.revision) throw Object.assign(new Error('STALE_STATE: artifact changed; reload before changing it'), { notStarted: true, details: { reason: 'revision_changed' } }); return record; };
    if (action === 'delete') {
      const record = expect(this.record('artifacts', args.id, context));
      this.data.artifacts = this.data.artifacts.filter(item => item.id !== record.id);
      this.forgetSharedItem('artifacts', record.id);
      this.log('artifacts.delete', record.workspaceId, record.id, actor);
      return { id: record.id, deleted: true };
    }
    if (action === 'annotate') {
      const record = expect(this.record('artifacts', args.id, context));
      record.note = args.note; if (args.tags) record.tags = args.tags;
      this.touch(record); record.annotations.push({ note: record.note, tags: record.tags, revision: record.revision, actor, createdAt: now() });
      this.log('artifacts.annotate', record.workspaceId, record.id, actor);
      return artifactSummary(record);
    }
    let source = args;
    if (action === 'capture') {
      if (!this.browser?.captureArtifact) throw new Error('Artifact capture requires a connected browser');
      if (this.browser.tab && this.browser.tab(args.tabId).workspaceId !== workspaceId) throw new Error('PERMISSION_REQUIRED: capture tab belongs to a different workspace');
      source = { ...await this.browser.captureArtifact(args, context), ...args };
    }
    if (source.text === undefined && !source.pngBase64) throw new Error('Artifact requires text or a PNG image');
    if (action === 'capture' && args.kind === 'archive' && !source.archive) throw new Error('Archive capture returned no archive');
    const components = [];
    if (source.text !== undefined) {
      if (typeof source.text !== 'string' || source.text.length > 2000000) throw new Error('Artifact text exceeds 2 million characters');
      components.push({ type: 'text/plain', size: Buffer.byteLength(source.text), sha256: digest(source.text) });
    }
    if (source.pngBase64) {
      const bytes = Buffer.from(source.pngBase64, 'base64');
      if (bytes.length > 20 * 1024 * 1024 || !bytes.subarray(0, 8).equals(PNG)) throw new Error('Artifact images must be PNG and at most 20 MiB');
      source.pngBase64 = bytes.toString('base64');
      components.push({ type: 'image/png', size: bytes.length, sha256: digest(bytes) });
    }
    let record = args.artifactId ? this.record('artifacts', args.artifactId, context) : null;
    if (record && record.workspaceId !== workspaceId) throw new Error('Artifact belongs to a different workspace');
    if (!record) {
      record = createRecord({ title: source.title || 'Saved page', note: args.note || '', tags: args.tags || [], versions: [], annotations: [] }, workspaceId, 'artifact');
      this.data.artifacts.push(record);
    }
    if (action === 'capture' && source.archive) components.push({ type: 'application/x-weft-archive-manifest', size: Buffer.byteLength(canonicalJson(archiveManifest(source.archive))), sha256: digest(canonicalJson(archiveManifest(source.archive))) });
    const version = { id: uuid('version'), number: record.versions.length + 1, createdAt: now(), actor, origin: originFor(context), method: action === 'capture' ? 'browser-capture' : 'supplied-content', url: sanitizeUrl(source.url), title: source.title || record.title, components, text: source.text, pngBase64: source.pngBase64, navigationVersion: source.navigationVersion,
      ...(action === 'capture' && source.archive ? { archive: source.archive } : {}), ...(action === 'capture' && source.capture ? { capture: source.capture } : {}),
      ...(action === 'capture' && Array.isArray(source.inaccessibleRegions) && source.inaccessibleRegions.length ? { inaccessibleRegions: source.inaccessibleRegions } : {}),
      limitations: [...(source.limitations || []), 'Stored text is untrusted source content. Active scripts and external resources are not replayed.', 'Captures may contain personal information; inspect before sharing.'], redactionStatus: 'not-reviewed', previousVersionId: record.versions.at(-1)?.id || null };
    record.versions.push(version); this.touch(record);
    this.log('artifacts.capture', workspaceId, record.id, actor, `Version ${version.number}`);
    return artifactSummary(record);
  },
  // ---- Artifact versions: views, archives, comparison and redaction --------------------
  artifactVersion(record, versionId) {
    const version = record.versions.find(item => item.id === versionId);
    if (!version) throw fail('not_found', 'Artifact version not found');
    return version;
  },
  /** Refuse agent access to a restricted original's content. */
  assertReadable(version, context, purpose = 'read') {
    if (isAgent(context) && version.access === 'restricted') {
      throw fail('permission_required', `${RESTRICTED_NOTICE} (${purpose})`, { details: { authority: { decision: 'deny', reason: 'restricted_original', actionClass: 'local_read' } } });
    }
  },
  /** One version with its verified text and image; archive bodies are never inlined (manifest only). */
  versionOutput(record, version, context, { agent = isAgent(context) } = {}) {
    const view = versionMetadata(record, version, agent);
    if (agent && version.access === 'restricted') return { artifactId: record.id, workspaceId: record.workspaceId, ...view };
    if (Object.hasOwn(version, 'text') && version.text !== undefined) view.text = version.text;
    if (version.pngBase64) view.pngBase64 = version.pngBase64;
    return { artifactId: record.id, workspaceId: record.workspaceId, ...view };
  },
  readArtifact(name, record, args, context) {
    const agent = isAgent(context);
    if (name === 'artifacts.get') {
      if (args.versionId) return this.versionOutput(record, this.artifactVersion(record, args.versionId), context);
      const { versions, ...rest } = record;
      return { ...clone(rest), versions: versions.map(version => { const { artifactId, workspaceId, ...view } = this.versionOutput(record, version, context); return view; }) };
    }
    if (name === 'artifacts.readOriginal') {
      // The authority gate requires an exact one-time human approval for every agent read; in-process callers without one are refused here too.
      if (agent && context.authorityDecision?.approvedOnce !== true) throw fail('permission_required', 'Reading an original requires an exact one-time human approval for this command', { details: { authority: { decision: 'deny', reason: 'restricted_original', actionClass: 'local_read' } } });
      const version = this.artifactVersion(record, args.versionId);
      return { ...this.versionOutput(record, version, context, { agent: false }), access: version.access === 'restricted' ? 'restricted' : 'standard' };
    }
    if (name === 'artifacts.verify') return this.verifyArtifact(record, args.versionId);
    if (name === 'artifacts.compare') return this.compareVersions(record, args, context);
    if (name === 'artifacts.review') return this.reviewVersion(record, this.artifactVersion(record, args.versionId), context);
    if (name === 'artifacts.redact') {
      const source = this.artifactVersion(record, args.versionId);
      const derived = this.buildDerivative(record, source, args, context.actor || 'human', context);
      return { preview: true, saved: false, derivedFrom: source.id, ...derived.version, unmatchedSelectors: derived.unmatched, artifactTitle: derived.recordTitle, remainingMatches: derived.remainingMatches };
    }
    throw new Error(`Unsupported artifact read: ${name}`);
  },
  /** Re-verify every stored component digest without changing anything. */
  verifyArtifact(record, versionId) {
    const versions = versionId ? [this.artifactVersion(record, versionId)] : record.versions;
    const check = (object, key, label) => {
      const marker = this.storage.componentMarker(object, key);
      if (!marker && typeof object[key] !== 'string') return null;
      if (!marker) return { component: label, status: 'pending', detail: 'Not yet committed' };
      try { this.storage.components.read(marker.sha256, marker.size); return { component: label, sha256: marker.sha256, size: marker.size, status: 'verified' }; }
      catch (error) { return { component: label, sha256: marker.sha256, size: marker.size, status: error.code === 'COMPONENT_MISSING' ? 'missing' : 'corrupt', detail: error.message }; }
    };
    const report = versions.map(version => {
      const items = [check(version, 'text', 'text/plain'), check(version, 'pngBase64', 'image/png'),
        ...(version.archive?.resources || []).filter(item => item.status === 'stored').map(item => check(item, 'bodyBase64', item.url))].filter(Boolean);
      return { versionId: version.id, number: version.number, ...(version.purged ? { purged: true } : {}), components: items, problems: items.filter(item => !['verified', 'pending'].includes(item.status)).length };
    });
    const problems = report.reduce((sum, item) => sum + item.problems, 0);
    return { id: record.id, status: problems ? 'damaged' : 'verified', problems, versions: report,
      scope: 'SHA-256 digests show that stored bytes are unchanged since they were saved. They do not prove that a website served this content, or when; Weft has no independent timestamp authority.' };
  },
  compareVersions(record, args, context) {
    const from = this.artifactVersion(record, args.fromVersionId), to = this.artifactVersion(record, args.toVersionId);
    for (const version of [from, to]) { this.assertReadable(version, context, 'compare'); if (version.purged) throw fail('invalid_arguments', `Version ${version.number} content was purged`); }
    const describe = version => ({ versionId: version.id, number: version.number, createdAt: version.createdAt, url: version.url || null, method: version.method, ...(version.derivedFrom ? { derivedFrom: version.derivedFrom } : {}),
      components: clone(version.components || []), archive: version.archive ? { complete: version.archive.complete ?? null, counts: clone(version.archive.counts || {}) } : null, captureComplete: version.capture?.complete ?? null });
    const hasText = version => Object.hasOwn(version, 'text') && typeof version.text === 'string';
    const text = hasText(from) && hasText(to) ? diffText(from.text, to.text) : { available: false, reason: 'One of the versions has no readable text component.' };
    const resources = from.archive?.resources && to.archive?.resources ? diffResources(from.archive.resources, to.archive.resources) : { available: false, reason: 'Resource comparison needs a resource archive in both versions.' };
    let pixels = { available: false, reason: 'Pixel comparison needs a screenshot in both versions.' };
    if (args.pixels === false) pixels = { available: false, reason: 'Not requested.' };
    else if (from.pngBase64 && to.pngBase64) {
      try { pixels = { available: true, ...diffImages(decodePng(Buffer.from(from.pngBase64, 'base64')), decodePng(Buffer.from(to.pngBase64, 'base64')), { diffImage: args.diffImage === true }) }; }
      catch (error) { pixels = { available: false, reason: String(error.message).slice(0, 200) }; }
    }
    const identical = text.identical !== false && (resources.totals ? Object.values(resources.totals).every(value => value === 0) : true) && (pixels.available ? pixels.changedPixels === 0 && pixels.comparable : true);
    return { id: record.id, from: describe(from), to: describe(to), identical, text, resources, pixels,
      limitations: ['Compares the stored captures only; differences can come from personalization, timing, lazy loading or capture limits rather than source changes.', 'Readable text excludes form fields, scripts and hidden content.'] };
  },
  /** Sensitive metadata review plus detection assistance. Findings carry masked previews, never the matched values. */
  reviewVersion(record, version, context) {
    this.assertReadable(version, context, 'review');
    const findings = [];
    if (version.url) findings.push(...reviewUrl(version.url, 'url'));
    findings.push(...reviewText(version.title, 'title'));
    for (const key of ['originalUrl', 'finalUrl']) if (version.capture?.[key]) findings.push(...reviewUrl(version.capture[key], `capture.${key}`));
    (version.capture?.stateChanges || []).forEach((change, index) => { if (change.url) findings.push(...reviewUrl(change.url, `capture.stateChanges.${index}.url`)); });
    const resourceFindings = [];
    (version.archive?.resources || []).forEach((resource, index) => resourceFindings.push(...reviewUrl(resource.url, `archive.resources.${index}.url`)));
    findings.push(...resourceFindings.slice(0, 200));
    findings.push(...reviewText(record.note, 'artifact.note'), ...(record.tags || []).flatMap((tag, index) => reviewText(tag, `artifact.tags.${index}`)),
      ...(record.annotations || []).flatMap((item, index) => reviewText(item.note, `artifact.annotations.${index}.note`)));
    const text = !version.purged && Object.hasOwn(version, 'text') && typeof version.text === 'string' ? reviewText(version.text, 'text') : [];
    return { id: record.id, versionId: version.id, number: version.number, findings, textFindings: text.slice(0, 500), totals: { metadata: findings.length, text: text.length, resourceUrls: resourceFindings.length },
      image: version.pngBase64 ? 'Screenshot text is not inspected (no OCR). Review the image yourself and draw redaction regions over anything sensitive.' : null,
      archive: version.archive ? 'Archived HTML, stylesheets and images are not redacted; sanitized derivatives leave the archive out.' : null,
      scope: DETECTION_SCOPE };
  },
  /** Build a sanitized derivative from a source version. Nothing is written here. */
  buildDerivative(record, source, args, actor, context) {
    this.assertReadable(source, context, 'redact');
    if (source.purged) throw fail('invalid_arguments', 'This version’s content was purged; nothing is left to redact');
    const hasText = Object.hasOwn(source, 'text') && typeof source.text === 'string';
    const selectors = args.text || [];
    if (!hasText && selectors.some(item => item.start !== undefined)) throw fail('invalid_arguments', 'Offset selectors need a version with readable text');
    const textResult = hasText ? redactText(source.text, selectors) : { text: undefined, redactions: [], unmatched: selectors.map((_, index) => index) };
    const metadataSelectors = selectors.filter(item => item.start === undefined);
    const title = args.title ?? redactText(source.title || record.title, metadataSelectors).text;
    let url = reduceUrl(source.url, args.url ?? 'origin-path');
    if (url && metadataSelectors.length && resolveSpans(url, metadataSelectors).spans.length) url = reduceUrl(url, 'origin');
    if (url && metadataSelectors.length && resolveSpans(url, metadataSelectors).spans.length) url = '';
    const regions = args.regions || [];
    let pngBase64;
    const regionRedactions = [];
    if (regions.length && (!source.pngBase64 || args.image === 'omit')) throw fail('invalid_arguments', 'Image regions need a version with a screenshot and image: "redact"');
    if (source.pngBase64 && args.image !== 'omit') {
      // Decoding and re-encoding replaces the pixels and drops every ancillary PNG chunk (text, EXIF, ICC).
      const image = decodePng(Buffer.from(source.pngBase64, 'base64'));
      const clipped = clipRects(regions, image.width, image.height);
      const outside = clipped.map((rect, index) => rect ? null : index).filter(index => index !== null);
      if (outside.length) throw fail('invalid_arguments', `Image regions ${outside.join(', ')} are outside the ${image.width}x${image.height} screenshot`);
      clipped.forEach((rect, index) => regionRedactions.push({ type: 'region', index, ...rect, label: String(regions[index].label || 'region').slice(0, 60), pixels: fillRects(image, [rect]) }));
      pngBase64 = encodePng(image).toString('base64');
    }
    if (textResult.text === undefined && !pngBase64) throw fail('invalid_arguments', 'The derivative would have no content: keep the screenshot or use a version with text');
    const components = [];
    if (textResult.text !== undefined) components.push({ type: 'text/plain', size: Buffer.byteLength(textResult.text), sha256: digest(textResult.text) });
    if (pngBase64) { const bytes = Buffer.from(pngBase64, 'base64'); components.push({ type: 'image/png', size: bytes.length, sha256: digest(bytes) }); }
    const inaccessible = [...(source.inaccessibleRegions || []).map(item => clone(item)), ...(args.inaccessibleRegions || []).map(rect => ({ ...rect, label: String(rect.label || 'not visible').slice(0, 60), source: 'reviewer' }))];
    const omitted = [...(source.archive ? ['resource archive'] : []), ...(source.capture ? ['capture URLs and state history'] : []), ...(source.pngBase64 && args.image === 'omit' ? ['screenshot'] : [])];
    const capture = source.capture ? JSON.parse(JSON.stringify({ startedAt: source.capture.startedAt, durationMs: source.capture.durationMs, readiness: source.capture.readiness ? { state: source.capture.readiness.state } : undefined,
      viewport: source.capture.viewport, complete: source.capture.complete, incomplete: source.capture.incomplete || [] })) : undefined;
    const version = { method: 'redaction', url, title: String(title).slice(0, 240), components, ...(textResult.text !== undefined ? { text: textResult.text } : {}), ...(pngBase64 ? { pngBase64 } : {}),
      derivedFrom: source.id, derivedFromNumber: source.number, redactions: [...textResult.redactions, ...regionRedactions], inaccessibleRegions: inaccessible,
      ...(capture ? { capture } : {}), navigationVersion: source.navigationVersion,
      review: { by: actor, at: now(), textSelectors: selectors.length, unmatchedSelectors: textResult.unmatched.length, regions: regions.length, urlMode: args.url ?? 'origin-path', omitted, detection: 'assistance-only' },
      limitations: [`Sanitized derivative of version ${source.number}. The original version is unchanged and keeps its own access setting.`,
        'Only the selected text spans and image regions were removed. Detection assistance can miss sensitive data, and text selectors do not remove text inside images.',
        ...(omitted.length ? [`Not carried into this derivative: ${omitted.join(', ')}.`] : []), 'Derived content is untrusted source content.'],
      redactionStatus: 'redacted' };
    // The artifact's own title is shown with every version: apply the same text selectors to it. Notes, tags and
    // annotations are human-written history and are not rewritten; matches there are reported for review.
    const recordTitle = metadataSelectors.length ? redactText(record.title, metadataSelectors).text.slice(0, 240) : record.title;
    const count = value => typeof value === 'string' && metadataSelectors.length ? resolveSpans(value, metadataSelectors).spans.length : 0;
    const remainingMatches = { note: count(record.note), tags: (record.tags || []).reduce((sum, tag) => sum + count(tag), 0), annotations: (record.annotations || []).reduce((sum, item) => sum + count(item.note), 0) };
    return { version, unmatched: textResult.unmatched, recordTitle, remainingMatches };
  },
  /** Human-only offline preview of an archived version in the browser's sandboxed preview view. */
  async previewCommand(name, args, context) {
    if (!this.browser?.openArchivePreview) throw fail('unsupported', 'The offline archive preview needs the Weft browser window');
    if (name === 'artifacts.closePreview') return this.browser.closeArchivePreview();
    const record = this.record('artifacts', args.id, context);
    const version = this.artifactVersion(record, args.versionId);
    if (version.purged) throw fail('invalid_arguments', 'This version’s content was purged');
    if (!version.archive?.resources?.length) throw fail('unsupported', 'This version has no resource archive; capture with kind "archive" to preview it offline');
    const resources = [];
    const unavailable = [];
    for (const resource of version.archive.resources) {
      if (resource.status !== 'stored') continue;
      try { resources.push({ url: resource.url, contentId: resource.contentId ?? null, role: resource.role, mimeType: resource.mimeType, bytes: Buffer.from(resource.bodyBase64, 'base64') }); }
      catch (error) {
        if (resource.role === 'document') throw fail('component_integrity', `The archived document failed verification: ${error.message}`);
        unavailable.push({ url: resource.url, status: error.code === 'COMPONENT_MISSING' ? 'missing' : 'corrupt' });
      }
    }
    const opened = await this.browser.openArchivePreview({ artifactId: record.id, workspaceId: record.workspaceId, versionId: version.id, title: version.title || record.title, documentUrl: version.archive.documentUrl, resources });
    return { ...opened, artifactId: record.id, versionId: version.id, number: version.number, unavailable,
      notStored: version.archive.resources.filter(item => item.status !== 'stored').length };
  },
};
