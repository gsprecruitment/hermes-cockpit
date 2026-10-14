// hermes-cockpit — desktop half. Loaded uncompiled by the Hermes desktop app: no JSX, only
// `@hermes/plugin-sdk`, `react` and `react/jsx-runtime` resolve. Theme variables only.
//
// Data comes from three doors, tried in order and shown as a badge in the mission bar:
//   live  — the Python sensor (`ctx.rest('/fleet')`), pushed by `plugin.hermes-cockpit.fleet.changed`
//   rpc   — no sensor enabled: `profiles.list` + `session.active_list` per profile over JSON-RPC
//   demo  — nothing reachable: a synthetic fleet so the page is never blank
import { jsx, jsxs } from 'react/jsx-runtime'
import React from 'react'
import { host, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS, PALETTE_AREA, KEYBINDS_AREA } from '@hermes/plugin-sdk'

const { useState, useEffect, useRef, useCallback, useMemo } = React
// Keyed children: the jsx runtime takes `key` as the third argument, not inside props.
const jsxk = (type, props) => { const { key, ...rest } = props; return jsx(type, rest, key) }
const jsxsk = (type, props) => { const { key, ...rest } = props; return jsxs(type, rest, key) }
const ID = 'hermes-cockpit'
const PATH = '/cockpit'
const STATES = ['blocked', 'failed', 'task', 'working', 'idle', 'off']
const STATE_LABEL = { blocked: 'needs you', failed: 'failed', task: 'on task', working: 'working', idle: 'idle', off: 'off duty' }

// ── tiny store. Not a nanostore: the SDK's `useValue` (nanostores' useStore) reads `.value`
// on subscribe and would see `undefined`; we subscribe ourselves with `useAtom` below.
function atom(initial) {
  let v = initial; const subs = new Set()
  return {
    get: () => v,
    get value() { return v },
    set: (n) => { if (n === v) return; v = n; subs.forEach(f => { try { f(v) } catch (e) { /* listener error must not break others */ } }) },
    subscribe: (f) => { subs.add(f); f(v); return () => subs.delete(f) },
    listen: (f) => { subs.add(f); return () => subs.delete(f) }
  }
}
function useAtom(a) {
  const [v, setV] = useState(a.get())
  useEffect(() => { setV(a.get()); return a.listen(setV) }, [a])
  return v
}

const DEFAULT_PREFS = {
  pollMs: 4000, showLanes: true, laneMinutes: 60, density: 'comfortable', particles: true,
  reducedMotion: false, demo: false, showIdle: true, laneBy: 'group', focusOnNeedsYou: true,
  theme: 'gsp', view: 'grid', queueCollapsed: false,
  showKpis: null, showRail: null, showQueue: null, showFeed: null, drawerMode: 'auto', drawerW: null, queueH: null, lanesH: null, textSize: 'normal'   // null = smart default (shown); a user choice wins   // theme: 'gsp' house style | 'app' host variables; view: 'grid' | 'constellation'
}
const $prefs = atom(DEFAULT_PREFS)
const $snap = atom(null)       // fleet snapshot (sensor shape, also produced by rpc/demo adapters)
const $feed = atom([])         // [{seq, ts, kind, profile, text}]
const $history = atom([])      // [{ts, states:{p:state}, tpm:{p:n}}]
const $mode = atom('connecting')  // connecting | live | rpc | demo | error
const $error = atom(null)
const $selected = atom(null)   // profile name
const $filter = atom({ q: '', states: new Set(STATES), group: null })
const $replayT = atom(null)    // epoch seconds when scrubbing; null = live
const $notice = atom(null)     // {text, kind}
const $dim = atom({ w: 1200, h: 700, size: 'medium', short: false })  // the page's own size, measured
const $feedOpen = atom(false)  // slide-over panel open on the feed tab without a unit
const $queueOpen = atom(false)  // short layout: the needs-you card panel
const $lanesOpen = atom(false)  // short layout: the swimlanes panel
const $searchOpen = atom(false) // short layout: the search field over the rail
const $tab = atom('unit')      // slide-over tab: 'unit' | 'feed'
// Short layout (H < 650 css px): header is one bar row + one rail row + a 28px needs-you strip, lanes only as a panel.
const SHORT_CHROME = { bar: 36, rail: 36, strip: 28 }
// Layout buckets by the page's own size (not the screen): wide >= 1400, medium 1100-1399, narrow < 1100; short < 650 high.
function chooseLayout(w, h) { return { w, h, size: w >= 1400 ? 'wide' : (w >= 1100 ? 'medium' : 'narrow'), short: h < 650 } }

function fmtAge(s) { if (s == null) return '—'; if (s < 60) return `${Math.round(s)}s`; if (s < 3600) return `${Math.round(s / 60)}m`; if (s < 86400) return `${(s / 3600).toFixed(1)}h`; return `${Math.round(s / 86400)}d` }
function fmtTok(n) { n = Number(n || 0); if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`; if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`; return String(Math.round(n)) }
function fmtUsd(n) { return n == null ? '—' : `$${Number(n).toFixed(2)}` }
function fmtClock(ts) { try { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) } catch (e) { return '' } }
function notice(text, kind = 'info') { $notice.set({ text, kind, at: Date.now() }) }

// ── colours: everything resolves through --ck-* custom properties (see CK_CSS) ──────────
const VAR_FALLBACK = { // VAR_FALLBACK: only used when a custom property is missing (never in the app)
  '--ck-text': '#e6e6e6', '--ck-muted': '#9aa0a6', '--ck-accent': '#7aa2ff', '--ck-line': 'rgba(127,127,127,.25)', '--ck-tip': 'rgba(60,60,60,.9)', // VAR_FALLBACK
  '--ck-s-blocked': '#f5c518', '--ck-s-failed': '#ef4e4e', '--ck-s-task': '#f2f5fa', '--ck-s-working': '#8fb3e8', '--ck-s-idle': '#5b6b85', '--ck-s-off': '#3a4760', // VAR_FALLBACK
  '--ck-z': '1', '--ck-sans': 'system-ui, sans-serif', '--ck-mono': 'ui-monospace, monospace'
}
function cssVar(el, name) {
  try { const v = getComputedStyle(el).getPropertyValue(name).trim(); if (v) return v } catch (e) { /* no DOM */ }
  return VAR_FALLBACK[name] || '#888'
}
function palette(el) {
  const g = (n) => cssVar(el, n)
  return {
    text: g('--ck-text'), muted: g('--ck-muted'), accent: g('--ck-accent'), border: g('--ck-line'), tip: g('--ck-tip'), sans: g('--ck-sans'), mono: g('--ck-mono'), z: Number(g('--ck-z')) || 1,
    blocked: g('--ck-s-blocked'), failed: g('--ck-s-failed'), task: g('--ck-s-task'), working: g('--ck-s-working'), idle: g('--ck-s-idle'), off: g('--ck-s-off')
  }
}

// ── data adapters ───────────────────────────────────────────────────────────────────────
function unitsOf(snap) { return snap ? Object.values(snap.units || {}) : [] }

async function fetchLive(ctx) {
  const snap = await ctx.rest('/fleet')
  if (!snap || !snap.units) throw new Error('sensor returned no fleet')
  return snap
}
async function fetchFeedLive(ctx, since) { const r = await ctx.rest(`/feed?since=${since}&limit=200`); return r && r.items ? r.items : [] }
async function fetchHistoryLive(ctx, minutes) { const r = await ctx.rest(`/history?minutes=${minutes}`); return r && r.points ? r.points : [] }

// RPC-only picture: enough to show who exists and who is mid-turn. No kanban, no cost.
async function fetchRpc() {
  const res = await host.request('profiles.list', {})
  const rows = Array.isArray(res) ? res : (res && (res.profiles || res.items || res.rows)) || []
  const now = Date.now() / 1000
  const units = {}
  const names = rows.map(r => (typeof r === 'string' ? r : (r.name || r.id))).filter(Boolean)
  if (!names.includes('default')) names.unshift('default')
  const limit = 6; let i = 0
  async function worker() {
    while (i < names.length) {
      const name = names[i++]; const row = rows.find(r => (r.name || r.id) === name) || {}
      let sessions = []
      try {
        const r = await host.requestProfile(name, 'session.active_list', {})
        sessions = (r && r.sessions) || []
      } catch (e) { /* profile has no backend right now */ }
      const live = sessions.filter(s => s.status && /running|streaming|working|busy|active/i.test(String(s.status)))
      const latest = sessions.slice().sort((a, b) => (b.last_active || 0) - (a.last_active || 0))[0]
      units[name] = {
        profile: name, group: 'other', state: live.length ? 'working' : 'idle', since: now, is_owner: name === 'default',
        display_name: row.display_name || '', description: row.description || '', model: row.model || (latest && latest.model) || null,
        heartbeat_age_s: null, lease_count: live.length, active_sessions: live.length, delegations: 0, tokens_today: 0, cost_today_usd: 0,
        sessions_today: sessions.length, tokens_per_min: 0, blocked: [], failed: [], anomalies: [], cron: {}, task: null,
        latest_session: latest ? { id: latest.id, title: latest.title || latest.preview || '', model: latest.model, last_activity_at: latest.last_active } : null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, names.length) }, worker))
  return {
    rev: 0, ts: now, mode: 'rpc', title: 'Hermes Cockpit', owner: 'default', groups: [{ id: 'other', label: 'Fleet', profiles: names }],
    units, totals: totalsOf(units), pipeline: {}, boards: [], signals: [], gateway: {}, spend_ceiling_usd: null
  }
}
function totalsOf(units) {
  const list = Object.values(units); const by = {}
  STATES.forEach(s => { by[s] = list.filter(u => u.state === s).length })
  return {
    units: list.length, by_state: by, needs_you: by.blocked, delegations: list.reduce((a, u) => a + (u.delegations || 0), 0),
    tokens_today: list.reduce((a, u) => a + (u.tokens_today || 0), 0), cost_today_usd: list.reduce((a, u) => a + (u.cost_today_usd || 0), 0),
    tokens_per_min: list.reduce((a, u) => a + (u.tokens_per_min || 0), 0)
  }
}

// Demo fleet: ~47 profiles in five groups, deterministic (seeded) and slowly evolving, so the page is never
// blank and screenshots are stable. First tick: about 3 need you, 1 failed, 6 working, 4 on a task.
const DEMO_GROUPS = [
  { id: 'leadership', label: 'Leadership', profiles: ['chief-of-staff', 'coordinator', 'strategist', 'planner', 'board-liaison', 'risk-officer'] },
  { id: 'operations', label: 'Operations', profiles: ['kpi-reporter', 'invoice-matcher', 'backoffice', 'finance', 'contract-clerk', 'payroll-checker', 'compliance-watch', 'scheduler', 'inbox-triage', 'vendor-desk'] },
  { id: 'recruiting', label: 'Recruiting', profiles: ['sourcer-embedded', 'sourcer-cpp', 'sourcer-ot-security', 'screener', 'outreach', 'candidate-care', 'market-analyst', 'vacancy-writer', 'cv-formatter', 'interview-planner', 'reference-checker', 'talent-pool'] },
  { id: 'engineering', label: 'Engineering', profiles: ['engineering-lead', 'plugin-engineer', 'backend-engineer', 'frontend-engineer', 'mobile-engineer', 'qa-runner', 'security-reviewer', 'devops-bot', 'tech-planner', 'code-reviewer'] },
  { id: 'sales', label: 'Sales', profiles: ['account-manager', 'lead-finder', 'proposal-writer', 'crm-hygiene', 'client-researcher', 'pipeline-analyst', 'renewal-watch', 'client-outreach'] }
]
const DEMO_START = { // everything not listed starts idle
  blocked: ['chief-of-staff', 'invoice-matcher', 'outreach'], failed: ['kpi-reporter'],
  task: ['engineering-lead', 'sourcer-cpp', 'backend-engineer', 'lead-finder'],
  working: ['sourcer-embedded', 'screener', 'plugin-engineer', 'account-manager', 'proposal-writer', 'backoffice'],
  off: ['risk-officer', 'talent-pool', 'renewal-watch']
}
const DEMO_TITLES = ['Morning brief', 'Source embedded engineers', 'Draft outreach batch', 'Review PR #5', 'Reconcile invoices', 'Screen new CVs', 'Weekly KPI sheet', 'Update CRM contacts', 'Plan sprint', 'Check vacancy fit']
const DEMO_MODELS = ['glm-5.3-flash', 'deepseek-v4-flash', 'claude-fable-5-1', 'qwen-3-max']
let demoSeed = 7
function rnd() { demoSeed = (demoSeed * 1103515245 + 12345) & 0x7fffffff; return demoSeed / 0x7fffffff }
const demoId = () => 'T' + (100 + Math.round(rnd() * 800))
function demoSnap(prev) {
  const now = Date.now() / 1000
  const units = prev ? JSON.parse(JSON.stringify(prev.units)) : {}
  const all = ['default'].concat(DEMO_GROUPS.flatMap(g => g.profiles))
  all.forEach((p, i) => {
    if (!units[p]) {
      const st = Object.keys(DEMO_START).find(k => DEMO_START[k].includes(p)) || 'idle'
      const title = DEMO_TITLES[i % DEMO_TITLES.length]; const active = st === 'working' || st === 'task'
      units[p] = { profile: p, group: (DEMO_GROUPS.find(g => g.profiles.includes(p)) || { id: 'other' }).id, state: st, since: now - 60 - rnd() * 3000, is_owner: p === 'default', display_name: '', description: '', model: DEMO_MODELS[i % DEMO_MODELS.length], heartbeat_age_s: 4, lease_count: active ? 1 : 0, active_sessions: active ? 1 : 0, delegations: 0, tokens_today: Math.round(rnd() * 400000), cost_today_usd: rnd() * 6, sessions_today: 1 + Math.round(rnd() * 20), tokens_per_min: 0, blocked: [], failed: [], anomalies: [], cron: { jobs: Math.round(rnd() * 4), running: 0, errors_recent: 0, paused: 0 }, task: null, latest_session: { id: 's' + i, title, model: null, last_activity_at: now - (active ? rnd() * 60 : 300 + rnd() * 7000), tool_calls: Math.round(rnd() * 30), tokens: Math.round(rnd() * 50000) } }
      const u = units[p]
      if (st === 'task') u.task = { id: demoId(), title, started_at: u.since, created_by: 'agent:chief-of-staff', board: 'demo' }
      if (st === 'blocked') u.blocked = [{ id: demoId(), title: 'Approve: ' + title, block_kind: 'needs_human', created_at: u.since }]
      if (st === 'failed') u.failed = [{ id: demoId(), title: 'Failed: ' + title, created_at: u.since }]
    }
    const u = units[p]; const r = rnd()
    if (u.state === 'idle' && r < 0.04) { u.state = 'working'; u.since = now }
    else if (u.state === 'working' && r < 0.03) { u.state = 'task'; u.since = now; const by = DEMO_GROUPS[0].profiles[0]; u.task = { id: demoId(), title: u.latest_session.title, started_at: now, created_by: 'agent:' + by, board: 'demo' }; u.delegated_by = by }
    else if ((u.state === 'working' || u.state === 'task') && r > 0.985) { u.state = 'failed'; u.since = now; u.task = null; u.delegated_by = null; u.failed = [{ id: demoId(), title: 'Failed: ' + u.latest_session.title, created_at: now }] }
    else if ((u.state === 'working' || u.state === 'task') && r > 0.975) { u.state = 'blocked'; u.since = now; u.blocked = [{ id: demoId(), title: 'Approve: ' + u.latest_session.title, block_kind: 'needs_human', created_at: now }] }
    else if (u.state === 'blocked' && r > 0.95) { u.state = 'idle'; u.since = now; u.blocked = []; u.task = null; u.delegated_by = null }
    else if (u.state === 'failed' && r > 0.96) { u.state = 'idle'; u.since = now; u.failed = [] }
    else if ((u.state === 'working' || u.state === 'task') && r > 0.93) { u.state = 'idle'; u.since = now; u.task = null; u.delegated_by = null }
    if (u.state === 'working' || u.state === 'task') { const rate = 800 + rnd() * 4000; u.tokens_per_min = Math.round(rate); u.tokens_today += Math.round(rate / 15); u.cost_today_usd += rate / 15 * 0.0000025; u.latest_session.last_activity_at = now }
    else u.tokens_per_min = Math.max(0, Math.round(u.tokens_per_min * 0.6))
    u.delegations = u.state === 'task' ? 1 + Math.round(rnd() * 2) : 0
  })
  return { rev: (prev ? prev.rev : 0) + 1, ts: now, mode: 'demo', title: 'Hermes Cockpit · demo', owner: 'default', spend_ceiling_usd: 60, groups: DEMO_GROUPS.concat([{ id: 'other', label: 'You', profiles: ['default'] }]), units, totals: totalsOf(units), pipeline: { todo: 4, ready: 2, running: 3, blocked: 2, review: 1, done: 41 }, boards: ['demo'], signals: [{ id: 'sync', label: 'sync tick', age_s: 120, ok: true, warn_after_s: 900 }], gateway: { heartbeat_age_s: 3 } }
}
// Backfill ~an hour of history for the demo so sparklines and lanes have a past (no randomness: stable screenshots).
function demoHistory(snap) {
  const pts = []; const hash = (p, k) => { let h = k * 2654435761; for (let i = 0; i < p.length; i++) h = (h ^ p.charCodeAt(i)) * 16777619 >>> 0; return h % 100 }
  for (let k = 30; k >= 1; k--) {
    const states = {}, tpm = {}
    unitsOf(snap).forEach(u => {
      const live = u.state === 'working' || u.state === 'task' || u.state === 'blocked' || u.state === 'failed'
      if (live && k < 6 + hash(u.profile, 1) % 24) { states[u.profile] = u.state; if (u.state === 'working' || u.state === 'task') tpm[u.profile] = 600 + hash(u.profile, k) * 40 } else states[u.profile] = u.state === 'off' ? 'off' : 'idle'
    })
    pts.push({ ts: snap.ts - k * 120, states, tpm })
  }
  return pts
}

