# Viral Content Scraper

A local dashboard for campaign content strategy. For a brand's topics it pulls the top-performing short-form videos from the last **30, 60 or 90 days** on **TikTok, Instagram, Facebook and YouTube**, plus the **brand's own best past videos**. It then uses Claude to break each video down (hook, structure, why it works, how to adapt it) and writes a **strategy report** you can paste into a deck or creator brief.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the keys below
npm run dev            # → http://localhost:3020
```

| Key | Needed for | Where to get it |
|---|---|---|
| `APIFY_TOKEN` | Scraping (required) | console.apify.com → Settings → API & Integrations |
| `ANTHROPIC_API_KEY` | Breakdowns + reports (required) | platform.claude.com |
| `ELEVENLABS_API_KEY` | Transcribing spoken words (optional) | Same key `video-use` uses |

Recommended: `brew install yt-dlp`. Without it, YouTube breakdowns only see the thumbnail, title and captions, not the video itself.

## How a pull works

1. **New pull**: enter the brand, campaign notes, keywords, hashtags, the window and the brand's handles. You can also list competitors or creators to watch.
2. Each platform runs as its own Apify job in parallel. A failure on one platform doesn't stop the others; it shows red with the reason.
3. Videos are normalized, deduped, scored and tagged with a window (≤30, ≤60, ≤90 days). Brand videos are kept whatever their age.
4. **Break down** a video (or **Break down top 10**). The app downloads the video, grabs 14 frames (five in the first 3 seconds, where the hook is), transcribes it and has Claude return a structured breakdown. Breakdowns are cached.
5. **Strategy report** combines every breakdown plus the top 15 videos into a TL;DR, what's working, a hook bank, the brand's history, creator brief ideas, do/don't lists and a watch list.

### Viral score (0–100)

- 50% reach: log of views; 10M views earns full marks.
- 30% outlier: views ÷ followers. A video doing 30× a small account's size is the strongest "the content did this, not the audience" signal.
- 20% engagement: (likes + comments + shares + saves) ÷ views; 12% earns full marks.

Other sort options: raw views, views ÷ followers, engagement rate, views per day and newest.

### What each platform can and can't do

| Platform | Trending discovery | Brand's past videos | Actor |
|---|---|---|---|
| TikTok | Keyword search + hashtags | All-time most popular | `clockworks/tiktok-scraper` |
| Instagram | Hashtags (single-word keywords are tried as hashtags; Instagram has no keyword video search) | Reels from the last 12 months | `apify/instagram-scraper`, `apify/instagram-reel-scraper` |
| Facebook | **No public search.** Add pages under "Competitors / creators to watch" | Page reels from the last 12 months | `apify/facebook-reels-scraper` |
| YouTube | Keyword search, sorted by views (Shorts and long-form) | Channel videos + Shorts | `streamers/youtube-scraper` |

## Cost

Apify charges per result. A typical pull (2–3 keywords, 2 hashtags, 4 platforms, 30 results each, brand handles) costs a few dollars, and the job header shows the exact Apify cost. Each Claude breakdown costs a few cents (about 14 images plus a transcript). The report costs more because it reads everything at high effort.

Breakdowns and reports use `claude-opus-5-5` by default (change it with `CLAUDE_MODEL`), with server-side refusal fallbacks turned on.

## Files

```
server.mjs          local HTTP server + API routes
lib/platforms.mjs   Apify inputs + per-platform normalizers → one Video shape
lib/jobs.mjs        runs a pull, dedupes, scores, buckets into windows
lib/media.mjs       download (yt-dlp → direct URL → Apify), ffmpeg frames, ElevenLabs transcript
lib/analyze.mjs     Claude breakdown schema + strategy report prompt
public/             dashboard (vanilla JS)
data/               jobs, breakdowns, downloaded media (gitignored)
```
