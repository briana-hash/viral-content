const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (n == null ? '–' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
const pct = n => (n == null ? '–' : (n * 100).toFixed(1) + '%');
const PLATFORM = { tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube' };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), 5000);
}

function segValue(id) { return $(`#${id} .on`)?.dataset.v; }
function wireSeg(id, onChange) {
  $(`#${id}`).addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    $$(`#${id} button`).forEach(x => x.classList.toggle('on', x === b));
    onChange?.(b.dataset.v);
  });
}

// ---------- state ----------
const state = { job: null, poll: null, analyzing: new Set(), queue: [] };

// ---------- status + job list ----------
async function loadStatus() {
  const s = await api('/api/status');
  const pill = (ok, label, tip) => `<span class="pill ${ok ? 'ok' : 'warn'}" title="${esc(tip)}">${ok ? '●' : '○'} ${label}</span>`;
  $('#status').innerHTML =
    pill(s.apify, 'Apify', s.apify ? 'Scraping is ready' : 'Add APIFY_TOKEN to .env') +
    pill(s.anthropic, 'Claude', s.anthropic ? `Breakdowns use ${s.model}` : 'Add ANTHROPIC_API_KEY to .env') +
    pill(s.transcription, 'Transcripts', s.transcription ? 'ElevenLabs transcription on' : 'Optional: add ELEVENLABS_API_KEY for spoken-word transcripts');
}

async function loadJobs() {
  const jobs = await api('/api/jobs');
  $('#jobList').innerHTML = jobs.length ? jobs.map(j => `
    <li><a href="#/job/${j.id}" class="${state.job?.id === j.id ? 'on' : ''}">
      <strong>${esc(j.brand)}</strong>
      <span>${new Date(j.createdAt).toLocaleDateString()} · ${j.windowDays}d · ${j.videoCount} videos ${j.status !== 'done' ? '· ' + j.status : ''}${j.hasReport ? ' · report' : ''}</span>
    </a></li>`).join('') : '<li class="muted small">No pulls yet.</li>';
}

// ---------- routing ----------
function route() {
  clearInterval(state.poll);
  const m = location.hash.match(/^#\/job\/([\w-]+)/);
  $('#formView').classList.toggle('hidden', Boolean(m));
  $('#jobView').classList.toggle('hidden', !m);
  if (m) openJob(m[1]);
  else { state.job = null; loadJobs(); }
}
window.addEventListener('hashchange', route);
$('#newPullBtn').onclick = () => { location.hash = ''; };

// ---------- new pull form ----------
wireSeg('windowSeg');
$('#pullForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const handles = prefix => Object.fromEntries(['tiktok', 'instagram', 'facebook', 'youtube'].map(p => [p, f.get(`${prefix}_${p}`) || '']));
  const body = {
    brand: f.get('brand'), campaignNotes: f.get('campaignNotes'),
    keywords: f.get('keywords'), hashtags: f.get('hashtags'),
    platforms: f.getAll('platforms'), windowDays: Number(segValue('windowSeg')),
    brandHandles: handles('brand'), watchAccounts: handles('watch'),
    perQuery: f.get('perQuery'), brandPerAccount: f.get('brandPerAccount'),
  };
  $('#formError').textContent = '';
  try {
    const { id } = await api('/api/jobs', { method: 'POST', body });
    location.hash = `#/job/${id}`;
  } catch (err) { $('#formError').textContent = err.message; }
});

// ---------- job view ----------
async function openJob(id) {
  try {
    state.job = await api(`/api/jobs/${id}`);
  } catch (err) { toast(err.message, true); return; }
  renderJob();
  loadJobs();
  if (['queued', 'running'].includes(state.job.status)) {
    state.poll = setInterval(async () => {
      state.job = await api(`/api/jobs/${id}`);
      renderJob();
      if (!['queued', 'running'].includes(state.job.status)) { clearInterval(state.poll); loadJobs(); }
    }, 4000);
  }
}

