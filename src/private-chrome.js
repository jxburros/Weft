// Trusted chrome of a private window (#94): address bar and page controls only. Page content runs in a
// separate sandboxed view with its own in-memory session; this page receives only the address, title and
// navigation state of that page.
const $ = (id) => document.getElementById(id);
const api = window.weftPrivate;
let state = {};
function render(next) {
  state = next || {};
  if (document.activeElement !== $("address")) $("address").value = state.url === "about:blank" ? "" : state.url || "";
  $("back").disabled = !state.canGoBack;
  $("forward").disabled = !state.canGoForward;
  $("reload").textContent = state.loading ? "×" : "⟳";
  $("reload").setAttribute("aria-label", state.loading ? "Stop loading" : "Reload");
  document.title = `${state.title ? `${state.title} — ` : ""}Private window — Weft`;
  if (state.error) $("status").textContent = state.error;
}
api.onState(render);
$("navigation").addEventListener("submit", (event) => {
  event.preventDefault();
  void api.navigate($("address").value).then((result) => {
    if (result?.error) $("status").textContent = result.error;
    else $("address").blur();
  });
});
$("back").onclick = () => api.control("back");
$("forward").onclick = () => api.control("forward");
$("reload").onclick = () => api.control(state.loading ? "stop" : "reload");
$("new-private").onclick = () => api.control("new-window");
api.onFocusAddress(() => { $("address").focus(); $("address").select(); });
document.addEventListener("keydown", (event) => {
  const command = (event.ctrlKey || event.metaKey) && !event.altKey;
  const key = event.key.toLowerCase();
  if (command && event.shiftKey && key === "n") { event.preventDefault(); void api.control("new-window"); }
  else if (command && !event.shiftKey && key === "l") { event.preventDefault(); $("address").focus(); $("address").select(); }
  else if (command && !event.shiftKey && key === "w") { event.preventDefault(); void api.control("close"); }
  else if (event.key === "Escape" && document.activeElement === $("address")) { $("address").value = state.url === "about:blank" ? "" : state.url || ""; void api.control("focus-page"); }
});
void api.ready().then(render);
