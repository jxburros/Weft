/**
 * Dialog, chat and model-connection actions.
 * Moved from the act() switch in src/gui.js (#119). Each handler receives the clicked button and its
 * data-action, data-id and data-kind; `g` holds live bindings to gui.js state and helpers.
 */
let g;

const handlers = {
  "close-dialog": async (button, a, id, kind) => {
    g.closeDialog();
  },
  "ask": async (button, a, id, kind) => {
    g.openAgent(true);
  },
  "new-chat": async (button, a, id, kind) => {
    if (g.chatBusy)
      throw new Error(
        "Cancel the current request before starting a new conversation.",
      );
    g.conversationId = null;
    g.renderAgent();
  },
  "close-agent": async (button, a, id, kind) => {
    g.closeAgent();
  },
  "open-chat": async (button, a, id, kind) => {
    g.conversationId = id;
    g.openAgent(true);
  },
  "chat-prompt": async (button, a, id, kind) => {
    g.$("chat-input").value = button.dataset.text;
    g.$("chat-input").focus();
  },
  "cancel-chat": async (button, a, id, kind) => {
    await g.execute("chat.cancel", { conversationId: g.conversationId }, true);
  },
  "attach-chat": async (button, a, id, kind) => {
    g.attachDialog();
  },
  "remove-attachment": async (button, a, id, kind) => {
    g.chatAttachments.splice(Number(id), 1);
    g.renderAttachments();
  },
  "continue-chat": async (button, a, id, kind) => {
    g.$("chat-input").value = "Continue exactly where your previous reply stopped.";
    g.$("chat-form").requestSubmit();
  },
  "discover-models": async (button, a, id, kind) => {
    const form = g.$("edit-form"), generation = g.dialogGeneration;
    const v = Object.fromEntries(new FormData(form));
    const args = id && !v.apiKey && v.endpoint === g.models.find(m => m.id === id)?.endpoint && v.provider === g.models.find(m => m.id === id)?.provider && v.apiKeyEnv === (g.models.find(m => m.id === id)?.apiKeyEnv || "")
      ? { modelId: id } : { provider: v.provider, endpoint: v.endpoint, ...(v.apiKey ? { apiKey: v.apiKey } : {}), ...(v.apiKeyEnv ? { apiKeyEnv: v.apiKeyEnv } : {}) };
    const target = g.$("model-catalog"); target.textContent = "Fetching models…";
    try {
      const result = await g.execute("models.discover", args, true);
      if (generation !== g.dialogGeneration) return;
      target.innerHTML = g.choice("Available models", "discoveredModel", [["", "Choose a model"], ...result.models.map(m => [m.id, `${m.name} · ${m.capabilities.images === undefined ? "image capability unknown" : m.capabilities.images ? "images" : "text"}${m.capabilities.tools ? " · tools" : ""}${m.capabilities.contextWindow ? " · " + m.capabilities.contextWindow + " tokens" : ""}`])], "");
      target.querySelector('select').onchange = e => {
        const m = result.models.find(m => m.id === e.target.value); if (!m) return;
        form.elements.model.value = m.id;
        if (m.capabilities.images !== undefined) form.elements.imageInput.value = String(m.capabilities.images);
        if (m.capabilities.contextWindow) form.elements.contextWindow.value = m.capabilities.contextWindow;
        if (m.capabilities.tools !== undefined) form.elements.tools.value = String(m.capabilities.tools);
      };
      target.querySelector('select').removeAttribute('name');
    } catch (e) { if (generation === g.dialogGeneration) target.textContent = g.errorMessage(e); }
  },
  "probe-model": async (button, a, id, kind) => {
    const probe = await g.execute("models.probe", { modelId: id }, true);
    g.toast(probe.probed ? `Endpoint reported: ${probe.reported.join(", ")}. Your explicit settings still take priority.` : probe.reason);
    await g.loadModels();
    g.modelForm(id);
  },
  "new-model": async (button, a, id, kind) => {
    g.modelForm();
  },
  "edit-model": async (button, a, id, kind) => {
    g.modelForm(id);
  },
  "delete-model": async (button, a, id, kind) => {
    await g.execute("models.delete", { modelId: id });
    await g.loadModels();
    g.closeDialog();
    g.renderContent();
  },
  "commands": async (button, a, id, kind) => {
    g.openCommands();
  },
};

/** Bind the handlers to the GUI's shared context and return them by action name. */
export function chatActions(context) {
  g = context;
  return handlers;
}
