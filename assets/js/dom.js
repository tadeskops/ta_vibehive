/* DOM helpers — no innerHTML, no eval, XSS-safe by construction. */
'use strict';

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (k === 'on' && typeof v === 'object') for (const [evt, fn] of Object.entries(v)) node.addEventListener(evt, fn);
    else if (k === 'html') throw new Error('html prop not allowed');
    else if (k === 'text') node.textContent = v;
    else if (k in node && typeof node[k] !== 'function') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
export function mount(node, ...children) { clear(node); for (const c of children.flat()) if (c) node.append(c); return node; }

export function toast(msg, kind = '') {
  const t = document.getElementById('tpl-toast').content.firstElementChild.cloneNode(true);
  t.textContent = msg;
  if (kind) t.classList.add(kind);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

export function modal({ title, body, actions }) {
  const back = el('div', { class: 'modal-back' });
  const close = () => back.remove();
  const box = el('div', { class: 'modal' },
    el('div', { class: 'modal-head' },
      el('h3', { text: title }),
      el('button', { class: 'x-close', 'aria-label': 'Close', on: { click: close } }, '×')
    ),
    el('div', { class: 'modal-body' }, body),
    actions ? el('div', { class: 'modal-foot' }, ...actions.map(a => a.close ? el('button', { class: 'btn btn-ghost', on: { click: close } }, a.label) :
      el('button', { class: `btn ${a.kind || ''}`, on: { click: () => { if (a.onClick) a.onClick(close); } } }, a.label))) : null
  );
  back.append(box);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  return { close, root: back };
}

export function fmtINR(n) {
  const num = Number(n) || 0;
  return '₹' + num.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function daysLeft(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}
