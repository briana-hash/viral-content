// Gets a video file onto disk, then pulls out what Claude needs to "watch" it:
// key frames (dense in the first 3 seconds, where the hook lives) and a timed transcript.
import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.mjs';
import { runActor } from './apify.mjs';
import { mediaDir } from './store.mjs';

const exec = promisify(execFile);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function has(bin) {
  try { await exec('which', [bin]); return true; } catch { return false; }
}

async function download(url, dest, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (/text\/html|application\/json/.test(type)) throw new Error('got a web page, not a video');
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const { size } = await fs.stat(dest);
  if (size < 20_000) throw new Error('file too small to be a video');
  return dest;
}

// Asks the platform's Apify actor to store a copy of this one video, then downloads it.
async function viaApify(v, dest) {
  let input, actor, pick;
  if (v.platform === 'tiktok') {
    actor = 'clockworks~tiktok-scraper';
    input = { postURLs: [v.url], shouldDownloadVideos: true, resultsPerPage: 1 };
    pick = it => it.mediaUrls?.[0];
  } else if (v.platform === 'instagram') {
    actor = 'apify~instagram-reel-scraper';
    input = { username: [v.url], includeDownloadedVideo: true, resultsLimit: 1 };
    pick = it => it.downloadedVideo || it.videoUrl;
  } else {
    return null;
  }
  const { items } = await runActor(actor, input, { timeoutSecs: 300 });
  const url = items.map(pick).find(Boolean);
  if (!url) throw new Error('Apify returned no video file');
  return download(url, dest, url.includes('api.apify.com') ? { Authorization: `Bearer ${config.apifyToken}` } : {});
}

// Tries, in order: yt-dlp (if installed), the direct video URL from the scrape, then Apify's downloader.
export async function fetchVideo(v) {
  const dir = mediaDir(v.id);
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, 'video.mp4');
  if (existsSync(dest)) return { file: dest, via: 'cache' };
  const errors = [];

  if (await has('yt-dlp')) {
    try {
      await exec('yt-dlp', ['-q', '--no-playlist', '-f', 'b[height<=720][ext=mp4]/bv*[height<=720]+ba/b', '--merge-output-format', 'mp4', '-o', dest, v.url], { timeout: 180_000 });
      if (existsSync(dest)) return { file: dest, via: 'yt-dlp' };
    } catch (e) { errors.push('yt-dlp: ' + (e.stderr || e.message).toString().split('\n')[0]); }
  }
  if (v.videoUrl) {
    try {
      return { file: await download(v.videoUrl, dest, v.platform === 'tiktok' ? { Referer: 'https://www.tiktok.com/' } : {}), via: 'direct' };
    } catch (e) { errors.push('direct: ' + e.message); }
  }
  try {
    const f = await viaApify(v, dest);
    if (f) return { file: f, via: 'apify' };
  } catch (e) { errors.push('apify: ' + e.message); }
  await fs.rm(dest, { force: true });
  return { file: null, errors };
}

async function probeDuration(file) {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    return parseFloat(stdout) || null;
  } catch { return null; }
}

// Hook frames at 0–3s, then evenly spaced through the rest. Returns [{t, file}].
export async function extractFrames(file, maxFrames = 14) {
  const duration = (await probeDuration(file)) || 30;
  const hook = [0.1, 0.7, 1.4, 2.2, 3.0].filter(t => t < duration);
  const restCount = Math.max(0, maxFrames - hook.length);
  const rest = [];
  const start = Math.min(4, duration);
  for (let i = 0; i < restCount; i++) {
    const t = start + ((duration - start) * (i + 0.5)) / restCount;
    if (t < duration - 0.1) rest.push(Math.round(t * 10) / 10);
  }
  const dir = path.join(path.dirname(file), 'frames');
  await fs.mkdir(dir, { recursive: true });
  const frames = [];
  for (const t of [...hook, ...rest]) {
    const out = path.join(dir, `f_${t.toFixed(1)}.jpg`);
    if (!existsSync(out)) {
      try {
        await exec('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', "scale='min(540,iw)':-2", '-q:v', '5', out]);
      } catch { continue; }
    }
    if (existsSync(out)) frames.push({ t, file: out });
  }
  return { duration, frames };
}

// ElevenLabs Scribe → lines like "[0.0s] Stop scrolling if you…"
export async function transcribe(file) {
  if (!config.elevenLabsKey) return null;
  const cache = path.join(path.dirname(file), 'transcript.txt');
  if (existsSync(cache)) return fs.readFile(cache, 'utf8');
  const audio = path.join(path.dirname(file), 'audio.mp3');
  try {
    await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', audio]);
  } catch { return null; } // no audio track
  const form = new FormData();
  form.append('model_id', 'scribe_v1');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'true');
  form.append('file', new Blob([await fs.readFile(audio)], { type: 'audio/mpeg' }), 'audio.mp3');
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': config.elevenLabsKey }, body: form });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const lines = [];
  let cur = null;
  for (const w of data.words || []) {
    if (w.type === 'spacing') { if (cur) cur.text += ' '; continue; }
    if (!cur) cur = { start: w.start, text: '' };
    cur.text += w.text;
    if (/[.!?]$/.test(w.text) || w.end - cur.start > 6) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  const text = lines.map(l => `[${(l.start ?? 0).toFixed(1)}s] ${l.text.trim().replace(/\s+/g, ' ')}`).join('\n') || (data.text || '').trim();
  await fs.writeFile(cache, text);
  return text;
}

// TikTok exposes WebVTT captions; turn them into the same "[t] text" lines.
export async function fetchSubtitles(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/' } });
    if (!res.ok) return null;
    const vtt = await res.text();
    const out = [];
    for (const block of vtt.split(/\n\n+/)) {
      const m = block.match(/(\d+):(\d+):([\d.]+)\s+-->.*\n([\s\S]+)/) || block.match(/(\d+):([\d.]+)\s+-->.*\n([\s\S]+)/);
      if (!m) continue;
      const secs = m.length === 5 ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
      out.push(`[${secs.toFixed(1)}s] ${(m.length === 5 ? m[4] : m[3]).replace(/\s+/g, ' ').trim()}`);
    }
    return out.join('\n') || null;
  } catch { return null; }
}

export async function imageFromUrl(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    return { media_type: type, data: Buffer.from(await res.arrayBuffer()).toString('base64') };
  } catch { return null; }
}
