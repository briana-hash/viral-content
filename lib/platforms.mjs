// Per-platform Apify tasks and normalizers.
// Every scraper result is mapped to one shared Video shape so scoring, the
// dashboard and the breakdowns never need to know which platform it came from.

const DAY = 86400000;

const num = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').trim();
  const m = s.match(/^([\d.]+)\s*([kmb])?/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
};
const first = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '');
const firstNum = (...vals) => { for (const v of vals) { const n = num(v); if (n != null) return n; } return null; };
const toIso = v => {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const hms = v => {
  if (typeof v === 'number') return v;
  if (!v) return null;
  const parts = String(v).split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
};
const clean = s => String(s || '').replace(/^[@#\s]+/, '').trim();
const hashtagsIn = text => [...String(text || '').matchAll(/#([\p{L}\p{N}_]+)/gu)].map(m => m[1].toLowerCase());

function video(base) {
  return {
    id: `${base.platform}:${base.platformId}`,
    caption: '', hashtags: [], author: '', authorFollowers: null, postedAt: null,
    durationSec: null, views: null, likes: null, comments: null, shares: null, saves: null,
    thumbnail: null, videoUrl: null, sound: null, transcript: null, subtitleUrl: null,
    ...base,
    hashtags: base.hashtags?.length ? base.hashtags : hashtagsIn(base.caption),
  };
}

// ---------- TikTok (clockworks~tiktok-scraper) ----------
const tiktok = {
  label: 'TikTok',
  actor: 'clockworks~tiktok-scraper',
  discovery({ keywords, hashtags, windowDays, perQuery }) {
    if (!keywords.length && !hashtags.length) return [];
    return [{
      label: 'TikTok search + hashtags',
      input: {
        hashtags: hashtags.map(clean),
        searchQueries: keywords,
        resultsPerPage: perQuery,
        oldestPostDateUnified: String(windowDays),
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
      },
    }];
  },
  accounts(handles, { windowDays, perQuery }, kind) {
    return handles.map(h => ({
      label: `TikTok @${clean(h)}`,
      input: kind === 'brand'
        // Brand: all-time most popular uploads = what has worked for them before.
        ? { profiles: [clean(h)], profileSorting: 'popular', resultsPerPage: perQuery, excludePinnedPosts: false }
        : { profiles: [clean(h)], profileSorting: 'latest', resultsPerPage: perQuery, oldestPostDateUnified: String(windowDays) },
    }));
  },
  normalize(it) {
    if (!it || it.error || (!it.id && !it.webVideoUrl)) return null;
    if (it.isSlideshow || (Array.isArray(it.slideshowImageLinks) && it.slideshowImageLinks.length)) return null;
    const meta = it.videoMeta || {};
    const author = it.authorMeta || {};
    const music = it.musicMeta || {};
    const subs = Array.isArray(meta.subtitleLinks) ? meta.subtitleLinks : [];
    const en = subs.find(s => /^en|eng/i.test(s.language || '')) || subs[0];
    return video({
      platform: 'tiktok', platformId: String(it.id),
      url: it.webVideoUrl || `https://www.tiktok.com/@${author.name}/video/${it.id}`,
      caption: it.text || '',
      hashtags: (it.hashtags || []).map(h => (h.name || h).toString().toLowerCase()).filter(Boolean),
      author: author.name || author.nickName || '', authorFollowers: num(author.fans),
      postedAt: toIso(first(it.createTimeISO, it.createTime)),
      durationSec: num(meta.duration),
      views: num(it.playCount), likes: num(it.diggCount), comments: num(it.commentCount),
      shares: num(it.shareCount), saves: num(it.collectCount),
      thumbnail: first(meta.coverUrl, meta.originalCoverUrl, it.covers?.[0]),
      videoUrl: first(it.mediaUrls?.[0], meta.downloadAddr),
      sound: music.musicName ? `${music.musicName}${music.musicAuthor ? ' — ' + music.musicAuthor : ''}${music.musicOriginal ? ' (original)' : ''}` : null,
      subtitleUrl: en?.downloadLink || en?.tiktokLink || null,
    });
  },
};

// ---------- Instagram (hashtags: apify~instagram-scraper, accounts: apify~instagram-reel-scraper) ----------
const instagram = {
  label: 'Instagram',
  actor: 'apify~instagram-reel-scraper',
  discovery({ keywords, hashtags, windowDays, perQuery }) {
    // Instagram has no keyword video search; single-word keywords are tried as hashtags.
    const tags = [...new Set([...hashtags, ...keywords.filter(k => !/\s/.test(k))].map(t => clean(t).toLowerCase()).filter(Boolean))];
    if (!tags.length) return [];
    return [{
      label: 'Instagram hashtags',
      actor: 'apify~instagram-scraper',
      input: {
        directUrls: tags.map(t => `https://www.instagram.com/explore/tags/${encodeURIComponent(t)}/`),
        resultsType: 'posts',
        resultsLimit: perQuery,
        onlyPostsNewerThan: `${windowDays} days`,
      },
    }];
  },
  accounts(handles, { windowDays, perQuery }, kind) {
    return [{
      label: `Instagram ${handles.map(h => '@' + clean(h)).join(', ')}`,
      input: {
        username: handles.map(clean),
        resultsLimit: perQuery,
        // Brand: last 12 months so the best past performers surface; watched accounts: the selected window.
        onlyPostsNewerThan: kind === 'brand' ? '12 months' : `${windowDays} days`,
        skipPinnedPosts: false,
      },
    }];
  },
  normalize(it) {
    if (!it || it.error) return null;
    const isVideo = it.type === 'Video' || it.productType === 'clips' || it.isVideo || it.videoUrl || it.videoViewCount != null || it.videoPlayCount != null;
    if (!isVideo) return null;
    const code = first(it.shortCode, it.code);
    const pid = first(it.id, code);
    if (!pid) return null;
    const music = it.musicInfo || {};
    return video({
      platform: 'instagram', platformId: String(pid),
      url: first(it.url, code ? `https://www.instagram.com/reel/${code}/` : null),
      caption: it.caption || '',
      hashtags: (it.hashtags || []).map(h => String(h).toLowerCase()),
      author: first(it.ownerUsername, it.owner?.username, ''),
      authorFollowers: firstNum(it.ownerFollowersCount, it.owner?.followersCount),
      postedAt: toIso(first(it.timestamp, it.takenAtTimestamp)),
      durationSec: firstNum(it.videoDuration),
      views: firstNum(it.videoPlayCount, it.videoViewCount, it.playCount),
      likes: firstNum(it.likesCount), comments: firstNum(it.commentsCount), shares: firstNum(it.sharesCount),
      thumbnail: first(it.displayUrl, it.thumbnailUrl),
      videoUrl: first(it.downloadedVideo, it.videoUrl),
      sound: music.song_name ? `${music.song_name}${music.artist_name ? ' — ' + music.artist_name : ''}${music.uses_original_audio ? ' (original)' : ''}` : null,
      transcript: it.transcript || null,
    });
  },
};

// ---------- Facebook (apify~facebook-reels-scraper; pages only — Facebook has no public video search) ----------
const fbUrl = h => (/^https?:\/\//.test(h) ? h : `https://www.facebook.com/${clean(h)}/`);
const facebook = {
  label: 'Facebook',
  actor: 'apify~facebook-reels-scraper',
  discovery() { return []; },
  accounts(handles, { windowDays, perQuery }, kind) {
    return [{
      label: `Facebook ${handles.map(clean).join(', ')}`,
      input: {
        startUrls: handles.map(h => ({ url: fbUrl(h) })),
        resultsLimit: perQuery,
        onlyPostsNewerThan: kind === 'brand' ? '12 months' : `${windowDays} days`,
      },
    }];
  },
  normalize(it) {
    if (!it || it.error) return null;
    const pid = first(it.id, it.postId, it.videoId, it.reelId, it.url);
    if (!pid) return null;
    return video({
      platform: 'facebook', platformId: String(pid).replace(/[^\w-]/g, '').slice(-40),
      url: first(it.url, it.reelUrl, it.topLevelUrl, it.facebookUrl),
      caption: first(it.text, it.caption, it.description, ''),
      author: first(it.pageName, it.user?.name, it.ownerName, it.author?.name, ''),
      authorFollowers: firstNum(it.pageFollowers, it.followers, it.user?.followers),
      postedAt: toIso(first(it.time, it.timestamp, it.date, it.publishedAt, it.creationTime)),
      durationSec: firstNum(it.lengthInSeconds, it.durationSec, it.duration) ?? hms(it.duration),
      views: firstNum(it.playCount, it.viewsCount, it.views, it.videoViewCount, it.plays),
      likes: firstNum(it.likes, it.likesCount, it.reactionsCount, it.reactions),
      comments: firstNum(it.comments, it.commentsCount),
      shares: firstNum(it.shares, it.sharesCount),
      thumbnail: first(it.thumbnail, it.thumbnailUrl, it.media?.[0]?.thumbnail, it.previewImage),
      videoUrl: first(it.videoUrl, it.playableUrl, it.videoHdUrl, it.videoSdUrl, it.media?.[0]?.url),
    });
  },
};

// ---------- YouTube (streamers~youtube-scraper) ----------
const ytUrl = h => (/^https?:\/\//.test(h) ? h : `https://www.youtube.com/@${clean(h)}`);
const youtube = {
  label: 'YouTube',
  actor: 'streamers~youtube-scraper',
  discovery({ keywords, hashtags, windowDays, perQuery }) {
    const queries = [...keywords, ...hashtags.map(h => '#' + clean(h))];
    if (!queries.length) return [];
    const input = {
      searchQueries: queries,
      maxResults: Math.ceil(perQuery / 2),
      maxResultsShorts: perQuery,
      dateFilter: windowDays <= 30 ? 'month' : 'year',
    };
    return [{
      label: 'YouTube search',
      input: { ...input, sortingOrder: 'views' },
      // If the actor rejects the sort option, retry with its default sort.
      fallbackInput: input,
    }];
  },
  accounts(handles, { perQuery }) {
    return [{
      label: `YouTube ${handles.map(clean).join(', ')}`,
      input: {
        startUrls: handles.map(h => ({ url: ytUrl(h) })),
        maxResults: perQuery,
        maxResultsShorts: perQuery,
      },
    }];
  },
  normalize(it) {
    if (!it || it.error || !it.id || it.type === 'channel' || it.type === 'playlist') return null;
    return video({
      platform: 'youtube', platformId: String(it.id),
      url: it.url || `https://www.youtube.com/watch?v=${it.id}`,
      caption: [it.title, it.text].filter(Boolean).join('\n\n'),
      title: it.title || '',
      hashtags: (it.hashtags || []).map(h => clean(h).toLowerCase()),
      author: first(it.channelName, it.channelUsername, ''),
      authorFollowers: firstNum(it.numberOfSubscribers, it.channelSubscribers),
      postedAt: toIso(first(it.date, it.uploadDate, it.publishedAt)),
      durationSec: hms(it.duration) ?? num(it.lengthSeconds),
      views: firstNum(it.viewCount, it.views), likes: firstNum(it.likes),
      comments: firstNum(it.commentsCount, it.comments),
      thumbnail: first(it.thumbnailUrl, it.thumbnails?.[0]?.url),
      transcript: Array.isArray(it.subtitles) ? it.subtitles.map(s => s.plaintext || s.srt || '').join('\n').trim() || null : null,
      isShort: it.type === 'shorts' || /\/shorts\//.test(it.url || ''),
    });
  },
};

export const PLATFORMS = { tiktok, instagram, facebook, youtube };

// Builds the list of Apify runs for one job.
export function buildTasks(job) {
  const tasks = [];
  const opts = { keywords: job.keywords, hashtags: job.hashtags, windowDays: job.windowDays, perQuery: job.perQuery };
  for (const key of job.platforms) {
    const p = PLATFORMS[key];
    if (!p) continue;
    for (const t of p.discovery(opts)) tasks.push({ platform: key, kind: 'discovery', actor: t.actor || p.actor, ...t });
    const brand = (job.brandHandles?.[key] || []).filter(Boolean);
    if (brand.length) for (const t of p.accounts(brand, { ...opts, perQuery: job.brandPerAccount }, 'brand')) tasks.push({ platform: key, kind: 'brand', actor: t.actor || p.actor, ...t });
    const watch = (job.watchAccounts?.[key] || []).filter(Boolean);
    if (watch.length) for (const t of p.accounts(watch, opts, 'watch')) tasks.push({ platform: key, kind: 'watch', actor: t.actor || p.actor, ...t });
  }
  return tasks;
}

export function normalize(platform, item) {
  try { return PLATFORMS[platform].normalize(item); } catch { return null; }
}

export const ageDays = (iso, now = Date.now()) => (iso ? Math.max(0, (now - new Date(iso).getTime()) / DAY) : null);
