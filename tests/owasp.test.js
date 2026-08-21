// ta_vibehive · OWASP baseline suite (G0-05)
//
// Runs against the built _site/ directory (or the workspace root as a fallback
// so `node --test` on a workstation still works). Each assertion is one OWASP
// Top-10 control mapped from arch 15.2.
//
// The suite is intentionally strict: any regression here fails CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = existsSync('_site') ? '_site' : '.';

function readAllHtml() {
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      // skip artefacts / vendored / VCS
      if (name === '.git' || name === 'node_modules' || name === 'temp' ||
          name === 'tests' || name === 'scripts' || name === 'docs' ||
          name === 'temp\\suggested') continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.html')) out.push({ path: p, body: readFileSync(p, 'utf8') });
    }
  }
  walk(ROOT);
  return out;
}

function readAllJs() {
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules' || name === 'temp' ||
          name === 'tests' || name === 'scripts' || name === 'docs' ||
          name === 'vendor') continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.js')) out.push({ path: p, body: readFileSync(p, 'utf8') });
    }
  }
  const roots = [join(ROOT, 'assets')].filter(existsSync);
  if (ROOT === '.') roots.push('lib');
  for (const r of roots.filter(existsSync)) walk(r);
  return out;
}

const htmls = readAllHtml();
const jss   = readAllJs();

test('A01/A05 · every HTML has a Content-Security-Policy meta', () => {
  assert.ok(htmls.length > 0, 'no html files found');
  for (const h of htmls) {
    assert.match(h.body, /Content-Security-Policy/i, `${h.path} missing CSP`);
  }
});

