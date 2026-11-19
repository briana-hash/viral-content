// Minimal Apify REST client: start an actor run, wait for it, read its dataset.
import { config } from './config.mjs';

const API = 'https://api.apify.com/v2';

async function call(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${config.apifyToken}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.text();
  if (!res.ok) {
    let msg = body;
    try { msg = JSON.parse(body).error?.message || body; } catch {}
    throw new Error(`Apify ${res.status}: ${msg.slice(0, 300)}`);
  }
  return body ? JSON.parse(body) : null;
}

// Runs an actor (e.g. "clockworks~tiktok-scraper") and returns its dataset items.
// Polls instead of using run-sync so long scrapes (> 5 min) still finish.
export async function runActor(actorId, input, { timeoutSecs = 900, maxItems } = {}) {
  if (!config.apifyToken) throw new Error('APIFY_TOKEN is not set. Add it to .env (see .env.example).');
  const qs = new URLSearchParams({ timeout: String(timeoutSecs) });
  if (maxItems) qs.set('maxItems', String(maxItems));
  const { data: run } = await call(`${API}/acts/${actorId}/runs?${qs}`, { method: 'POST', body: JSON.stringify(input) });

  const deadline = Date.now() + (timeoutSecs + 60) * 1000;
  let current = run;
  while (['READY', 'RUNNING'].includes(current.status)) {
    if (Date.now() > deadline) throw new Error(`${actorId} timed out`);
    await new Promise(r => setTimeout(r, 4000));
    ({ data: current } = await call(`${API}/actor-runs/${run.id}?waitForFinish=30`));
  }
  if (current.status !== 'SUCCEEDED') {
    throw new Error(`${actorId} run ${current.status.toLowerCase()} (run ${run.id})`);
  }
  const items = await call(`${API}/datasets/${current.defaultDatasetId}/items?clean=true&format=json`);
  return { items: Array.isArray(items) ? items : [], runId: run.id, costUsd: current.usageTotalUsd ?? null };
}