// Diff two snapshots into feed rows (used by the rpc/demo adapters; live has a server feed).
let localSeq = 0
function diffToFeed(prev, next) {
  if (!prev) return []
  const out = []
  Object.values(next.units).forEach(u => { const p = prev.units[u.profile]; if (p && p.state !== u.state) out.push({ seq: ++localSeq, ts: next.ts, kind: 'state', profile: u.profile, text: `${u.profile}: ${STATE_LABEL[p.state]} → ${STATE_LABEL[u.state]}` }) })
  return out
}

// ── the poller: one per plugin lifetime, owned by register() ────────────────────────────
function startPoller(ctx) {
  let stopped = false, timer = null, feedSeq = 0, consecutiveFail = 0, backoff = 1
  const mark = (m) => { if ($mode.get() !== m) $mode.set(m) }
  async function tick() {
    if (stopped) return
    const prefs = $prefs.get(); const prev = $snap.get()
    try {
      if (prefs.demo) {
        const s = demoSnap(prev && prev.mode === 'demo' ? prev : null); apply(s, diffToFeed(prev && prev.mode === 'demo' ? prev : null, s)); mark('demo')
      } else {
        let snap = null
        try {
          snap = await fetchLive(ctx); mark('live')
          const items = await fetchFeedLive(ctx, feedSeq)
          if (items.length) { feedSeq = items[items.length - 1].seq; $feed.set($feed.get().concat(items).slice(-500)) }
          if ($history.get().length === 0 || (snap.rev % 15) === 0) { const pts = await fetchHistoryLive(ctx, prefs.laneMinutes); if (pts.length) $history.set(pts) }
          else pushHistory(snap)
        } catch (e) {
          // Sensor not enabled (404) or gateway without the python half → RPC door.
          snap = await fetchRpc(); mark('rpc'); apply(snap, diffToFeed(prev, snap)); snap = null
        }
        if (snap) { $snap.set(snap); $error.set(null) }
      }
      consecutiveFail = 0; backoff = 1
    } catch (e) {
      consecutiveFail++; $error.set(String(e && e.message || e))
      if (consecutiveFail >= 3) { mark('demo'); const s = demoSnap(prev && prev.mode === 'demo' ? prev : null); apply(s, []); backoff = Math.min(backoff * 2, 8) }
    }
    timer = ctx.setTimeout(tick, Math.max(1500, $prefs.get().pollMs) * backoff)
  }
  function apply(snap, feedRows) { $snap.set(snap); if (feedRows.length) $feed.set($feed.get().concat(feedRows).slice(-500)); pushHistory(snap) }
  function pushHistory(snap) {
    const states = {}, tpm = {}; unitsOf(snap).forEach(u => { states[u.profile] = u.state; if (u.tokens_per_min) tpm[u.profile] = u.tokens_per_min })
    const past = snap.mode === 'demo' && $history.get().length < 3 ? demoHistory(snap) : $history.get()
    const h = past.concat([{ ts: snap.ts, states, tpm }]); const cutoff = snap.ts - $prefs.get().laneMinutes * 60 - 60
    $history.set(h.filter(p => p.ts >= cutoff))
  }
  // Push from the sensor → fetch now (no faster than once per second).
  let lastPush = 0
  const offEvt = host.onEvent ? host.onEvent(`plugin.${ID}.fleet.changed`, (payload) => {
    const now = Date.now(); if (now - lastPush < 1000) return; lastPush = now
    if (payload && payload.needs_you > 0 && $prefs.get().focusOnNeedsYou) notice(`${payload.needs_you} unit${payload.needs_you > 1 ? 's' : ''} need${payload.needs_you > 1 ? '' : 's'} you`, 'warn')
    if (timer) { try { timer() } catch (e) { /* already fired */ } }
    tick()
  }) : null
  tick()
  return () => { stopped = true; if (timer) { try { timer() } catch (e) { /* ok */ } } if (typeof offEvt === 'function') offEvt() }
}

// ── actions (every write goes through Hermes' own RPC/REST, never a shell) ───────────────
const actions = {
  openChat(profile) { try { host.newChat(profile === 'default' ? null : profile) } catch (e) { notice(`open chat failed: ${e.message || e}`, 'error') } },
  async steer(profile, sessionId, text) {
    if (!sessionId || !text) return
    try { await host.requestProfile(profile, 'session.steer', { session_id: sessionId, text }); notice(`steered ${profile}`) }
    catch (e) { notice(`steer failed: ${e.message || e}`, 'error') }
  },
  async interrupt(profile, sessionId) {
    if (!sessionId) return
    try { await host.requestProfile(profile, 'session.interrupt', { session_id: sessionId }); notice(`interrupted ${profile}`) }
    catch (e) { notice(`interrupt failed: ${e.message || e}`, 'error') }
  },
  async cron(profile, jobId, action) {
    try { await host.requestProfile(profile, 'cron.manage', { action, job_id: jobId }); notice(`cron ${action}: ${jobId}`) }
    catch (e) { notice(`cron ${action} failed: ${e.message || e}`, 'error') }
  },
  async createTask(ctx, assignee, title, description) {
    try { const r = await ctx.rest('/task', { method: 'POST', body: { assignee, title, description } }); notice(`card ${r.task_id} → ${assignee}`); return r }
    catch (e) { notice(`task refused: ${e.message || e}`, 'error'); return null }
  },
  handCard(profile) { // the create form lives in the drawer: select the unit, then ask it to focus the form
    $selected.set(profile)
    if (($snap.get() || {}).mode !== 'live') return notice('Handing a card needs the live sensor', 'warn')
    $focusCreate.set(Date.now())
  },
  copy(text) { try { navigator.clipboard.writeText(text); notice('copied') } catch (e) { notice('clipboard unavailable', 'error') } }
}

// ── department orbit (canvas): seat in the centre, one cluster per department on an ellipse ──────────
// Cluster angle share ~ sqrt(unit count) so a 21-unit department does not crowd the rest; units are dots
// packed on a hex grid (most urgent in the middle), shaped per state so nothing relies on colour alone.
function hexCells(n) { // first n axial cells ordered by distance from the middle
  let k = 0; while (3 * k * (k + 1) + 1 < n) k++
  const cells = []
  for (let q = -k; q <= k; q++) for (let r = -k; r <= k; r++) if (Math.abs(q + r) <= k) { const x = q + r / 2, y = r * 0.866; cells.push({ x, y, d: Math.hypot(x, y), a: Math.atan2(y, x) }) }
  cells.sort((a, b) => (a.d - b.d) || (a.a - b.a))
  return { cells: cells.slice(0, n), k }
}
function layout(snap, w, h, showIdle) {
  const cx = w / 2, cy = h / 2, pos = {}
  const sp = Math.max(9, Math.min(15, Math.min(w, h) / 24)) // dot spacing
  const groups = (snap.groups || []).map(g => {
    const members = g.profiles.filter(p => p !== snap.owner && snap.units[p] && (showIdle || (snap.units[p].state !== 'idle' && snap.units[p].state !== 'off'))).map(p => snap.units[p]).sort(byPriority)
    return { g, members }
  }).filter(x => x.members.length)
  const weight = (n) => Math.max(1.8, Math.sqrt(n)) // floor: tiny clusters keep a gap
  const total = groups.reduce((a, x) => a + weight(x.members.length), 0) || 1
  const maxK = Math.max(1, ...groups.map(x => hexCells(x.members.length).k))
  const Rx = Math.max(60, w / 2 - (maxK + 1.2) * sp - 60), Ry = Math.max(40, h / 2 - (maxK + 1) * sp - 22)
  let a0 = -Math.PI / 2
  const clusters = groups.map(({ g, members }) => {
    const span = (weight(members.length) / total) * Math.PI * 2; const a = a0 + span / 2; a0 += span
    const { cells, k } = hexCells(members.length)
    const ccx = cx + Math.cos(a) * Rx, ccy = cy + Math.sin(a) * Ry, radius = (k + 0.7) * sp
    members.forEach((u, i) => { pos[u.profile] = { x: ccx + cells[i].x * sp, y: ccy + cells[i].y * sp } })
    return { id: g.id, label: g.label, cx: ccx, cy: ccy, a, radius, n: members.length, active: members.filter(u => u.state === 'working' || u.state === 'task').length, hot: members.some(u => u.state === 'blocked') ? 'blocked' : (members.some(u => u.state === 'failed') ? 'failed' : null), members }
  })
  if (snap.owner && snap.units[snap.owner]) pos[snap.owner] = { x: cx, y: cy }
  return { pos, clusters, cx, cy, Rx, Ry, sp }
}

// Label placement, pure so it can be tested: cluster labels first (outer side, above, below, left, right, then nudged
// outward along the ray until free), then up to 2 urgent unit labels per cluster (+ the selected one) outside the
// cluster's dot area with a leader line. Returns every box so callers can check there is no overlap.
function orbitLabels(view, L, w, h, measure, opt) {
  opt = opt || {}
  const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  const inside = (b) => b.x >= 2 && b.y >= 2 && b.x + b.w <= w - 2 && b.y + b.h <= h - 2
  const dotBoxes = L.clusters.map(cl => ({ x: cl.cx - cl.radius, y: cl.cy - cl.radius * 0.9, w: cl.radius * 2, h: cl.radius * 1.8 }))
  const boxes = [{ x: L.cx - 16, y: L.cy + 14, w: 32, h: 14 }]
  const free = (b, skipDots) => inside(b) && !boxes.some(o => hit(b, o)) && !dotBoxes.some((o, i) => i !== skipDots && hit(b, o))
  const clusters = L.clusters.map((cl, i) => {
    const text = `${cl.label}  ${cl.n} · ${cl.active} active`; const tw = measure(text, true)
    const dx = Math.cos(cl.a), dy = Math.sin(cl.a), R = cl.radius
    const cand = [
      dx > 0 ? { x: cl.cx + R + 8, y: cl.cy - 7 } : { x: cl.cx - R - 8 - tw, y: cl.cy - 7 },
      { x: cl.cx - tw / 2, y: cl.cy - R - 17 }, { x: cl.cx - tw / 2, y: cl.cy + R + 4 },
      { x: cl.cx - R - 8 - tw, y: cl.cy - 7 }, { x: cl.cx + R + 8, y: cl.cy - 7 }
    ].map(c => ({ x: c.x, y: c.y, w: tw, h: 14 }))
    let box = cand.find(b => free(b, i))
    for (let k = 1; !box && k <= 30; k++) { // nudge outward along the ray
      const d = R + 8 + k * 8; const ax = cl.cx + dx * d, ay = cl.cy + dy * d
      const b = { x: dx > 0.3 ? ax : (dx < -0.3 ? ax - tw : ax - tw / 2), y: ay - 7 + (Math.abs(dx) <= 0.3 ? (dy > 0 ? 8 : -8) : 0), w: tw, h: 14 }
      if (free(b, i)) box = b
    }
    if (!box) box = { ...cand[0], x: Math.max(2, Math.min(w - tw - 2, cand[0].x)), y: Math.max(2, Math.min(h - 16, cand[0].y)) }
    boxes.push(box)
    return { id: cl.id, text, box }
  })
  const units = []
  L.clusters.forEach((cl, i) => {
    let n = 0
    cl.members.forEach(u => {
      const urgent = u.state === 'blocked' || u.state === 'failed' || u.state === 'task' || u.state === 'working'
      const isSel = opt.sel === u.profile
      if (!isSel && !(urgent && n < 2 && (!opt.matches || opt.matches(u)))) return
      const p = L.pos[u.profile]; if (!p) return
      const name = unitName(u); const tw = measure(name, false)
      let vx = p.x - cl.cx, vy = p.y - cl.cy; let vl = Math.hypot(vx, vy)
      if (vl < 1) { vx = Math.cos(cl.a); vy = Math.sin(cl.a); vl = 1 }
      const dirs = [[vx / vl, vy / vl], [Math.cos(cl.a), Math.sin(cl.a)], [0, -1], [0, 1], [-1, 0], [1, 0]]
      let box = null, from = null
      for (const [ux, uy] of dirs) { for (let k = 0; k < 14 && !box; k++) {
        const d = cl.radius + 6 + k * 8; const ax = cl.cx + ux * d, ay = cl.cy + uy * d
        const b = { x: ux >= 0.3 ? ax : (ux <= -0.3 ? ax - tw : ax - tw / 2), y: ay - 7, w: tw, h: 14 }
        if (free(b, i) && !hit(b, dotBoxes[i])) { box = b; from = { x: ax, y: ay } }
      } if (box) break }
      if (!box && isSel) { box = { x: Math.max(2, Math.min(w - tw - 2, p.x + 8)), y: Math.max(2, Math.min(h - 16, p.y - 7)), w: tw, h: 14 }; from = { x: p.x, y: p.y } }
      if (!box) return
      boxes.push(box); if (urgent) n++
      units.push({ p: u.profile, text: name, box, from, dot: p, sel: isSel })
    })
  })
  return { clusters, units, boxes }
}
function drawDot(c, shape, x, y, r, col) {
  c.fillStyle = col; c.strokeStyle = col; c.lineWidth = 1.6
  if (shape === 'blocked') { c.beginPath(); c.moveTo(x, y - r - 1); c.lineTo(x + r + 1, y); c.lineTo(x, y + r + 1); c.lineTo(x - r - 1, y); c.closePath(); c.fill() }
  else if (shape === 'failed') { c.beginPath(); c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.moveTo(x + r, y - r); c.lineTo(x - r, y + r); c.stroke() }
  else if (shape === 'task') { c.beginPath(); c.moveTo(x - r * 0.8, y - r); c.lineTo(x + r, y); c.lineTo(x - r * 0.8, y + r); c.closePath(); c.fill() }
  else if (shape === 'working') { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill() }
  else if (shape === 'idle') { c.beginPath(); c.arc(x, y, r - 0.5, 0, Math.PI * 2); c.stroke() }
  else { c.beginPath(); c.moveTo(x - r, y); c.lineTo(x + r, y); c.stroke() }
}

