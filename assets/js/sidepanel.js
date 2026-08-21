/* SidePanel — reusable right-drawer (desktop) / bottom-sheet (mobile).
 *
 *   import { open, close, isOpen } from './sidepanel.js';
 *   const ctrl = open({
 *     title:   'Edit event',
 *     subtitle:'Diwali fund · A wing',
 *     size:    'md',                          // 'sm' | 'md' | 'lg' | number(px)
 *     body:    formEl | (root) => void,       // fill it however you like
 *     actions: [
 *       { label:'Save',   kind:'primary',
 *         onClick: (ctx) => ctx.setBusy(saveAsync()).then(() => ctx.close()) },
 *       { label:'Cancel', kind:'ghost', close: true },
 *     ],
 *     onOpen:  (ctrl) => wire(),
 *     onClose: () => cleanup(),
 *   });
 *
 * Behaviour
 *   • Right-drawer ≥ 641px viewport; bottom-sheet ≤ 640px.
 *   • Backdrop click, Escape, header ×, or any [data-sp-close] child closes.
 *   • Focus is trapped inside and restored on close.
 *   • Only one panel open at a time — a second open() closes the first.
 *   • Panel busy=1 while an action Promise is in flight; ignores taps/keys.
 *   • CSS is injected once on first open — no page-CSS changes required.
 */
'use strict';

const CSS_ID = 'tvh-sp-css';
const CSS = `
.tvh-sp{position:fixed;inset:0;z-index:80}
.tvh-sp[hidden]{display:none}
.tvh-sp-back{position:absolute;inset:0;background:rgba(42,26,16,.42)}
.tvh-sp-panel{position:absolute;top:0;right:0;bottom:0;width:min(var(--tvh-sp-w,440px),100%);
  background:var(--card,#fff);color:var(--ink,#2a1a10);display:flex;flex-direction:column;
  box-shadow:-8px 0 32px rgba(42,26,16,.25);animation:tvh-sp-in .18s ease-out;overflow:hidden}
.tvh-sp[data-busy="1"] .tvh-sp-panel{pointer-events:none;opacity:.7}
.tvh-sp[data-busy="1"] .tvh-sp-back{cursor:progress}
@keyframes tvh-sp-in{from{transform:translateX(100%)}to{transform:translateX(0)}}
.tvh-sp-head{padding:16px 20px;border-bottom:1px solid var(--line,#e8dcc7);display:flex;align-items:flex-start;gap:12px}
.tvh-sp-head h3{margin:0;font-size:17px;letter-spacing:-.01em}
.tvh-sp-head .tvh-sp-sub{color:var(--muted,#7d6858);font-size:12px;margin-top:2px}
.tvh-sp-x{margin-left:auto;background:transparent;border:none;font-size:22px;line-height:1;color:var(--muted,#7d6858);padding:4px 8px;border-radius:8px;min-height:40px;min-width:40px}
.tvh-sp-x:hover{color:var(--ink,#2a1a10);background:var(--terra-soft,#f2d8ca)}
.tvh-sp-body{flex:1;overflow-y:auto;padding:18px 20px;-webkit-overflow-scrolling:touch}
.tvh-sp-actions{padding:12px 20px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--line,#e8dcc7);
  display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;background:var(--card,#fff)}
.tvh-sp-actions .btn{min-height:44px}
@media (max-width:640px){
  .tvh-sp-panel{top:auto;right:0;left:0;bottom:0;width:100%;height:auto;max-height:88vh;
    border-radius:20px 20px 0 0;animation:tvh-sp-up .2s ease-out}
  @keyframes tvh-sp-up{from{transform:translateY(100%)}to{transform:translateY(0)}}
  .tvh-sp-head{padding-top:22px;position:relative}
  .tvh-sp-head::before{content:"";position:absolute;top:8px;left:50%;transform:translateX(-50%);width:44px;height:4px;border-radius:999px;background:var(--line,#e8dcc7)}
}
`;

const SIZES = { sm: 340, md: 440, lg: 620 };

let live = null;

function injectCSS() {
  if (document.getElementById(CSS_ID)) return;
  const s = document.createElement('style');
  s.id = CSS_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function focusablesIn(root) {
  const sel = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll(sel)).filter(el => !el.hasAttribute('hidden'));
}

