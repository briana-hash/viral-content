// Loads .env (if present) into process.env and exposes paths and settings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');

for (const name of ['.env', '.env.local']) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

export const config = {
  port: Number(process.env.PORT) || 3020,
  apifyToken: process.env.APIFY_TOKEN || '',
  elevenLabsKey: process.env.ELEVENLABS_API_KEY || '',
  model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
};

export function status() {
  return {
    apify: Boolean(config.apifyToken),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    transcription: Boolean(config.elevenLabsKey),
    model: config.model,
  };
}