function Constellation({ ctx, onPick }) {
  const ref = useRef(null); const wrap = useRef(null)
  const selected = useAtom($selected)
  const anim = useRef({ t: 0, hover: null, hits: [], labels: [] })
  // Resize: set width/height ATTRIBUTES from the container (hard rule 5).
  useEffect(() => {
    const el = wrap.current, c = ref.current; if (!el || !c) return
    const fit = () => { const r = el.getBoundingClientRect(); const dpr = Math.min(2, window.devicePixelRatio || 1); c.width = Math.max(1, Math.floor(r.width * dpr)); c.height = Math.max(1, Math.floor(r.height * dpr)); c.style.width = r.width + 'px'; c.style.height = r.height + 'px' }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const c = ref.current; if (!c) return
    let raf = 0, last = performance.now(), alive = true
    const draw = (now) => {
      if (!alive) return
      const dt = Math.min(0.1, (now - last) / 1000); last = now
      const A = anim.current; A.t += dt
      const g2 = c.getContext('2d'); if (!g2) return
      const dpr = Math.min(2, window.devicePixelRatio || 1); const w = c.width / dpr, h = c.height / dpr
      g2.setTransform(dpr, 0, 0, dpr, 0, 0); g2.clearRect(0, 0, w, h)
      const s = $snap.get(); if (!s) { raf = requestAnimationFrame(draw); return }
      // Replay: substitute historical states when scrubbing.
      const rt = $replayT.get(); let view = s
      if (rt != null) { const pt = nearest($history.get(), rt); if (pt) { view = { ...s, units: {} }; Object.values(s.units).forEach(u => { view.units[u.profile] = { ...u, state: pt.states[u.profile] || 'off', tokens_per_min: (pt.tpm || {})[u.profile] || 0 } }) } }
      const P = palette(c); const pf = $prefs.get(); const f = $filter.get(); const sel = $selected.get()
      const L = layout(view, w, h, pf.showIdle)
      const motion = pf.reducedMotion ? 0 : 1
      const q = f.q
      const matches = (u) => unitMatches(u, q) && f.states.has(u.state) && (!f.group || f.group === u.group || u.profile === view.owner)
      A.hits = []; A.labels = []
      // seat → hot clusters
      g2.lineWidth = 1
      L.clusters.forEach(cl => { if (!cl.hot) return; g2.strokeStyle = P[cl.hot]; g2.globalAlpha = 0.45; g2.beginPath(); g2.moveTo(L.cx, L.cy); g2.lineTo(cl.cx, cl.cy); g2.stroke(); g2.globalAlpha = 1 })
      // seat
      const seatU = view.units[view.owner]
      g2.fillStyle = P.muted; g2.font = `${10 * P.z}px ${P.sans}`; g2.textAlign = 'center'
      g2.strokeStyle = P.muted; g2.beginPath(); g2.arc(L.cx, L.cy, 11, 0, Math.PI * 2); g2.stroke()
      if (seatU) { drawDot(g2, seatU.state, L.cx, L.cy, 5, P[seatU.state] || P.idle); A.hits.push({ p: view.owner, x: L.cx, y: L.cy }) }
      g2.fillText('you', L.cx, L.cy + 24)
      const LB = orbitLabels(view, L, w, h, (t, bold) => { g2.font = bold ? `600 ${11 * P.z}px ${P.sans}` : `${11 * P.z}px ${P.sans}`; return g2.measureText(t).width }, { sel, matches })
      LB.clusters.forEach(cl => {
        g2.font = `600 ${11 * P.z}px ${P.sans}`; g2.globalAlpha = f.group && f.group !== cl.id ? 0.4 : 1; g2.fillStyle = f.group === cl.id ? P.accent : P.text; g2.textAlign = 'left'
        g2.fillText(cl.text, cl.box.x, cl.box.y + 11); g2.globalAlpha = 1; A.labels.push({ id: cl.id, ...cl.box })
      })
      // dots
      L.clusters.forEach(cl => {
        cl.members.forEach(u => {
          const p = L.pos[u.profile]; if (!p) return
          const m = matches(u); const r = pf.density === 'compact' ? 3.6 : 4.4
          g2.globalAlpha = m ? 1 : 0.18
          if (u.state === 'blocked') { const fl = 0.5 + 0.5 * Math.sin(A.t * 5 * motion); g2.fillStyle = P.blocked; g2.globalAlpha = (m ? 1 : 0.18) * (0.15 + fl * 0.25); g2.beginPath(); g2.arc(p.x, p.y, r + 4 + fl * 2, 0, Math.PI * 2); g2.fill(); g2.globalAlpha = m ? 1 : 0.18 }
          drawDot(g2, u.state, p.x, p.y, r, P[u.state] || P.idle)
          if ((u.anomalies || []).length) { g2.fillStyle = P.accent; g2.beginPath(); g2.arc(p.x + r + 1, p.y - r - 1, 1.8, 0, Math.PI * 2); g2.fill() }
          if (sel === u.profile) { g2.strokeStyle = P.accent; g2.lineWidth = 1.2; g2.beginPath(); g2.arc(p.x, p.y, r + 4, 0, Math.PI * 2); g2.stroke() }
          A.hits.push({ p: u.profile, x: p.x, y: p.y })
          g2.globalAlpha = 1
        })
      })
      LB.units.forEach(l => {
        g2.strokeStyle = P.muted; g2.globalAlpha = 0.5; g2.lineWidth = 1; g2.beginPath(); g2.moveTo(l.dot.x, l.dot.y); g2.lineTo(l.from.x, l.from.y); g2.stroke(); g2.globalAlpha = 1
        g2.font = `${11 * P.z}px ${P.sans}`; g2.fillStyle = l.sel ? P.accent : P.text; g2.textAlign = 'left'; g2.fillText(l.text, l.box.x, l.box.y + 11)
      })
      // hover tooltip
      const hv = A.hover && view.units[A.hover], hp = hv && (L.pos[A.hover])
      if (hv && hp) {
        const lines = [`${unitName(hv)} · ${STATE_LABEL[hv.state]}${hv.since ? ' · ' + fmtAge(view.ts - hv.since) : ''}`, unitTask(hv) ? `task: ${unitTask(hv).title}` : (hv.latest_session && hv.latest_session.title ? `last: ${hv.latest_session.title}` : ''), hv.model ? `model: ${hv.model}` : '', hv.cost_today_usd ? `today: ${fmtTok(hv.tokens_today)} tok · ${fmtUsd(hv.cost_today_usd)}` : ''].filter(Boolean)
        g2.font = `${11 * P.z}px ${P.sans}`; const tw = Math.max(...lines.map(l => g2.measureText(l).width)) + 16; const th = lines.length * 15 + 10
        const tx = Math.min(w - tw - 4, Math.max(4, hp.x + 12)), ty = Math.max(4, Math.min(h - th - 4, hp.y - th - 8))
        g2.fillStyle = P.tip; g2.fillRect(tx, ty, tw, th); g2.strokeStyle = P.muted; g2.lineWidth = 1; g2.strokeRect(tx + 0.5, ty + 0.5, tw - 1, th - 1)
        g2.fillStyle = P.text; g2.textAlign = 'left'; lines.forEach((l, i) => g2.fillText(l, tx + 8, ty + 16 + i * 15))
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => { alive = false; cancelAnimationFrame(raf) }
  }, [selected])
  const at = (ev) => {
    const c = ref.current; if (!c) return {}; const r = c.getBoundingClientRect(); const x = ev.clientX - r.left, y = ev.clientY - r.top
    const A = anim.current; let best = null, bd = 10 * 10
    A.hits.forEach(hh => { const d = (hh.x - x) ** 2 + (hh.y - y) ** 2; if (d < bd) { bd = d; best = hh.p } })
    const lab = best ? null : A.labels.find(l => x >= l.x - 2 && x <= l.x + l.w + 2 && y >= l.y - 2 && y <= l.y + l.h + 2)
    return { p: best, group: lab && lab.id }
  }
  return jsx('div', { ref: wrap, className: 'ck-canvas-wrap', style: { position: 'relative', flex: '1 1 0', minHeight: 0, overflow: 'hidden' }, children:
    jsx('canvas', { ref, 'aria-label': 'Department orbit: units grouped by department', role: 'img', style: { display: 'block', position: 'absolute', top: 0, left: 0, cursor: 'pointer' },
      onMouseMove: (e) => { anim.current.hover = at(e).p }, onMouseLeave: () => { anim.current.hover = null },
      onClick: (e) => { const { p, group } = at(e); if (group) { const f = $filter.get(); $filter.set({ ...f, group: f.group === group ? null : group }); return } $selected.set(p); if (p && onPick) onPick(p) },
      onDoubleClick: (e) => { const { p } = at(e); if (p) actions.openChat(p) } })
  })
}
function nearest(hist, t) { let best = null, bd = Infinity; for (const p of hist) { const d = Math.abs(p.ts - t); if (d < bd) { bd = d; best = p } } return best }

// ── swimlanes (history strip with replay scrubber) ──────────────────────────────────────
function Swimlanes({ ctx }) {
  const ref = useRef(null); const wrap = useRef(null)
  const snap = useAtom($snap); const hist = useAtom($history); const prefs = useAtom($prefs); const replayT = useAtom($replayT); const selected = useAtom($selected); const dimS = useAtom($dim)
  const rows = useMemo(() => {
    if (!snap) return []
    if (prefs.laneBy === 'unit') return unitsOf(snap).filter(u => prefs.showIdle || u.state !== 'idle').map(u => ({ id: u.profile, label: u.profile, members: [u.profile] }))
    return (snap.groups || []).map(g => ({ id: g.id, label: g.label, members: g.profiles }))
  }, [snap, prefs.laneBy, prefs.showIdle])
  useEffect(() => {
    const el = wrap.current, c = ref.current; if (!el || !c) return
    const fit = () => { const r = el.getBoundingClientRect(); const dpr = Math.min(2, window.devicePixelRatio || 1); c.width = Math.max(1, Math.floor(r.width * dpr)); c.height = Math.max(1, Math.floor(r.height * dpr)); c.style.width = r.width + 'px'; c.style.height = r.height + 'px'; paint() }
    const paint = () => {
      const ctx2 = c.getContext('2d'); if (!ctx2 || !snap) return
      const dpr = Math.min(2, window.devicePixelRatio || 1); const w = c.width / dpr, h = c.height / dpr
      ctx2.setTransform(dpr, 0, 0, dpr, 0, 0); ctx2.clearRect(0, 0, w, h)
      const P = palette(c); const now = snap.ts; const span = prefs.laneMinutes * 60; const x0 = 110, x1 = w - 8
      const X = (t) => x0 + ((t - (now - span)) / span) * (x1 - x0)
      const rowH = Math.max(8, Math.min(20, (h - 18) / Math.max(1, rows.length)))
      ctx2.font = `${11 * P.z}px ${P.sans}`
      rows.forEach((row, i) => {
        const y = 4 + i * rowH
        ctx2.fillStyle = P.muted; ctx2.textAlign = 'right'; ctx2.fillText(row.label.slice(0, 16), x0 - 8, y + rowH * 0.65)
        ctx2.fillStyle = P.border; ctx2.fillRect(x0, y + rowH / 2, x1 - x0, 1)
        // per member: draw segments for non-idle states from consecutive history points
        row.members.forEach((p, j) => {
          const lanes = Math.max(1, row.members.length); const sub = (rowH - 6) / lanes; const yy = y + 3 + j * sub
          let seg = null
          const flush = (endT) => { if (!seg) return; ctx2.fillStyle = P[seg.state] || P.idle; ctx2.globalAlpha = selected && selected !== p ? 0.35 : 0.9; ctx2.fillRect(Math.max(x0, X(seg.t0)), yy, Math.max(1.5, X(endT) - X(seg.t0)), Math.max(1.5, sub - 1)); ctx2.globalAlpha = 1; seg = null }
          hist.forEach((pt, k) => {
            const st = pt.states[p]; const live = st && st !== 'idle' && st !== 'off'
            if (seg && (!live || seg.state !== st)) flush(pt.ts)
            if (live && !seg) seg = { state: st, t0: pt.ts }
            if (k === hist.length - 1 && seg) flush(now)
          })
        })
      })
      // time ticks
      ctx2.fillStyle = P.muted; ctx2.textAlign = 'center'; ctx2.font = `${10 * P.z}px ${P.mono}`
      for (let m = 0; m <= prefs.laneMinutes; m += Math.max(5, Math.round(prefs.laneMinutes / 6))) { const x = X(now - m * 60); ctx2.fillRect(x, h - 14, 1, 4); ctx2.fillText(m === 0 ? 'now' : `-${m}m`, x, h - 2) }
      if (replayT != null) { const x = X(replayT); ctx2.fillStyle = P.text; ctx2.fillRect(x, 0, 1.5, h - 16); ctx2.textAlign = 'left'; ctx2.fillText(fmtClock(replayT), Math.min(x + 4, w - 70), 10) }
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect()
  }, [snap, hist, rows, prefs.laneMinutes, replayT, selected])
  const scrub = (e, release) => {
    const c = ref.current; if (!c || !snap) return; const r = c.getBoundingClientRect(); const x = e.clientX - r.left; const x0 = 110, x1 = r.width - 8
    if (release || x >= x1 - 6) { $replayT.set(null); return }
    const frac = Math.max(0, Math.min(1, (x - x0) / (x1 - x0))); $replayT.set(snap.ts - prefs.laneMinutes * 60 * (1 - frac))
  }
  const drag = useRef(false)
  const autoH = Math.max(60, Math.min(dimS.short ? 96 : 140, 22 + rows.length * 12))
  return jsxs('div', { className: 'ck-lanes-box', children: [
    ctx && jsx(Handle, liveHandle(ctx, 'lanesH', { axis: 'y', sign: -1, value: prefs.lanesH || autoH, min: 60, max: 400, label: 'Swimlanes height', cls: 'ht' })),
    jsxs('div', { className: 'ck-lh', children: [`last ${prefs.laneMinutes} min`, ...STATES.map(s => jsxsk('span', { key: s, className: `ck-leg ck-st-${s}`, children: [jsx(Glyph, { s }), STATE_LABEL[s]] }))] }),
    jsx('div', { ref: wrap, className: 'ck-lanes', style: { height: prefs.lanesH || Math.max(60, Math.min(dimS.short ? 96 : 140, 22 + rows.length * 12)), position: 'relative' }, children:
      jsx('canvas', { ref, 'aria-label': 'Swimlanes', role: 'img', style: { display: 'block', cursor: 'ew-resize' },
        onMouseDown: (e) => { drag.current = true; scrub(e) }, onMouseMove: (e) => { if (drag.current) scrub(e) },
        onMouseUp: (e) => { drag.current = false }, onMouseLeave: () => { drag.current = false }, onDoubleClick: () => $replayT.set(null) }) })
  ] })
}

// ── house style: one injected stylesheet; palette lives in CSS custom properties ─────────
// theme 'gsp' = navy/gold house style; theme 'app' maps the same names onto the app's --ui-* variables.
const CK_RAW = `
.hermes-cockpit[data-ck-theme=gsp]{--ck-bg:#0A1628;--ck-surface:#0F1F38;--ck-tip:#16294A;--ck-accent:#FAC800;--ck-on-accent:#0A1628;} /* VAR_FALLBACK */
.hermes-cockpit[data-ck-theme=gsp]{--ck-text:#E8ECF3;--ck-muted:#8B97AD;--ck-line:rgba(255,255,255,.08);--ck-line-gold:rgba(250,200,0,.10);} /* VAR_FALLBACK */
.hermes-cockpit[data-ck-theme=gsp]{--ck-s-blocked:#FAC800;--ck-s-failed:#FF5D5D;--ck-s-task:#F2F5FA;--ck-s-working:#8FB3E8;--ck-s-idle:#5B6B85;--ck-s-off:#3A4760;} /* VAR_FALLBACK */
.hermes-cockpit[data-ck-theme=gsp]{--ck-serif:'Newsreader',Georgia,'Times New Roman',serif;--ck-sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--ck-mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.hermes-cockpit[data-ck-theme=app]{--ck-bg:transparent;--ck-surface:var(--ui-surface);--ck-tip:var(--ui-border);--ck-accent:var(--ui-accent);--ck-on-accent:var(--ui-text-on-accent,#000);} /* VAR_FALLBACK */
.hermes-cockpit[data-ck-theme=app]{--ck-text:var(--ui-text);--ck-muted:var(--ui-text-secondary);--ck-line:var(--ui-border);--ck-line-gold:var(--ui-border);}
.hermes-cockpit[data-ck-theme=app]{--ck-s-blocked:var(--ui-danger);--ck-s-failed:var(--ui-warning);--ck-s-task:var(--ui-accent);--ck-s-working:var(--ui-success);--ck-s-idle:var(--ui-text-secondary);--ck-s-off:var(--ui-border);}
.hermes-cockpit[data-ck-theme=app]{--ck-serif:system-ui,sans-serif;--ck-sans:system-ui,sans-serif;--ck-mono:ui-monospace,monospace;}
.hermes-cockpit{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--ck-bg);color:var(--ck-text);font:13px/1.35 var(--ck-sans);}
.hermes-cockpit *{box-sizing:border-box;}
.hermes-cockpit>*{flex-shrink:0;min-width:0;}
.hermes-cockpit button{font:inherit;color:inherit;cursor:pointer;border-radius:3px;}
.hermes-cockpit button:focus-visible,.hermes-cockpit input:focus-visible,.hermes-cockpit select:focus-visible{outline:2px solid var(--ck-accent);outline-offset:1px;}
.hermes-cockpit .ck-st-blocked{--ck-sc:var(--ck-s-blocked);} .hermes-cockpit .ck-st-failed{--ck-sc:var(--ck-s-failed);} .hermes-cockpit .ck-st-task{--ck-sc:var(--ck-s-task);}
.hermes-cockpit .ck-st-working{--ck-sc:var(--ck-s-working);} .hermes-cockpit .ck-st-idle{--ck-sc:var(--ck-s-idle);} .hermes-cockpit .ck-st-off{--ck-sc:var(--ck-s-off);}
.ck-g{color:var(--ck-sc);display:inline-block;min-width:1em;text-align:center;}
.ck-mono{font-family:var(--ck-mono);}
.ck-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
.ck-bar{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;padding:6px 12px;background:var(--ck-surface);border-bottom:1px solid var(--ck-line-gold);}
.ck-brand{display:flex;align-items:center;gap:10px;min-width:0;flex:0 1 auto;}
.ck-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 17px var(--ck-serif);letter-spacing:.01em;}
.ck-seg{display:inline-flex;border:1px solid var(--ck-line);border-radius:3px;overflow:hidden;}
.ck-seg span{padding:2px 9px;font:600 10px var(--ck-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ck-muted);}
.ck-seg span.on{background:var(--ck-accent);color:var(--ck-on-accent);}
.ck-chips{display:flex;flex-wrap:wrap;gap:5px;}
.ck-kcl{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin-left:auto;}
.ck-medium .ck-chip .lb,.ck-narrow .ck-chip .lb{display:none;}
.ck-medium .ck-kpi span,.ck-narrow .ck-kpi span{font-size:9px;}

.ck-chip{display:inline-flex;align-items:center;flex:none;gap:5px;height:22px;padding:0 8px;white-space:nowrap;border:1px solid var(--ck-line);border-radius:999px;background:transparent;font-size:11px;letter-spacing:.05em;text-transform:uppercase;}
.ck-chip:hover{border-color:var(--ck-accent);}
.ck-chip .n{font-family:var(--ck-mono);font-weight:600;}
.ck-chip.dim{opacity:.45;}
.ck-chip.sel{border-color:var(--ck-accent);color:var(--ck-accent);}
.ck-chip.hot{background:var(--ck-s-blocked);border-color:var(--ck-s-blocked);color:var(--ck-on-accent);font-weight:600;}
.ck-chip.hot .ck-g{color:inherit;}
.ck-chip.bad{border-color:var(--ck-s-failed);color:var(--ck-s-failed);}
.ck-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ck-s-failed);}
.ck-kpi{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 5px;line-height:1.15;white-space:nowrap;}
.ck-kpi b{font:600 13px var(--ck-mono);font-variant-numeric:tabular-nums;}
.ck-kpi span{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ck-muted);}
.ck-kpi.warn b{color:var(--ck-accent);} .ck-kpi.bad b{color:var(--ck-s-failed);}
.ck-gauge{flex-basis:100%;min-width:90px;height:3px;margin-top:2px;background:var(--ck-line);border-radius:3px;overflow:hidden;}
.ck-gauge i{display:block;height:100%;background:var(--ck-accent);}
.ck-gauge.over i{background:var(--ck-s-failed);}
.ck-note{padding:4px 14px;font-size:11px;color:var(--ck-muted);}
.ck-note.demo{color:var(--ck-accent);}
.ck-toast{font-size:12px;} .ck-toast.error{color:var(--ck-s-failed);} .ck-toast.warn{color:var(--ck-accent);}
.ck-rail{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px 8px;padding:5px 12px;border-bottom:1px solid var(--ck-line);font-size:11px;}
.ck-sp{flex:1;}
.ck-rchips{display:flex;flex:1 1 300px;min-width:0;flex-wrap:wrap;align-items:center;gap:5px;position:relative;}
.ck-pop{position:absolute;top:26px;right:0;z-index:20;min-width:200px;max-height:240px;overflow-y:auto;padding:4px;background:var(--ck-tip);border:1px solid var(--ck-line-gold);border-radius:3px;box-shadow:0 6px 18px rgba(0,0,0,.35);}
.ck-pop button{display:flex;width:100%;gap:8px;justify-content:space-between;padding:4px 8px;border:0;background:none;text-align:left;font-size:12px;}
.ck-pop button:hover{background:var(--ck-line);}
.ck-rpin{display:flex;flex:0 1 auto;flex-wrap:wrap;align-items:center;gap:6px;margin-left:auto;}
.ck-narrow .ck-board{display:none;} .ck-narrow .ck-input{min-width:0;width:120px;}
.ck-board{color:var(--ck-muted);font-family:var(--ck-mono);font-size:11px;}
.ck-input{background:var(--ck-surface);border:1px solid var(--ck-line);color:var(--ck-text);border-radius:3px;padding:4px 8px;font:12px var(--ck-sans);min-width:150px;}
.ck-btn{padding:4px 10px;border:1px solid var(--ck-line);background:transparent;font-size:12px;}
.ck-btn:hover{border-color:var(--ck-accent);}
.ck-btn.sm{padding:2px 8px;font-size:11px;}
.ck-btn.on{border-color:var(--ck-accent);color:var(--ck-accent);}
.ck-btn.gold{background:var(--ck-accent);border-color:var(--ck-accent);color:var(--ck-on-accent);font-weight:600;}
.ck-vt{display:inline-flex;gap:0;}
.ck-vt .ck-btn:first-child{border-radius:3px 0 0 3px;} .ck-vt .ck-btn:last-child{border-radius:0 3px 3px 0;border-left:0;}
.ck-queue{padding:6px 12px 8px;background:var(--ck-surface);border-bottom:1px solid var(--ck-line-gold);}
.ck-qh{display:flex;align-items:center;gap:8px;margin-bottom:6px;font:600 11px var(--ck-sans);letter-spacing:.1em;text-transform:uppercase;color:var(--ck-accent);}
.ck-qh button{border:0;background:none;padding:0 4px;color:inherit;}
.ck-qrow{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px;}
.ck-card{height:56px;min-width:0;display:flex;align-items:stretch;gap:6px;padding:0 8px 0 0;border:1px solid var(--ck-line);border-top:2px solid var(--ck-sc);border-radius:3px;background:var(--ck-bg);}
.ck-cb{flex:1;display:flex;flex-direction:column;justify-content:center;gap:3px;min-width:0;padding:0 0 0 10px;border:0;background:none;text-align:left;}
.ck-l1{display:flex;align-items:baseline;gap:6px;min-width:0;}
.ck-l1 .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ck-l1 .gr{color:var(--ck-muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ck-l1 .age,.ck-l1 .md{margin-left:auto;font:11px var(--ck-mono);color:var(--ck-muted);white-space:nowrap;}
.ck-l2{display:flex;gap:6px;min-width:0;font-size:12px;}
.ck-l2 .id{font-family:var(--ck-mono);color:var(--ck-sc);white-space:nowrap;}
.ck-l2 .tt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ck-muted);}
.ck-ca{display:flex;flex-direction:column;justify-content:center;gap:3px;}
.ck-ca .ck-btn{padding:1px 7px;font-size:10px;line-height:16px;white-space:nowrap;}
.ck-body{position:relative;display:flex;flex:1 1 0;min-height:0;min-width:0;}
.ck-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;}
.ck-scroll{flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:var(--ck-s-idle) transparent;}
.ck-scroll::-webkit-scrollbar{width:6px;} .ck-scroll::-webkit-scrollbar-thumb{background:var(--ck-s-idle);border-radius:3px;}
.ck-grid{padding:12px 14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px 14px;align-content:start;}
.ck-col h3{margin:0 0 8px;padding-bottom:4px;display:flex;align-items:baseline;gap:8px;font:500 16px var(--ck-serif);border-bottom:1px solid var(--ck-line-gold);}
.ck-col h3 small{font:11px var(--ck-mono);color:var(--ck-muted);}
.ck-tiles{display:flex;flex-direction:column;gap:4px;}
.ck-tile{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:1px 8px;width:100%;padding:6px 8px 6px 9px;text-align:left;background:var(--ck-surface);border:1px solid var(--ck-line);border-left:3px solid var(--ck-sc);border-radius:3px;}
.ck-compact .ck-tile{padding:3px 6px 3px 8px;}
.ck-tile:hover{border-color:var(--ck-line-gold);border-left-color:var(--ck-sc);background:var(--ck-tip);}
.ck-tile[aria-pressed=true]{outline:1px solid var(--ck-accent);outline-offset:0;}
.ck-tile .t1{display:flex;align-items:baseline;gap:6px;min-width:0;}
.ck-tile .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;}
.ck-tile .md{font:10px var(--ck-mono);color:var(--ck-muted);white-space:nowrap;max-width:10ch;overflow:hidden;text-overflow:ellipsis;}
.ck-tile .t2{grid-column:1;font:11px var(--ck-mono);color:var(--ck-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ck-tile .t2 .id{color:var(--ck-sc);}
.ck-tile svg{grid-column:2;grid-row:2;display:block;}
.ck-compact .ck-tile svg{display:none;}
.ck-tile.ck-st-idle .nm,.ck-tile.ck-st-off .nm{color:var(--ck-muted);}
.ck-more{width:100%;margin-top:2px;padding:2px 8px;border:1px dashed var(--ck-line);background:none;color:var(--ck-muted);font-size:11px;}
.ck-more:hover{border-color:var(--ck-accent);color:var(--ck-accent);}
.ck-empty{padding:18px 14px;color:var(--ck-muted);font-size:12px;}
.ck-lanes-box{border-top:1px solid var(--ck-line-gold);}
.ck-lh{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;padding:6px 14px 0;font:600 10px var(--ck-sans);letter-spacing:.1em;text-transform:uppercase;color:var(--ck-muted);}
.ck-leg{display:inline-flex;align-items:center;gap:4px;font-weight:400;letter-spacing:.04em;}
.ck-side{display:flex;flex-direction:column;flex:none;width:320px;min-height:0;background:var(--ck-surface);border-left:1px solid var(--ck-line-gold);}
.ck-over{position:absolute;top:0;right:0;bottom:0;width:min(380px,45%);z-index:10;display:flex;flex-direction:column;background:var(--ck-surface);border-left:1px solid var(--ck-line-gold);box-shadow:-8px 0 24px rgba(0,0,0,.35);}
.ck-tabs{display:flex;align-items:center;gap:4px;padding:6px 10px;border-bottom:1px solid var(--ck-line);}
.ck-over .ck-feed{border-top:0;}
.ck-over .ck-drawer{flex:3 1 0;min-height:0;overflow-y:auto;overflow-x:hidden;padding:12px 14px;font-size:12px;}
.ck-drawer{flex:3 1 auto;min-height:0;overflow:auto;padding:12px 14px;font-size:12px;}
.ck-eyebrow{display:flex;align-items:center;gap:8px;font:600 10px var(--ck-sans);letter-spacing:.12em;text-transform:uppercase;color:var(--ck-muted);}
.ck-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border:1px solid var(--ck-sc);border-radius:3px;color:var(--ck-sc);font-weight:600;}
.ck-name{margin:4px 0 2px;font:500 24px/1.15 var(--ck-serif);}
.ck-sub{font:11px var(--ck-mono);color:var(--ck-muted);}
.ck-desc{color:var(--ck-muted);margin:6px 0;}
.ck-task{margin:10px 0;padding:8px 10px;background:var(--ck-bg);border:1px solid var(--ck-line);border-top:2px solid var(--ck-accent);border-radius:3px;}
.ck-task .id{font-family:var(--ck-mono);color:var(--ck-sc);}
.ck-row{display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap;}
.ck-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0;}
.ck-kpis b{display:block;font:500 22px/1.1 var(--ck-serif);font-variant-numeric:tabular-nums;}
.ck-kpis span{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ck-muted);}
.ck-h{margin:14px 0 4px;font:600 10px var(--ck-sans);letter-spacing:.12em;text-transform:uppercase;color:var(--ck-muted);}
.ck-kv{display:flex;gap:8px;padding:2px 0;} .ck-kv>span:first-child{min-width:90px;color:var(--ck-muted);} .ck-kv>span:last-child{word-break:break-word;}
.ck-steps{font:11px var(--ck-mono);}
.ck-steps div{display:flex;gap:8px;padding:1px 0;color:var(--ck-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ck-steps .tl{color:var(--ck-text);}
.ck-cron{display:flex;align-items:center;gap:8px;padding:2px 0;}
.ck-cron .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ck-warn{color:var(--ck-accent);}
.ck-feed{flex:1 1 0;min-height:110px;display:flex;flex-direction:column;border-top:1px solid var(--ck-line-gold);}
.ck-feed .hd{display:flex;gap:8px;align-items:center;padding:8px 14px 4px;font:600 10px var(--ck-sans);letter-spacing:.12em;text-transform:uppercase;color:var(--ck-muted);}
.ck-feed .hd label{text-transform:none;letter-spacing:0;font-weight:400;cursor:pointer;}
.ck-fl{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 14px 10px;font-size:11px;}
.ck-fr{display:flex;gap:8px;align-items:baseline;padding:2px 0;border-bottom:1px dashed var(--ck-line);}
.ck-fr .tm{font:10px var(--ck-mono);color:var(--ck-muted);white-space:nowrap;}
.ck-fr button{background:none;border:0;padding:0;text-align:left;}
.ck-short .ck-bar{flex-wrap:nowrap;height:${SHORT_CHROME.bar}px;padding:0 10px;gap:0 10px;position:relative;}
.ck-short .ck-title{flex:1 1 0;min-width:40px;font-size:15px;}
.ck-short .ck-brand{flex:1 1 0;min-width:0;}
.ck-short .ck-kcl{flex-wrap:nowrap;margin-left:0;gap:0 10px;}
.ck-short .ck-chip{padding:0 6px;}
.ck-short .ck-toast{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ck-short .ck-rail{flex-wrap:nowrap;height:${SHORT_CHROME.rail}px;padding:0 10px;align-items:center;position:relative;}
.ck-short .ck-rchips{flex:1 1 0;max-height:24px;overflow:hidden;align-content:flex-start;}
.ck-short .ck-rchips:has(.ck-pop){overflow:visible;}
.ck-short .ck-board{display:none;}
.ck-pop.right{left:auto;right:0;top:30px;min-width:220px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;}
.ck-searchbar{position:absolute;left:0;right:0;top:0;bottom:0;z-index:12;display:flex;align-items:center;gap:6px;padding:0 10px;background:var(--ck-surface);}
.ck-searchbar .ck-input{flex:1;}
.ck-strip{position:relative;display:flex;align-items:center;gap:6px;height:${SHORT_CHROME.strip}px;padding:0 10px;background:var(--ck-surface);border-bottom:1px solid var(--ck-line-gold);font-size:12px;white-space:nowrap;}
.ck-strip .hd{font:600 11px var(--ck-sans);letter-spacing:.08em;text-transform:uppercase;color:var(--ck-accent);}
.ck-strip .names{flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow:hidden;}
.ck-strip .names button{border:0;background:none;padding:0 2px;color:var(--ck-text);font-size:12px;white-space:nowrap;}
.ck-strip .names button:hover{color:var(--ck-accent);text-decoration:underline;}
.ck-qover{position:absolute;left:0;right:0;top:100%;z-index:15;max-height:300px;overflow-y:auto;overflow-x:hidden;padding:8px 10px;background:var(--ck-surface);border-bottom:1px solid var(--ck-line-gold);box-shadow:0 10px 24px rgba(0,0,0,.4);}
.ck-main{position:relative;}
.ck-lanes-over{position:absolute;left:0;right:0;bottom:0;max-height:40%;overflow:hidden;z-index:12;background:var(--ck-bg);border-top:1px solid var(--ck-line-gold);box-shadow:0 -8px 20px rgba(0,0,0,.35);}
.ck-lanes-over>.ck-btn{position:absolute;top:3px;right:8px;z-index:2;}
.ck-handle{position:absolute;z-index:14;background:transparent;touch-action:none;}
.ck-handle.v{left:-3px;top:0;bottom:0;width:6px;cursor:col-resize;}
.ck-handle.hb{left:0;right:0;bottom:-3px;height:6px;cursor:row-resize;}
.ck-handle.ht{left:0;right:0;top:-3px;height:6px;cursor:row-resize;}
.ck-handle:hover,.ck-handle:focus-visible,.ck-handle.drag{background:var(--ck-accent);outline:none;}
.ck-side{position:relative;}
.ck-lanes-box{position:relative;}
.ck-lay label{display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;}
.ck-lay .ck-row{margin:2px 0;}
.ck-lay select{background:var(--ck-bg);color:var(--ck-text);border:1px solid var(--ck-line);border-radius:3px;padding:2px 4px;font-size:12px;}
.ck-bar{position:relative;}
@media (prefers-reduced-motion:reduce){.hermes-cockpit *{transition:none !important;animation:none !important;}}
`

// Every font size in the sheet is multiplied by --ck-z (text-size control: compact / normal / large).
const CK_CSS = CK_RAW.replace(/(font(?:-size)?:(?:\s*\d{3}\s+|\s*))(\d+(?:\.\d+)?)px/g, '$1calc($2px*var(--ck-z,1))')

const GLYPH = { blocked: '◆', failed: '✕', task: '▶', working: '●', idle: '○', off: '–' }
const STATE_PRI = { blocked: 0, failed: 1, task: 2, working: 3, idle: 4, off: 5 }
const $focusCreate = atom(0)   // bumped by "Hand a card": the drawer focuses its create form

const S = { // used by the Settings page only (rendered outside .hermes-cockpit, so theme variables)
  btn: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--ui-border)', background: 'transparent', color: 'var(--ui-text)', cursor: 'pointer', fontSize: 12 },
  input: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--ui-border)', background: 'transparent', color: 'var(--ui-text)', fontSize: 12, minWidth: 140 }
}
const cx = (...a) => a.filter(Boolean).join(' ')
function Glyph({ s }) { return jsx('span', { className: 'ck-g', 'aria-hidden': 'true', children: GLYPH[s] || '·' }) }
function Badge({ s }) { return jsxs('span', { className: `ck-badge ck-st-${s}`, children: [jsx(Glyph, { s }), STATE_LABEL[s]] }) }
function fmtHM(ts) { try { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch (e) { return '' } }
function shortModel(m) { // 'qwen3.8-flash' -> 'qwen flash', 'deepseek-v4-flash' -> 'deepseek'
  if (!m) return ''
  const toks = String(m).split('/').pop().toLowerCase().replace(/^claude-/, '').split(/[-_\s]+/).map(t => t.replace(/\d[\d.]*$/, '')).filter(t => t && !/^v\d*$/.test(t))
  const j = toks.join(' ')
  return (j.length <= 10 ? j : (toks[0] || j)).slice(0, 10)
}
function countStates(snap) { const c = {}; STATES.forEach(s => { c[s] = 0 }); unitsOf(snap).forEach(u => { if (c[u.state] != null) c[u.state]++ }); return c }
function taskItems(u) { return [].concat(u.blocked || [], u.failed || [], u.task ? [u.task] : []) }
// The card a unit is about: the one it is blocked on, the one that failed, else its running task.
function cleanTitle(t) { return String(t == null ? '' : t).replace(/\\[tnr]/g, ' ').replace(/\s+/g, ' ').trim() } // real and literal \t \n runs -> one space
function unitTask(u) { const t = rawTask(u); return t ? { ...t, title: cleanTitle(t.title) } : null }
function rawTask(u) { return (u.state === 'blocked' && (u.blocked || [])[0]) || (u.state === 'failed' && (u.failed || [])[0]) || u.task || (u.blocked || [])[0] || (u.failed || [])[0] || null }
function unitMatches(u, q) {
  q = (q || '').trim().toLowerCase(); if (!q) return true
  return u.profile.toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q) || taskItems(u).some(t => String(t.id || '').toLowerCase().includes(q) || String(t.title || '').toLowerCase().includes(q))
}
const unitName = (u) => cleanTitle(u.display_name || u.profile)
const groupLabel = (snap, u) => { const g = (snap.groups || []).find(x => x.id === u.group || x.profiles.includes(u.profile)); return g ? g.label : u.group || '' }
const byPriority = (a, b) => (STATE_PRI[a.state] - STATE_PRI[b.state]) || (a.since || 0) - (b.since || 0) || a.profile.localeCompare(b.profile)

function Kpi({ v, l, tone, children }) { return jsxs('div', { className: cx('ck-kpi', tone), children: [jsx('b', { children: v }), jsx('span', { children: l }), children] }) }
function LogoMark() { return jsx('svg', { width: 22, height: 22, viewBox: '0 0 22 22', 'aria-hidden': 'true', children: [jsx('path', { key: 'a', d: 'M11 1.5 20.5 11 11 20.5 1.5 11Z', fill: 'none', stroke: 'var(--ck-accent)', strokeWidth: 1.6 }), jsx('path', { key: 'b', d: 'M11 6.5 15.5 11 11 15.5 6.5 11Z', fill: 'var(--ck-accent)' })] }) }

function Handle({ ctx, axis, sign, value, min, max, label, onChange, onCommit, onReset, cls }) {
  const st = useRef(null); const [drag, setDrag] = useState(false)
  const clamp = (v) => Math.max(min, Math.min(max, Math.round(v)))
  const coord = (e) => axis === 'x' ? e.clientX : e.clientY
  return jsx('div', { className: cx('ck-handle', cls, drag && 'drag'), role: 'separator', tabIndex: 0, 'aria-label': label, 'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal', 'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': Math.round(value),
    title: `${label} (drag, arrow keys, double-click to reset)`,
    onPointerDown: (e) => { st.current = { c: coord(e), v: value }; setDrag(true); try { e.currentTarget.setPointerCapture(e.pointerId) } catch (x) { /* no capture */ } },
    onPointerMove: (e) => { if (st.current) onChange(clamp(st.current.v + (coord(e) - st.current.c) * sign)) },
    onPointerUp: (e) => { if (!st.current) return; const v = clamp(st.current.v + (coord(e) - st.current.c) * sign); st.current = null; setDrag(false); onCommit(v) },
    onDoubleClick: () => onReset(),
    onKeyDown: (e) => {
      const k = axis === 'x' ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 }
      if (k[e.key]) { e.preventDefault(); onCommit(clamp(value + 16 * k[e.key] * sign)) }
    } })
}
// live width/height while dragging stays in memory; the pointer-up commit persists through setPrefs
const liveHandle = (ctx, key, props) => ({ ctx, onChange: (v) => $prefs.set({ ...$prefs.get(), [key]: v }), onCommit: (v) => setPrefs(ctx, { [key]: v }), onReset: () => setPrefs(ctx, { [key]: null }), ...props })

