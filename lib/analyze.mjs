// Claude breakdowns: one structured analysis per video, plus a campaign strategy
// report that synthesizes every breakdown in a job.
import fs from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { config } from './config.mjs';
import { fetchVideo, extractFrames, transcribe, fetchSubtitles, imageFromUrl } from './media.mjs';
import { getBreakdown, saveBreakdown } from './store.mjs';

const client = new Anthropic();

const Breakdown = z.object({
  summary: z.string().describe('One or two sentences: what happens in the video.'),
  format: z.string().describe('Content format, e.g. "POV skit", "talking-head storytime", "GRWM", "product demo", "green-screen reaction", "street interview".'),
  hook: z.object({
    verbatim: z.string().describe('The exact words spoken or shown on screen in the first ~3 seconds. Empty string if none.'),
    visual: z.string().describe('What the viewer SEES in the first ~3 seconds.'),
    type: z.string().describe('Hook archetype, e.g. "curiosity gap", "bold claim", "negative/warning", "relatable pain point", "pattern interrupt", "result first", "question", "list promise".'),
    whyItStopsTheScroll: z.string(),
    template: z.string().describe('A reusable fill-in-the-blank version of the hook, e.g. "I tried [X] for [time] so you don\'t have to".'),
  }),
  structure: z.array(z.object({
    time: z.string().describe('Approximate timestamp range, e.g. "0–3s".'),
    beat: z.string().describe('Short label, e.g. "Hook", "Setup", "Twist", "Payoff", "CTA".'),
    whatHappens: z.string(),
  })).describe('The beat-by-beat structure of the video.'),
  whyItWorks: z.array(z.string()).describe('3–6 specific reasons this video performed, grounded in what is in the video and its metrics.'),
  retentionTactics: z.array(z.string()).describe('Pacing, cuts, open loops, on-screen text, payoff timing, etc.'),
  visualStyle: z.string().describe('Filming setup, framing, lighting, editing style, text overlays, production level.'),
  audio: z.string().describe('Voiceover / trending sound / original audio, and how audio supports the video.'),
  onScreenText: z.array(z.string()).describe('Key on-screen text overlays, in order.'),
  cta: z.string().describe('The call to action, explicit or implied. Empty string if none.'),
  emotionalTriggers: z.array(z.string()),
  engagementDrivers: z.string().describe('What likely drove comments/shares/saves specifically.'),
  brandIntegration: z.string().describe('How a brand or product appears (or how one could be integrated naturally if none appears).'),
  replicability: z.object({
    score: z.number().int().min(1).max(5).describe('1 = hard to replicate (celebrity, luck, huge budget), 5 = any creator can do this.'),
    howToAdapt: z.string().describe('How a creator could adapt this for the campaign brand.'),
  }),
  confidence: z.enum(['high', 'medium', 'low']).describe('high = full video frames and transcript available; low = only thumbnail/caption.'),
});

const SYSTEM = `You are a senior short-form video strategist at SideShift, a creator marketing platform. Your breakdowns are used to brief creators for brand campaigns, so they must be specific and usable: quote real words, name real visual moments, and tie claims to what is actually in the frames, transcript and metrics. Do not invent details you cannot see or read; if the frames or transcript are missing, say what you can infer from the caption and metrics and set confidence accordingly.`;

const fmt = n => (n == null ? 'n/a' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));

function metricsText(v) {
  return [
    `Platform: ${v.platform}${v.isShort ? ' (YouTube Short)' : ''}`,
    `Account: @${v.author} (${fmt(v.authorFollowers)} followers)${v.isBrand ? ' — this is the campaign brand\'s own account' : ''}`,
    `Posted: ${v.postedAt?.slice(0, 10) || 'unknown'} (${v.ageDays ?? '?'} days ago)`,
    `Length: ${v.durationSec ? Math.round(v.durationSec) + 's' : 'unknown'}`,
    `Views: ${fmt(v.views)} | Likes: ${fmt(v.likes)} | Comments: ${fmt(v.comments)} | Shares: ${fmt(v.shares)} | Saves: ${fmt(v.saves)}`,
    `Engagement rate: ${v.engagementRate != null ? (v.engagementRate * 100).toFixed(1) + '%' : 'n/a'} | Views ÷ followers: ${v.outlierRatio != null ? v.outlierRatio.toFixed(1) + 'x' : 'n/a'} | Viral score: ${v.viralScore}/100`,
    v.sound ? `Sound: ${v.sound}` : null,
    `Caption: ${v.caption || '(none)'}`,
  ].filter(Boolean).join('\n');
}

// Turns SDK errors into messages a non-engineer can act on.
async function callClaude(fn) {
  try { return await fn(); } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || /authentication method/i.test(err.message)) {
      throw new Error('Claude is not set up: add ANTHROPIC_API_KEY to .env and restart the server.');
    }
    if (err instanceof Anthropic.RateLimitError) throw new Error('Claude rate limit hit; wait a minute and try again.');
    throw err;
  }
}