function trapFocus(root, prev) {
  function onKey(e) {
    if (e.key !== 'Tab') return;
    const nodes = focusablesIn(root);
    if (!nodes.length) { e.preventDefault(); return; }
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  root.addEventListener('keydown', onKey);
  return () => {
    root.removeEventListener('keydown', onKey);
    if (prev && prev.focus) { try { prev.focus(); } catch (_e) {} }
  };
}

function resolveSize(size) {
  if (typeof size === 'number' && size > 0) return `${size}px`;
  if (typeof size === 'string' && SIZES[size]) return `${SIZES[size]}px`;
  return `${SIZES.md}px`;
}

export function isOpen() { return !!live; }

export function close() {
  if (!live) return;
  const c = live; live = null;
  try { if (c.opts.onClose) c.opts.onClose(); } catch (e) { console.error(e); }
  if (c.untrap) { try { c.untrap(); } catch (_e) {} }
  document.removeEventListener('keydown', c.onEsc);
  c.root.remove();
}

export function open(opts) {
  if (!opts || typeof opts !== 'object') throw new Error('SidePanel.open requires options');
  injectCSS();
  if (live) close();

  const root = document.createElement('div');
  root.className = 'tvh-sp';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  if (opts.ariaLabel) root.setAttribute('aria-label', opts.ariaLabel);
  else if (opts.title) root.setAttribute('aria-label', opts.title);

  const back = document.createElement('div');
  back.className = 'tvh-sp-back';
  const panel = document.createElement('div');
  panel.className = 'tvh-sp-panel';
  panel.style.setProperty('--tvh-sp-w', resolveSize(opts.size));

  /* Header */
  const head = document.createElement('div');
  head.className = 'tvh-sp-head';
  const titleWrap = document.createElement('div');
  titleWrap.style.flex = '1';
  const h = document.createElement('h3');
  h.textContent = opts.title || '';
  titleWrap.appendChild(h);
  if (opts.subtitle) {
    const s = document.createElement('div');
    s.className = 'tvh-sp-sub';
    s.textContent = opts.subtitle;
    titleWrap.appendChild(s);
  }
  head.appendChild(titleWrap);
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'tvh-sp-x';
  x.setAttribute('aria-label', 'Close');
  x.textContent = '\u00d7';
  x.addEventListener('click', () => close());
  head.appendChild(x);

  /* Body */
  const bodyEl = document.createElement('div');
  bodyEl.className = 'tvh-sp-body';
  if (typeof opts.body === 'function') opts.body(bodyEl);
  else if (opts.body instanceof Node) bodyEl.appendChild(opts.body);
  else if (typeof opts.body === 'string') bodyEl.textContent = opts.body;

  /* Actions */
  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'tvh-sp-actions';
  const actionEls = [];
  for (const a of (opts.actions || [])) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ' + (a.kind === 'ghost' ? 'btn-ghost' : a.kind === 'sage' ? 'btn-sage' : a.kind === 'emerg' ? 'btn-emerg' : '');
    btn.textContent = a.label || 'OK';
    if (a.id) btn.dataset.action = a.id;
    btn.addEventListener('click', () => runAction(a, btn));
    actionsWrap.appendChild(btn);
    actionEls.push(btn);
  }

  panel.append(head, bodyEl, actionsWrap);
  root.append(back, panel);
  document.body.appendChild(root);

  const prev = document.activeElement;
  const untrap = trapFocus(panel, prev);

  function onEsc(e) {
    if (root.dataset.busy === '1') return;
    if (e.key === 'Escape' && opts.closeOnEscape !== false) close();
  }
  document.addEventListener('keydown', onEsc);

  back.addEventListener('click', () => {
    if (root.dataset.busy === '1') return;
    if (opts.closeOnBackdrop !== false) close();
  });

  bodyEl.addEventListener('click', (e) => {
    const t = e.target && e.target.closest && e.target.closest('[data-sp-close]');
    if (t) close();
  });

  function setBusy(v) {
    if (v && typeof v === 'object' && typeof v.then === 'function') {
      root.dataset.busy = '1';
      return v.finally(() => { root.dataset.busy = ''; });
    }
    root.dataset.busy = v ? '1' : '';
  }

  function runAction(a, btn) {
    if (root.dataset.busy === '1') return;
    if (a.close && !a.onClick) { close(); return; }
    if (!a.onClick) return;
    const ret = a.onClick({
      close, setBusy,
      getRoot: () => panel, getBody: () => bodyEl,
      getForm: () => panel.querySelector('form'),
    }, btn);
    if (ret && typeof ret.then === 'function') setBusy(ret);
  }

  live = { root, panel, opts, onEsc, untrap };
  try { if (opts.onOpen) opts.onOpen(controller()); } catch (e) { console.error(e); }
  const first = focusablesIn(panel).find(n => !n.classList.contains('tvh-sp-x')) || panel;
  try { first.focus(); } catch (_e) {}

  function controller() {
    return {
      close, isOpen: () => live && live.root === root,
      setBusy,
      getRoot: () => panel, getBody: () => bodyEl,
      getForm: () => panel.querySelector('form'),
      setTitle: (v) => { h.textContent = v || ''; },
      setSubtitle: (v) => {
        let s = head.querySelector('.tvh-sp-sub');
        if (!s && v) { s = document.createElement('div'); s.className = 'tvh-sp-sub'; titleWrap.appendChild(s); }
        if (s) { s.textContent = v || ''; if (!v) s.remove(); }
      },
    };
  }
  return controller();
}