function LayoutMenu({ ctx }) {
  const prefs = useAtom($prefs); const dim = useAtom($dim); const lanesOpen = useAtom($lanesOpen)
  const Tg = (label, on, set) => jsxs('label', { children: [jsx('input', { type: 'checkbox', checked: on, onChange: (e) => set(e.target.checked) }), label] })
  const sec = (key, label) => Tg(label, isOn(prefs, key), (v) => setPrefs(ctx, { [key]: v }))
  const lanesOn = dim.short ? lanesOpen : prefs.showLanes
  return jsxs('div', { className: 'ck-pop right ck-lay', role: 'dialog', 'aria-label': 'Layout', children: [
    sec('showKpis', 'Key figures'), sec('showRail', 'Department rail'), sec('showQueue', 'Needs you'),
    Tg('Swimlanes', !!lanesOn, (v) => dim.short ? $lanesOpen.set(v) : setPrefs(ctx, { showLanes: v })),
    sec('showFeed', 'Feed'),
    jsxs('label', { children: ['Drawer', jsx('select', { 'aria-label': 'Drawer placement', value: prefs.drawerMode, onChange: (e) => setPrefs(ctx, { drawerMode: e.target.value }), children: [['auto', 'Auto'], ['overlay', 'Always slide-over'], ['side', 'Always side column']].map(([v, l]) => jsxk('option', { key: v, value: v, children: l })) })] }),
    jsxs('div', { className: 'ck-row', role: 'group', 'aria-label': 'Text size', children: ['Text', ...['compact', 'normal', 'large'].map(z => jsxk('button', { key: z, type: 'button', className: cx('ck-btn sm', prefs.textSize === z && 'on'), 'aria-pressed': prefs.textSize === z, onClick: () => setPrefs(ctx, { textSize: z }), children: z }))] }),
    jsxs('div', { className: 'ck-row', role: 'group', 'aria-label': 'View', children: ['View', ...[['grid', 'Grid'], ['constellation', 'Orbit']].map(([v, l]) => jsxk('button', { key: v, type: 'button', className: cx('ck-btn sm', prefs.view === v && 'on'), 'aria-pressed': prefs.view === v, onClick: () => setPrefs(ctx, { view: v }), children: l })), jsx('button', { type: 'button', className: 'ck-btn sm', onClick: () => { $tab.set('feed'); $feedOpen.set(true) }, children: 'Open feed' })] }),
    jsx('button', { type: 'button', className: 'ck-btn sm', onClick: () => resetLayout(ctx), children: 'Reset layout' })
  ] })
}