function renderJob() {
  const j = state.job;
  $('#jobTitle').textContent = j.brand;
  const terms = [...j.keywords, ...j.hashtags.map(h => '#' + h)].join(', ');
  $('#jobMeta').innerHTML = `Last ${j.windowDays} days · ${j.platforms.map(p => PLATFORM[p]).join(', ')}${terms ? ' · ' + esc(terms) : ''} · <span class="status-${j.status}">${j.status}</span>${j.costUsd ? ` · Apify cost $${j.costUsd}` : ''}`;
  $('#csvBtn').href = `/api/jobs/${j.id}/export.csv`;

  const running = ['queued', 'running'].includes(j.status);
  $('#tasks').innerHTML = j.tasks.map(t => `
    <div class="task ${t.status}" title="${esc(t.error || '')}">
      <span class="dot"></span>${esc(t.label)}
      <span class="muted">${t.status === 'done' ? `${t.count} videos` : t.status === 'error' ? 'failed: ' + esc(t.error).slice(0, 120) : t.status + '…'}</span>
    </div>`).join('');
  $('#tasks').classList.toggle('compact', !running && j.tasks.every(t => t.status === 'done'));
  renderGrid();
  renderReport();
}

function filtered() {
  const j = state.job;
  const w = segValue('fWindow'), p = segValue('fPlatform'), s = segValue('fSource'), sort = $('#fSort').value;
  let list = j.videos.filter(v =>
    (w === 'all' || (v.window != null && v.window <= Number(w))) &&
    (p === 'all' || v.platform === p) &&
    (s === 'all' || (v.sources || []).includes(s)));
  list = [...list].sort((a, b) => sort === 'newest'
    ? (b.postedAt || '').localeCompare(a.postedAt || '')
    : (b[sort] ?? -1) - (a[sort] ?? -1));
  return list;
}

