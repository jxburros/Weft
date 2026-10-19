/**
 * Workspace encryption dialogs and the lock screen.
 * Moved from src/gui.js (#119); `g` holds live bindings to gui.js state and helpers.
 */
let g;
/** Connect these views to the GUI's shared context (called once by gui.js). */
export function bindEncryptionViews(context) {
  g = context;
}

const unlockWaiters = [];
const backendLabel = (b) => ({ keychain: "macOS Keychain", dpapi: "Windows DPAPI", gnome_libsecret: "Secret Service (libsecret)", kwallet: "KWallet", kwallet5: "KWallet 5", kwallet6: "KWallet 6", basic_text: "basic_text (no OS secret service)" })[b] || b || "none";
export function plaintextExportNotice() {
  if (!g.encryption?.enabled) return "";
  return `<div class="notice"><strong>This export is not encrypted.</strong> Your workspace data is encrypted on this computer, but the exported file or folder will be readable by anyone who gets a copy.</div><label class="check-row"><input type="checkbox" name="acknowledgePlaintext" required> I understand this export is written as plaintext</label>`;
}
export function encryptionSection() {
  const e = g.encryption;
  if (!e) return "";
  const os = e.methods.os;
  const osLine = os.protects ? `OS key store available: ${g.esc(backendLabel(os.backend))}.` : `OS key store: ${g.esc(backendLabel(os.backend))}. ${g.esc(os.reason || "")}`;
  if (!e.enabled) {
    return `<section class="settings-section" id="encryption-settings"><h2>Encryption</h2><p>Off. Project records, captures and files are stored unencrypted in this profile; full-disk encryption is the only protection if this computer is lost. ${osLine}</p><div class="inline-actions">${g.action("encryption-enable", "Turn on encryption…", "lock")}${g.action("encryption-coverage", "What encryption covers", "")}</div></section>`;
  }
  const unlock = e.unlockMode === "os" ? `unlocks with ${g.esc(backendLabel(os.backend))} at startup` : "asks for your passphrase or recovery key at every start";
  return `<section class="settings-section" id="encryption-settings"><h2>Encryption</h2><p>On (AES-256-GCM). Weft ${unlock}${e.methods.passphrase.configured ? "; a passphrase is set" : ""}. Data key version ${Number(e.keyVersion)}.${e.autoLock?.idleMinutes ? ` Locks after ${Number(e.autoLock.idleMinutes)} minutes idle.` : ""}${e.autoLock?.onScreenLock ? " Locks with the screen." : ""}${e.rotation ? " A data-key rotation is in progress." : ""} Agents cannot unlock it. ${e.unlockMode === "os" ? "" : osLine}</p><div class="inline-actions">${g.action("encryption-lock", "Lock now", "lock")}${g.action("encryption-configure", "Unlock options…", "")}${g.action("encryption-rotate", "Rotate keys…", "")}${g.action("encryption-check", "Check recovery key…", "")}${g.action("encryption-coverage", "What encryption covers", "")}${g.action("encryption-disable", "Turn off…", "", "", "secondary danger")}</div></section>`;
}
function coverageList(e) {
  return `<p>${g.esc(e.coverage.threatModel)}</p><h3>Encrypted</h3><ul>${e.coverage.encrypted.map((x) => `<li>${g.esc(x)}</li>`).join("")}</ul><h3>Not encrypted</h3><ul>${e.coverage.notEncrypted.map((x) => `<li>${g.esc(x)}</li>`).join("")}</ul>`;
}
export function encryptionCoverageDialog() {
  g.openDialog("What encryption covers", coverageList(g.encryption), g.action("close-dialog", "Close"), true);
}
const mb = (bytes) => bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
export async function enableEncryptionDialog() {
  const e = await g.execute("encryption.status", { inventory: true }, true);
  const os = e.methods.os;
  const copies = e.plaintextCopies || [];
  const removable = copies.filter((c) => c.removable);
  g.formDialog("Turn on encryption",
    `${coverageList(e)}${g.choice("How Weft unlocks", "unlockMode", os.protects ? [["os", `Automatically with ${backendLabel(os.backend)} when I sign in`], ["manual", "Ask for my passphrase or recovery key at every start"]] : [["manual", "Ask for my passphrase or recovery key at every start"]], os.protects ? "os" : "manual")}${os.protects ? "" : `<div class="notice">${g.esc(os.reason || "The OS key store is unavailable.")} Weft will ask for your passphrase or recovery key at every start.</div>`}${g.field("Passphrase (optional, at least 12 characters)", "passphrase", "", "password")}${g.field("Repeat passphrase", "passphrase2", "", "password")}${copies.length ? `<div class="notice">Plaintext copies remain in this profile: ${copies.map((c) => `${g.esc(c.path)} (${mb(c.bytes)})`).join(", ")}.</div>${removable.length ? `<label class="check-row"><input type="checkbox" name="removePlaintextCopies"> Overwrite and remove ${removable.length} plaintext backup and recovery cop${removable.length === 1 ? "y" : "ies"} (export packages stay)</label>` : ""}` : ""}<div class="notice">Encrypting rewrites your data in place; earlier blocks may remain on SSDs and in snapshots. Weft shows a recovery key once. <strong>If you lose the recovery key${" "}and your passphrase, and the OS key is unavailable, nobody can recover your data.</strong></div><label class="check-row"><input type="checkbox" name="acknowledgeKeyLoss" required> I understand that losing every key means my data is lost</label>`,
    async (values) => {
      if (values.passphrase !== values.passphrase2) throw new Error("The passphrases do not match.");
      const result = await g.execute("encryption.enable", { acknowledgeKeyLoss: true, unlockMode: values.unlockMode, ...(values.passphrase ? { passphrase: values.passphrase } : {}), removePlaintextCopies: Boolean(values.removePlaintextCopies) }, true);
      setTimeout(() => showRecoveryKey("Encryption is on", result.recoveryKey, result.notice), 0);
    }, { save: "Encrypt my data", wide: true, trusted: "Encryption" });
}
function showRecoveryKey(title, key, notice) {
  g.openDialog(title,
    `<p>${g.esc(notice)}</p><p>Recovery key (shown only once):</p><p><code id="recovery-key" class="recovery-key">${g.esc(key)}</code></p><p>Write it down or store it in a password manager on another device. Weft cannot show it again.</p><label class="check-row"><input type="checkbox" id="recovery-saved"> I stored the recovery key somewhere safe</label>`,
    '<button id="recovery-done" class="primary" disabled>Done</button>');
  g.$("recovery-saved").onchange = (event) => (g.$("recovery-done").disabled = !event.target.checked);
  g.$("recovery-done").onclick = () => { g.closeDialog(); void g.refresh(true); };
}
export function configureEncryptionDialog() {
  const os = g.encryption.methods.os;
  g.formDialog("Unlock options",
    `${g.choice("How Weft unlocks", "unlockMode", os.protects ? [["os", `Automatically with ${backendLabel(os.backend)}`], ["manual", "Ask for my passphrase or recovery key at every start"]] : [["manual", "Ask for my passphrase or recovery key at every start"]], g.encryption.unlockMode)}${g.choice("Passphrase", "passphraseAction", [["keep", g.encryption.methods.passphrase.configured ? "Keep the current passphrase" : "No passphrase"], ["set", "Set a new passphrase"], ...(g.encryption.methods.passphrase.configured ? [["remove", "Remove the passphrase"]] : [])], "keep")}${g.field("New passphrase (at least 12 characters)", "passphrase", "", "password")}${g.choice("Lock automatically when I am away from the computer", "autoLockMinutes", [["off", "Never"], ...[5, 15, 30, 60, 240].map((m) => [String(m), `After ${m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`} without using the computer`])], g.encryption.autoLock?.idleMinutes ? String(g.encryption.autoLock.idleMinutes) : "off")}<label class="check-row"><input type="checkbox" name="lockOnScreenLock"${g.encryption.autoLock?.onScreenLock ? " checked" : ""}> Also lock when the screen locks or the computer sleeps</label><div class="notice">Idle time is how long nobody has used this computer’s keyboard or mouse. Agent activity never keeps Weft unlocked; running agent work stops when it locks.</div>`,
    async (values) => {
      const passphrase = values.passphraseAction === "set" ? values.passphrase : values.passphraseAction === "remove" ? null : undefined;
      if (values.passphraseAction === "set" && !values.passphrase) throw new Error("Enter the new passphrase.");
      await g.execute("encryption.configure", { unlockMode: values.unlockMode, ...(passphrase !== undefined ? { passphrase } : {}), autoLockMinutes: values.autoLockMinutes === "off" ? null : Number(values.autoLockMinutes), lockOnScreenLock: Boolean(values.lockOnScreenLock) }, true);
      g.toast("Unlock options saved.");
    });
}
export function rotateEncryptionDialog() {
  g.formDialog("Rotate encryption keys",
    `${g.choice("Rotate", "target", [["wrapping", "Profile key and recovery key (fast; your data is not rewritten)"], ["dataKey", "Data key (re-encrypts all data; resumes after a restart)"]], "wrapping")}${g.field("Passphrase to keep (profile-key rotation only; leave empty to remove it)", "passphrase", "", "password")}<div class="notice">Profile-key rotation shows a new recovery key once; the old recovery key and passphrase stop working. Backups made earlier keep their own keys. Make a new backup afterwards.</div>`,
    async (values) => {
      if (values.target === "dataKey") {
        const result = await g.execute("encryption.rotate", { target: "dataKey" }, true);
        g.toast(`Data key rotated to version ${Number(result.keyVersion)}; ${Number(result.reencrypted)} items re-encrypted.`);
        return;
      }
      const result = await g.execute("encryption.rotate", { target: "wrapping", ...(values.passphrase ? { passphrase: values.passphrase } : {}) }, true);
      setTimeout(() => showRecoveryKey("New recovery key", result.recoveryKey, result.notice), 0);
    });
}
export function checkRecoveryKeyDialog() {
  g.formDialog("Check a recovery key", `<p>Checks that a recovery key opens this profile. Nothing is unlocked or changed.</p>${g.field("Recovery key", "recoveryKey", "", "password", true)}`,
    async (values) => {
      const result = await g.execute("encryption.checkRecoveryKey", { recoveryKey: values.recoveryKey }, true);
      if (!result.valid) throw new Error("That recovery key does not open this profile.");
      g.toast("The recovery key opens this profile.");
    }, { save: "Check" });
}
export function disableEncryptionDialog() {
  g.formDialog("Turn off encryption",
    `<div class="notice"><strong>Project data will be stored unencrypted on this disk.</strong> Anyone with access to this profile or its future backups can read it. Encrypted backups made earlier stay encrypted.</div><label class="check-row"><input type="checkbox" name="acknowledgePlaintext" required> Store my data unencrypted</label>`,
    async () => {
      await g.execute("encryption.disable", { acknowledgePlaintext: true }, true);
      g.toast("Encryption is off.");
    }, { save: "Turn off encryption", trusted: "Encryption" });
}
/** Full-window lock screen: nothing else renders until a person unlocks. */
export async function showLockScreen() {
  if (g.lockScreenOpen) return new Promise((resolve) => unlockWaiters.push(resolve));
  g.lockScreenOpen = true;
  if (g.$("dialog").open) g.closeDialog();
  // Only the lock screen is operable: everything behind it is inert to keyboard, pointer and assistive technology.
  const restoreFocus = g.rememberFocus();
  for (const element of [g.$("app"), document.querySelector(".skip-link")]) element.inert = true;
  try { g.encryption = await g.weftExecute("encryption.status", {}); } catch { /* render with what is known */ }
  const e = g.encryption || { methods: { os: {}, passphrase: {} } };
  const screen = document.createElement("div");
  screen.id = "lock-screen";
  screen.setAttribute("role", "dialog");
  screen.setAttribute("aria-modal", "true");
  screen.setAttribute("aria-labelledby", "lock-title");
  const osReady = e.methods.os.configured && e.methods.os.protects;
  screen.innerHTML = `<div class="lock-card"><h1 id="lock-title">Weft is locked</h1><p>Your workspace data is encrypted on this computer.${e.lockReason === "os_key_unavailable" ? " The OS key store could not unlock it here (another computer or account?)." : e.lockReason === "idle" ? " It locked automatically after the idle time you set." : e.lockReason === "screen_locked" ? " It locked automatically when the screen locked." : ""} Unlock it to continue. Agents cannot unlock it.</p>${osReady ? `<button id="unlock-os" class="primary">Unlock with ${g.esc(backendLabel(e.methods.os.backend))}</button>` : ""}<form id="unlock-form"><label>Unlock with<select name="method">${e.methods.passphrase.configured ? '<option value="passphrase">Passphrase</option>' : ""}<option value="recovery">Recovery key</option></select></label><label>Passphrase or recovery key<input name="secret" type="password" autocomplete="off" required></label><button type="submit" class="${osReady ? "secondary" : "primary"}">Unlock</button></form><div class="form-error" id="unlock-error" role="alert"></div></div>`;
  document.body.append(screen);
  window.weft.layout({ x: 0, y: 0, width: 1, height: 1, visible: false }).catch?.(() => {});
  const unlock = async (args, button) => {
    button.disabled = true;
    g.$("unlock-error").textContent = "";
    try {
      await g.weftExecute("encryption.unlock", args);
      screen.remove();
      g.lockScreenOpen = false;
      for (const element of [g.$("app"), document.querySelector(".skip-link")]) element.inert = false;
      for (const resolve of unlockWaiters.splice(0)) resolve();
      await g.refresh(true);
      restoreFocus();
      g.toast("Unlocked.");
    } catch (error) {
      g.$("unlock-error").textContent = g.errorMessage(error);
      button.disabled = false;
    }
  };
  if (osReady) g.$("unlock-os").onclick = (event) => unlock({ method: "os" }, event.currentTarget);
  g.$("unlock-form").onsubmit = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const secret = form.get("secret");
    event.currentTarget.querySelector("[name=secret]").value = "";
    void unlock({ method: form.get("method"), secret }, event.currentTarget.querySelector("button"));
  };
  setTimeout(() => (osReady ? g.$("unlock-os") : screen.querySelector("[name=secret]"))?.focus(), 30);
  return new Promise((resolve) => unlockWaiters.push(resolve));
}