function MissionBar({ ctx }) {
  const snap = useAtom($snap); const mode = useAtom($mode); const err = useAtom($error); const filter = useAtom($filter); const prefs = useAtom($prefs); const n = useAtom($notice); const dim = useAtom($dim); const lanesOpen = useAtom($lanesOpen); const [more, setMore] = useState(false); const [lay, setLay] = useState(false); const short = dim.short; const kp = isOn(prefs, 'showKpis')
  const t = snap ? snap.totals : null; const counts = countStates(snap)
  const ceiling = snap && snap.spend_ceiling_usd; const spend = t ? t.cost_today_usd : 0; const over = !!(ceiling && spend > ceiling)
  const hb = snap && snap.gateway && snap.gateway.heartbeat_age_s
  const toggleState = (s) => { const next = new Set(filter.states); if (next.has(s) && next.size > 1) next.delete(s); else next.add(s); $filter.set({ ...filter, states: next }) }
  return jsxs('div', { className: 'ck-bar', children: [
    jsxs('div', { className: 'ck-brand', children: [
      jsx(LogoMark, {}), jsx('span', { className: 'ck-title', children: snap ? snap.title : 'Hermes Cockpit' }),
      jsx('span', { className: 'ck-seg', role: 'group', 'aria-label': 'Data source', title: err || `data: ${mode}`, children: ['live', 'rpc', 'demo'].filter(m => !short || mode === m || !['live', 'rpc', 'demo'].includes(mode)).map(m => jsxk('span', { key: m, className: mode === m ? 'on' : '', 'aria-current': mode === m ? 'true' : undefined, children: m })) })
    ] }),
    jsx('div', { className: 'ck-chips', role: 'group', 'aria-label': 'Filter by state', children: STATES.map(s => {
      const on = filter.states.has(s)
      return jsxsk('button', { key: s, type: 'button', 'aria-pressed': on, title: `${on ? 'Hide' : 'Show'} ${STATE_LABEL[s]}`, 'aria-label': `${STATE_LABEL[s]} ${counts[s]}`, className: cx('ck-chip', `ck-st-${s}`, !on && 'dim', s === 'blocked' && counts.blocked > 0 && 'hot', s === 'failed' && counts.failed > 0 && 'bad'), onClick: () => toggleState(s), children: [jsx(Glyph, { s }), jsx('span', { className: 'lb', children: STATE_LABEL[s] }), jsx('span', { className: 'n', children: counts[s] })] })
    }) }),
    jsxs('div', { className: 'ck-kcl', children: [
    kp && t && jsx(Kpi, { v: `${fmtTok(t.tokens_per_min)}/min`, l: 'tokens' }),
    kp && t && (short
      ? jsx(Kpi, { v: fmtUsd(spend) + (ceiling ? ` / ${fmtUsd(ceiling)}` : ''), l: 'spend today', tone: over ? 'bad' : '' })
      : jsx(Kpi, { v: fmtUsd(spend) + (ceiling ? ` / ${fmtUsd(ceiling)}` : ''), l: 'spend today', tone: over ? 'bad' : '', children: ceiling ? jsx('div', { className: cx('ck-gauge', over && 'over'), 'aria-hidden': 'true', children: jsx('i', { style: { width: `${Math.min(100, Math.round(spend / ceiling * 100))}%` } }) }) : null })),
    kp && !short && snap && jsx(Kpi, { v: hb == null ? '—' : fmtAge(hb), l: 'gateway hb', tone: hb != null && hb > 300 ? 'warn' : '' }),
    kp && !short && snap && (snap.signals || []).map(sg => jsxk(Kpi, { key: sg.id, v: sg.age_s == null ? '—' : fmtAge(sg.age_s), l: sg.label, tone: sg.ok ? '' : 'bad' })),
    !short && jsx('button', { type: 'button', className: 'ck-btn sm', title: 'Swimlanes (L)', 'aria-pressed': !!prefs.showLanes, onClick: () => setPrefs(ctx, { showLanes: !prefs.showLanes }), children: prefs.showLanes ? 'lanes ▾' : 'lanes ▸' }),
    n && Date.now() - n.at < 6000 && jsx('span', { role: 'status', className: cx('ck-toast', n.kind), children: n.text }),
    jsx('button', { type: 'button', className: cx('ck-btn sm', lay && 'on'), 'aria-expanded': lay, 'aria-haspopup': 'dialog', 'aria-label': 'Layout', title: 'Layout: show, hide, text size', onClick: () => { setLay(!lay); setMore(false) }, children: '▦' }),
    short && jsx('button', { type: 'button', className: cx('ck-btn sm', more && 'on'), 'aria-expanded': more, 'aria-haspopup': 'true', title: 'More: gateway, signals, swimlanes', onClick: () => { setMore(!more); setLay(false) }, children: '⋯' })
    ] }),
    lay && jsx(LayoutMenu, { ctx }),
    short && more && jsxs('div', { className: 'ck-pop right', role: 'menu', children: [
      kp && snap && jsx(Kpi, { v: hb == null ? '—' : fmtAge(hb), l: 'gateway hb', tone: hb != null && hb > 300 ? 'warn' : '' }),
      kp && snap && (snap.signals || []).map(sg => jsxk(Kpi, { key: sg.id, v: sg.age_s == null ? '—' : fmtAge(sg.age_s), l: sg.label, tone: sg.ok ? '' : 'bad' })),
      jsx('button', { type: 'button', className: 'ck-btn sm', 'aria-pressed': lanesOpen, onClick: () => { $lanesOpen.set(!lanesOpen); setMore(false) }, children: lanesOpen ? 'Hide swimlanes' : 'Show swimlanes' })
    ] })
  ] })
}

