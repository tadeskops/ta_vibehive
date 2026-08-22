#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.cwd();

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function rel(p) {
  return path.relative(root, p).replace(/\\/g, '/');
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exitCode = 1;
}

function warn(msg) {
  console.warn(`WARN: ${msg}`);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function ensureFiles() {
  const required = ['index.html', '404.html', 'manifest.webmanifest', 'assets/js/app.js'];
  for (const p of required) {
    const full = path.join(root, p);
    if (!fs.existsSync(full)) fail(`missing required file ${p}`);
  }
}

function checkJson() {
  const targets = [
    ...walk(path.join(root, 'config')).filter(p => p.endsWith('.json')),
    path.join(root, 'manifest.webmanifest'),
  ].filter(p => fs.existsSync(p));

  for (const file of targets) {
    try {
      JSON.parse(read(file));
    } catch (err) {
      fail(`invalid JSON in ${rel(file)}: ${err.message}`);
    }
  }
}

function checkHtmlSecurity() {
  const files = [path.join(root, 'index.html'), path.join(root, '404.html')].filter(fs.existsSync);
  const requiredMetas = [
    'Content-Security-Policy',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Permissions-Policy',
  ];

  for (const file of files) {
    const t = read(file);
    for (const meta of requiredMetas) {
      if (!t.includes(meta)) fail(`${rel(file)} missing ${meta} meta`);
    }

    const cspMatch = t.match(/Content-Security-Policy"\s+content="([^"]+)"/i);
    if (!cspMatch) {
      fail(`${rel(file)} missing CSP content`);
      continue;
    }
    const csp = cspMatch[1];
    if (!/default-src\s+'self'/.test(csp)) fail(`${rel(file)} CSP missing default-src 'self'`);
    if (!/frame-ancestors\s+'none'/.test(csp)) fail(`${rel(file)} CSP missing frame-ancestors 'none'`);
    if (/unsafe-eval/.test(csp)) fail(`${rel(file)} CSP contains unsafe-eval`);
    const scriptSrc = (csp.match(/script-src\s+([^;]+)/) || [null, ''])[1];
    if (/unsafe-inline/.test(scriptSrc)) fail(`${rel(file)} script-src contains unsafe-inline`);
  }
}

function checkNoInlineJs() {
  const htmlFiles = walk(root)
    .filter(p => p.endsWith('.html'))
    .filter(p => !rel(p).startsWith('.history/'))
    .filter(p => !rel(p).startsWith('temp/'));

  const handlerRe = /\son(?:click|load|error|submit|change|input|mouseover|focus|blur|keydown|keyup)\s*=/i;
  const inlineScriptRe = /<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi;

  for (const file of htmlFiles) {
    const t = read(file);
    if (handlerRe.test(t)) fail(`${rel(file)} has inline JS event handler`);
    const scripts = t.match(inlineScriptRe) || [];
    for (const s of scripts) {
      const body = s.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
      if (body.length > 0) fail(`${rel(file)} has inline script body`);
    }
  }
}

function checkJsSyntax() {
  const jsFiles = walk(path.join(root, 'assets', 'js')).filter(p => p.endsWith('.js'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tvh-syntax-'));
  for (const file of jsFiles) {
    const tmpFile = path.join(tmpRoot, rel(file).replace(/\//g, '__') + '.mjs');
    fs.writeFileSync(tmpFile, read(file), 'utf8');
    try {
      const out = spawnSync(process.execPath, ['--check', tmpFile], { encoding: 'utf8' });
      if (out.status !== 0) {
        fail(`syntax parse failed in ${rel(file)}: ${(out.stderr || out.stdout || '').trim()}`);
      }
    } catch (err) {
      fail(`syntax parse failed in ${rel(file)}: ${err.message}`);
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function checkDomSinks() {
  const files = walk(path.join(root, 'assets', 'js')).filter(p => p.endsWith('.js'));
  const hardFail = [
    /document\.write\s*\(/g,
    /\beval\s*\(/g,
    /new\s+Function\s*\(/g,
    /innerHTML\s*=/g,
    /outerHTML\s*=/g,
  ];

  for (const file of files) {
    const t = read(file);
    for (const re of hardFail) {
      if (re.test(t)) fail(`${rel(file)} contains forbidden sink ${re}`);
    }
  }
}

function checkBudget() {
  const cssFile = path.join(root, 'assets', 'css', 'base.css');
  if (!fs.existsSync(cssFile)) return;
  const cssBytes = Buffer.byteLength(read(cssFile), 'utf8');
  if (cssBytes > 220000) {
    fail(`assets/css/base.css is too large (${cssBytes} bytes)`);
  }
}

function main() {
  ensureFiles();
  checkJson();
  checkHtmlSecurity();
  checkNoInlineJs();
  checkJsSyntax();
  checkDomSinks();
  checkBudget();

  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
  console.log('CI verify: all blocking checks passed.');
}

main();
