/**
 * Captures, artifact viewer, archive preview, comparison, redaction, export/import and backups.
 * Moved from src/gui.js (#119); `g` holds live bindings to gui.js state and helpers.
 */
let g;
/** Connect these views to the GUI's shared context (called once by gui.js). */
export function bindCapturesViews(context) {
  g = context;
}

export async function capture(artifactId) {
  await g.refresh(true);
  if (!g.active() || g.active().url === "about:blank")
    throw new Error("Open a web page before saving a capture.");
  g.formDialog(
    artifactId ? "Save a new capture version" : "Save page to workspace",
    g.field("Title", "title", g.displayTitle(g.active()), "text", true) +
      g.area("Why is this useful?", "note", "") +
      g.choice(
        "Capture",
        "kind",
        [
          ["bundle", "Reference bundle · text + screenshot"],
          ["archive", "Resource archive · page, resources, text + screenshot"],
          ["text", "Readable text"],
          ["screenshot", "Screenshot"],
        ],
        "bundle",
      ) +
      "<p>Saved captures are historical references. Review the page for private information before saving it. A resource archive stores the page as Chromium rendered it, without scripts, and lists anything it could not keep.</p>",
    async (values) => {
      g.closeDialog();
      g.section = "browse";
      g.renderShell();
      g.renderContent();
      await g.layout();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      await g.execute("artifacts.capture", {
        ...values,
        workspaceId: g.ws().id,
        tabId: g.active().id,
        ...(artifactId ? { artifactId } : {}),
      });
      g.section = "artifacts";
      g.toast("Saved to your workspace.");
    },
    { save: "Save capture" },
  );
}
const incompleteLabels = { "page-not-ready": "page had not finished loading", "resources-not-stored": "some resources were not stored", "archive-failed": "archive could not be created", "archive-timeout": "archive timed out",
  "capture-time-limit": "capture time limit reached", "page-changed-during-capture": "page changed during capture", "in-page-state-changed": "page state changed during capture", "virtualized-content": "list content is virtualized",
  "lazy-content-pending": "lazy content had not loaded", "busy-regions": "regions were still loading", "inaccessible-frames": "cross-origin frames not included", "screenshot-unavailable": "no screenshot", "coverage-unavailable": "coverage unknown" };