function GroupRail({ ctx }) {
  const snap = useAtom($snap); const filter = useAtom($filter); const prefs = useAtom($prefs); const dim = useAtom($dim); const feedOpen = useAtom($feedOpen)
  const [cut, setCut] = useState(null); const [pop, setPop] = useState(false); const box = useRef(null); const searchOpen = useAtom($searchOpen); const short = dim.short; const sIn = useRef(null)
  useEffect(() => { if (searchOpen && sIn.current) sIn.current.focus() }, [searchOpen])
  const sig = snap ? (snap.groups || []).map(g => g.id + ':' + g.profiles.length).join('|') + '|' + (filter.group || '') + '|' + dim.w + '|' + (dim.short ? 1 : 2) : ''
  useEffect(() => { setCut(null); setPop(false) }, [sig])
  useEffect(() => { // phase 2: after a full render, count how many chips land in the first two rows
    if (cut !== null) return; const el = box.current; if (!el) return
    const kids = Array.from(el.querySelectorAll('[data-chip]')); if (!kids.length) return
    const tops = Array.from(new Set(kids.map(k => k.offsetTop))).sort((a, b) => a - b)
    const rows = dim.short ? 1 : 2
    if (tops.length <= rows) { setCut(kids.length); return }
    setCut(Math.max(1, kids.filter(k => k.offsetTop < tops[rows]).length - 1))
  })
  if (!snap) return null
  const pick = (id) => { $filter.set({ ...filter, group: filter.group === id ? null : id }); setPop(false) }
  const chips = [{ id: null, label: 'All units', n: snap.totals.units, hot: false }].concat((snap.groups || []).map(g => { const members = g.profiles.map(p => snap.units[p]).filter(Boolean); return { id: g.id, label: g.label, n: members.length, hot: members.some(u => u.state === 'blocked' || u.state === 'failed') } }))
  const shown = cut == null ? chips : chips.slice(0, cut); const hidden = cut == null ? [] : chips.slice(cut)
  const chip = (c) => jsxsk('button', { key: String(c.id), 'data-chip': '1', type: 'button', className: cx('ck-chip', filter.group === c.id && 'sel'), 'aria-pressed': filter.group === c.id, onClick: () => pick(c.id), children: [c.label, ' ', jsx('span', { className: 'n', children: c.n }), c.hot ? jsx('span', { className: 'ck-dot', title: 'needs you or failed' }) : null, c.hot ? jsx('span', { className: 'ck-sr', children: ' needs attention' }) : null] })
  return jsxs('div', { className: 'ck-rail', children: [
    short && searchOpen && jsxs('div', { className: 'ck-searchbar', children: [
      jsx('input', { ref: sIn, className: 'ck-input', 'aria-label': 'Find unit or task id', placeholder: 'Find unit or task id', 'data-ck-search': '1', value: filter.q, onChange: (e) => $filter.set({ ...filter, q: e.target.value }), onKeyDown: (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); $searchOpen.set(false) } } }),
      jsx('button', { type: 'button', className: 'ck-btn sm', 'aria-label': 'Close search', onClick: () => { $searchOpen.set(false) }, children: '×' })
    ] }),
    jsxs('div', { ref: box, className: 'ck-rchips', children: [
      ...shown.map(chip),
      hidden.length ? jsxs('button', { type: 'button', className: cx('ck-chip', hidden.some(c => filter.group === c.id) && 'sel'), 'aria-expanded': pop, 'aria-haspopup': 'true', onClick: () => setPop(!pop), children: [`+${hidden.length}`, hidden.some(c => c.hot) ? jsx('span', { className: 'ck-dot', title: 'needs you or failed' }) : null] }) : null,
      pop && hidden.length ? jsx('div', { className: 'ck-pop', role: 'menu', children: hidden.map(c => jsxsk('button', { key: String(c.id), type: 'button', role: 'menuitem', onClick: () => pick(c.id), children: [jsx('span', { children: c.label + (c.hot ? ' ●' : '') }), jsx('span', { className: 'ck-mono', children: c.n })] })) }) : null
    ] }),
    snap.pipeline && Object.keys(snap.pipeline).length ? jsx('span', { className: 'ck-board', style: { alignSelf: 'center' }, children: 'board: ' + ['todo', 'ready', 'running', 'blocked', 'review', 'done'].filter(k => snap.pipeline[k] != null).map(k => `${k} ${snap.pipeline[k]}`).join(' · ') }) : null,
    jsxs('div', { className: 'ck-rpin', children: [
      !short && jsx('input', { className: 'ck-input', 'aria-label': 'Find unit or task id', placeholder: 'Find unit or task id', 'data-ck-search': '1', value: filter.q, onChange: (e) => $filter.set({ ...filter, q: e.target.value }) }),
      short && jsx('button', { type: 'button', className: cx('ck-btn sm', filter.q && 'on'), 'aria-label': 'Find unit or task id', title: 'Find unit or task id', onClick: () => $searchOpen.set(true), children: '🔍' }),
      jsxs('span', { className: 'ck-vt', role: 'group', 'aria-label': 'View', children: [
        jsx('button', { type: 'button', className: cx('ck-btn sm', prefs.view !== 'constellation' && 'on'), 'aria-pressed': prefs.view !== 'constellation', onClick: () => setPrefs(ctx, { view: 'grid' }), children: 'Grid' }),
        jsx('button', { type: 'button', className: cx('ck-btn sm', prefs.view === 'constellation' && 'on'), 'aria-pressed': prefs.view === 'constellation', onClick: () => setPrefs(ctx, { view: 'constellation' }), children: 'Orbit' })
      ] }),
      (!drawerSide(prefs, dim) && isOn(prefs, 'showFeed')) && jsx('button', { type: 'button', className: cx('ck-btn sm', feedOpen && 'on'), 'aria-pressed': feedOpen, title: 'Event feed', onClick: () => { $tab.set('feed'); $feedOpen.set(!feedOpen) }, children: 'Feed' })
    ] })
  ] })
}

function NeedsQueue({ ctx }) {
  const snap = useAtom($snap); const filter = useAtom($filter); const prefs = useAtom($prefs); const dim = useAtom($dim); const [showAll, setShowAll] = useState(false); const qOpen = useAtom($queueOpen)
  if (!snap) return null
  const list = unitsOf(snap).filter(u => (u.state === 'blocked' || u.state === 'failed') && (!filter.group || u.group === filter.group) && unitMatches(u, filter.q)).sort(byPriority)
  if (!list.length) return null
  const nb = list.filter(u => u.state === 'blocked').length, nf = list.length - nb; const open = !prefs.queueCollapsed
  const cols = Math.max(1, Math.floor((dim.w - 24 + 8) / 308)); const cap = cols * (dim.short ? 1 : 2); const more = list.length > cap
  const vis = more && !showAll ? list.slice(0, cap) : list
  const card = (u) => {
    const t = unitTask(u)
    return jsxsk('div', { key: u.profile, className: `ck-card ck-st-${u.state}`, children: [
      jsxs('button', { type: 'button', className: 'ck-cb', onClick: () => { $selected.set(u.profile); $queueOpen.set(false) }, 'aria-label': `${unitName(u)}, ${STATE_LABEL[u.state]}${t ? ', ' + t.title : ''}`, children: [
        jsxs('span', { className: 'ck-l1', children: [jsx(Glyph, { s: u.state }), jsx('span', { className: 'nm', children: unitName(u) }), jsx('span', { className: 'gr', children: groupLabel(snap, u) }), jsx('span', { className: 'age', children: fmtAge(snap.ts - u.since) })] }),
        jsxs('span', { className: 'ck-l2', children: [t && jsx('span', { className: 'id', children: t.id }), jsx('span', { className: 'tt', children: t ? t.title : STATE_LABEL[u.state] })] })
      ] }),
      jsxs('div', { className: 'ck-ca', children: [
        jsx('button', { type: 'button', className: 'ck-btn sm', onClick: () => actions.openChat(u.profile), children: 'Open chat' }),
        u.state === 'blocked' && jsx('button', { type: 'button', className: 'ck-btn sm', onClick: () => { $queueOpen.set(false); actions.handCard(u.profile) }, children: 'Hand a card' })
      ] })
    ] })
  }
  if (dim.short) { // one 28px strip; the cards open as a panel over the main area, never pushing it down
    return jsxs('section', { className: 'ck-strip', 'aria-label': 'Needs you', children: [
      jsx('span', { className: 'hd', children: `◆ ${list.length} need${list.length === 1 ? 's' : ''} you${nf ? ` · ${nf} failed` : ''}:` }),
      jsx('span', { className: 'names', children: list.flatMap((u, i) => [i ? jsx('span', { key: 'd' + u.profile, 'aria-hidden': 'true', children: '·' }) : null, jsxk('button', { key: u.profile, type: 'button', title: `${STATE_LABEL[u.state]}: ${(unitTask(u) || {}).title || ''}`, onClick: () => { $selected.set(u.profile); $queueOpen.set(false) }, children: unitName(u) })]) }),
      jsx('button', { type: 'button', className: 'ck-btn sm', 'aria-expanded': qOpen, 'aria-label': qOpen ? 'Close the needs-you panel' : 'Open all needs-you cards', onClick: () => $queueOpen.set(!qOpen), children: qOpen ? '▴' : '▾' }),
      qOpen && jsxs('div', { className: 'ck-qover', style: { maxHeight: prefs.queueH || 300 }, children: [jsx('div', { className: 'ck-qrow', children: list.map(card) }), jsx(Handle, liveHandle(ctx, 'queueH', { axis: 'y', sign: 1, value: prefs.queueH || 300, min: 80, max: 600, label: 'Needs-you panel height', cls: 'hb' }))] })
    ] })
  }
  return jsxs('section', { className: 'ck-queue', 'aria-label': 'Needs you', children: [
    jsxs('div', { className: 'ck-qh', children: [`◆ needs you · ${nb} waiting · ${nf} failed`, jsx('button', { type: 'button', 'aria-expanded': open, 'aria-label': open ? 'Collapse the needs-you queue' : 'Expand the needs-you queue', onClick: () => setPrefs(ctx, { queueCollapsed: open }), children: open ? '▾' : '▸' }), open && more ? jsx('button', { type: 'button', className: 'ck-btn sm', 'aria-expanded': showAll, onClick: () => setShowAll(!showAll), children: showAll ? 'show fewer' : `show all ${list.length}` }) : null] }),
    open && jsx('div', { className: 'ck-qrow', children: vis.map(card) })
  ] })
}

function Spark({ vals, w = 64, h = 16 }) {
  const max = Math.max(1, ...vals); const n = vals.length
  const pts = n < 2 ? `0,${h - 1} ${w},${h - 1}` : vals.map((v, i) => `${(i / (n - 1) * w).toFixed(1)},${(h - 1 - (v / max) * (h - 3)).toFixed(1)}`).join(' ')
  return jsx('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true', focusable: 'false', children: jsx('polyline', { points: pts, fill: 'none', stroke: 'var(--ck-sc)', strokeWidth: 1.2, strokeLinejoin: 'round', strokeLinecap: 'round', opacity: n < 2 ? 0.4 : 1 }) })
}
function tileSub(u) {
  const t = unitTask(u)
  if (u.state === 'off') return { text: 'off duty' }
  if (t && u.state !== 'idle') return { id: t.id, text: cleanTitle(u.current_step || t.title || '') }
  if (u.state === 'idle' || !u.latest_session) { const la = u.latest_session && u.latest_session.last_activity_at; return { text: la ? `idle · last run ${fmtHM(la)}` : 'idle' } }
  return { text: cleanTitle(u.latest_session.title) || STATE_LABEL[u.state] }
}

