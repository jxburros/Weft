/**
 * Model connection form and the chat panel.
 * Moved from src/gui.js (#119); `g` holds live bindings to gui.js state and helpers.
 */
let g;
/** Connect these views to the GUI's shared context (called once by gui.js). */
export function bindModelsViews(context) {
  g = context;
}

export function modelForm(id) {
  const r = g.models.find((m) => m.id === id);
  g.formDialog(
    r ? "Configure model connection" : "Add model connection",
    g.choice("Provider", "preset", g.PROVIDER_PRESETS.map(p => [p.id, p.name]), g.PROVIDER_PRESETS.find(p => p.endpoint === r?.endpoint)?.id || "compatible") +
    g.field("Connection name", "name", r?.name || "", "text", true) +
      g.choice(
        "API format",
        "provider",
        [
          ["openai", "OpenAI-compatible (including local models)"],
          ["anthropic", "Anthropic"],
          ["ollama", "Ollama native API (local)"],
        ],
        r?.provider || "openai",
      ) +
      g.field(
        "API base URL",
        "endpoint",
        r?.endpoint || "http://localhost:11434/v1",
        "url",
        true,
      ) +
      g.field("Model ID", "model", r?.model || "", "text", true) +
      g.action("discover-models", "Fetch available models", "search", r ? `data-id="${g.esc(r.id)}"` : "") + '<div id="model-catalog" aria-live="polite"></div>' +
      g.choice(
        "Tool capability",
        "tools",
        [
          ["false", "Text only"],
          ["true", "Enable tools and action proposals"],
        ],
        String(r?.tools || false),
      ) +
      g.field(
        "API key (optional; encrypted by the OS)",
        "apiKey",
        "",
        "password",
      ) +
      g.field("Or environment variable name", "apiKeyEnv", r?.apiKeyEnv || "") +
      (r?.apiKeyEnv ? g.choice("If you change the endpoint to another host", "keyDestination", [["drop", "Stop sending this environment key"], ["send", "Send this environment key to the new host"]], "drop") : "") +
      "<p>Keys are stored separately from project files. Saving a key requires OS secure storage. Local models may not require a key.</p>" +
      `<fieldset><legend>Capabilities</legend><p>Your settings take priority over what the endpoint reports.${r?.probed ? ` Last discovery: ${g.esc(g.date(r.probed.probedAt))}.` : ""}</p>` +
      g.choice("Image input", "imageInput", [["auto", `Use discovered or default (${r?.capabilities?.images ? "images" : "text only"})`], ["true", "Accepts images"], ["false", "Text only"]],
        r?.configuredCapabilities?.images === undefined ? "auto" : String(r.configuredCapabilities.images)) +
      g.choice("Replies", "streaming", [["true", "Stream as they are written"], ["false", "Wait for the whole reply"]], String(r?.configuredCapabilities?.streaming ?? true)) +
      g.field(`Context window in tokens (blank: ${r?.capabilities?.sources?.contextWindow === "probed" ? "discovered" : "assumed"} ${r?.capabilities?.contextWindow || 32768})`, "contextWindow", r?.configuredCapabilities?.contextWindow ?? "", "number") +
      g.field("Maximum reply tokens (blank: 4096)", "maxOutputTokens", r?.configuredCapabilities?.maxOutputTokens ?? "", "number") +
      g.choice("Vision fallback for images this model cannot read", "visionFallbackId", [["", "None — refuse image items"], ...g.models.filter((m) => m.id !== r?.id).map((m) => [m.id, `${m.name} · ${m.model} (${m.locality})`])], r?.visionFallbackId || "") +
      "</fieldset>" +
      `<fieldset><legend>Cost estimates (optional)</legend><p>Estimates use your prices and provider-reported tokens. They are not a bill.</p>${g.field("Currency (ISO code)", "currency", r?.pricing?.currency || "")}${g.field("Price per million input tokens", "inputPerMillion", r?.pricing?.inputPerMillion ?? "")}${g.field("Price per million output tokens", "outputPerMillion", r?.pricing?.outputPerMillion ?? "")}</fieldset>`,
    async (values) => {
      delete values.preset;
      values.tools = values.tools === "true";
      if (!values.apiKey) delete values.apiKey;
      if (!values.apiKeyEnv) delete values.apiKeyEnv;
      if (values.keyDestination === "send") values.confirmKeyDestination = true;
      delete values.keyDestination;
      const capabilities = {};
      if (values.imageInput !== "auto") capabilities.images = values.imageInput === "true";
      if (values.streaming === "false") capabilities.streaming = false;
      if (values.contextWindow) capabilities.contextWindow = Number(values.contextWindow);
      if (values.maxOutputTokens) capabilities.maxOutputTokens = Number(values.maxOutputTokens);
      if (Object.keys(capabilities).length) values.capabilities = capabilities;
      if (values.currency || values.inputPerMillion || values.outputPerMillion) {
        if (!values.currency || values.inputPerMillion === "" || values.outputPerMillion === "") throw new Error("Cost estimates need a currency and both prices.");
        values.pricing = { currency: values.currency.trim().toUpperCase(), inputPerMillion: Number(values.inputPerMillion), outputPerMillion: Number(values.outputPerMillion) };
      }
      if (!values.visionFallbackId) delete values.visionFallbackId;
      for (const key of ["imageInput", "streaming", "contextWindow", "maxOutputTokens", "currency", "inputPerMillion", "outputPerMillion"]) delete values[key];
      await g.execute("models.save", { ...values, ...(r ? { id: r.id } : {}) });
      await loadModels();
      if (g.agentOpen) renderAgent();
    },
    {
      save: "Save connection",
      wide: true,
      extra: r
        ? g.action("probe-model", "Discover capabilities", "search", `data-id="${g.esc(r.id)}"`) +
          g.action(
            "delete-model",
            "Remove connection",
            "trash",
            `data-id="${g.esc(r.id)}"`,
            "secondary danger",
          )
        : "",
    },
  );
}
export async function loadModels() {
  g.models = await g.execute("models.list", {}, true);
  if (!g.models.some((m) => m.id === g.modelId)) g.modelId = g.models[0]?.id || "";
}
export function openAgent(focus = false) {
  g.agentOpen = true;
  void g.execute("settings.update", { agentPanelOpen: true }, true).catch(
    () => {},
  );
  g.saveResume({ panels: { agentPanelOpen: true } });
  g.$("app").classList.add("agent-open");
  g.$("agent-panel").hidden = false;
  g.renderShell();
  renderAgent();
  g.layout();
  if (focus) g.$("chat-input")?.focus();
}
export function closeAgent() {
  g.agentOpen = false;
  void g.execute("settings.update", { agentPanelOpen: false }, true).catch(
    () => {},
  );
  g.saveResume({ panels: { agentPanelOpen: false } });
  g.$("app").classList.remove("agent-open");
  g.$("agent-panel").hidden = true;
  g.$("agent-toggle").focus();
  g.renderShell();
  g.layout();
}
export function renderAgent() {
  const conversation = g.records("conversations").find(
    (c) => c.id === g.conversationId,
  );
  if (!conversation) g.conversationId = null;
  g.$("agent-panel").innerHTML =
    `<div class="agent-header"><span class="agent-symbol icon" aria-hidden="true">${g.icon("spark")}</span><div><h2 class="agent-title">${g.esc(conversation?.title || "A thinking partner")}</h2><small>WITH YOUR WORKSPACE</small></div><button class="icon-button" data-action="new-chat" aria-label="New conversation">${g.icon("plus")}</button><button class="icon-button" data-action="close-agent" aria-label="Close agent panel">${g.icon("close")}</button></div><div class="agent-model"><select id="chat-model" aria-label="Choose model">${g.models.map((m) => `<option value="${g.esc(m.id)}" ${m.id === g.modelId ? "selected" : ""}>${g.esc(m.name)} · ${g.esc(m.model)} · ${m.capabilities?.images ? "images" : "text"}${m.capabilities?.tools ? " · tools" : ""}${m.capabilities?.contextWindow ? " · " + g.esc(m.capabilities.contextWindow) + " tokens" : ""}</option>`).join("")}</select><small id="model-destination"></small></div><div id="chat-messages" class="chat-messages" role="log" aria-label="Conversation messages" aria-live="off" tabindex="0"></div><form id="chat-form" class="chat-composer"><textarea id="chat-input" aria-label="Message your model" placeholder="What would you like to work on?" required></textarea><div id="chat-attachments" class="chat-attachments" role="group" aria-label="Selected attachments"></div><label class="chat-tool-choice"><input id="retrieve-context" type="checkbox">Find relevant workspace context (uses your configured search endpoint)</label><label class="chat-tool-choice"><input id="allow-app-tools" type="checkbox">Let Ask Weft propose app actions (approval required)</label><label class="chat-tool-choice"><input id="allow-read-tools" type="checkbox">Allow reading current tab & workspace search</label><div class="composer-footer"><label><input id="include-context" type="checkbox">Project context (${g.records("context").length})</label><button type="button" class="text-button" data-action="attach-chat">${g.icon("plus")}Attach</button><button class="primary" id="chat-send" type="submit">${g.icon("arrow")}Send</button></div></form>`;
  updateDestination();
  renderAttachments();
  renderMessages();
  g.$("chat-model").onchange = () => {
    g.modelId = g.$("chat-model").value;
    updateDestination();
  };
  g.$("chat-form").onsubmit = sendChat;
}
function updateDestination() {
  const m = g.models.find((m) => m.id === g.modelId);
  const caps = m?.capabilities || {};
  g.$("model-destination").textContent = m
    ? `${m.endpoint} · ${m.locality || "endpoint"} · ${caps.images ? "Text and images" : caps.visionFallback?.available ? `Text only · images via ${caps.visionFallback.name} (asks first)` : "Text only"}${caps.contextWindow ? ` · ${Math.round(caps.contextWindow / 1024)}k context${caps.sources?.contextWindow === "assumed default" ? " (assumed)" : ""}` : ""} · ${caps.tools ? "Tools and proposals available (opt-in below)" : "No automatic page access"}`
    : "Add a model connection in Settings to start.";
  if (g.$("allow-read-tools")) {
    g.$("allow-read-tools").disabled = !m?.capabilities?.tools;
    if (!m?.capabilities?.tools) g.$("allow-read-tools").checked = false;
  }
}
function turnUsage(manifest) {
  if (!manifest) return "";
  const usage = manifest.usage;
  const tokens = usage && (usage.inputTokens !== null || usage.outputTokens !== null)
    ? `${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out tokens (reported by provider)`
    : "Usage not reported by provider";
  const cost = manifest.cost ? ` · ≈ ${manifest.cost.currency} ${Number(manifest.cost.amount).toFixed(6)} estimated from your configured pricing` : "";
  const omitted = manifest.context?.omitted ? ` · ${Number(manifest.context.omitted)} earlier messages omitted to fit the context window (originals kept)` : "";
  const images = manifest.visualInputs?.length ? ` · ${manifest.visualInputs.length} image(s) sent${manifest.visualInputs.some((v) => v.destination === "vision-fallback") ? " via vision fallback" : ""}` : "";
  return `<small class="message-usage">${g.esc(`${manifest.locality || "endpoint"} · ${tokens}${cost}${omitted}${images}`)}</small>`;
}
function messageAuthor(m) {
  if (m.role === "user") return "YOU";
  if (m.role === "tool" && /"tool":"propose_action"/.test(m.content)) return "ACTION PROPOSAL";
  if (m.role === "tool" && /"tool":"action_receipt"/.test(m.content)) return "ACTION RESULT";
  if (m.role === "tool") return /"tool":"vision_fallback"/.test(m.content) ? `VISION FALLBACK · ${m.model || "model"}` : /"tool":"propose_task"/.test(m.content) ? "TASK PROPOSAL" : "READ-ONLY TOOL";
  return m.model || "MODEL";
}
export function renderMessages() {
  if (!g.$("chat-messages")) return;
  const c = g.records("conversations").find((c) => c.id === g.conversationId);
  const messages = c?.messages || [];
  const manifests = new Map((c?.turnManifests || []).filter((t) => t.turnId).map((t) => [t.turnId, t]));
  const last = messages.at(-1);
  g.setHTML(g.$("chat-messages"), messages.length
    ? messages
        .map((m) => {
          const manifest = m.turnId && manifests.get(m.turnId);
          const failed = m.role === "user" && manifest?.status === "failed" && !messages.some((x) => x.role === "assistant" && x.turnId === m.turnId)
            ? `<div class="notice" role="status">Request failed: ${g.esc(manifest.error || "Unknown error")} No reply was saved.</div>` : "";
          const status = m.status && m.status !== "complete" ? ` · ${g.esc(m.status)}${m.finishReason ? ` (${g.esc(m.finishReason.replace("_", " "))})` : ""}` : "";
          const resume = m === last && m.role === "assistant" && m.continuable && !g.chatBusy ? g.action("continue-chat", "Continue reply", "arrow", "", "text-button") : "";
          return `<div class="chat-message ${m.role === "user" ? "user" : "assistant"}"><div class="message-author">${g.esc(messageAuthor(m))}${status}</div><div class="message-body">${m.role === "tool" ? g.proposalCard(m) || `<details><summary>Source and tool result</summary><pre class="tool-result">${g.esc(m.content)}</pre></details>` : g.esc(m.content)}</div>${m.role === "assistant" ? turnUsage(manifest) : ""}${resume}</div>${failed}`;
        })
        .join("")
    : `<div class="chat-welcome"><span class="agent-symbol icon">${g.icon("spark")}</span><h3>A little help,<br>a fresh perspective.</h3><p>Think through an idea, make a plan, or ask a question. Choose a model above to get started.</p><button data-action="chat-prompt" data-text="Help me turn a project idea into a clear plan.">Help me make a plan ${g.icon("arrow")}</button><button data-action="chat-prompt" data-text="Help me organize my research. What should I collect first?">Organize my research ${g.icon("arrow")}</button><button data-action="section" data-section="settings">Configure a model ${g.icon("settings")}</button></div>`);
  if (g.chatBusy) {
    g.$("chat-messages").innerHTML += `<p class="muted chat-waiting"><span class="waiting-art" aria-hidden="true">${g.motionArt("waiting-dots", "waiting-dots")}</span>Waiting for your model…</p>`;
    g.$("chat-messages").__weftHTML = null;
  }
  renderLiveTurn();
  g.$("chat-messages").scrollTop = g.$("chat-messages").scrollHeight;
}
// Streamed deltas arrive over trusted IPC; the durable message replaces this bubble once saved.
function renderLiveTurn() {
  const box = g.$("chat-messages");
  if (!box) return;
  let bubble = g.$("chat-live");
  if (!g.liveTurn || g.liveTurn.conversationId !== g.conversationId) { bubble?.remove(); return; }
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.id = "chat-live";
    bubble.className = "chat-message assistant";
    // Streaming text is shown, not read token by token; completion is announced once.
    bubble.setAttribute("aria-hidden", "true");
    bubble.innerHTML = '<div class="message-author"></div><div class="message-body"></div>';
    const waiting = g.$("chat-waiting");
    if (waiting) box.insertBefore(bubble, waiting); else box.append(bubble);
    box.__weftHTML = null;
  }
  bubble.querySelector(".message-author").textContent = `${g.liveTurn.model || "MODEL"} · ${g.liveTurn.phase === "vision_fallback" ? "describing images with the vision fallback" : "streaming"}`;
  bubble.querySelector(".message-body").textContent = g.liveTurn.text || "…";
  box.scrollTop = box.scrollHeight;
}
export function onTurnFrame(frame) {
  if (frame.type === "start") g.liveTurn = { turnId: frame.turnId, conversationId: frame.conversationId, model: frame.model, text: "" };
  if (!g.liveTurn || g.liveTurn.turnId !== frame.turnId) return;
  if (frame.type === "request") g.liveTurn.text = "";
  if (frame.type === "delta") g.liveTurn.text += frame.text;
  if (frame.type === "phase") g.liveTurn.phase = frame.phase;
  if (frame.type === "end") {
    if (!g.chatBusy && frame.conversationId === g.conversationId && g.agentOpen) g.announce("A model reply finished in this conversation.");
    g.liveTurn = null;
    // Turns started by other clients also settle into durable messages.
    if (!g.chatBusy) void g.refresh(true).catch(() => {});
  }
  if (g.agentOpen) renderLiveTurn();
}
export function renderAttachments() {
  if (!g.$("chat-attachments")) return;
  g.$("chat-attachments").innerHTML = g.chatAttachments
    .map((a, i) => `<span class="tag">${g.esc(a.label)}<button type="button" class="icon-button" data-action="remove-attachment" data-id="${i}" aria-label="Remove ${g.esc(a.label)}">${g.icon("close")}</button></span>`)
    .join("");
}
export function attachDialog() {
  const tab = g.active();
  const check = (value, label) => `<label class="attach-choice"><input type="checkbox" name="attach" value="${g.esc(value)}">${g.esc(label)}</label>`;
  const group = (title, list) => list.length ? `<fieldset><legend>${g.esc(title)}</legend>${list.join("")}</fieldset>` : "";
  const artifacts = g.records("artifacts").flatMap((a) => (a.versions || []).slice(-3).reverse().map((v) =>
    check(`artifact|${a.id}|${v.id}`, `${a.title} · version ${v.number || ""} · ${g.date(v.createdAt)}${(v.components || []).some((c) => c.type === "image/png") ? " · text + image" : ""}${v.derivedFrom ? " · sanitized" : ""}${v.access === "restricted" ? " · restricted original: its newest sanitized version is sent instead" : ""}`)));
  g.openDialog("Attach to this message",
    `<p>Choose exactly what this message may use. The next step shows what the selected model will receive, item by item, before anything is sent.</p>${tab && tab.url !== "about:blank" ? group("Current tab", [check(`tab|${tab.id}`, `Readable snapshot of ${g.displayTitle(tab)}`)]) : ""}${group("Materials", g.records("materials").map((r) => check(`material|${r.id}`, r.title)))}${group("Context", g.records("context").map((r) => check(`context|${r.id}`, r.title)))}${group("Tasks", g.records("tasks").map((r) => check(`task|${r.id}`, r.title)))}${group("Captures (exact versions)", artifacts)}<fieldset><legend>Selected passage</legend>${g.field("Passage title", "passageTitle", "Selected passage")}${g.area("Paste the passage to attach", "passage")}</fieldset>`,
    g.action("close-dialog", "Cancel") + '<button id="attach-selected" class="primary">Attach selected</button>', true);
  g.$("attach-selected").onclick = () => {
    for (const input of document.querySelectorAll('#dialog-content input[name="attach"]:checked')) {
      const [kind, id, versionId] = input.value.split("|");
      const label = input.parentElement.textContent.trim();
      g.chatAttachments.push({ label: g.short(label, 48), attachment: kind === "tab" ? { kind, tabId: Number(id) } : kind === "artifact" ? { kind, id, versionId } : { kind, id } });
    }
    const passage = document.querySelector('#dialog-content [name="passage"]').value.trim();
    if (passage) {
      const title = document.querySelector('#dialog-content [name="passageTitle"]').value.trim() || "Selected passage";
      g.chatAttachments.push({ label: g.short(title, 48), attachment: { kind: "passage", title: title.slice(0, 300), content: passage.slice(0, 100000) } });
    }
    g.chatAttachments = g.chatAttachments.slice(0, 16);
    g.closeDialog();
    renderAttachments();
  };
}
export const deliveryLabel = {
  text: "sent as text", image: "sent as image", "image-via-fallback": "image sent to vision fallback", "reference-only": "reference only (not read or inspected)",
  withheld: "withheld (local only)", excluded: "excluded by you", omitted: "omitted to fit the context window", unsupported: "cannot be sent", unavailable: "unavailable",
};
async function sendChat(e) {
  e.preventDefault();
  if (g.chatBusy) return;
  const input = g.$("chat-input"),
    text = input.value.trim();
  if (!text || !g.modelId) return;
  g.chatBusy = true;
  g.$("chat-send").disabled = true;
  try {
    if (!g.conversationId) {
      const c = await g.execute(
        "conversations.create",
        { title: g.short(text, 65), workspaceId: g.ws().id },
        true,
      );
      g.conversationId = c.id;
    }
    const context = g.$("include-context").checked
      ? g.records("context")
          .slice(0, 12)
          .map((r) => ({
            id: r.id,
            recordType: "context",
            localOnly: !!r.localOnly,
            title: `${r.category}: ${r.title}`,
            content: r.content.slice(0, 100000),
          }))
      : [];
    const request = {
      conversationId: g.conversationId, modelId: g.modelId, text, context,
      ...((g.chatAttachments.length || g.$("retrieve-context").checked) ? { attachments: [...g.chatAttachments.map((a) => a.attachment), ...(g.$("retrieve-context").checked ? [{ kind: "search", query: text.slice(0, 1000), limit: 8 }] : [])] } : {}),
      allowReadTools: g.$("allow-read-tools").checked,
      allowAppTools: g.$("allow-app-tools").checked,
      ...(g.$("allow-read-tools").checked && g.active() && g.active().url !== "about:blank" ? { tabId: g.active().id } : {}),
    };
    if (g.catalog["chat.preview"]) {
      const preview = await g.execute("chat.preview", request, true);
      const d = preview.disclosure;
      if (d.requiresAcknowledgement || d.blocked || request.attachments || d.context?.omitted) {
        const review = await g.reviewDisclosure(d, request);
        if (!review) return;
        if (review.exclude.length) request.exclude = review.exclude;
        if (review.acknowledged) request.disclosureAck = true;
      }
    }
    input.value = "";
    g.chatAttachments = [];
    renderAttachments();
    g.$("chat-messages").innerHTML +=
      `<div class="chat-message user"><div class="message-author">YOU</div><div class="message-body">${g.esc(text)}</div></div><p class="muted chat-waiting" id="chat-waiting"><span class="waiting-art" aria-hidden="true">${g.motionArt("waiting-dots", "waiting-dots")}</span>Waiting for your model… ${g.action("cancel-chat", "Cancel", "", "", "text-button")}</p>`;
    g.$("chat-messages").__weftHTML = null;
    g.$("chat-messages").setAttribute("aria-busy", "true");
    g.announce("Message sent. Waiting for the model.");
    await g.execute("chat.send", request, true);
    g.liveTurn = null;
    await g.refresh(true);
    const reply = g.records("conversations").find((c) => c.id === g.conversationId)?.messages?.filter((m) => m.role === "assistant").at(-1);
    g.announce(reply ? `Reply from ${reply.model || "the model"}${reply.status && reply.status !== "complete" ? ` (${reply.status})` : ""}: ${g.short(reply.content, 160)}` : "The model did not return a reply.");
  } catch (error) {
    g.liveTurn = null;
    g.toast(g.errorMessage(error));
    await g.refresh(true);
  } finally {
    g.chatBusy = false;
    g.$("chat-messages")?.removeAttribute("aria-busy");
    if (g.$("chat-send")) g.$("chat-send").disabled = false;
    renderMessages();
  }
}
