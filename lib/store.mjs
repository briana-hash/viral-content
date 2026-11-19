// Tiny JSON-file store under data/. One file per job; breakdowns cached per video.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA } from './config.mjs';

const safe = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, file);
}

export const jobFile = id => path.join(DATA, 'jobs', safe(id) + '.json');
export const getJob = id => readJson(jobFile(id));
export const saveJob = job => writeJson(jobFile(job.id), job);

export async function listJobs() {
  const dir = path.join(DATA, 'jobs');
  let names = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  const jobs = await Promise.all(names.filter(n => n.endsWith('.json')).map(n => readJson(path.join(dir, n))));
  return jobs.filter(Boolean)
    .map(({ id, brand, createdAt, status, windowDays, videos, report }) => ({
      id, brand, createdAt, status, windowDays, videoCount: videos?.length || 0, hasReport: Boolean(report),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const breakdownFile = key => path.join(DATA, 'breakdowns', safe(key) + '.json');
export const getBreakdown = key => readJson(breakdownFile(key));
export const saveBreakdown = (key, b) => writeJson(breakdownFile(key), b);

export const mediaDir = key => path.join(DATA, 'media', safe(key));