function versionLabel(v) {
  return `Version ${v.number || ""}${v.derivedFrom ? " · sanitized" : ""}${v.access === "restricted" ? " · restricted original" : ""}${v.purged ? " · content purged" : ""} · ${g.date(v.createdAt)}`;
}
function archiveSummary(version) {
  const archive = version.archive;
  const capture = version.capture;
  if (!archive && !capture) return "";
  const parts = Object.entries(archive?.counts || {}).map(([status, count]) => `${count} ${status.replaceAll("-", " ")}`);
  const unstored = (archive?.resources || []).filter((r) => r.status !== "stored");
  return `<div class="notice"><strong>${capture?.complete ? "Complete capture" : "Incomplete capture"}</strong>${capture?.incomplete?.length ? ": " + g.esc(capture.incomplete.map((i) => incompleteLabels[i] || i).join(", ")) : ""}<br>`
    + `${archive ? `Resource archive: ${g.esc(parts.join(" · ") || archive.status || "no resources")}${archive.reason ? " — " + g.esc(archive.reason) : ""}<br>` : ""}`
    + `${capture ? `Captured in ${g.esc(String(capture.durationMs ?? "?"))} ms${capture.readiness ? ` · readiness ${g.esc(capture.readiness.state)}` : ""}${capture.viewport ? ` · viewport ${g.esc(String(capture.viewport.width))}×${g.esc(String(capture.viewport.height))}` : ""}${capture.originalUrl && capture.finalUrl && capture.originalUrl !== capture.finalUrl ? `<br>Started at ${g.esc(capture.originalUrl)}, ended at ${g.esc(capture.finalUrl)}` : ""}` : ""}`
    + `${unstored.length ? `<details><summary>Resources not stored (${g.esc(String(unstored.length))})</summary><ul>${unstored.slice(0, 30).map((r) => `<li>${g.esc(r.status)}${r.httpStatus ? " " + g.esc(String(r.httpStatus)) : ""} · ${g.esc(r.url)}</li>`).join("")}</ul></details>` : ""}`
    + `<small>Hashes show stored bytes are unchanged since capture; they do not prove what the site served or when.</small></div>`;
}
export async function viewArtifact(id, versionId) {
  const r = await g.execute("artifacts.get", { id }, true);
  const versions = r.versions || [];
  const version = versions.find((v) => v.id === versionId) || versions.at(-1) || {};
  const text = version.text ?? "";
  const png = version.pngBase64;
  const derived = version.derivedFrom ? versions.find((v) => v.id === version.derivedFrom) : null;
  const derivatives = versions.filter((v) => v.derivedFrom === version.id);
  const vattr = `data-id="${g.esc(id)}" data-version="${g.esc(version.id || "")}"`;
  const redactions = version.redactions || [];
  g.openDialog(
    r.title || "Saved capture",
    `<span class="tag sage">Saved capture · Offline</span>${version.access === "restricted" ? '<span class="tag">Restricted original · withheld from agents, search and default exports</span>' : ""}${version.derivedFrom ? `<span class="tag">Sanitized derivative of version ${g.esc(String(derived?.number || version.derivedFromNumber || "?"))}</span>` : ""}`
      + `<div class="notice">${g.esc(version.url || version.sourceUrl || "Local capture")}<br>${g.esc(new Date(version.createdAt || r.createdAt).toLocaleString())}<br>${g.esc((version.limitations || []).join(" "))}</div>${archiveSummary(version)}`
      + `${redactions.length ? `<p>${g.esc(String(redactions.filter((x) => x.type === "text").length))} text spans and ${g.esc(String(redactions.filter((x) => x.type === "region").length))} image regions were removed in this version.</p>` : ""}`
      + `${derivatives.length ? `<p>Sanitized versions: ${derivatives.map((d) => g.esc("version " + d.number)).join(", ")}.</p>` : ""}`
      + `${versions.length > 1 ? `<label>Version<select id="capture-version">${versions.map((v) => `<option value="${g.esc(v.id)}" ${v.id === version.id ? "selected" : ""}>${g.esc(versionLabel(v))}</option>`).join("")}</select></label>` : ""}`
      + `${version.purged ? "<p>The stored content of this version was purged. Its metadata and hashes remain.</p>" : ""}${png ? `<img class="artifact-image" src="data:image/png;base64,${g.esc(png)}" alt="Saved page screenshot">` : ""}<pre class="artifact-text">${g.esc(text)}</pre>`,
    (version.archive?.resources?.length && !version.purged ? g.action("preview-archive", "Preview offline", "globe", vattr) : "")
      + (versions.length > 1 ? g.action("compare-versions", "Compare versions", "", vattr) : "")
      + (!version.purged ? g.action("redact-version", "Review & redact", "shield", vattr) : "")
      + (version.access === "restricted" ? g.action("allow-version", "Allow agent access", "", vattr) : g.action("restrict-version", "Restrict original", "lock", vattr))
      + g.action("verify-artifact", "Verify", "", vattr)
      + g.action("open-in-pane", "Open in new pane", "split", `data-kind="artifact" data-id="${g.esc(id)}" data-version="${g.esc(version.id || "")}"`)
      + g.action("move-record", "Move to workspace…", "", `data-kind="artifacts" data-id="${g.esc(id)}"`)
      + (!version.purged ? g.action("purge-version", "Purge content", "trash", vattr, "secondary danger") : "")
      + g.action("delete-record", "Delete all versions", "trash", `data-kind="artifacts" data-id="${g.esc(id)}"`, "secondary danger")
      + g.knowledge.shareButton("artifacts", id)
      + g.action("close-dialog", "Close"),
    true,
  );
  if (g.$("capture-version"))
    g.$("capture-version").onchange = () =>
      void viewArtifact(id, g.$("capture-version").value).catch((e) => g.toast(g.errorMessage(e)));
}
export async function openPreview(id, versionId) {
  const result = await g.execute("artifacts.preview", { id, versionId }, true);
  g.previewing = result;
  // With several panes, the offline preview takes a pane instead of the whole browse area (#101).
  if (g.panes.multi()) { g.panes.open({ type: "preview" }, g.visibleTabs(), g.active()); g.savePanes(); }
  g.closeDialog();
  g.navigateSection("browse");
  g.toast(result.unavailable?.length ? `${result.unavailable.length} archived resources failed verification and are not shown.` : "Showing the archived page offline.");
}
export async function closePreview(quiet = false) {
  if (!g.previewing) return;
  g.previewing = null;
  if (g.panes.items.some((item) => item?.type === "preview")) { g.panes.remove("preview"); g.savePanes(); }
  try { await g.weftExecute("artifacts.closePreview", {}); } catch { /* already closed */ }
  if (!quiet) { g.renderContent(); g.layout(); }
}
export async function compareDialog(id, versionId) {
  const r = await g.execute("artifacts.get", { id }, true);
  const versions = (r.versions || []).filter((v) => !v.purged);
  const current = Math.max(0, versions.findIndex((v) => v.id === versionId));
  const from = versions[Math.max(0, current - 1)]?.id, to = versions[Math.max(current, Math.min(1, versions.length - 1))]?.id;
  const select = (name, value) => `<label>${name === "from" ? "Earlier version" : "Later version"}<select name="${name}">${versions.map((v) => `<option value="${g.esc(v.id)}" ${v.id === value ? "selected" : ""}>${g.esc(versionLabel(v))}</option>`).join("")}</select></label>`;
  g.openDialog("Compare capture versions", `<form id="compare-form">${select("from", from)}${select("to", to)}<label><input type="checkbox" name="pixels" checked> Compare screenshots pixel by pixel</label><button class="primary" type="submit">Compare</button></form><div id="compare-result" aria-live="polite"></div>`, g.action("close-dialog", "Close"), true);
  g.$("compare-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const pixels = form.get("pixels") === "on";
      const c = await g.execute("artifacts.compare", { id, fromVersionId: form.get("from"), toVersionId: form.get("to"), pixels, diffImage: pixels }, true);
      const lines = (c.text.hunks || []).map((h) => h.lines.map((l) => `<span class="diff-${l.op}">${l.op === "added" ? "+ " : l.op === "removed" ? "− " : "  "}${g.esc(l.text)}</span>`).join("\n")).join('\n<span class="diff-gap">…</span>\n');
      const t = c.resources.totals;
      const res = t ? `${t.added} added · ${t.removed} removed · ${t.changed} changed · ${t.statusChanged} changed status · ${c.resources.unchanged} unchanged` : g.esc(c.resources.reason);
      const px = c.pixels.available ? `${c.pixels.changedPixels} of ${c.pixels.comparedPixels} pixels changed (${(c.pixels.changedRatio * 100).toFixed(2)}%)${c.pixels.note ? " · " + g.esc(c.pixels.note) : ""}` : g.esc(c.pixels.reason);
      const changes = t ? [...c.resources.added.map((x) => ["Added", x.url]), ...c.resources.removed.map((x) => ["Removed", x.url]), ...c.resources.changed.map((x) => ["Changed", x.url]), ...c.resources.statusChanged.map((x) => [`${x.from} → ${x.to}`, x.url])].slice(0, 50) : [];
      g.$("compare-result").innerHTML = `<div class="notice"><strong>${c.identical ? "No differences found" : "Differences found"}</strong><br>Text: ${c.text.available === false ? g.esc(c.text.reason) : `${c.text.added} lines added, ${c.text.removed} removed${c.text.approximate ? " (approximate)" : ""}`}<br>Resources: ${res}<br>Screenshot: ${px}<br><small>${g.esc(c.limitations.join(" "))}</small></div>`
        + `${lines ? `<pre class="artifact-text diff">${lines}</pre>` : ""}${changes.length ? `<ul>${changes.map(([k, u]) => `<li>${g.esc(k)} · ${g.esc(u)}</li>`).join("")}</ul>` : ""}${c.pixels.diffPngBase64 ? `<img class="artifact-image" src="data:image/png;base64,${g.esc(c.pixels.diffPngBase64)}" alt="Changed pixels highlighted in red">` : ""}`;
    } catch (error) { g.$("form-error").textContent = g.errorMessage(error); }
  };
}
export async function redactionEditor(id, versionId) {
  const [version, review] = await Promise.all([g.execute("artifacts.get", { id, versionId }, true), g.execute("artifacts.review", { id, versionId }, true)]);
  const regions = [];
  const findings = review.textFindings || [];
  const metadata = review.findings || [];
  g.openDialog("Review and redact",
    `<div class="notice">A sanitized copy is saved as a new version; this version is not changed. ${g.esc(review.scope)}</div><form id="redact-form">`
      + `${findings.length ? `<fieldset><legend>Detected in the text (assistance only)</legend>${findings.map((f, i) => `<label><input type="checkbox" name="finding" value="${i}" checked> ${g.esc(f.kind)} · ${g.esc(f.preview)}</label>`).join("")}</fieldset>` : "<p>Detection assistance found nothing. Review the text yourself; detection is incomplete.</p>"}`
      + `${g.area("Exact text to remove (one entry per line; every occurrence, also in the title)", "literals")}${g.field("Pattern to remove (optional regular expression)", "pattern")}`
      + `${metadata.length ? `<fieldset><legend>Address and metadata review</legend><ul>${metadata.slice(0, 30).map((f) => `<li>${g.esc(f.field)}: ${g.esc(f.detail)}${f.parameter ? " (" + g.esc(f.parameter) + ")" : ""}</li>`).join("")}</ul></fieldset>` : ""}`
      + `${g.choice("Keep of the web address", "url", [["origin-path", "Site and path, no query (recommended)"], ["origin", "Site only"], ["remove", "Nothing"], ["keep", "Full address"]], "origin-path")}`
      + `${version.pngBase64 ? `${g.choice("Screenshot", "image", [["redact", "Keep, with the areas drawn below blacked out"], ["omit", "Leave the screenshot out"]], "redact")}<p>Drag on the screenshot to mark areas to black out. ${g.esc(review.image || "")}</p><div class="redact-canvas" id="redact-canvas"><img id="redact-image" src="data:image/png;base64,${g.esc(version.pngBase64)}" alt="Screenshot to redact" draggable="false"></div><div id="redact-regions" class="muted" aria-live="polite">No areas marked.</div><fieldset class="region-entry"><legend>Or add an area by its position in screenshot pixels</legend><div class="region-fields">${[["Left", "rx"], ["Top", "ry"], ["Width", "rw"], ["Height", "rh"]].map(([label, name]) => `<label>${label}<input name="${name}" type="number" min="0" step="1" inputmode="numeric"></label>`).join("")}</div><button type="button" class="secondary" id="redact-add-region">Add area</button></fieldset>` : ""}`
      + `${review.archive ? `<p>${g.esc(review.archive)}</p>` : ""}<label><input type="checkbox" name="restrict" ${version.access === "restricted" ? "checked disabled" : "checked"}> Restrict the original: withhold it from agents, search and default exports</label></form><div id="redact-preview" aria-live="polite"></div>`,
    `<button class="secondary" type="button" id="redact-show">Preview</button>` + g.action("close-dialog", "Cancel") + `<button class="primary" type="button" id="redact-save">Save sanitized version</button>`, true);
  const image = g.$("redact-image");
  const listRegions = () => { g.$("redact-regions").innerHTML = regions.length ? regions.map((r, i) => `${g.esc(String(i + 1))}: ${r.width}×${r.height} px at ${r.x}, ${r.y} <button type="button" class="text-button" data-remove-region="${i}">Remove</button>`).join("<br>") : "No areas marked."; };
  if (image) {
    const canvas = g.$("redact-canvas");
    let start = null, box = null;
    const point = (event) => { const rect = image.getBoundingClientRect(); const scale = image.naturalWidth / rect.width; return { x: Math.max(0, Math.min(image.naturalWidth, Math.round((event.clientX - rect.left) * scale))), y: Math.max(0, Math.min(image.naturalHeight, Math.round((event.clientY - rect.top) * scale))), scale }; };
    canvas.onpointerdown = (event) => { event.preventDefault(); start = point(event); box = document.createElement("div"); box.className = "redact-box"; canvas.append(box); canvas.setPointerCapture(event.pointerId); };
    canvas.onpointermove = (event) => { if (!start) return; const p = point(event); Object.assign(box.style, { left: `${Math.min(start.x, p.x) / p.scale + image.offsetLeft}px`, top: `${Math.min(start.y, p.y) / p.scale + image.offsetTop}px`, width: `${Math.abs(p.x - start.x) / p.scale}px`, height: `${Math.abs(p.y - start.y) / p.scale}px` }); };
    canvas.onpointerup = (event) => { if (!start) return; const p = point(event); const r = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) }; start = null; if (r.width >= 2 && r.height >= 2) regions.push(r); else box.remove(); listRegions(); };
    g.$("redact-regions").onclick = (event) => { const index = event.target.dataset?.removeRegion; if (index === undefined) return; regions.splice(Number(index), 1); canvas.querySelectorAll(".redact-box")[Number(index)]?.remove(); listRegions(); g.$("redact-add-region")?.focus(); };
    // Keyboard alternative to dragging (#31): the same region, entered as numbers.
    g.$("redact-add-region").onclick = () => {
      const form = g.$("redact-form");
      const value = (name) => Math.round(Number(form.querySelector(`[name="${name}"]`).value));
      const r = { x: value("rx"), y: value("ry"), width: value("rw"), height: value("rh") };
      if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 2 || r.height < 2 || r.x < 0 || r.y < 0) { g.$("form-error").textContent = "Enter a left and top position and a width and height of at least 2 pixels."; return; }
      r.width = Math.min(r.width, image.naturalWidth - Math.min(r.x, image.naturalWidth));
      r.height = Math.min(r.height, image.naturalHeight - Math.min(r.y, image.naturalHeight));
      if (r.width < 2 || r.height < 2) { g.$("form-error").textContent = `The area must lie inside the ${image.naturalWidth} × ${image.naturalHeight} pixel screenshot.`; return; }
      g.$("form-error").textContent = "";
      const scale = image.naturalWidth / image.getBoundingClientRect().width;
      const drawn = document.createElement("div");
      drawn.className = "redact-box";
      Object.assign(drawn.style, { left: `${r.x / scale + image.offsetLeft}px`, top: `${r.y / scale + image.offsetTop}px`, width: `${r.width / scale}px`, height: `${r.height / scale}px` });
      canvas.append(drawn);
      regions.push(r);
      listRegions();
    };
  }
  const collect = () => {
    const form = new FormData(g.$("redact-form"));
    const text = [...form.getAll("finding").map((i) => ({ start: findings[Number(i)].start, end: findings[Number(i)].end, label: findings[Number(i)].kind })),
      ...String(form.get("literals") || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((literal) => ({ literal, label: "selected text" })),
      ...(String(form.get("pattern") || "").trim() ? [{ pattern: String(form.get("pattern")).trim(), label: "pattern" }] : [])];
    const image = version.pngBase64 ? form.get("image") || "redact" : undefined;
    return { args: { id, versionId, text, regions: image === "redact" ? regions.map((r) => ({ ...r, label: "marked area" })) : [], url: form.get("url"), ...(image ? { image } : {}) }, restrict: form.get("restrict") === "on" };
  };
  g.$("redact-show").onclick = async () => {
    try {
      const preview = await g.execute("artifacts.redact", { ...collect().args, preview: true }, true);
      g.$("redact-preview").innerHTML = `<h3>Preview of the sanitized version</h3><div class="notice">${g.esc(String(preview.redactions.length))} removals · address kept: ${g.esc(preview.url || "none")} · title: ${g.esc(preview.title)}${preview.unmatchedSelectors?.length ? ` · ${g.esc(String(preview.unmatchedSelectors.length))} entries matched nothing` : ""}${Object.values(preview.remainingMatches || {}).some(Boolean) ? "<br>Matches remain in this capture’s notes, tags or annotations; edit them separately." : ""}</div>`
        + `${preview.pngBase64 ? `<img class="artifact-image" src="data:image/png;base64,${g.esc(preview.pngBase64)}" alt="Sanitized screenshot preview">` : ""}${preview.text !== undefined ? `<pre class="artifact-text">${g.esc(preview.text)}</pre>` : ""}`;
    } catch (error) { g.$("form-error").textContent = g.errorMessage(error); }
  };
  g.$("redact-save").onclick = async () => {
    try {
      const { args, restrict } = collect();
      const result = await g.execute("artifacts.redact", args, true);
      if (restrict && version.access !== "restricted") await g.execute("artifacts.setAccess", { id, versionId, access: "restricted" }, true);
      g.toast(`Sanitized version ${result.derivative.number} saved${restrict ? "; the original is restricted" : ""}.`);
      await g.refresh(true);
      await viewArtifact(id, result.derivative.versionId);
    } catch (error) { g.$("form-error").textContent = g.errorMessage(error); }
  };
}
function downloadJson(name, value) {
  const a = document.createElement("a");
  a.href =
    "data:application/json;charset=utf-8," +
    encodeURIComponent(JSON.stringify(value, null, 2));
  a.download = name;
  a.click();
}
function downloadText(name, text, type) {
  const a = document.createElement("a");
  a.href = `data:${type};charset=utf-8,` + encodeURIComponent(text);
  a.download = name;
  a.click();
}
export function exportWorkspace() {
  g.openDialog("Review workspace export",
    `<p>Exports may contain private notes, messages, captures, and files. Model credentials and browser sessions are excluded.</p><form id="export-form">${g.plaintextExportNotice()}${g.choice("Format", "format", [["json", "Weft JSON (can be imported again)"], ["markdown", "Markdown (readable; produced by the markdown plugin)"]], "json")}${g.choice("Captures", "captures", [["exclude-restricted", "Leave out restricted originals (recommended)"], ["derivatives-only", "Only sanitized versions"], ["all", "Include restricted originals"]], "exclude-restricted")}<label><input type="checkbox" name="reviewMetadata"> Review web addresses and detected personal data in the export (assistance only)</label>${g.area("Optional sensitive terms to check (one per line)", "sensitiveTerms")}<p>Terms are checked locally. Images and unsupported binary files cannot be verified by a text scan.</p><button class="primary" type="submit">Prepare export</button></form><div id="export-review" aria-live="polite"></div>`,
    g.action("close-dialog", "Cancel"));
  g.$("export-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      const form = new FormData(event.currentTarget);
      const sensitiveTerms = form.get("sensitiveTerms").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      const format = form.get("format") || "json";
      const captures = form.get("captures") || "exclude-restricted";
      const reviewMetadata = form.get("reviewMetadata") === "on";
      const bundle = await g.execute(format === "json" ? "workspaces.export" : "workspaces.exportAs", { id: g.ws().id, captures, ...(format === "json" ? { reviewMetadata } : { format }), ...(sensitiveTerms.length ? { sensitiveTerms } : {}), ...(form.get("acknowledgePlaintext") ? { acknowledgePlaintext: true } : {}) }, true);
      const scan = bundle.residueScan;
      const excludedContent = bundle.excludedContent || [];
      const review = bundle.metadataReview;
      g.$("export-review").innerHTML = `${excludedContent.length ? `<div class="notice">${g.esc(String(excludedContent.length))} capture versions or captures are left out: ${g.esc([...new Set(excludedContent.map((x) => x.reason))].join(", "))}.</div>` : ""}${bundle.linkedSourcesNotIncluded?.count ? `<p>${g.esc(String(bundle.linkedSourcesNotIncluded.count))} records cite live pages, files or services that are not included in the export.</p>` : ""}${review ? `<details><summary>Metadata review: ${g.esc(String(review.findings.length))} findings (assistance only)</summary><ul>${review.findings.slice(0, 50).map((f) => `<li>${g.esc(f.field)}: ${g.esc(f.kind)}${f.preview ? " " + g.esc(f.preview) : ""}${f.parameter ? " (" + g.esc(f.parameter) + ")" : ""}</li>`).join("")}</ul><small>${g.esc(review.scope)}</small></details>` : ""}<div class="notice">${scan ? `Sensitive-term scan: <strong>${g.esc(scan.status)}</strong>. ${scan.found?.length || 0} term matches; ${scan.unverifiable?.length || 0} items could not be verified. ${g.esc(scan.scope || "")}` : "No sensitive-term scan requested."} Review this result before saving; a clean text scan does not establish that the export is free of private information.</div>${bundle.exclusions ? `<p>This ${g.esc(bundle.format)} export omits:</p><ul>${bundle.exclusions.map(item => `<li>${g.esc(item)}</li>`).join("")}</ul>` : ""}<button id="save-export" class="primary">Save reviewed export</button>`;
      g.$("save-export").onclick = () => {
        const base = g.ws().name.replace(/[^a-z\d -]/gi, "") || "workspace";
        if (bundle.format === "weft-workspace") downloadJson(`${base}.weft.json`, bundle);
        else downloadText(`${base}.${bundle.extension}`, bundle.content, bundle.mimeType);
        g.closeDialog();
        g.toast("Workspace export prepared.");
      };
    } catch (error) {
      g.$("form-error").textContent = g.errorMessage(error);
    } finally { button.disabled = false; }
  };
}
function disclosureBody(d, exclude) {
  const items = (d.items || []).map((item) => {
    const key = item.key || "";
    const excludable = key && item.kind !== "message" && !["withheld", "unavailable", "omitted"].includes(item.delivery);
    const regions = item.regions && (item.regions.redacted || item.regions.inaccessible) ? ` · ${Number(item.regions.redacted)} redacted / ${Number(item.regions.inaccessible)} inaccessible regions (not visible)` : "";
    const label = `${g.esc(item.kind)}: ${g.esc(item.title || item.id || "Request data")} · ${Number(item.bytes) || 0} bytes${item.estimatedTokens ? ` · ~${Number(item.estimatedTokens)} tokens` : ""}${item.delivery ? ` · ${g.esc(g.deliveryLabel[item.delivery] || item.delivery)}` : item.withheld ? " · withheld" : ""}${item.reason ? ` — ${g.esc(item.reason)}` : ""}${g.esc(regions)}`;
    return `<li>${excludable ? `<label><input type="checkbox" class="disclosure-item" value="${g.esc(key)}" ${exclude.includes(key) || item.delivery === "excluded" ? "" : "checked"}>${label}</label>` : label}</li>`;
  }).join("");
  const caps = d.capabilities;
  const ctx = d.context;
  const reasons = d.acknowledgementReasons || ["destination"];
  return `<p>Your request will be sent to <strong>${g.esc(d.endpoint)}</strong> using ${g.esc(d.model)} (${g.esc(d.locality)}).</p>`
    + (caps ? `<p>Model capabilities: ${caps.images ? "text and images" : "text only"}${caps.streaming ? ", streaming" : ""}${caps.tools ? ", read-only tools" : ""}; context window ${Number(caps.contextWindow)} tokens (${g.esc(caps.sources?.contextWindow || "unknown")}).</p>` : "")
    + (d.fallback ? `<div class="notice">Selected images will be sent to the vision fallback <strong>${g.esc(d.fallback.name)}</strong> · ${g.esc(d.fallback.model)} at ${g.esc(d.fallback.endpoint)} (${g.esc(d.fallback.locality)}). ${g.esc(d.fallback.scope)} Its description returns to ${g.esc(d.model)} as untrusted text.</div>` : "")
    + (d.blocked ? `<div class="notice" role="alert">${g.esc(d.blocked.message)} Uncheck the item and update the preview, or choose another model.</div>` : "")
    + `<ul class="disclosure-items">${items}</ul>`
    + (ctx ? `<p>Estimated input about ${Number(ctx.estimatedInputTokens)} of ${Number(ctx.window)} tokens; ${Number(ctx.reservedOutputTokens)} reserved for the reply.${ctx.omitted ? ` ${Number(ctx.omitted)} earlier messages will be omitted to fit (not summarized); the saved conversation is unchanged.` : ""}</p>` : "")
    + `<p>Total disclosed bytes: ${Number(d.totalBytes) || 0}. Tools: ${g.esc((d.tools || []).join(", ") || "None")}.</p>`
    + (d.toolScope ? `<p>Tool scope: workspace ${g.esc(d.toolScope.workspaceId)}${d.toolScope.tabId ? `, tab ${g.esc(d.toolScope.tabId)}` : ""}; at most ${Number(d.toolScope.maxCalls)} calls.</p>` : "")
    + (d.requiresAcknowledgement ? `<p>${reasons.includes("destination") ? "This acknowledgement applies to this workspace and this model destination. " : ""}${reasons.some((r) => r !== "destination") ? "Images and vision fallback use need acknowledgement every time. " : ""}Review your selections before each request.</p>` : "");
}
export function reviewDisclosure(disclosure, request) {
  return new Promise((resolve) => {
    let result = null;
    let d = disclosure;
    let exclude = [];
    let done = false;
    const token = String(++g.reviewSerial);
    const collect = () => [...document.querySelectorAll("#dialog-content .disclosure-item")].filter((box) => !box.checked).map((box) => box.value);
    const render = () => {
      const selectable = (d.items || []).some((item) => item.key && item.kind !== "message");
      const send = `<button id="acknowledge-disclosure" class="primary" ${d.blocked ? "disabled" : ""}>${d.requiresAcknowledgement ? "Acknowledge and send" : "Send"}</button>`;
      g.openDialog(d.requiresAcknowledgement ? "Review model destination" : "Review what the model receives", disclosureBody(d, exclude),
        g.action("close-dialog", "Cancel") + (selectable ? '<button id="update-disclosure" class="secondary">Update preview</button>' : "") + send, false, "Model destination review");
      if (g.$("update-disclosure")) g.$("update-disclosure").onclick = async () => {
        exclude = collect();
        try { d = (await g.execute("chat.preview", { ...request, ...(exclude.length ? { exclude } : {}) }, true)).disclosure; render(); }
        catch (error) { g.$("form-error").textContent = g.errorMessage(error); }
      };
      g.$("acknowledge-disclosure").dataset.review = token;
      g.$("acknowledge-disclosure").onclick = () => { result = { exclude: collect(), acknowledged: Boolean(d.requiresAcknowledgement) }; g.closeDialog(); finish(); };
    };
    const finish = () => {
      if (done) return;
      done = true;
      g.$("dialog").removeEventListener("close", onClose);
      resolve(result);
    };
    // A "close" event is dispatched asynchronously. One queued by the dialog that closed just
    // before this review opened (for example the attachment picker) can arrive after it is
    // showing; it must not end this review as cancelled. Only a close of this review, or its
    // replacement by another dialog, ends it.
    const onClose = () => {
      if (g.$("dialog").open && g.$("acknowledge-disclosure")?.dataset.review === token) return;
      finish();
    };
    g.$("dialog").addEventListener("close", onClose);
    render();
  });
}
function importReportHtml(report) {
  const counts = Object.entries(report.records || {}).filter(([, n]) => n).map(([name, n]) => `${g.esc(name)}: ${Number(n)}`).join(" · ") || "No records";
  const lossy = (report.lossy || []).map((item) => `<li>${g.esc(item.collection)} ${g.esc(item.field)}: ${g.esc(item.reason)} (${Number(item.count)})</li>`).join("");
  const rules = report.policies?.siteRules || [], flows = report.policies?.workflows || [];
  const linked = report.linkedSourcesNotIncluded || { count: 0, items: [] };
  return `<div class="notice"><strong>${counts}</strong>. ${Number(report.artifactVersions) || 0} capture versions; ${Number(report.remapped?.freeFormCitations) || 0} citations in text updated to new IDs.</div>` +
    `<h3>Policies and workflows (inactive until you enable them)</h3>${rules.length || flows.length ? `<ul>${rules.map((r) => `<li>Site rule: ${g.esc(r.behavior)} ${g.esc(r.hostname)}${g.esc(r.path === "/" ? "" : r.path)} · ${g.esc(r.reason)}</li>`).join("")}${flows.map((w) => `<li>Workflow: ${g.esc(w.title)} · ${Number(w.steps)} steps${w.allowedSites?.length ? ` · sites ${g.esc(w.allowedSites.join(", "))}` : ""}</li>`).join("")}</ul>` : "<p>None.</p>"}` +
    `<h3>Not carried over exactly</h3>${lossy ? `<ul>${lossy}</ul>` : "<p>Nothing beyond the exclusions below.</p>"}` +
    `<h3>Linked sources not included</h3><p>${Number(linked.count)} linked pages, files or services are referenced but their live content is not part of the export.</p>` +
    `<h3>Never imported</h3><ul>${(report.excluded || []).map((item) => `<li>${g.esc(item)}</li>`).join("")}</ul>`;
}
// Imports are previewed with a dry run before anything is written.
async function previewImport(title, command, args) {
  const preview = await g.execute(command, { ...args, dryRun: true }, true);
  g.openDialog(title, `<p>Review what will be imported. The workspace is created only when you confirm.</p>${importReportHtml(preview.result.importReport)}`,
    g.action("close-dialog", "Cancel") + '<button id="confirm-import" class="primary">Import as new workspace</button>', true);
  g.$("confirm-import").onclick = async () => {
    g.$("confirm-import").disabled = true;
    try {
      const result = await g.execute(command, args);
      g.closeDialog();
      g.toast("Workspace imported. Review its contents before enabling policies.");
      if (result.id) await g.execute("workspaces.switch", { id: result.id });
    } catch (error) { g.$("form-error").textContent = g.errorMessage(error); g.$("confirm-import").disabled = false; }
  };
}
export function importWorkspace() {
  g.formDialog(
    "Import a workspace",
    '<p>Imported policies and workflows stay inactive until reviewed. Model keys and browser sessions are not imported. You will see a preview before anything is imported.</p><label>Workspace export<input id="import-file" type="file" accept="application/json,.json" required></label>',
    async () => {
      const f = g.$("import-file").files[0];
      if (!f || f.size > 50 * 1024 * 1024)
        throw new Error("Choose a JSON workspace export under 50 MB, or use Import large project.");
      const data = JSON.parse(await f.text());
      setTimeout(() => previewImport("Review workspace import", "workspaces.import", { data }).catch((error) => g.toast(g.errorMessage(error))), 0);
    },
    { save: "Preview import" },
  );
}
export function exportPackage() {
  const suggested = `${(g.ws().name || "workspace").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 60) || "workspace"}-${new Date().toISOString().slice(0, 10)}`;
  g.formDialog("Export a large project",
    `<p>Writes a folder with project records, exact capture and file components, and a checksum manifest into the transfers folder of this profile. Copy the folder to move the project. Browser sessions and credentials are excluded.</p>${g.plaintextExportNotice()}${g.field("Package name (letters, digits, dots, dashes)", "name", suggested, "text", true)}${g.choice("Captures", "captures", [["exclude-restricted", "Leave out restricted originals (recommended)"], ["derivatives-only", "Only sanitized versions"], ["all", "Include restricted originals"]], "exclude-restricted")}`,
    async (values) => {
      const result = await g.execute("workspaces.exportPackage", { id: g.ws().id, name: values.name, captures: values.captures || "exclude-restricted", ...(values.acknowledgePlaintext ? { acknowledgePlaintext: true } : {}) }, true);
      g.toast(`Package written to ${result.path}`);
    }, { save: "Export package" });
}
export function importPackage() {
  g.formDialog("Import a large project",
    `<p>Place the package folder in the transfers folder of this profile, then enter its name. Every component is verified against the package manifest.</p>${g.field("Package name", "name", "", "text", true)}`,
    async (values) => { setTimeout(() => previewImport("Review package import", "workspaces.importPackage", { name: values.name }).catch((error) => g.toast(g.errorMessage(error))), 0); },
    { save: "Preview import" });
}
export async function manageBackups() {
  const { backups, policy, location } = await g.execute("backups.list", {}, true);
  const size = (bytes) => bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  g.openDialog("Backups",
    `<p>Stored in ${g.esc(location)}. Automatic backups: ${policy.automatic ? `every ${Number(policy.intervalHours)} hours, keeping ${Number(policy.keep)}` : "off"}.${policy.lastError ? ` <strong>Last automatic backup failed:</strong> ${g.esc(policy.lastError)}` : ""}</p>` +
    (backups.length ? backups.map((b) => `<div class="settings-row"><div><strong>${g.esc(b.kind === "automatic" ? "Automatic backup" : "Manual backup")}</strong><small>${g.esc(b.createdAt ? new Date(b.createdAt).toLocaleString() : b.id)}${b.bytes ? ` · ${size(b.bytes)}` : ""} · ${g.esc(b.status)}</small></div><div class="inline-actions">${g.action("verify-backup", "Verify", "", 'data-id="' + g.esc(b.id) + '"')}${g.action("restore-backup", "Restore", "", 'data-id="' + g.esc(b.id) + '"', "secondary danger")}</div></div>`).join("") : g.empty("No backups yet", "Make a backup before large changes.", "clock")),
    g.action("backup-now", "Back up now", "download") + g.action("close-dialog", "Close"), true);
}
export async function restoreBackupDialog(id) {
  const preview = await g.execute("backups.restore", { id, dryRun: true }, true);
  const counts = (value) => Object.entries(value || {}).filter(([key]) => !["activity", "history"].includes(key)).map(([key, n]) => `${g.esc(key)}: ${Number(n)}`).join(" · ");
  g.openDialog("Restore this backup?",
    `<p>The backup passed verification. Restoring replaces current workspaces and records with the backup. Your current data is kept in the profile recovery folder, not deleted.</p><div class="notice">Now: ${counts(preview.changes.current)}<br>After restore: ${counts(preview.changes.restored)}</div>${preview.changes.encryption && preview.changes.encryption.current !== preview.changes.encryption.restored ? `<div class="notice"><strong>${preview.changes.encryption.restored === "plaintext" ? "This backup is not encrypted." : "This backup is encrypted."}</strong> ${preview.changes.encryption.restored === "plaintext" ? "After restoring, project data is stored unencrypted until you turn encryption on again." : "After restoring, unlock it with the recovery key or passphrase that was valid when the backup was made."}</div>` : ""}`,
    g.action("close-dialog", "Cancel") + '<button id="confirm-restore" class="primary">Restore backup</button>');
  g.$("confirm-restore").onclick = async () => {
    g.$("confirm-restore").disabled = true;
    try {
      const result = await g.execute("backups.restore", { id }, true);
      g.closeDialog();
      g.toast(`Backup restored. Previous data kept in ${result.preservedOriginal}.`);
      await g.refresh(true);
    } catch (error) { g.$("form-error").textContent = g.errorMessage(error); g.$("confirm-restore").disabled = false; }
  };
}
