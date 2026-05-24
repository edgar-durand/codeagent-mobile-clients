package com.windsurf.controller.services

/**
 * Legacy JS payload for Cascade / Windsurf JCEF panels. Lives here
 * rather than inline in AgentOutputMonitor so the script is easy to
 * iterate on without scrolling through 1100 LOC of monitor state.
 *
 * Captures:
 *   1. The page innerText, emitted to `__CAGENT__:` so the polling
 *      stability heuristic can detect "thinking done" by watching
 *      the text stop growing.
 *   2. The HTML of the latest assistant bubble (Cascade DOM
 *      structure: `.cascade-scrollbar > div > div > div[many
 *      children] > last-child`), emitted to `__CAGENT_HTML__:`. The
 *      innerText of the same element is also emitted to
 *      `__CAGENT_RESPONSE__:` as a fallback for renderers that need
 *      plain text.
 *
 * The console.log calls trigger CefDisplayHandler.onConsoleMessage
 * which AgentOutputMonitor's setupAndExecuteJcefCapture installs to
 * round-trip the bytes back into the extension host.
 */
internal const val CASCADE_INJECTION_JS: String = """(function(){
  try {
    var t = document.body ? (document.body.innerText || '') : '';
    if (t.length > 5) console.log('__CAGENT__:' + t);

    // Find last agent response HTML via Cascade DOM structure:
    // .cascade-scrollbar > div > div > div[many children] > last-child
    var scroll = document.querySelector('.cascade-scrollbar');
    if (!scroll) return;

    var msgContainer = null;
    var candidates = scroll.querySelectorAll('div');
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].children.length >= 5) {
        if (!msgContainer || candidates[i].children.length > msgContainer.children.length) {
          msgContainer = candidates[i];
        }
      }
    }
    if (!msgContainer || msgContainer.children.length < 2) return;

    var responseEl = null;
    var skipPatterns = ['Feedback submitted', 'Was this response helpful'];
    for (var j = msgContainer.children.length - 1; j >= 0; j--) {
      var child = msgContainer.children[j];
      var txt = (child.innerText || '').trim();
      if (txt.length < 10) continue;
      var isUI = false;
      for (var k = 0; k < skipPatterns.length; k++) {
        if (txt.indexOf(skipPatterns[k]) >= 0 && txt.length < 200) { isUI = true; break; }
      }
      if (!isUI) { responseEl = child; break; }
    }
    if (responseEl && responseEl.innerHTML && responseEl.innerHTML.length > 20) {
      console.log('__CAGENT_HTML__:' + responseEl.innerHTML);
      var respText = (responseEl.innerText || '').trim();
      if (respText.length > 3) {
        console.log('__CAGENT_RESPONSE__:' + respText);
      }
    }
  } catch(e) {}
})();"""
