#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.github.com';
const root = process.cwd();

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return fallback;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function parseRepo(ref) {
  const m = String(ref || '').trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function nowParts(timezone) {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const bag = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {
    iso: d.toISOString(),
    year: bag.year,
    month: bag.month,
    day: bag.day,
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second),
    hourText: bag.hour,
    minuteText: bag.minute,
    secondText: bag.second,
  };
}

function shouldRun(schedule, hourNow, force) {
  if (force) return true;
  if (!schedule || schedule.enabled === false) return false;
  const hours = Array.isArray(schedule.run_hours_local)
    ? schedule.run_hours_local.map(x => Number(x)).filter(x => Number.isInteger(x) && x >= 0 && x <= 23)
    : [6, 14, 22];
  return hours.includes(hourNow);
}

async function gh(token, method, urlPath) {
  const res = await fetch(API + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} ${urlPath}: ${t.slice(0, 220)}`);
  }
  return res.json();
}

function decodeB64Utf8(s) {
  return Buffer.from(String(s || '').replace(/\n/g, ''), 'base64').toString('utf8');
}

async function fetchRepoJsonBlobs(token, owner, repo, branch) {
  const tree = await gh(token, 'GET', `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const blobs = Array.isArray(tree.tree) ? tree.tree.filter(n => n && n.type === 'blob' && String(n.path || '').endsWith('.json')) : [];

  const eventNodes = blobs.filter(n => String(n.path).startsWith('events/') && String(n.path).endsWith('/event.json'));
  const skipPrefixes = ['events/', 'history/', 'reports/', 'settings/', 'archive/'];
  const receiptCandidates = blobs.filter(n => !skipPrefixes.some(p => String(n.path).startsWith(p)));

  const fetchBlobJson = async (node) => {
    const blob = await gh(token, 'GET', `/repos/${owner}/${repo}/git/blobs/${node.sha}`);
    const text = decodeB64Utf8(blob.content || '');
    try {
      return JSON.parse(text);
    } catch (_e) {
      return null;
    }
  };

  const events = [];
  for (const n of eventNodes) {
    const j = await fetchBlobJson(n);
    if (!j || !j.id) continue;
    events.push({ path: n.path, data: j });
  }

  const receipts = [];
  for (const n of receiptCandidates) {
    const j = await fetchBlobJson(n);
    if (!j || !j.receipt || !j.contribution) continue;
    receipts.push({ path: n.path, data: j });
  }

  return { events, receipts };
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildReport(events, receipts, opts = {}) {
  const live = events.filter(e => String(e.data.status || '').toLowerCase() === 'published');
  const liveById = new Map(live.map(e => [e.data.id, e]));
  const maxRows = Number(opts.maxRowsPerEvent || 5000);

  const grouped = new Map();
  for (const r of receipts) {
    const c = r.data.contribution || {};
    const eventId = c.event;
    if (!liveById.has(eventId)) continue;
    if (!grouped.has(eventId)) grouped.set(eventId, []);
    const bucket = grouped.get(eventId);
    if (bucket.length < maxRows) bucket.push({ ...r.data, _path: r.path });
  }

  const summaries = [];
  const allRows = [];
  for (const [eventId, rows] of grouped.entries()) {
    const evt = liveById.get(eventId)?.data || {};
    const verified = rows.filter(r => String((r.contribution || {}).status || '').toLowerCase() === 'verified');
    const total = verified.reduce((s, r) => s + toNumber((r.contribution || {}).amount), 0);
    const contributors = new Set(verified.map(r => String((r.contribution || {}).contributor || '')));
    const latest = verified
      .map(r => String((r.contribution || {}).verified_at || (r.contribution || {}).created_at || ''))
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || '';

    summaries.push({
      event_id: eventId,
      event_title: String(evt.title || eventId),
      goal: toNumber(evt.goal),
      verified_count: verified.length,
      unique_contributors: contributors.size,
      verified_total: total,
      latest_verified_at: latest,
      status: String(evt.status || ''),
    });

    rows.forEach((row) => {
      const c = row.contribution || {};
      const rc = row.receipt || {};
      allRows.push({
        event_id: eventId,
        event_title: String(evt.title || eventId),
        receipt_id: String(rc.id || ''),
        contribution_id: String(c.id || ''),
        flat: String(c.flat || ''),
        amount: toNumber(c.amount),
        status: String(c.status || ''),
        verified_at: String(c.verified_at || ''),
        issued_at: String(rc.issued_at || ''),
        source_path: String(row._path || ''),
      });
    });
  }

  summaries.sort((a, b) => b.verified_total - a.verified_total);
  allRows.sort((a, b) => String(b.verified_at || '').localeCompare(String(a.verified_at || '')));

  const totals = {
    live_event_count: live.length,
    covered_live_events: summaries.length,
    verified_total_all_live_events: summaries.reduce((s, x) => s + x.verified_total, 0),
    verified_rows_all_live_events: summaries.reduce((s, x) => s + x.verified_count, 0),
  };

  return { summaries, allRows, totals };
}

function buildMarkdown(meta, report) {
  const lines = [];
  lines.push('# Live Event Contribution Report');
  lines.push('');
  lines.push(`Generated: ${meta.generated_at_utc}`);
  lines.push(`Timezone: ${meta.timezone}`);
  lines.push(`Archive repo: ${meta.archive_repo}`);
  lines.push('');
  lines.push(`- Live events discovered: ${report.totals.live_event_count}`);
  lines.push(`- Live events with receipt contributions: ${report.totals.covered_live_events}`);
  lines.push(`- Verified contribution rows: ${report.totals.verified_rows_all_live_events}`);
  lines.push(`- Verified total amount: ₹${report.totals.verified_total_all_live_events.toLocaleString('en-IN')}`);
  lines.push('');
  lines.push('## Event summary');
  lines.push('');
  lines.push('| Event | Verified rows | Unique contributors | Verified total | Goal | Latest verified |');
  lines.push('|---|---:|---:|---:|---:|---|');
  if (!report.summaries.length) {
    lines.push('| (none) | 0 | 0 | 0 | 0 | — |');
  } else {
    for (const r of report.summaries) {
      lines.push(`| ${r.event_title} | ${r.verified_count} | ${r.unique_contributors} | ₹${r.verified_total.toLocaleString('en-IN')} | ₹${r.goal.toLocaleString('en-IN')} | ${r.latest_verified_at || '—'} |`);
    }
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- This cron report is computed from receipt archive entries (verified contributions).');
  lines.push('- Pending contributions without minted receipts are not part of this scheduled snapshot.');
  return lines.join('\n') + '\n';
}

function buildCsv(rows) {
  const head = ['event_id', 'event_title', 'receipt_id', 'contribution_id', 'flat', 'amount', 'status', 'verified_at', 'issued_at', 'source_path'];
  const out = [head.join(',')];
  for (const r of rows) {
    out.push([
      r.event_id,
      r.event_title,
      r.receipt_id,
      r.contribution_id,
      r.flat,
      r.amount,
      r.status,
      r.verified_at,
      r.issued_at,
      r.source_path,
    ].map(csvEscape).join(','));
  }
  return out.join('\n') + '\n';
}

async function main() {
  const force = String(process.env.FORCE_RUN || '').toLowerCase() === 'true';
  const mode = String(process.env.GITHUB_EVENT_NAME || 'manual');

  const schedule = readJson(path.join(root, 'config', 'reports-cron.json'), {
    enabled: true,
    timezone: 'Asia/Kolkata',
    run_hours_local: [6, 14, 22],
    output: { dir: 'docs/ops/live-reports', write_latest: true },
    report: { max_rows_per_event: 5000 },
  });
  const timezone = String(schedule.timezone || 'Asia/Kolkata');
  const now = nowParts(timezone);

  if (mode === 'schedule' && !shouldRun(schedule, now.hour, force)) {
    console.log(`Skip: current local hour ${now.hour} not in run_hours_local`);
    return;
  }

  if (schedule.enabled === false && !force) {
    console.log('Skip: reports-cron disabled in config/reports-cron.json');
    return;
  }

  const soc = readJson(path.join(root, 'config', 'society.json'));
  if (!soc || !soc.receipts) throw new Error('config/society.json is missing receipts configuration');
  const repoRef = parseRepo(soc.receipts.archive_repo);
  if (!repoRef) throw new Error('receipts.archive_repo must be owner/repo');
  const branch = String(soc.receipts.archive_branch || 'main');

  const token = String(process.env.TVH_ARCHIVE_PAT || process.env.ARCHIVE_PAT || '').trim();
  if (!token) throw new Error('Missing TVH_ARCHIVE_PAT secret/environment variable');

  const { events, receipts } = await fetchRepoJsonBlobs(token, repoRef.owner, repoRef.repo, branch);
  const report = buildReport(events, receipts, schedule.report || {});

  const outputDirRel = String((schedule.output && schedule.output.dir) || 'docs/ops/live-reports');
  const outputDirAbs = path.join(root, outputDirRel);
  ensureDir(outputDirAbs);

  const stamp = `${now.year}-${now.month}-${now.day}_${now.hourText}${now.minuteText}`;
  const base = `live-events-${stamp}`;

  const meta = {
    generated_at_utc: now.iso,
    timezone,
    archive_repo: `${repoRef.owner}/${repoRef.repo}`,
    archive_branch: branch,
    schedule_hours_local: Array.isArray(schedule.run_hours_local) ? schedule.run_hours_local : [6, 14, 22],
  };

  const md = buildMarkdown(meta, report);
  const json = JSON.stringify({ meta, report }, null, 2) + '\n';
  const csv = buildCsv(report.allRows);

  fs.writeFileSync(path.join(outputDirAbs, `${base}.md`), md, 'utf8');
  fs.writeFileSync(path.join(outputDirAbs, `${base}.json`), json, 'utf8');
  fs.writeFileSync(path.join(outputDirAbs, `${base}.csv`), csv, 'utf8');

  if (!schedule.output || schedule.output.write_latest !== false) {
    fs.writeFileSync(path.join(outputDirAbs, 'latest.md'), md, 'utf8');
    fs.writeFileSync(path.join(outputDirAbs, 'latest.json'), json, 'utf8');
    fs.writeFileSync(path.join(outputDirAbs, 'latest.csv'), csv, 'utf8');
  }

  console.log(`Report generated: ${outputDirRel}/${base}.{md,json,csv}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