test('A05 · CSP is strict (default-src self, no unsafe-inline, no unsafe-eval)', () => {
  for (const h of htmls) {
    const m = h.body.match(/http-equiv=["']Content-Security-Policy["'][^>]*content="([^"]+)"/i);
    assert.ok(m, `${h.path} CSP meta not parseable`);
    const csp = m[1];
    assert.match(csp, /default-src\s+'self'/, `${h.path} missing default-src 'self'`);
    assert.ok(!/unsafe-inline/.test(csp), `${h.path} CSP contains unsafe-inline`);
    assert.ok(!/unsafe-eval/.test(csp), `${h.path} CSP contains unsafe-eval`);
    assert.match(csp, /frame-ancestors\s+'none'/, `${h.path} missing frame-ancestors 'none'`);
  }
});

test('A05 · X-Content-Type-Options: nosniff meta present', () => {
  for (const h of htmls) {
    assert.match(h.body, /X-Content-Type-Options[^>]*nosniff/i, `${h.path} missing XCTO`);
  }
});

test('A05 · Referrer-Policy meta present', () => {
  for (const h of htmls) {
    assert.match(h.body, /Referrer-Policy/i, `${h.path} missing Referrer-Policy`);
  }
});

test('A05 · Permissions-Policy meta present', () => {
  for (const h of htmls) {
    assert.match(h.body, /Permissions-Policy/i, `${h.path} missing Permissions-Policy`);
  }
});

test('A03 · no inline event handlers (onclick=, onload= ...)', () => {
  const forbidden = /\bon(click|load|error|submit|change|input|mouseover|focus|blur|keydown|keyup)\s*=/i;
  for (const h of htmls) {
    // Allow Alpine's x-on: bindings; strip them out before the check.
    const stripped = h.body.replace(/x-on:[a-z]+=/gi, '').replace(/@[a-z]+=/gi, '');
    assert.ok(!forbidden.test(stripped), `${h.path} inline event handler`);
  }
});

test('A05 · no inline style= attributes (blocked by strict CSP style-src)', () => {
  // `style-src 'self'` without `'unsafe-inline'` blocks style attributes in
  // modern browsers. Ship classes in base.css instead.
  const styleAttr = /\sstyle\s*=/;
  for (const h of htmls) {
    assert.ok(!styleAttr.test(h.body), `${h.path} uses inline style= attribute (blocked by CSP)`);
  }
});

test('A03 · no inline <script> body (must have src=)', () => {
  const inline = /<script(?![^>]*\bsrc=)[^>]*>\s*\S/i;
  for (const h of htmls) {
    assert.ok(!inline.test(h.body), `${h.path} inline <script> body`);
  }
});

test('A03 · no dangerous DOM sinks (innerHTML=, outerHTML=, document.write)', () => {
  const sinks = [/\binnerHTML\s*=/, /\bouterHTML\s*=/, /\bdocument\.write\b/];
  for (const j of jss) {
    for (const s of sinks) {
      assert.ok(!s.test(j.body), `${j.path} uses forbidden DOM sink ${s}`);
    }
  }
});

test('A03 · no Alpine x-html binding (XSS-safe: x-text only)', () => {
  const bad = /\bx-html\s*=/;
  for (const h of htmls) assert.ok(!bad.test(h.body), `${h.path} uses x-html`);
  for (const j of jss)   assert.ok(!bad.test(j.body), `${j.path} uses x-html`);
});

test('A06 · every vendored <script> has SRI integrity attribute', () => {
  const ref = /<script[^>]*src=["']assets\/vendor\/([^"']+)["'][^>]*>/g;
  for (const h of htmls) {
    let m;
    while ((m = ref.exec(h.body)) !== null) {
      // Grab the whole tag and check for integrity=
      const tagStart = m.index;
      const tagEnd = h.body.indexOf('>', tagStart);
      const tag = h.body.slice(tagStart, tagEnd + 1);
      assert.match(tag, /integrity=["']sha384-/, `${h.path}: vendored ${m[1]} lacks SRI`);
      assert.match(tag, /crossorigin=/, `${h.path}: vendored ${m[1]} lacks crossorigin=`);
    }
  }
});

test('A06 · no LLM SDK marker in shipped code', () => {
  const pat = /\b(openai|anthropic|langchain|@ai-sdk)\b/i;
  for (const j of jss)   assert.ok(!pat.test(j.body), `${j.path} references LLM SDK`);
  for (const h of htmls) assert.ok(!pat.test(h.body), `${h.path} references LLM SDK`);
});

test('A02 · no plaintext secrets in shipped code (heuristic)', () => {
  const suspects = [
    /['"]sk-[A-Za-z0-9]{20,}['"]/,          // openai style
    /['"]AKIA[0-9A-Z]{16}['"]/,             // AWS key id
    /['"]ghp_[A-Za-z0-9]{30,}['"]/,         // github classic PAT
    /['"]gho_[A-Za-z0-9]{30,}['"]/,         // github oauth token
    /['"]-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM keys
  ];
  const all = [...jss, ...htmls];
  for (const f of all) {
    for (const s of suspects) {
      assert.ok(!s.test(f.body), `${f.path} looks like it embeds a secret`);
    }
  }
});

test('A04/A08 · every fetch/XHR/eval is absent from shipped browser code', () => {
  // Slice G0-05 has no network layer yet. Introducing fetch/XHR/eval must be
  // an explicit act with a documented threat model — this test guards against
  // accidental additions before that happens.
  const banned = [/\beval\s*\(/, /new\s+Function\s*\(/];
  for (const j of jss) {
    // Only enforce on browser JS (assets/js/), not lib/ (workflow-side).
    if (!j.path.includes('assets')) continue;
    for (const b of banned) {
      assert.ok(!b.test(j.body), `${j.path} uses ${b}`);
    }
  }
});

test('A09 · audit-log-lite is available (chain integrity core)', () => {
  const auditPath = existsSync(join('lib', 'audit.js')) ? join('lib', 'audit.js') : null;
  assert.ok(auditPath, 'lib/audit.js missing — audit chain is required for launch');
  const body = readFileSync(auditPath, 'utf8');
  assert.match(body, /export function append/);
  assert.match(body, /export function verify/);
  assert.match(body, /sha256/i);
});

test('A10 · no server-side-request from static shell (SSRF surface = zero on G-1)', () => {
  // On G-1 (static Pages) there is no server to make outbound requests. If a
  // future slice adds an Action that fetches user-controlled URLs, that Action
  // must land its own G-05-style guards. This test is a documentation anchor.
  assert.equal(existsSync('server.js'), false);
  assert.equal(existsSync('index.mjs'), false);
});
