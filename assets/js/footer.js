/*!
 * VibeHive footer wiring.
 *
 * Injected as a plain (non-module) script from index.html so it runs
 * regardless of whether the ES module bundle boots — the footer is a
 * defence-in-depth diagnostic surface and must remain functional even
 * when app.js has parse errors or import failures.
 *
 * Responsibilities:
 *  1. Fill the "©" year span with the current year.
 *  2. Wire the "Report site bug" button — opens a TSH-styled modal
 *     built in raw DOM (CSP-safe, no innerHTML on script-authored
 *     content). Design parity with
 *     `ta-society-helpdesk/docs/partials/footer.html` so the two apps
 *     feel like siblings from the resident's POV.
 *
 * Backend note:
 *  - TSH has a Cloudflare Worker and POSTs `/tool-issues` with the
 *    description + resized screenshots. VibeHive has no Worker, so
 *    on "Send report" we open GitHub's new-issue endpoint with the
 *    description prefilled in the body, then trigger a browser
 *    download of any picked-and-resized screenshots so the reporter
 *    can drop them onto the freshly opened GitHub issue tab. Mailto
 *    is the popup-blocked fallback so the button is never a dead-end.
 */
'use strict';
(function () {
  try {
    var y = document.getElementById('year');
    if (y) y.textContent = String(new Date().getFullYear());
  } catch (_e) { /* noop */ }

  /* Small createElement helper — same shape as assets/js/dom.js#el,
   * duplicated here so the footer script has zero coupling to the
   * ES module bundle. */
  function h(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'on' && v && typeof v === 'object') {
          for (var ev in v) { if (Object.prototype.hasOwnProperty.call(v, ev)) n.addEventListener(ev, v[ev]); }
        }
        else if (k === 'style' && v && typeof v === 'object') {
          for (var s in v) { if (Object.prototype.hasOwnProperty.call(v, s)) n.style[s] = v[s]; }
        }
        else if (k in n && typeof n[k] !== 'object') { try { n[k] = v; } catch (_e) { n.setAttribute(k, v); } }
        else n.setAttribute(k, v);
      }
    }
    if (children) {
      if (!Array.isArray(children)) children = [children];
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c == null || c === false) continue;
        n.append(c.nodeType ? c : document.createTextNode(String(c)));
      }
    }
    return n;
  }

  /* Toast that works even when the ES module bundle failed. Falls back
   * to a plain floating <div> so the reporter always has feedback. */
  function toast(msg, kind) {
    try {
      var tpl = document.getElementById('tpl-toast');
      if (tpl && tpl.content && tpl.content.firstElementChild) {
        var t = tpl.content.firstElementChild.cloneNode(true);
        t.textContent = msg;
        if (kind) t.classList.add(kind);
        document.body.append(t);
        setTimeout(function () { t.remove(); }, 3200);
        return;
      }
    } catch (_e) { /* fall through */ }
    var d = h('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: msg });
    document.body.append(d);
    setTimeout(function () { d.remove(); }, 3200);
  }

  /* Resize an image File → JPEG blob capped at MAX_DIM on the long
   * edge, quality 0.8. Same tuning as TSH's PhotoTray. Returns null
   * on failure so the caller can degrade to no-image. */
  var MAX_DIM = 1400;
  var JPEG_Q  = 0.8;
  function resizeImage(file) {
    return new Promise(function (resolve) {
      if (!file || !/^image\//.test(file.type)) return resolve(null);
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, hgt = img.naturalHeight;
          var scale = Math.min(1, MAX_DIM / Math.max(w, hgt));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(hgt * scale));
          var cv = document.createElement('canvas');
          cv.width = cw; cv.height = ch;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, cw, ch);
          cv.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (!blob) return resolve(null);
            var reader = new FileReader();
            reader.onload = function () { resolve({ blob: blob, dataUrl: reader.result, name: file.name || 'screenshot.jpg' }); };
            reader.onerror = function () { resolve(null); };
            reader.readAsDataURL(blob);
          }, 'image/jpeg', JPEG_Q);
        } catch (_e) { URL.revokeObjectURL(url); resolve(null); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  /* Save a Blob to the user's downloads. Used to hand back resized
   * screenshots so the reporter can drag them onto the freshly opened
   * GitHub issue tab. Best-effort — a failure here must not block
   * opening the issue. */
  function downloadBlob(blob, filename) {
    try {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename || 'screenshot.jpg';
      document.body.append(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
    } catch (_e) { /* best-effort */ }
  }

  /* Build + open the "Report site bug" modal. Layout mirrors
   * ta-society-helpdesk's footer modal (title, hint, textarea,
   * optional screenshots tray, Cancel + Send). Theme is inherited
   * from base.css (Community Warmth palette). */
  function openReporterModal() {
    var descTa = h('textarea', {
      rows: 5,
      required: true,
      minlength: 10,
      maxlength: 2000,
      placeholder: 'Describe the problem, what you expected, and any steps to reproduce.'
    });
    var fileInput = h('input', {
      type: 'file',
      accept: 'image/*',
      multiple: true,
      style: { width: '100%' }
    });
    var tray = h('div', {
      style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }
    });
    /* Selected + resized screenshots, capped at MAX_PICKS. */
    var picks = [];
    var MAX_PICKS = 3;

    function renderTray() {
      tray.textContent = '';
      picks.forEach(function (p, i) {
        var thumb = h('div', {
          style: {
            position: 'relative',
            width: '72px', height: '72px',
            borderRadius: '10px',
            overflow: 'hidden',
            border: '1px solid var(--line)',
            background: '#fff',
            flex: '0 0 auto'
          }
        }, [
          h('img', {
            src: p.dataUrl,
            alt: p.name,
            style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
          }),
          h('button', {
            type: 'button',
            'aria-label': 'Remove screenshot ' + (i + 1),
            title: 'Remove',
            style: {
              position: 'absolute', top: '2px', right: '2px',
              width: '20px', height: '20px', padding: '0',
              borderRadius: '999px', border: 'none',
              background: 'rgba(42,26,16,.72)', color: '#faf3ea',
              fontSize: '13px', lineHeight: '20px', cursor: 'pointer'
            },
            on: { click: function () { picks.splice(i, 1); renderTray(); } }
          }, '\u00d7')
        ]);
        tray.append(thumb);
      });
    }

    fileInput.addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      var remaining = MAX_PICKS - picks.length;
      if (remaining <= 0) {
        toast('You can attach up to ' + MAX_PICKS + ' screenshots.', 'warn');
        fileInput.value = '';
        return;
      }
      files.slice(0, remaining).reduce(function (p, f) {
        return p.then(function () {
          return resizeImage(f).then(function (out) {
            if (out) picks.push(out);
          });
        });
      }, Promise.resolve()).then(function () {
        renderTray();
        fileInput.value = '';
      });
    });

    var back = h('div', { class: 'modal-back' });
    function close() { back.remove(); }

    var LABEL_STYLE = {
      display: 'block',
      fontSize: '11px',
      fontWeight: '700',
      color: 'var(--muted)',
      letterSpacing: '.08em',
      textTransform: 'uppercase',
      marginBottom: '6px'
    };

    var descField = h('label', { class: 'field', style: { display: 'block' } }, [
      h('span', { style: LABEL_STYLE }, [
        'What went wrong ',
        h('span', { class: 'req', 'aria-hidden': 'true' }, '*')
      ]),
      descTa
    ]);

    var shotField = h('label', { class: 'field', style: { display: 'block' } }, [
      h('span', { style: LABEL_STYLE }, 'Screenshots (optional, up to 3)'),
      fileInput,
      h('small', { style: { display: 'block', color: 'var(--muted)', fontSize: '12px', marginTop: '6px' } },
        'Resized in your browser to keep uploads small. When you tap Send, GitHub opens in a new tab and the resized files are saved to your Downloads so you can drop them onto the issue.'),
      tray
    ]);

    var box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'reporter-title' }, [
      h('div', { class: 'modal-head' }, [
        h('h3', { id: 'reporter-title', style: { color: 'var(--gold)', margin: 0 }, text: 'Report site bug' }),
        h('button', { class: 'x-close', 'aria-label': 'Close', on: { click: close } }, '\u00d7')
      ]),
      h('div', { class: 'modal-body' }, [
        h('p', { style: { marginTop: 0, color: 'var(--muted)' } }, [
          'Report a problem with the ',
          h('strong', { style: { color: 'var(--ink)' } }, 'website itself'),
          ' \u2014 a layout bug, a broken button, wrong data, etc. This is filed as a GitHub issue for the maintainer and ',
          h('strong', { style: { color: 'var(--ink)' } }, 'does not'),
          ' create a society helpdesk ticket.'
        ]),
        descField,
        shotField
      ]),
      h('div', { class: 'modal-foot' }, [
        h('button', { class: 'btn btn-ghost', type: 'button', on: { click: close } }, 'Cancel'),
        h('button', {
          class: 'btn', type: 'button',
          on: { click: function () {
            var desc = (descTa.value || '').trim();
            if (desc.length < 10) {
              toast('Please describe the problem in at least 10 characters.', 'warn');
              descTa.focus();
              return;
            }
            var repo = 'https://github.com/tadeskops/ta_vibehive';
            var page = location.href;
            var ua = (navigator.userAgent || 'unknown').slice(0, 300);
            var viewport = (window.innerWidth || 0) + '\u00d7' + (window.innerHeight || 0);
            /* Short title = first line of the description, capped so
             * the URL stays well under GitHub's 8 KB limit. */
            var firstLine = desc.split(/\r?\n/, 1)[0].trim().slice(0, 60);
            var title = 'Site bug: ' + (firstLine || 'unspecified');
            var bodyParts = [
              '**What went wrong**',
              desc,
              '',
              '---',
              '**Page:** ' + page,
              '**User agent:** `' + ua + '`',
              '**Viewport:** ' + viewport,
              '**Build:** Community Warmth \u00b7 v0.1'
            ];
            if (picks.length) {
              bodyParts.push('');
              bodyParts.push('**Screenshots:** ' + picks.length +
                ' resized image(s) saved to your Downloads folder \u2014 please drag them onto this issue.');
            }
            var body = bodyParts.join('\n');
            var url = repo + '/issues/new?labels=' + encodeURIComponent('site-bug')
                    + '&title=' + encodeURIComponent(title)
                    + '&body='  + encodeURIComponent(body);
            /* Save any resized screenshots to Downloads so the user
             * has files ready to attach on GitHub. */
            picks.forEach(function (p, i) {
              var stem = 'vibehive-bug-' + Date.now().toString(36) + '-' + (i + 1);
              downloadBlob(p.blob, stem + '.jpg');
            });
            var w = window.open(url, '_blank', 'noopener,noreferrer');
            if (!w) {
              var mail = 'mailto:ta.deskops@gmail.com'
                       + '?subject=' + encodeURIComponent('VibeHive site bug')
                       + '&body=' + encodeURIComponent(body);
              location.href = mail;
            } else if (picks.length) {
              toast('Report opened. Screenshots saved to Downloads \u2014 attach them on the GitHub tab.', 'ok');
            } else {
              toast('Report opened on GitHub. Thanks!', 'ok');
            }
            close();
          } }
        }, 'Send report')
      ])
    ]);

    back.append(box);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.body.append(back);
    /* Focus the textarea so keyboard users can start typing
     * immediately. Deferred one frame so mobile keyboards don't
     * fight the modal mount. */
    setTimeout(function () { try { descTa.focus(); } catch (_e) { /* noop */ } }, 40);
  }

  try {
    var btn = document.getElementById('footpad-report-btn');
    if (!btn) return;
    btn.addEventListener('click', openReporterModal);
  } catch (_e) { /* footer must never break the page */ }
})();
