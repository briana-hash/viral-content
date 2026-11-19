// Runs a scrape job: one Apify run per platform task, in parallel, then
// normalizes, dedupes, scores and buckets the videos into 30/60/90-day windows.
import crypto from 'node:crypto';
import { runActor } from './apify.mjs';
import { buildTasks, normalize, ageDays } from './platforms.mjs';
import { saveJob, getJob } from './store.mjs';

const list = v => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map(s => String(s).trim()).filter(Boolean);
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export function newJob(body) {
  const handles = obj => Object.fromEntries(['tiktok', 'instagram', 'facebook', 'youtube'].map(k => [k, list(obj?.[k])]));
  const job = {
    id: new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(3).toString('hex'),
    createdAt: new Date().toISOString(),
    brand: String(body.brand || '').trim() || 'Untitled campaign',
    campaignNotes: String(body.campaignNotes || '').trim(),
    keywords: list(body.keywords),
    hashtags: list(body.hashtags).map(h => h.replace(/^#/, '')),
    platforms: list(body.platforms).filter(p => ['tiktok', 'instagram', 'facebook', 'youtube'].includes(p)),
    brandHandles: handles(body.brandHandles),
    watchAccounts: handles(body.watchAccounts),
    windowDays: [30, 60, 90].includes(Number(body.windowDays)) ? Number(body.windowDays) : 90,
    perQuery: clampInt(body.perQuery, 5, 200, 30),
    brandPerAccount: clampInt(body.brandPerAccount, 5, 100, 30),
    status: 'queued',
    tasks: [],
    videos: [],
    report: null,
  };
  if (!job.platforms.length) job.platforms = ['tiktok', 'instagram', 'facebook', 'youtube'];
  job.tasks = buildTasks(job).map(t => ({ ...t, status: 'queued', count: 0, error: null }));
  if (!job.tasks.length) throw new Error('Nothing to scrape: add keywords, hashtags, brand handles or accounts to watch.');
  return job;
}

// Viral score (0–100): absolute reach, reach relative to the account's size
// (an "outlier" video from a small account is the strongest signal), and engagement.
export function score(v) {
  const views = v.views || 0;
  const interactions = (v.likes || 0) + (v.comments || 0) + (v.shares || 0) + (v.saves || 0);
  const er = views > 0 ? interactions / views : null;
  const outlier = views > 0 && v.authorFollowers ? views / Math.max(v.authorFollowers, 1000) : null;
  const age = ageDays(v.postedAt);
  const reach = Math.min(1, Math.log10(views + 1) / 7);                       // 10M views = full marks
  const out = outlier == null ? 0.4 : Math.min(1, Math.log2(outlier + 1) / 5); // 31x followers = full marks
  const eng = er == null ? 0.3 : Math.min(1, er / 0.12);                      // 12% engagement = full marks
  return {
    ...v,
    engagementRate: er,
    outlierRatio: outlier,
    ageDays: age == null ? null : Math.round(age),
    viewsPerDay: age ? Math.round(views / Math.max(age, 1)) : null,
    window: age == null ? null : age <= 30 ? 30 : age <= 60 ? 60 : age <= 90 ? 90 : null,
    viralScore: Math.round((reach * 0.5 + out * 0.3 + eng * 0.2) * 100),
  };
}

async function runTask(task) {
  try {
    return await runActor(task.actor, task.input);
  } catch (err) {
    if (task.fallbackInput && /input|sort/i.test(err.message)) return runActor(task.actor, task.fallbackInput);
    throw err;
  }
}

const running = new Set();
export const isRunning = id => running.has(id);

export async function runJob(job) {
  running.add(job.id);
  job.status = 'running';
  await saveJob(job);
  const byId = new Map();
  let costUsd = 0;
  // Save progress serially so concurrent task completions don't race on the file.
  let saving = Promise.resolve();
  const persist = () => (saving = saving.then(() => saveJob(job)));

  await Promise.all(job.tasks.map(async task => {
    task.status = 'running';
    persist();
    try {
      const { items, runId, costUsd: c } = await runTask(task);
      costUsd += c || 0;
      task.runId = runId;
      let kept = 0;
      for (const item of items) {
        const v = normalize(task.platform, item);
        if (!v) continue;
        kept++;
        const prev = byId.get(v.id);
        const sources = new Set([...(prev?.sources || []), task.kind]);
        byId.set(v.id, { ...(prev || {}), ...v, sources: [...sources], isBrand: sources.has('brand') });
      }
      task.count = kept;
      task.raw = items.length;
      task.status = 'done';
    } catch (err) {
      task.status = 'error';
      task.error = err.message;
    }
    persist();
  }));

  const videos = [...byId.values()].map(score).filter(v =>
    // Brand videos are kept regardless of age (they're the "what worked before" set);
    // everything else must fall inside the selected window.
    v.isBrand || (v.window != null && v.window <= job.windowDays));
  videos.sort((a, b) => b.viralScore - a.viralScore);
  job.videos = videos;
  job.costUsd = Math.round(costUsd * 100) / 100;
  job.status = job.tasks.every(t => t.status === 'error') ? 'error' : 'done';
  job.finishedAt = new Date().toISOString();
  await saving;
  await saveJob(job);
  running.delete(job.id);
  return job;
}

// On server restart, any job left "running" can't resume — mark it so the UI can rerun it.
export async function markStale(id) {
  const job = await getJob(id);
  if (job && job.status === 'running' && !running.has(id)) {
    job.status = 'interrupted';
    await saveJob(job);
  }
  return job;
}