function check(res) {
  if (res.stop_reason === 'refusal') throw new Error(`Claude declined this request (${res.stop_details?.category || 'policy'})`);
  if (res.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before finishing; try again');
}

export async function analyzeVideo(v, { campaign, force = false } = {}) {
  if (!force) {
    const cached = await getBreakdown(v.id);
    if (cached) return cached;
  }
  const notes = [];
  const got = await fetchVideo(v);
  let frames = [];
  let transcript = null;
  let duration = v.durationSec;
  if (got.file) {
    const ex = await extractFrames(got.file);
    frames = ex.frames;
    duration = duration || ex.duration;
    try { transcript = await transcribe(got.file); } catch (e) { notes.push('Transcription failed: ' + e.message); }
  } else {
    notes.push('Could not download the video (' + (got.errors || []).join('; ') + '). Analysis is based on the thumbnail, caption and metrics.');
  }
  if (!transcript) transcript = v.transcript || (await fetchSubtitles(v.subtitleUrl));
  if (!transcript && got.file && !process.env.ELEVENLABS_API_KEY) notes.push('No ELEVENLABS_API_KEY set, so spoken words were not transcribed.');

  const content = [];
  for (const f of frames) {
    content.push({ type: 'text', text: `Frame at ${f.t.toFixed(1)}s${f.t <= 3 ? ' (hook)' : ''}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: (await fs.readFile(f.file)).toString('base64') } });
  }
  if (!frames.length && v.thumbnail) {
    const img = await imageFromUrl(v.thumbnail);
    if (img) { content.push({ type: 'text', text: 'Cover / thumbnail image:' }); content.push({ type: 'image', source: { type: 'base64', ...img } }); }
  }
  content.push({
    type: 'text',
    text: [
      campaign ? `<campaign>\n${campaign}\n</campaign>` : '',
      `<metrics>\n${metricsText({ ...v, durationSec: duration })}\n</metrics>`,
      `<transcript>\n${transcript || '(no transcript available)'}\n</transcript>`,
      'Break this video down for a creator campaign brief: the hook, the structure, why it worked, and how a creator could adapt it for the campaign brand.',
    ].filter(Boolean).join('\n\n'),
  });

  const res = await callClaude(() => client.beta.messages.parse({
    model: config.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: betaZodOutputFormat(Breakdown) },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  }));
  check(res);
  if (!res.parsed_output) throw new Error('Claude returned an unreadable breakdown; try again');

  const breakdown = {
    videoId: v.id,
    createdAt: new Date().toISOString(),
    model: res.model,
    inputs: { frames: frames.length, transcript: Boolean(transcript), downloadedVia: got.via || null },
    notes,
    transcript,
    ...res.parsed_output,
  };
  await saveBreakdown(v.id, breakdown);
  return breakdown;
}

const REPORT_SYSTEM = `You are SideShift's head of creator strategy. You turn breakdowns of viral short-form videos into a campaign content strategy update that account managers paste into client decks and creator briefs. Write in clear, direct Markdown. Be concrete: cite specific videos by their [n] number, quote hooks, and give numbers. No filler, no generic social-media advice.`;

export async function strategyReport(job, items) {
  const brandItems = items.filter(i => i.video.isBrand);
  const lines = items.map((i, n) => {
    const v = i.video;
    const b = i.breakdown;
    return `[${n + 1}] ${v.isBrand ? '(BRAND) ' : ''}${v.platform} @${v.author} — ${fmt(v.views)} views, ${v.engagementRate != null ? (v.engagementRate * 100).toFixed(1) + '% ER' : ''}, ${v.outlierRatio != null ? v.outlierRatio.toFixed(1) + 'x followers' : ''}, posted ${v.postedAt?.slice(0, 10) || '?'}, score ${v.viralScore}
URL: ${v.url}
${b ? `Format: ${b.format}
Hook (${b.hook.type}): "${b.hook.verbatim}" / visual: ${b.hook.visual}
Hook template: ${b.hook.template}
Structure: ${b.structure.map(s => `${s.time} ${s.beat}`).join(' → ')}
Why it works: ${b.whyItWorks.join(' | ')}
Retention: ${b.retentionTactics.join(' | ')}
Audio: ${b.audio}
CTA: ${b.cta}
Replicability: ${b.replicability.score}/5 — ${b.replicability.howToAdapt}` : `Caption: ${v.caption?.slice(0, 400)}\n(no breakdown yet — metrics and caption only)`}`;
  }).join('\n\n');

  const prompt = `<campaign>
Brand: ${job.brand}
Notes: ${job.campaignNotes || '(none)'}
Keywords: ${job.keywords.join(', ') || '(none)'} | Hashtags: ${job.hashtags.map(h => '#' + h).join(' ') || '(none)'}
Window: last ${job.windowDays} days | Platforms: ${job.platforms.join(', ')}
</campaign>

<videos>
${lines}
</videos>

Write the content strategy update with these sections:
1. **TL;DR**: 3–5 bullets an account manager can read in 20 seconds.
2. **What's working right now**: the formats, hook types and themes that keep appearing in the top videos, with [n] citations. Note differences between the 30/60/90-day windows and between platforms when the data shows any.
3. **Hook bank**: 8–12 ready-to-use hook lines adapted for ${job.brand}, each with the [n] video it is modeled on.
4. ${brandItems.length ? `**What has worked for ${job.brand} before**: patterns in the brand's own top videos and how they compare with the wider trend.` : '**Brand history**: say that no brand videos were pulled and what to add next time.'}
5. **Creator brief ideas**: 4–6 concrete concepts (format, hook, beat outline, CTA, best platform), each tied to evidence.
6. **Do / Don't**: short lists.
7. **Watch list**: trends or sounds that look early and worth testing.`;

  const stream = client.beta.messages.stream({
    model: config.model,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high' },
    system: REPORT_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  const res = await callClaude(() => stream.finalMessage());
  check(res);
  const markdown = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { createdAt: new Date().toISOString(), model: res.model, videoCount: items.length, analyzedCount: items.filter(i => i.breakdown).length, markdown };
}