const MAX_TILES = 8
function UnitGrid() {
  const snap = useAtom($snap); const filter = useAtom($filter); const prefs = useAtom($prefs); const sel = useAtom($selected); const hist = useAtom($history)
  const pts = useMemo(() => hist.slice(-30), [hist]); const [open, setOpen] = useState(() => new Set())
  if (!snap) return jsx('div', { className: 'ck-empty', children: 'Waiting for the first snapshot…' })
  const cols = (snap.groups || []).map(g => {
    const members = g.profiles.map(p => snap.units[p]).filter(Boolean)
    const vis = members.filter(u => filter.states.has(u.state) && (prefs.showIdle || (u.state !== 'idle' && u.state !== 'off')) && (!filter.group || filter.group === g.id) && unitMatches(u, filter.q)).sort(byPriority)
    return { g, members, vis }
  }).filter(c => c.vis.length)
  if (!cols.length) return jsx('div', { className: 'ck-empty', children: 'No unit matches the current filter.' })
  return jsx('div', { className: 'ck-grid', style: { minHeight: 360 }, children: cols.map(({ g, members, vis }) => jsxsk('section', { key: g.id, className: 'ck-col', 'aria-label': g.label, children: [
    jsxs('h3', { children: [g.label, jsx('small', { children: `${members.length} · ${members.filter(u => u.state === 'working' || u.state === 'task').length} active` })] }),
    jsx('div', { className: 'ck-tiles', children: vis.slice(0, open.has(g.id) ? vis.length : MAX_TILES).map(u => {
      const sub = tileSub(u)
      return jsxsk('button', { key: u.profile, type: 'button', className: `ck-tile ck-st-${u.state}`, 'aria-pressed': sel === u.profile, 'aria-label': `${unitName(u)}, ${STATE_LABEL[u.state]}, ${(sub.id ? sub.id + ' ' : '') + sub.text}`, title: u.profile, onClick: () => $selected.set(sel === u.profile ? null : u.profile), onDoubleClick: () => actions.openChat(u.profile), children: [
        jsxs('span', { className: 't1', children: [jsx(Glyph, { s: u.state }), jsx('span', { className: 'nm', children: unitName(u) })] }),
        jsx('span', { className: 'md', title: u.model || '', children: shortModel(u.model) }),
        jsxs('span', { className: 't2', children: [sub.id ? jsx('span', { className: 'id', children: sub.id + ' ' }) : null, sub.text] }),
        jsx(Spark, { vals: pts.map(pt => (pt.tpm || {})[u.profile] || 0) })
      ] })
    }) }),
    vis.length > MAX_TILES ? jsx('button', { type: 'button', className: 'ck-more', 'aria-expanded': open.has(g.id), onClick: () => setOpen(o => { const n = new Set(o); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n }), children: open.has(g.id) ? 'Show fewer' : `+${vis.length - MAX_TILES} more` }) : null
  ] })) })
}

