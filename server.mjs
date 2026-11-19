// Local dashboard server.  Usage: npm run dev  →  http://localhost:3020
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, config, status } from './lib/config.mjs';
import { newJob, runJob, markStale } from './lib/jobs.mjs';
import { getJob, saveJob, listJobs, getBreakdown } from './lib/store.mjs';
import { analyzeVideo, strategyReport } from './lib/analyze.mjs';

const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = async req => {
  let raw = '';
  for await (const ch of req) raw += ch;
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
};

function campaignText(job) {
  return [`Brand: ${job.brand}`, job.campaignNotes && `Notes: ${job.campaignNotes}`, job.keywords.length && `Keywords: ${job.keywords.join(', ')}`].filter(Boolean).join('\n');
}

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const routes = [
  ['GET', /^\/api\/status$/, async () => status()],
  ['GET', /^\/api\/jobs$/, async () => listJobs()],
  ['POST', /^\/api\/jobs$/, async (req) => {
    const job = newJob(await readBody(req));
    await saveJob(job);
    runJob(job).catch(err => console.error('job failed', job.id, err));
    return { id: job.id };
  }],
  ['GET', /^\/api\/jobs\/([\w-]+)$/, async (req, m) => {
    const job = await markStale(m[1]);
    if (!job) throw Object.assign(new Error('Job not found'), { status: 404 });
    // Attach which videos already have breakdowns so the UI can mark them.
    const analyzed = await Promise.all(job.videos.map(v => getBreakdown(v.id).then(Boolean)));
    job.videos.forEach((v, i) => { v.analyzed = analyzed[i]; });
    return job;
  }],
  ['POST', /^\/api\/jobs\/([\w-]+)\/rerun$/, async (req, m) => {
    const old = await getJob(m[1]);
    if (!old) throw Object.assign(new Error('Job not found'), { status: 404 });
    const job = newJob(old);
    await saveJob(job);
    runJob(job).catch(err => console.error('job failed', job.id, err));
    return { id: job.id };
  }],
  ['POST', /^\/api\/jobs\/([\w-]+)\/analyze$/, async (req, m) => {
    const { videoId, force } = await readBody(req);
    const job = await getJob(m[1]);
    const v = job?.videos.find(x => x.id === videoId);
    if (!v) throw Object.assign(new Error('Video not found in this job'), { status: 404 });
    return analyzeVideo(v, { campaign: campaignText(job), force: Boolean(force) });
  }],
  ['GET', /^\/api\/breakdowns\/(.+)$/, async (req, m) => {
    const b = await getBreakdown(decodeURIComponent(m[1]));
    if (!b) throw Object.assign(new Error('No breakdown yet'), { status: 404 });
    return b;
  }],
  ['POST', /^\/api\/jobs\/([\w-]+)\/report$/, async (req, m) => {
    const { videoIds } = await readBody(req);
    const job = await getJob(m[1]);
    if (!job) throw Object.assign(new Error('Job not found'), { status: 404 });
    let videos = videoIds?.length ? job.videos.filter(v => videoIds.includes(v.id)) : [];
    if (!videos.length) {
      // Default: every analyzed video, plus the top 15 by score for context.
      const analyzed = (await Promise.all(job.videos.map(async v => ((await getBreakdown(v.id)) ? v : null)))).filter(Boolean);
      const top = job.videos.slice(0, 15);
      videos = [...new Map([...analyzed, ...top].map(v => [v.id, v])).values()];
    }
    if (!videos.length) throw Object.assign(new Error('No videos to report on yet'), { status: 400 });
    const items = await Promise.all(videos.map(async v => ({ video: v, breakdown: await getBreakdown(v.id) })));
    job.report = await strategyReport(job, items);
    await saveJob(job);
    return job.report;
  }],
  ['GET', /^\/api\/jobs\/([\w-]+)\/export\.csv$/, async (req, m, res) => {
    const job = await getJob(m[1]);
    if (!job) throw Object.assign(new Error('Job not found'), { status: 404 });
    const cols = ['viralScore', 'platform', 'author', 'isBrand', 'url', 'postedAt', 'ageDays', 'window', 'views', 'likes', 'comments', 'shares', 'saves', 'engagementRate', 'outlierRatio', 'authorFollowers', 'durationSec', 'sound', 'caption'];
    const rows = [cols.join(','), ...job.videos.map(v => cols.map(c => csvCell(v[c])).join(','))];
    res.setHeader('content-disposition', `attachment; filename="${job.brand.replace(/[^\w-]+/g, '-')}-${job.id}.csv"`);
    send(res, 200, rows.join('\n'), 'text/csv; charset=utf-8');
    return undefined;
  }],
];

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) return send(res, 404, { error: 'Not found' });
    try {
      const out = await route[2](req, url.pathname.match(route[1]), res);
      if (out !== undefined) send(res, 200, out);
    } catch (err) {
      console.error(req.method, url.pathname, err.message);
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
    }
    return;
  }
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 404, 'Not found', 'text/plain');
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}).listen(config.port, '127.0.0.1', () => {
  const s = status();
  console.log(`Viral Content Scraper → http://localhost:${config.port}`);
  if (!s.apify) console.log('  ! APIFY_TOKEN is not set — scraping will fail until you add it to .env');
  if (!s.anthropic) console.log('  ! ANTHROPIC_API_KEY is not set — breakdowns need it (or an `ant auth login` profile)');
  if (!s.transcription) console.log('  · ELEVENLABS_API_KEY not set — breakdowns will use platform captions instead of transcribing audio');
});
