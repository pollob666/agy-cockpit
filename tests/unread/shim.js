// Injected right after <head> of a copy of ui.html. Replaces the Antigravity sidecar bridge with the
// mock that harness.html (the parent page) exposes, so every Cockpit iframe talks to one shared fake
// server while sharing localStorage like the real per-chat aux pane iframes do.
(function () {
  const P = window.parent;
  const cid = new URLSearchParams(location.search).get('conversationId') || '';
  window.sidecar = {
    conversationId: cid,
    async getWorkspaceUris() { return ['file:///d:/dev/' + P.__mock.wsOf(cid)]; },
    onWorkspaceChange() {},
    ui: { toggleConversation(id) { P.__mock.cockpitToggle(id, cid); } },
    fetch: (url, opts) => P.__mock.fetch(url, opts, cid)
  };
  // The user types in the chat panel, never inside a Cockpit iframe.
  document.hasFocus = () => false;
})();