let focusHandled = 0
function cleanUnit(u) { // every free-text title the drawer shows goes through cleanTitle
  const ct = (x) => ({ ...x, title: cleanTitle(x.title) })
  return { ...u, blocked: (u.blocked || []).map(ct), failed: (u.failed || []).map(ct), task: u.task ? ct(u.task) : null, latest_session: u.latest_session ? ct(u.latest_session) : null, current_step: u.current_step ? cleanTitle(u.current_step) : u.current_step }
}
function Drawer({ ctx, overlay }) {
  const snap = useAtom($snap); const sel = useAtom($selected); const mode = useAtom($mode); const fc = useAtom($focusCreate)
  const [detail, setDetail] = useState(null); const [steer, setSteer] = useState(''); const [task, setTask] = useState('')
  const createRef = useRef(null)
  useEffect(() => {
    setDetail(null); if (!sel || mode !== 'live') return
    let alive = true; ctx.rest(`/unit/${encodeURIComponent(sel)}`).then(d => { if (alive) setDetail(d) }).catch(() => {})
    return () => { alive = false }
  }, [sel, mode, snap && snap.rev])
  useEffect(() => { // "Hand a card" from the queue: select the unit and put the cursor in its create form
    if (fc === focusHandled) return; focusHandled = fc // module-level: the drawer may mount after the request (slide-over)
    const el = createRef.current; if (!el) return
    try { if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); el.focus() } catch (e) { /* no layout */ }
  }, [fc])
  if (!snap || !sel || !snap.units[sel]) return jsx('div', { className: 'ck-drawer', children: jsx('div', { className: 'ck-note', children: 'Select a unit for its live steps and controls. Double-click opens a chat with it.' }) })
  const u = cleanUnit(snap.units[sel]); const d0 = detail || u; const d = { ...d0, recent_sessions: (d0.recent_sessions || []).map(x => ({ ...x, title: cleanTitle(x.title) })), recent_tool_calls: (d0.recent_tool_calls || []).map(x => ({ ...x, target: x.target == null ? x.target : cleanTitle(x.target) })) }; const sid = u.latest_session && u.latest_session.id; const cur = unitTask(u); const running = u.state === 'working' || u.state === 'task'
  const row = (k, v) => v == null || v === '' ? null : jsxs('div', { className: 'ck-kv', children: [jsx('span', { children: k }), jsx('span', { children: v })] })
  const summary = () => `${u.profile} — ${STATE_LABEL[u.state]} for ${fmtAge(snap.ts - u.since)}${u.task ? `; task ${u.task.id} "${u.task.title}"` : ''}${(u.blocked || []).length ? `; blocked: ${u.blocked.map(b => b.title).join(', ')}` : ''}; today ${fmtTok(u.tokens_today)} tok ${fmtUsd(u.cost_today_usd)}`
  const doSteer = () => { if (steer.trim()) { actions.steer(u.profile, sid, steer.trim()); setSteer('') } }
  return jsxs('div', { className: `ck-drawer ck-st-${u.state}`, children: [
    jsxs('div', { className: 'ck-eyebrow', children: [groupLabel(snap, u), '·', jsx(Badge, { s: u.state }), jsx('span', { className: 'ck-sp' }), !overlay && jsx('button', { type: 'button', className: 'ck-btn sm', onClick: () => $selected.set(null), 'aria-label': 'close', children: '×' })] }),
    jsx('div', { className: 'ck-name', children: unitName(u) }),
    jsx('div', { className: 'ck-sub', children: [u.model, fmtAge(snap.ts - u.since)].filter(Boolean).join(' · ') }),
    u.description && jsx('div', { className: 'ck-desc', children: u.description }),
    cur && jsxs('div', { className: 'ck-task', children: [jsx('div', { className: 'ck-h', style: { margin: '0 0 4px' }, children: 'current task' }), jsxs('div', { children: [jsx('span', { className: 'id', children: cur.id }), ' ', cur.title], }),
      cur.block_kind ? jsx('div', { className: 'ck-sub', children: cur.block_kind }) : null, u.task && cur === u.task ? jsx('div', { className: 'ck-sub', children: [`since ${fmtAge(snap.ts - (u.task.started_at || snap.ts))}`, u.task.created_by, u.task.board].filter(Boolean).join(' · ') }) : null] }),
    jsxs('div', { className: 'ck-row', children: [
      jsx('button', { type: 'button', className: 'ck-btn', onClick: () => actions.openChat(u.profile), children: 'Open chat' }),
      jsx('button', { type: 'button', className: 'ck-btn', onClick: () => actions.copy(summary()), children: 'Copy summary' })
    ] }),
    sid && running && jsxs('div', { className: 'ck-row', children: [
      jsx('input', { className: 'ck-input', style: { flex: 1 }, 'aria-label': 'Steer this turn', placeholder: 'steer this turn…', value: steer, onChange: e => setSteer(e.target.value), onKeyDown: e => { if (e.key === 'Enter') doSteer() } }),
      jsx('button', { type: 'button', className: 'ck-btn', onClick: () => actions.interrupt(u.profile, sid), children: 'Interrupt' }),
      jsx('button', { type: 'button', className: 'ck-btn gold', onClick: doSteer, children: 'Steer' })
    ] }),
    jsxs('div', { className: 'ck-kpis', children: [
      jsxs('div', { children: [jsx('b', { children: fmtUsd(u.cost_today_usd) }), jsx('span', { children: 'cost today' })] }),
      jsxs('div', { children: [jsx('b', { children: fmtTok(u.tokens_today) }), jsx('span', { children: 'tokens today' })] }),
      jsxs('div', { children: [jsx('b', { children: fmtTok(u.tokens_per_min) }), jsx('span', { children: 'tok/min' })] })
    ] }),
    u.blocked && u.blocked.length ? jsxs('div', { children: [jsx('div', { className: 'ck-h', children: 'needs you' }), ...u.blocked.map(b => jsxsk('div', { key: b.id, style: { padding: '3px 0' }, children: [jsx('span', { className: 'ck-mono', children: b.id }), ' ', b.title, b.block_kind ? jsx('span', { style: { color: 'var(--ck-muted)' }, children: ` · ${b.block_kind}` }) : null] }))] }) : null,
    u.failed && u.failed.length ? jsxs('div', { children: [jsx('div', { className: 'ck-h', children: 'failed' }), ...u.failed.map(b => jsxsk('div', { key: b.id, style: { padding: '3px 0' }, children: [jsx('span', { className: 'ck-mono', style: { color: 'var(--ck-s-failed)' }, children: b.id }), ' ', b.title] }))] }) : null,
    (u.anomalies || []).length ? jsxs('div', { children: [jsx('div', { className: 'ck-h', children: 'anomalies' }), ...u.anomalies.map((a, i) => jsxsk('div', { key: i, className: 'ck-warn', children: [a.rule, ' — ', jsx('span', { style: { color: 'var(--ck-muted)' }, children: a.evidence })] }))] }) : null,
    d.recent_tool_calls && d.recent_tool_calls.length ? jsxs('div', { children: [jsx('div', { className: 'ck-h', children: 'live steps' }), jsx('div', { className: 'ck-steps', children: d.recent_tool_calls.slice(0, 10).map((c, i) => jsxsk('div', { key: i, className: c.ok === false ? 'ck-st-failed' : 'ck-st-working', children: [c.ts ? jsx('span', { children: fmtClock(c.ts) }) : null, jsx(Glyph, { s: c.ok === false ? 'failed' : 'working' }), jsx('span', { className: 'tl', children: c.tool }), c.target ? ` ${c.target}` : ''] })) })] }) : null,
    u.cron && u.cron.jobs ? jsxs('div', { children: [jsx('div', { className: 'ck-h', children: `cron · ${u.cron.jobs} job${u.cron.jobs > 1 ? 's' : ''}${u.cron.errors_recent ? ` · ${u.cron.errors_recent} error` : ''}` }),
      ...(u.cron.list || []).slice(0, 8).map(j => jsxsk('div', { key: j.id, className: 'ck-cron', children: [
        jsx('span', { className: 'nm', title: j.schedule || '', children: j.name || j.id }),
        jsx('span', { style: { color: j.last_status === 'error' ? 'var(--ck-s-failed)' : 'var(--ck-muted)' }, children: j.paused ? 'paused' : (j.last_status || '') }),
        jsx('button', { type: 'button', className: 'ck-btn sm', onClick: () => actions.cron(u.profile, j.id, j.paused ? 'resume' : 'pause'), children: j.paused ? 'Resume' : 'Pause' })
      ] }))] }) : null,
    snap.mode === 'live' && jsxs('div', { children: [jsx('div', { className: 'ck-h', children: 'hand a card to this unit' }),
      jsxs('div', { className: 'ck-row', style: { margin: 0 }, children: [
        jsx('input', { ref: createRef, className: 'ck-input', style: { flex: 1 }, 'aria-label': 'Task title', placeholder: 'task title (needs allow_task_create in cockpit.yaml)', value: task, onChange: e => setTask(e.target.value), onKeyDown: e => { if (e.key === 'Enter') e.currentTarget.nextSibling.click() } }),
        jsx('button', { type: 'button', className: 'ck-btn', onClick: async () => { if (task.trim().length >= 3) { const r = await actions.createTask(ctx, u.profile, task.trim(), ''); if (r) setTask('') } }, children: 'Create' })
      ] })] }),
    jsx('div', { className: 'ck-h', children: 'unit' }),
    row('model', u.model), row('sessions today', u.sessions_today), row('subagents', u.delegations || 0), row('heartbeat', u.heartbeat_age_s == null ? null : fmtAge(u.heartbeat_age_s)),
    u.latest_session ? jsxs('div', { children: [jsx('div', { className: 'ck-h', children: 'latest session' }), row('title', u.latest_session.title), row('source', u.latest_session.source), row('activity', u.latest_session.last_activity_at ? fmtAge(snap.ts - u.latest_session.last_activity_at) + ' ago' : null), row('tool calls', u.latest_session.tool_calls)] }) : null,
    d.recent_sessions && d.recent_sessions.length > 1 ? jsxs('div', { children: [jsx('div', { className: 'ck-h', children: 'recent sessions' }), ...d.recent_sessions.slice(0, 6).map(s => jsxsk('div', { key: s.id, className: 'ck-kv', children: [jsx('span', { style: { color: 'var(--ck-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: s.title || s.id }), jsx('span', { className: 'ck-mono', style: { color: 'var(--ck-muted)' }, children: `${fmtTok(s.tokens)} · ${fmtUsd(s.estimated_cost_usd)}` })] }))] }) : null
  ] })
}

function feedGlyph(e) {
  if (e.kind === 'state') { const m = /→\s*(.+)$/.exec(e.text || ''); const s = m && STATES.find(k => STATE_LABEL[k] === m[1].trim()); return s || 'working' }
  return e.kind === 'kanban' ? 'idle' : 'blocked'
}
function Feed() {
  const feed = useAtom($feed); const sel = useAtom($selected); const [onlyMine, setOnlyMine] = useState(false)
  const rows = feed.filter(e => !onlyMine || !sel || e.profile === sel).slice(-80).reverse()
  return jsxs('div', { className: 'ck-feed', children: [
    jsxs('div', { className: 'hd', children: ['feed', jsx('span', { className: 'ck-sp' }), sel && jsxs('label', { children: [jsx('input', { type: 'checkbox', checked: onlyMine, onChange: e => setOnlyMine(e.target.checked) }), ` only ${sel}`] })] }),
    jsx('div', { className: 'ck-fl', children: rows.length ? rows.map(e => { const gs = feedGlyph(e); return jsxsk('div', { key: e.seq, className: `ck-fr ck-st-${gs}`, children: [
      jsx('span', { className: 'tm', children: fmtClock(e.ts) }), jsx(Glyph, { s: gs }),
      e.profile ? jsx('button', { type: 'button', onClick: () => $selected.set(e.profile), children: cleanTitle(e.text) }) : jsx('span', { children: cleanTitle(e.text) })
    ] }) }) : jsx('div', { className: 'ck-note', style: { padding: 0 }, children: 'No events yet — state changes and board events land here.' }) })
  ] })
}

// Layout switches (null = smart default, which is "shown"); Reset puts every one back.
const LAYOUT_DEFAULTS = { showKpis: null, showRail: null, showQueue: null, showFeed: null, drawerMode: 'auto', drawerW: null, queueH: null, lanesH: null, textSize: 'normal' }
const isOn = (p, k) => p[k] !== false
const TEXT_Z = { compact: 0.9, normal: 1, large: 1.15 }
const drawerSide = (p, dim) => p.drawerMode === 'side' || (p.drawerMode !== 'overlay' && dim.size === 'wide')
function resetLayout(ctx) {
  const auto = $dim.get().h < 800; const next = { ...$prefs.get(), ...LAYOUT_DEFAULTS, showLanes: !auto }
  $prefs.set(next); autoLanesOff = auto; const store = { ...next }; if (auto) delete store.showLanes
  try { ctx.storage.set('prefs', store) } catch (e) { /* storage unavailable */ }
}
let autoLanesOff = false // lanes were switched off for a short window, not by the user: do not persist that
function setPrefs(ctx, patch) { const next = { ...$prefs.get(), ...patch }; $prefs.set(next); if ('showLanes' in patch) autoLanesOff = false; const store = { ...next }; if (autoLanesOff) delete store.showLanes; try { ctx.storage.set('prefs', store) } catch (e) { /* storage unavailable */ } }

function Page({ ctx }) {
  const prefs = useAtom($prefs); const mode = useAtom($mode); const dim = useAtom($dim); const sel = useAtom($selected); const feedOpen = useAtom($feedOpen); const tab = useAtom($tab); const lanesOpen = useAtom($lanesOpen)
  const root = useRef(null)
  useEffect(() => { // first load in a short window: lanes off unless the user has ever set the pref
    const el = root.current; if (!el) return
    let saved = null; try { saved = ctx.storage.get('prefs', null) } catch (e) { /* none */ }
    if (!(saved && 'showLanes' in saved) && el.getBoundingClientRect().height < 800 && $prefs.get().showLanes) { autoLanesOff = true; $prefs.set({ ...$prefs.get(), showLanes: false }) }
  }, [])
  useEffect(() => { // measure the page itself (the app's plugin area), not the screen
    const el = root.current; if (!el) return
    const measure = () => { const r = el.getBoundingClientRect(); if (r.width < 1) return; const n = chooseLayout(Math.round(r.width), Math.round(r.height)); const o = $dim.get(); if (o.w !== n.w || o.h !== n.h || o.size !== n.size) $dim.set(n) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure); ro.observe(el); return () => ro.disconnect()
  }, [])
  useEffect(() => { if (sel) $tab.set('unit') }, [sel])
  const side = drawerSide(prefs, dim); const showFeed = isOn(prefs, 'showFeed'); const over = !side && (sel || (feedOpen && showFeed)); const dw = prefs.drawerW
  useEffect(() => { if (!showFeed && tab === 'feed') $tab.set('unit') }, [showFeed])
  const closeOver = () => { $selected.set(null); $feedOpen.set(false) }
  return jsxs('div', { ref: root, className: cx('hermes-cockpit', `ck-${dim.size}`, dim.short && 'ck-short', prefs.density === 'compact' && 'ck-compact'), 'data-ck-theme': prefs.theme === 'app' ? 'app' : 'gsp', 'data-ck-layout': dim.size, style: { '--ck-z': TEXT_Z[prefs.textSize] || 1 }, children: [
    jsx('style', { children: CK_CSS }),
    jsx(MissionBar, { ctx }),
    isOn(prefs, 'showRail') && jsx(GroupRail, { ctx }),
    mode === 'demo' && jsx('div', { className: 'ck-note demo', children: prefs.demo ? 'Demo data (Settings → Plugins → Hermes Cockpit to turn off).' : 'Showing demo data: the sensor is not enabled on this backend and RPC is unreachable. Enable `hermes-cockpit` in plugins.enabled for the live picture.' }),
    mode === 'rpc' && jsx('div', { className: 'ck-note', children: 'RPC-only picture: sessions per profile, no board/cost. The sensor half is not reachable at /api/plugins/hermes-cockpit — add `hermes-cockpit` to plugins.enabled on the backend, and check its dashboard/manifest.json `name` equals `hermes-cockpit` (the API mounts under /api/plugins/<manifest name>/).' }),
    isOn(prefs, 'showQueue') && jsx(NeedsQueue, { ctx }),
    jsxs('div', { className: 'ck-body', children: [
      jsxs('div', { className: 'ck-main', children: [prefs.view === 'constellation' ? jsx(Constellation, { ctx }) : jsx('div', { className: 'ck-scroll', children: jsx(UnitGrid, {}) }), !dim.short && prefs.showLanes && jsx(Swimlanes, { ctx }),
        dim.short && lanesOpen && jsxs('div', { className: 'ck-lanes-over', style: { maxHeight: prefs.lanesH ? '80%' : '40%' }, children: [jsx('button', { type: 'button', className: 'ck-btn sm', 'aria-label': 'Close swimlanes', onClick: () => $lanesOpen.set(false), children: '×' }), jsx(Swimlanes, { ctx })] })] }),
      side && jsxs('div', { className: 'ck-side', style: { width: dw || 320 }, children: [jsx(Handle, liveHandle(ctx, 'drawerW', { axis: 'x', sign: -1, value: dw || 320, min: 260, max: 560, label: 'Drawer width', cls: 'v' })), jsx(Drawer, { ctx }), showFeed && jsx(Feed, {})] }),
      over && jsxs('div', { className: 'ck-over', role: 'dialog', 'aria-label': 'Unit and feed', style: dw ? { width: `min(${dw}px, 90%)` } : undefined, children: [
        jsx(Handle, liveHandle(ctx, 'drawerW', { axis: 'x', sign: -1, value: dw || 380, min: 260, max: 560, label: 'Drawer width', cls: 'v' })),
        jsxs('div', { className: 'ck-tabs', children: [
          jsx('button', { type: 'button', className: cx('ck-btn sm', tab === 'unit' && 'on'), 'aria-pressed': tab === 'unit', onClick: () => $tab.set('unit'), children: 'Unit' }),
          showFeed && jsx('button', { type: 'button', className: cx('ck-btn sm', tab === 'feed' && 'on'), 'aria-pressed': tab === 'feed', onClick: () => $tab.set('feed'), children: 'Feed' }),
          jsx('span', { className: 'ck-sp' }),
          jsx('button', { type: 'button', className: 'ck-btn sm', 'aria-label': 'Close panel', onClick: closeOver, children: '×' })
        ] }),
        tab === 'feed' ? jsx(Feed, {}) : jsx(Drawer, { ctx, overlay: true })
      ] })
    ] })
  ] })
}

// Any render error shows on the page instead of an empty route.
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  render() {
    if (this.state.err) return jsxs('div', { style: { padding: 16, color: 'var(--ui-danger)', fontSize: 12, fontFamily: 'ui-monospace, monospace' }, children: ['Hermes Cockpit failed to render: ', String(this.state.err && this.state.err.message || this.state.err), jsx('div', { style: { color: 'var(--ui-text-secondary)', marginTop: 8 }, children: 'Copy this line into the issue tracker: github.com/madhatter1312sudo/hermes-cockpit' })] })
    return this.props.children
  }
}

// ── statusbar chip ──────────────────────────────────────────────────────────────────────
function StatusChip() {
  const snap = useAtom($snap); const mode = useAtom($mode)
  const t = snap && snap.totals
  const text = t ? `◉ ${t.needs_you ? t.needs_you + ' need you · ' : ''}${t.by_state.working + t.by_state.task} working · ${fmtUsd(t.cost_today_usd)}` : `◉ cockpit ${mode}`
  return jsx('button', { onClick: () => host.navigate(PATH), title: 'Open Hermes Cockpit', style: { background: 'transparent', border: 'none', cursor: 'pointer', color: t && t.needs_you ? 'var(--ui-danger)' : 'var(--ui-text-secondary)', fontSize: 11, padding: '0 6px' }, children: text })
}

// ── settings page (Settings → Plugins → Hermes Cockpit) ─────────────────────────────────
function Settings({ ctx }) {
  const p = useAtom($prefs)
  const Row = (label, control, help) => jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--ui-border)' }, children: [jsxs('div', { style: { flex: 1 }, children: [jsx('div', { style: { color: 'var(--ui-text)', fontSize: 13 }, children: label }), help && jsx('div', { style: { color: 'var(--ui-text-secondary)', fontSize: 11 }, children: help })] }), control] })
  const Toggle = (k) => jsx('input', { type: 'checkbox', checked: !!p[k], onChange: e => setPrefs(ctx, { [k]: e.target.checked }) })
  const Tri = (k) => jsx('input', { type: 'checkbox', checked: p[k] !== false, onChange: e => setPrefs(ctx, { [k]: e.target.checked }) })
  const Num = (k, min, max, step) => jsx('input', { type: 'number', min, max, step, value: p[k], style: { ...S.input, minWidth: 80 }, onChange: e => setPrefs(ctx, { [k]: Number(e.target.value) }) })
  const Sel = (k, opts) => jsx('select', { value: p[k], style: S.input, onChange: e => setPrefs(ctx, { [k]: e.target.value }), children: opts.map(o => jsxk('option', { key: o, value: o, children: o })) })
  return jsxs('div', { style: { padding: '4px 0', maxWidth: 640 }, children: [
    Row('Theme', Sel('theme', ['gsp', 'app']), 'gsp: GSP house style (navy, gold). app: the host app\'s own theme variables.'),
    Row('Main view', Sel('view', ['grid', 'constellation']), 'Grid: one column per group. Constellation: the canvas map.'),
    Row('Key figures in the mission bar', Tri('showKpis')), Row('Department rail', Tri('showRail')), Row('Needs-you strip / cards', Tri('showQueue')), Row('Feed', Tri('showFeed')),
    Row('Drawer placement', Sel('drawerMode', ['auto', 'overlay', 'side']), 'auto: side column when the page is 1400px wide or more, slide-over otherwise.'),
    Row('Text size', Sel('textSize', ['compact', 'normal', 'large']), 'Scales the cockpit\'s own text, to counter the app zoom.'),
    jsx('div', { style: { padding: '8px 0' }, children: jsx('button', { style: S.btn, onClick: () => resetLayout(ctx), children: 'Reset layout' }) }),
    Row('Poll interval (ms)', Num('pollMs', 1500, 60000, 500), 'How often to ask the sensor. Pushes from the gateway arrive instantly regardless.'),
    Row('Swimlanes', Toggle('showLanes'), 'History strip under the main view; drag it to replay.'),
    Row('Lane window (minutes)', Num('laneMinutes', 5, 1440, 5)),
    Row('Lanes by', Sel('laneBy', ['group', 'unit'])),
    Row('Show idle units', Toggle('showIdle'), 'Off hides idle/off-duty units from the constellation and lanes.'),
    Row('Density', Sel('density', ['comfortable', 'compact']), 'Compact: smaller nodes, labels only on active units — for 50+ profiles.'),
    Row('Delegation particles', Toggle('particles')),
    Row('Reduced motion', Toggle('reducedMotion'), 'No breathing, orbits or flashes; state still shows by position and colour.'),
    Row('Flash "needs you" in the mission bar', Toggle('focusOnNeedsYou')),
    Row('Demo data', Toggle('demo'), 'Synthetic fleet, for trying the view without a backend.'),
    jsx('div', { style: { color: 'var(--ui-text-secondary)', fontSize: 11, marginTop: 12 }, children: 'Groups, owner seat, thresholds and file signals live on the backend in $HERMES_HOME/cockpit.yaml (hot-reloaded). This page is per-laptop display preference.' })
  ] })
}

// ── plugin ──────────────────────────────────────────────────────────────────────────────
export default {
  id: ID,
  name: 'Hermes Cockpit',
  description: 'Live constellation + swimlanes of every Hermes profile: who works, who needs you, what it costs.',
  defaultEnabled: false,
  register(ctx) {
    try { const saved = ctx.storage.get('prefs', null); if (saved && typeof saved === 'object') $prefs.set({ ...DEFAULT_PREFS, ...saved }) } catch (e) { /* fresh install */ }
    const stopPoll = startPoller(ctx); ctx.onDispose(stopPoll)
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: PATH }, render: () => jsx(Boundary, { children: jsx(Page, { ctx }) }) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: PATH, label: 'Cockpit', codicon: 'radio-tower' } },
      { id: 'status', area: STATUSBAR_AREAS.right, order: 110, render: () => jsx(StatusChip, {}) },
      { id: 'palette.open', area: PALETTE_AREA, data: { id: 'cockpit.open', label: 'Open Cockpit', keywords: ['cockpit', 'fleet', 'mission', 'control', 'agents'], run: () => host.navigate(PATH) } },
      { id: 'palette.needs', area: PALETTE_AREA, data: { id: 'cockpit.needs-you', label: 'Cockpit: jump to the unit that needs me', keywords: ['blocked', 'needs', 'approve'], run: () => { const u = unitsOf($snap.get()).find(x => x.state === 'blocked'); if (u) { $selected.set(u.profile); host.navigate(PATH) } else notice('nothing needs you right now') } } },
      { id: 'palette.demo', area: PALETTE_AREA, data: { id: 'cockpit.demo', label: 'Cockpit: toggle demo data', keywords: ['demo'], run: () => setPrefs(ctx, { demo: !$prefs.get().demo }) } },
      { id: 'kb.open', area: KEYBINDS_AREA, data: { id: 'cockpit.open', label: 'Open Cockpit', category: 'Cockpit', defaults: ['mod+shift+k'], run: () => host.navigate(PATH) } },
      { id: 'kb.lanes', area: KEYBINDS_AREA, data: { id: 'cockpit.lanes', label: 'Toggle swimlanes', category: 'Cockpit', defaults: ['mod+shift+l'], run: () => setPrefs(ctx, { showLanes: !$prefs.get().showLanes }) } },
      { id: 'kb.next', area: KEYBINDS_AREA, data: { id: 'cockpit.next-blocked', label: 'Next unit that needs you', category: 'Cockpit', defaults: ['mod+shift+n'], run: () => { const bl = unitsOf($snap.get()).filter(x => x.state === 'blocked').map(x => x.profile); if (!bl.length) return notice('nothing needs you right now'); const i = bl.indexOf($selected.get()); $selected.set(bl[(i + 1) % bl.length]) } } }
    ])
    if (typeof ctx.registerSettingsPage === 'function') ctx.registerSettingsPage({ id: 'settings', title: 'Hermes Cockpit', icon: 'radio-tower', order: 0, render: () => jsx(Boundary, { children: jsx(Settings, { ctx }) }) })
    // Keyboard: "/" focuses search when the page is showing; Escape clears selection/replay.
    ctx.addEventListener(window, 'keydown', (e) => {
      const onPage = document.querySelector('.hermes-cockpit'); if (!onPage) return
      const inField = /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')
      if (e.key === '/' && !inField) { if ($dim.get().short) { e.preventDefault(); $searchOpen.set(true) } else { const s = onPage.querySelector('[data-ck-search]'); if (s) { e.preventDefault(); s.focus() } } }
      if (e.key === 'Escape') { if ($replayT.get() != null) $replayT.set(null); else if ($queueOpen.get()) $queueOpen.set(false); else if ($lanesOpen.get()) $lanesOpen.set(false); else if ($feedOpen.get() && !$selected.get()) $feedOpen.set(false); else if (!inField) $selected.set(null) }
    })
  }
}

// Exposed for tests only (not part of the plugin contract).
export const __test = { LAYOUT_DEFAULTS, SHORT_CHROME, $queueOpen, $lanesOpen, $searchOpen, chooseLayout, $dim, $feedOpen, orbitLabels, cleanTitle, atom, layout, totalsOf, demoSnap, diffToFeed, fmtAge, fmtTok, $snap, $feed, $history, $mode, $prefs, $selected, $filter, $replayT, STATES }
