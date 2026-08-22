#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const featuresPath = path.join(root, 'config', 'features.json');
const tracePath = path.join(root, 'config', 'feature-traceability.json');

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

function safeRead(file) {
  return fs.readFileSync(file, 'utf8');
}

function classify(refs) {
  if (refs >= 3) return 'wired';
  if (refs >= 1) return 'partial';
  return 'unwired';
}

function main() {
  if (!fs.existsSync(featuresPath)) {
    console.error('config/features.json not found');
    process.exit(1);
  }

  const cfg = JSON.parse(safeRead(featuresPath));
  const traceCfg = fs.existsSync(tracePath) ? JSON.parse(safeRead(tracePath)) : {};
  const mustLive = new Set(Array.isArray(traceCfg.must_live) ? traceCfg.must_live.map(String) : []);
  const featureFiles = traceCfg.feature_files && typeof traceCfg.feature_files === 'object'
    ? traceCfg.feature_files
    : {};
  const featureRows = Array.isArray(cfg.features) ? cfg.features : [];
  const allJsFiles = walk(path.join(root, 'assets', 'js')).filter(f => f.endsWith('.js'));

  const rows = featureRows.map((f) => {
    const id = String(f.id || '');
    const mappedFiles = Array.isArray(featureFiles[id])
      ? featureFiles[id].map(p => path.join(root, String(p))).filter(fs.existsSync)
      : [];
    const scanFiles = mappedFiles.length ? mappedFiles : allJsFiles;
    let refs = 0;
    for (const file of scanFiles) {
      const text = safeRead(file);
      if (text.includes(id)) refs += 1;
    }
    return {
      id,
      scope: String(f.scope || ''),
      default: !!f.default,
      mustLive: mustLive.has(id),
      mapped: mappedFiles.map(rel),
      refs,
      status: classify(refs),
    };
  });

  const totals = {
    total: rows.length,
    wired: rows.filter(r => r.status === 'wired').length,
    partial: rows.filter(r => r.status === 'partial').length,
    unwired: rows.filter(r => r.status === 'unwired').length,
    defaultOnUnwired: rows.filter(r => r.status === 'unwired' && r.default).length,
    mustLiveUnwired: rows.filter(r => r.mustLive && r.status === 'unwired').length,
  };

  let md = '';
  md += '# Feature Coverage Audit\n\n';
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `- Total features: ${totals.total}\n`;
  md += `- Wired: ${totals.wired}\n`;
  md += `- Partial: ${totals.partial}\n`;
  md += `- Unwired: ${totals.unwired}\n`;
  md += `- Default-ON but unwired: ${totals.defaultOnUnwired}\n\n`;
  md += `- Must-live but unwired: ${totals.mustLiveUnwired}\n\n`;

  md += '| Feature ID | Scope | Default | Must-live | JS refs | Status |\n';
  md += '|---|---|---:|---:|---:|---|\n';
  for (const r of rows) {
    md += `| ${r.id} | ${r.scope} | ${r.default ? 'on' : 'off'} | ${r.mustLive ? 'yes' : 'no'} | ${r.refs} | ${r.status} |\n`;
  }

  const outDir = path.join(root, 'temp');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'feature-audit.md');
  fs.writeFileSync(outFile, md, 'utf8');

  console.log(md);
  console.log(`\nSaved audit: ${rel(outFile)}`);

  const broken = rows.filter(r => r.mustLive && r.status === 'unwired').map(r => r.id);
  if (broken.length) {
    console.error(`\nMust-live features are unwired: ${broken.join(', ')}`);
    process.exit(1);
  }
}

main();