function renderGrid() {
  const j = state.job;
  if (['queued', 'running'].includes(j.status) && !j.videos.length) {
    $('#grid').innerHTML = '<div class="empty">Scraping… this usually takes 1–5 minutes. Videos appear here when every platform has finished.</div>';
    $('#countLabel').textContent = '';
    return;
  }
  const list = filtered();
  $('#countLabel').textContent = `${list.length} of ${j.videos.length} videos`;
  if (!list.length) { $('#grid').innerHTML = '<div class="empty">No videos match these filters.</div>'; return; }
  $('#grid').innerHTML = list.map(v => {
    const busy = state.analyzing.has(v.id) || state.queue.includes(v.id);
    return `
    <article class="vcard" data-id="${esc(v.id)}">
      <a class="thumb" href="${esc(v.url)}" target="_blank" rel="noopener">
        ${v.thumbnail ? `<img src="${esc(v.thumbnail)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        <span class="score" title="Viral score">${v.viralScore}</span>
        <span class="plat ${v.platform}">${PLATFORM[v.platform]}</span>
        ${v.isBrand ? '<span class="brandtag">Brand</span>' : ''}
        ${v.durationSec ? `<span class="dur">${Math.round(v.durationSec)}s</span>` : ''}
      </a>
      <div class="vbody">
        <div class="author">@${esc(v.author)} <span class="muted">${fmt(v.authorFollowers)} followers</span></div>
        <div class="stats">
          <span title="Views"><b>${fmt(v.views)}</b> views</span>
          <span title="Engagement rate (likes+comments+shares+saves ÷ views)"><b>${pct(v.engagementRate)}</b> ER</span>
          <span title="Views ÷ followers"><b>${v.outlierRatio != null ? v.outlierRatio.toFixed(1) + 'x' : '–'}</b> reach</span>
        </div>
        <div class="caption">${esc((v.title || v.caption || '').slice(0, 140))}</div>
        <div class="vfoot">
          <span class="muted">${v.ageDays != null ? v.ageDays + 'd ago' : ''}${v.sound ? ' · ♫ ' + esc(v.sound.slice(0, 32)) : ''}</span>
          <button class="btn small ${v.analyzed ? '' : 'primary'}" data-analyze="${esc(v.id)}" ${busy ? 'disabled' : ''}>
            ${busy ? 'Analyzing…' : v.analyzed ? 'View breakdown' : 'Break down'}
          </button>
        </div>
      </div>
    </article>`;
  }).join('');
}

['fWindow', 'fPlatform', 'fSource'].forEach(id => wireSeg(id, renderGrid));
$('#fSort').onchange = renderGrid;

$$('.tabs button').forEach(b => b.onclick = () => {
  $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  $('#videosTab').classList.toggle('hidden', b.dataset.tab !== 'videos');
  $('#reportTab').classList.toggle('hidden', b.dataset.tab !== 'report');
});
function showTab(name) { $(`.tabs button[data-tab="${name}"]`).click(); }

// ---------- breakdowns ----------
$('#grid').addEventListener('click', e => {
  const b = e.target.closest('[data-analyze]');
  if (!b) return;
  const v = state.job.videos.find(x => x.id === b.dataset.analyze);
  if (v.analyzed) showBreakdown(v);
  else enqueue([v.id], true);
});

const CONCURRENCY = 3;
function enqueue(ids, openWhenDone) {
  for (const id of ids) if (!state.queue.includes(id) && !state.analyzing.has(id)) state.queue.push(id);
  if (openWhenDone) state.openNext = ids[0];
  renderGrid();
  pump();
}
async function pump() {
  while (state.analyzing.size < CONCURRENCY && state.queue.length) {
    const id = state.queue.shift();
    state.analyzing.add(id);
    analyzeOne(id).finally(() => { state.analyzing.delete(id); renderGrid(); pump(); });
  }
}
async function analyzeOne(id, force = false) {
  const job = state.job;
  try {
    const b = await api(`/api/jobs/${job.id}/analyze`, { method: 'POST', body: { videoId: id, force } });
    const v = job.videos.find(x => x.id === id);
    if (v) v.analyzed = true;
    if (state.openNext === id || force) { state.openNext = null; showBreakdown(v, b); }
  } catch (err) {
    toast(`Breakdown failed: ${err.message}`, true);
  }
}

$('#analyzeTopBtn').onclick = () => {
  const ids = filtered().filter(v => !v.analyzed).slice(0, 10).map(v => v.id);
  if (!ids.length) return toast('The top videos in this view are already broken down.');
  enqueue(ids);
  toast(`Breaking down ${ids.length} videos (3 at a time, about a minute each)…`);
};

async function showBreakdown(v, b) {
  $('#drawer').classList.remove('hidden');
  $('#drawerBody').innerHTML = '<div class="empty">Loading…</div>';
  try { b = b || await api(`/api/breakdowns/${encodeURIComponent(v.id)}`); }
  catch (err) { $('#drawerBody').innerHTML = `<div class="error">${esc(err.message)}</div>`; return; }
  const list = arr => (arr?.length ? `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">–</p>');
  $('#drawerBody').innerHTML = `
    <div class="bd-head">
      ${v.thumbnail ? `<img src="${esc(v.thumbnail)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <div>
        <div class="muted">${PLATFORM[v.platform]} · @${esc(v.author)}${v.isBrand ? ' · <span class="brandtag inline">Brand</span>' : ''}</div>
        <h2>${esc(b.format)}</h2>
        <div class="stats">
          <span><b>${fmt(v.views)}</b> views</span><span><b>${pct(v.engagementRate)}</b> ER</span>
          <span><b>${v.outlierRatio != null ? v.outlierRatio.toFixed(1) + 'x' : '–'}</b> reach</span><span><b>${v.viralScore}</b> score</span>
        </div>
        <a href="${esc(v.url)}" target="_blank" rel="noopener">Open original ↗</a>
      </div>
    </div>
    <p>${esc(b.summary)}</p>
    ${b.notes?.length ? `<div class="note">${b.notes.map(esc).join('<br>')}</div>` : ''}
    <div class="muted small">Based on ${b.inputs.frames} frames · ${b.inputs.transcript ? 'transcript' : 'no transcript'} · confidence: ${esc(b.confidence)} · ${esc(b.model)}</div>

    <h3>Hook <span class="tag">${esc(b.hook.type)}</span></h3>
    <blockquote>${esc(b.hook.verbatim || '(no spoken/text hook)')}</blockquote>
    <p><b>Visual:</b> ${esc(b.hook.visual)}</p>
    <p><b>Why it stops the scroll:</b> ${esc(b.hook.whyItStopsTheScroll)}</p>
    <p class="template"><b>Template:</b> ${esc(b.hook.template)}</p>

    <h3>Structure</h3>
    <ol class="beats">${b.structure.map(s => `<li><span class="t">${esc(s.time)}</span> <b>${esc(s.beat)}</b>: ${esc(s.whatHappens)}</li>`).join('')}</ol>

    <h3>Why it works</h3>${list(b.whyItWorks)}
    <h3>Retention tactics</h3>${list(b.retentionTactics)}
    <div class="grid2">
      <div><h3>Visual style</h3><p>${esc(b.visualStyle)}</p></div>
      <div><h3>Audio</h3><p>${esc(b.audio)}</p></div>
    </div>
    ${b.onScreenText?.length ? `<h3>On-screen text</h3>${list(b.onScreenText)}` : ''}
    <div class="grid2">
      <div><h3>CTA</h3><p>${esc(b.cta || '–')}</p></div>
      <div><h3>Emotional triggers</h3><p>${esc((b.emotionalTriggers || []).join(', '))}</p></div>
    </div>
    <h3>Engagement drivers</h3><p>${esc(b.engagementDrivers)}</p>
    <h3>Brand integration</h3><p>${esc(b.brandIntegration)}</p>
    <h3>Replicability <span class="tag">${b.replicability.score}/5</span></h3><p>${esc(b.replicability.howToAdapt)}</p>
    ${b.transcript ? `<details><summary>Transcript</summary><pre>${esc(b.transcript)}</pre></details>` : ''}
    <div class="actions"><button class="btn" id="reanalyzeBtn">Re-run breakdown</button></div>`;
  $('#reanalyzeBtn').onclick = () => { $('#drawerBody').innerHTML = '<div class="empty">Re-analyzing… (about a minute)</div>'; analyzeOne(v.id, true); };
}
$$('[data-close]').forEach(el => el.onclick = () => $('#drawer').classList.add('hidden'));
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#drawer').classList.add('hidden'); });

// ---------- strategy report ----------
function renderReport() {
  const r = state.job.report;
  $('#reportMeta').textContent = r ? `Generated ${new Date(r.createdAt).toLocaleString()} from ${r.videoCount} videos (${r.analyzedCount} with full breakdowns) · ${r.model}` : '';
  $('#reportBody').innerHTML = r
    ? (window.marked ? marked.parse(r.markdown) : `<pre>${esc(r.markdown)}</pre>`)
    : '<div class="empty">No report yet. Break down a few top videos first for the best results, then click <b>Strategy report</b>.</div>';
  $('#copyReportBtn').disabled = !r;
}
async function generateReport() {
  const j = state.job;
  if (!j.videos.length) return toast('No videos yet.', true);
  showTab('report');
  $('#reportBody').innerHTML = '<div class="empty">Writing the strategy report… (1–3 minutes)</div>';
  $('#reportBtn').disabled = $('#regenReportBtn').disabled = true;
  try {
    j.report = await api(`/api/jobs/${j.id}/report`, { method: 'POST', body: {} });
    loadJobs();
  } catch (err) { toast(`Report failed: ${err.message}`, true); }
  $('#reportBtn').disabled = $('#regenReportBtn').disabled = false;
  renderReport();
}
$('#reportBtn').onclick = () => (state.job.report ? showTab('report') : generateReport());
$('#regenReportBtn').onclick = generateReport;
$('#copyReportBtn').onclick = async () => { await navigator.clipboard.writeText(state.job.report.markdown); toast('Report copied as Markdown.'); };
$('#rerunBtn').onclick = async () => {
  const { id } = await api(`/api/jobs/${state.job.id}/rerun`, { method: 'POST' });
  location.hash = `#/job/${id}`;
};

loadStatus();
route();
