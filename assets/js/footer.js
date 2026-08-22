/*!
 * VibeHive footer wiring.
 *
 * Injected as a plain (non-module) script from index.html so it runs
 * regardless of whether the ES module bundle boots — the footer is a
 * defence-in-depth diagnostic surface and must remain functional even
 * when app.js has parse errors or import failures.
 *
 * Responsibilities:
 *  1. Fill the "©" year span with the current year (avoids stale
 *     copyright dates on long-lived deploys).
 *  2. Wire the "Report site bug" button in the footer center zone.
 *     VibeHive has no Cloudflare Worker (unlike ta-society-helpdesk),
 *     so instead of POST-ing a report to a backend we open GitHub's
 *     new-issue endpoint in a new tab with a prefilled title + body.
 *     Falls back to mailto: if the popup is blocked so the button is
 *     never a dead-end.
 */
'use strict';
(function () {
  try {
    var y = document.getElementById('year');
    if (y) y.textContent = String(new Date().getFullYear());
  } catch (_e) { /* noop */ }

  try {
    var btn = document.getElementById('footpad-report-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var repo = 'https://github.com/tadeskops/ta_vibehive';
      var page = location.href;
      var ua = (navigator.userAgent || 'unknown').slice(0, 300);
      var viewport = (window.innerWidth || 0) + '\u00d7' + (window.innerHeight || 0);
      var title = 'Site bug: ';
      var body = [
        '**What went wrong**',
        '<!-- Describe the problem, what you expected, and any steps to reproduce. -->',
        '',
        '',
        '---',
        '**Page:** ' + page,
        '**User agent:** `' + ua + '`',
        '**Viewport:** ' + viewport,
        '**Build:** Community Warmth \u00b7 v0.1'
      ].join('\n');
      var url = repo + '/issues/new?labels=' + encodeURIComponent('site-bug')
              + '&title=' + encodeURIComponent(title)
              + '&body=' + encodeURIComponent(body);
      var w = window.open(url, '_blank', 'noopener,noreferrer');
      if (!w) {
        var mail = 'mailto:ta.deskops@gmail.com'
                 + '?subject=' + encodeURIComponent('VibeHive site bug')
                 + '&body=' + encodeURIComponent(body);
        location.href = mail;
      }
    });
  } catch (_e) { /* footer must never break the page */ }
})();
