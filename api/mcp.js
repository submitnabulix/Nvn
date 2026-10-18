// NVN Verse MCP server (Streamable HTTP, plain JSON responses) for Vercel.
// Put this file at api/mcp.js in your GitHub repo.
//
// Vercel environment variables:
//   SUPABASE_ANON_KEY     (required) the supabaseKey value from index.html
//   SUPABASE_URL          (optional) defaults to the NVN Verse project
//   NVN_SITE_URL          (optional) base for share links, default https://nvnverse.gt.tc
//   MCP_SECRET            (recommended) if set, the connector URL must end with ?key=<secret>
//   SUPABASE_SERVICE_KEY  (optional) enables admin tools, only works together with MCP_SECRET

const crypto = require('crypto');

const SERVER_INFO = { name: 'nvn-verse', version: '2.0.0' };
const SITE_URL = (process.env.NVN_SITE_URL || 'https://nvnverse.gt.tc').replace(/\/$/, '');
const SB_URL = (process.env.SUPABASE_URL || 'https://kjqwsdzxkzhoavukcejj.supabase.co').replace(/\/$/, '');
const SB_ANON = process.env.SUPABASE_ANON_KEY || '';
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY || '';
const SECRET = process.env.MCP_SECRET || '';
const ADMIN = Boolean(SECRET && SB_SERVICE);

const UPLOAD_CATEGORIES = [
  'People & Personalities', 'Lifestyle & Fashion', 'Entertainment & Media',
  'Nature & Places', 'Quotes & Emotions',
];
const SEARCH_CATEGORIES = [...UPLOAD_CATEGORIES, 'Art & Creative', 'Technology & Science'];
const SHARE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- helpers ----------

const clamp = (n, lo, hi, d) => {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d;
};
// Strip characters that would break PostgREST filter syntax.
const clean = (s) => String(s == null ? '' : s).replace(/[*,()\\"'%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
const shareLink = (code) => (code ? `${SITE_URL}/image/${code}` : null);

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function qs(params) {
  return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

async function sbRaw(table, { select = '*', filters = [], order, limit, offset, count, admin } = {}) {
  const key = admin ? SB_SERVICE : SB_ANON;
  if (!key) throw new Error(admin ? 'SUPABASE_SERVICE_KEY is not set' : 'SUPABASE_ANON_KEY is not set in the Vercel environment variables');
  const params = [['select', select], ...filters];
  if (order) params.push(['order', order]);
  if (limit != null) params.push(['limit', String(limit)]);
  if (offset) params.push(['offset', String(offset)]);
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  if (count) headers.Prefer = 'count=exact';
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${qs(params)}`, { headers });
  if (!r.ok) throw new Error(`Supabase ${r.status} on ${table}: ${(await r.text()).slice(0, 300)}`);
  return r;
}
const sb = async (table, opts) => (await sbRaw(table, opts)).json();
async function sbCount(table, filters = [], admin) {
  const r = await sbRaw(table, { select: 'id', filters, limit: 1, count: true, admin });
  const m = /\/(\d+)$/.exec(r.headers.get('content-range') || '');
  return m ? Number(m[1]) : null;
}

// Public view of a verse row. Never exposes imgbb delete URLs.
const verse = (r) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  categories: r.categories || [],
  url: r.url,
  share_code: r.share_code || null,
  share_link: shareLink(r.share_code),
  uploader_id: r.uid,
  uploaded_at: r.upload_date || r.created_at || null,
  width: r.width,
  height: r.height,
  dominant_color: r.dominant_color,
  hidden: Boolean(r.is_hidden),
});

async function resolveUid(who) {
  const s = String(who || '').trim();
  if (UUID_RE.test(s)) return s;
  const rows = await sb('usernames', { select: 'user_id,username', filters: [['username', `ilike.${clean(s)}`]], limit: 1 });
  if (!rows.length) throw new Error(`No user found for "${s}"`);
  return rows[0].user_id;
}

function ownOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}`;
}
async function fetchSite(req, path) {
  const origin = ownOrigin(req);
  const p = String(path || '/');
  if (/^[a-z]+:/i.test(p) || p.includes('..') || p.startsWith('//')) throw new Error('Only paths on this site are allowed, e.g. /index.html');
  const u = new URL(p.startsWith('/') ? p : `/${p}`, origin);
  if (u.origin !== origin) throw new Error('Only paths on this site are allowed');
  const r = await fetch(u, { headers: { 'user-agent': 'nvn-verse-mcp' } });
  return { url: u.toString(), status: r.status, type: r.headers.get('content-type'), text: await r.text() };
}

// ---------- tools ----------

const TOOLS = [];
function tool(name, description, properties, required, run, opts = {}) {
  TOOLS.push({
    name, description, run, admin: Boolean(opts.admin),
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
  });
}

tool('ping_nvn', 'Health check: confirms the NVN Verse MCP server is working and shows which features are configured.', {}, [],
  async (a, req) => ({
    message: 'NVN Verse MCP is working!',
    time: new Date().toISOString(),
    server: SERVER_INFO,
    supabase_configured: Boolean(SB_ANON),
    admin_tools_enabled: ADMIN,
    protected_by_secret: Boolean(SECRET),
    site_origin: ownOrigin(req),
    share_link_base: SITE_URL,
  }));

tool('get_site_info', 'Static overview of NVN Verse: what it is, tables, categories, share link format, routing.', {}, [],
  async () => ({
    name: 'NVN Verse',
    description: 'Pinterest-style image platform. Single-file front end (index.html) with a Supabase backend.',
    share_link_format: `${SITE_URL}/image/<share_code> (7 chars from ${SHARE_CHARS.length} unambiguous characters)`,
    routing: 'Hash based (#account, #privacy, #security, #about, #notifications) plus /image/<share_code> deep links (needs a rewrite to index.html on Vercel).',
    supabase_tables: ['verses', 'profiles', 'usernames', 'follows', 'notifications', 'saved_images', 'verse_likes', 'verse_shares', 'page_views', 'app_errors'],
    storage_buckets: ['profile-pictures'],
    image_hosting: 'imgbb (verses.imgbb_* columns)',
    upload_categories: UPLOAD_CATEGORIES,
    search_categories: SEARCH_CATEGORIES,
  }));

tool('list_categories', 'List the five upload categories and the seven search categories.', {}, [],
  async () => ({ upload_categories: UPLOAD_CATEGORIES, search_categories: SEARCH_CATEGORIES }));

tool('list_verses', 'List public (non-hidden) verses, newest first by default. Optional category and uploader filters.',
  {
    limit: { type: 'integer', description: '1-50, default 10' },
    offset: { type: 'integer', description: 'For paging, default 0' },
    category: { type: 'string', description: 'e.g. "Nature & Places"' },
    uploader: { type: 'string', description: 'Username or user id' },
    order: { type: 'string', enum: ['newest', 'oldest'] },
  }, [],
  async (a) => {
    const filters = [['is_hidden', 'eq.false']];
    if (a.category) filters.push(['categories_string', `ilike.*${clean(a.category)}*`]);
    if (a.uploader) filters.push(['uid', `eq.${await resolveUid(a.uploader)}`]);
    const rows = await sb('verses', {
      filters, limit: clamp(a.limit, 1, 50, 10), offset: clamp(a.offset, 0, 100000, 0),
      order: `upload_date.${a.order === 'oldest' ? 'asc' : 'desc'}`,
    });
    return { count: rows.length, verses: rows.map(verse) };
  });

tool('search_verses', 'Search public verses by text in title, description and categories.',
  { query: { type: 'string' }, limit: { type: 'integer', description: '1-50, default 10' } }, ['query'],
  async (a) => {
    const q = clean(a.query);
    if (!q) throw new Error('query is empty');
    const rows = await sb('verses', {
      filters: [['is_hidden', 'eq.false'], ['or', `(title.ilike.*${q}*,description.ilike.*${q}*,categories_string.ilike.*${q}*)`]],
      limit: clamp(a.limit, 1, 50, 10), order: 'upload_date.desc',
    });
    return { count: rows.length, verses: rows.map(verse) };
  });

tool('get_verse', 'Get one verse by id, share_code or image url.',
  { id: { type: 'string' }, share_code: { type: 'string' }, url: { type: 'string' } }, [],
  async (a) => {
    let f;
    if (a.id) f = ['id', `eq.${clean(a.id)}`];
    else if (a.share_code) f = ['share_code', `eq.${clean(a.share_code)}`];
    else if (a.url) f = ['url', `eq.${String(a.url).slice(0, 600)}`];
    else throw new Error('Provide id, share_code or url');
    const rows = await sb('verses', { filters: [f], limit: 1 });
    if (!rows.length) return { found: false };
    return { found: true, verse: verse(rows[0]) };
  });

tool('random_verses', 'Pick random public verses, optionally within a category.',
  { count: { type: 'integer', description: '1-10, default 5' }, category: { type: 'string' } }, [],
  async (a) => {
    const filters = [['is_hidden', 'eq.false']];
    if (a.category) filters.push(['categories_string', `ilike.*${clean(a.category)}*`]);
    const total = await sbCount('verses', filters);
    if (!total) return { total: 0, verses: [] };
    const n = Math.min(clamp(a.count, 1, 10, 5), total);
    const offsets = new Set();
    while (offsets.size < n) offsets.add(crypto.randomInt(total));
    const rows = await Promise.all([...offsets].map((o) => sb('verses', { filters, limit: 1, offset: o, order: 'upload_date.desc' })));
    return { total, verses: rows.flat().map(verse) };
  });

tool('count_verses', 'Count public verses, optionally within a category.',
  { category: { type: 'string' } }, [],
  async (a) => {
    const filters = [['is_hidden', 'eq.false']];
    if (a.category) filters.push(['categories_string', `ilike.*${clean(a.category)}*`]);
    return { count: await sbCount('verses', filters) };
  });

tool('category_stats', 'Verse counts per upload category (a verse can belong to 2 categories).', {}, [],
  async () => {
    const base = [['is_hidden', 'eq.false']];
    const [total, ...counts] = await Promise.all([
      sbCount('verses', base),
      ...UPLOAD_CATEGORIES.map((c) => sbCount('verses', [...base, ['categories_string', `ilike.*${c}*`]])),
    ]);
    return { total, by_category: Object.fromEntries(UPLOAD_CATEGORIES.map((c, i) => [c, counts[i]])) };
  });

tool('check_duplicate', 'Check whether an image url or title already exists (for the skip-and-flag duplicate rule).',
  { url: { type: 'string' }, title: { type: 'string' } }, [],
  async (a) => {
    if (!a.url && !a.title) throw new Error('Provide url and/or title');
    const out = { duplicate_found: false };
    if (a.url) {
      const u = String(a.url).slice(0, 600);
      const [byUrl, byDisplay] = await Promise.all([
        sb('verses', { filters: [['url', `eq.${u}`]], limit: 3 }),
        sb('verses', { filters: [['imgbb_display_url', `eq.${u}`]], limit: 3 }),
      ]);
      out.url_matches = [...byUrl, ...byDisplay].map(verse);
      if (out.url_matches.length) out.duplicate_found = true;
    }
    if (a.title) {
      const t = clean(a.title);
      const [exact, similar] = await Promise.all([
        sb('verses', { filters: [['title', `ilike.${t}`]], limit: 5 }),
        sb('verses', { filters: [['title', `ilike.*${t}*`]], limit: 5 }),
      ]);
      out.exact_title_matches = exact.map(verse);
      out.similar_titles = similar.filter((r) => !exact.some((e) => e.id === r.id)).map(verse);
      if (exact.length) out.duplicate_found = true;
    }
    return out;
  });

tool('generate_share_code', 'Generate unique 7-character share codes in the same format the app uses.',
  { count: { type: 'integer', description: '1-5, default 1' } }, [],
  async (a) => {
    const codes = [];
    for (let i = 0; i < clamp(a.count, 1, 5, 1); i++) {
      for (let attempt = 0; attempt < 5; attempt++) {
        let c = '';
        for (let k = 0; k < 7; k++) c += SHARE_CHARS[crypto.randomInt(SHARE_CHARS.length)];
        const taken = SB_ANON ? await sbCount('verses', [['share_code', `eq.${c}`]]) : 0;
        if (!taken && !codes.includes(c)) { codes.push(c); break; }
      }
    }
    return { codes, links: codes.map(shareLink) };
  });

tool('validate_metadata', 'Check image metadata against the NVN Verse rules: 1-2 categories from the five, description of 1-2 sentences with no em dashes or emoji, medium-length title.',
  {
    title: { type: 'string' }, description: { type: 'string' },
    categories: { type: 'array', items: { type: 'string' } },
  }, ['title', 'description', 'categories'],
  async (a) => {
    const issues = [], warnings = [];
    const title = String(a.title || '').trim(), desc = String(a.description || '').trim();
    const cats = Array.isArray(a.categories) ? a.categories : [];
    const words = title ? title.split(/\s+/).length : 0;
    if (!title) issues.push('Title is empty');
    else if (words < 3) warnings.push(`Title is short (${words} word(s)), aim for medium length`);
    else if (words > 12) warnings.push(`Title is long (${words} words), aim for medium length`);
    if (!desc) issues.push('Description is empty');
    if (/[\u2014]/.test(desc) || /[\u2014]/.test(title)) issues.push('Contains an em dash');
    if (/\p{Extended_Pictographic}/u.test(desc)) issues.push('Description contains an emoji');
    const sentences = desc.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim()).length;
    if (desc && (sentences < 1 || sentences > 2)) issues.push(`Description has ${sentences} sentences, use 1-2`);
    if (desc.length > 300) warnings.push('Description is long, keep it concise');
    if (cats.length < 1 || cats.length > 2) issues.push(`Use 1-2 categories (got ${cats.length})`);
    for (const c of cats) if (!UPLOAD_CATEGORIES.includes(c)) issues.push(`Unknown category: "${c}"`);
    return { valid: issues.length === 0, issues, warnings, allowed_categories: UPLOAD_CATEGORIES };
  });

tool('find_user', 'Search usernames (up to 10 matches).',
  { query: { type: 'string' } }, ['query'],
  async (a) => {
    const rows = await sb('usernames', { select: 'username', filters: [['username', `ilike.*${clean(a.query)}*`]], limit: 10 });
    return { usernames: rows.map((r) => r.username) };
  });

tool('get_user', 'Public profile for a user: name, bio, and verse, follower and following counts.',
  { username: { type: 'string' }, id: { type: 'string' } }, [],
  async (a) => {
    const uid = await resolveUid(a.id || a.username);
    const [profile, uname, verses, followers, following] = await Promise.all([
      sb('profiles', { select: 'name,bio', filters: [['id', `eq.${uid}`]], limit: 1 }),
      sb('usernames', { select: 'username', filters: [['user_id', `eq.${uid}`]], limit: 1 }),
      sbCount('verses', [['uid', `eq.${uid}`], ['is_hidden', 'eq.false']]),
      sbCount('follows', [['following_id', `eq.${uid}`]]),
      sbCount('follows', [['follower_id', `eq.${uid}`]]),
    ]);
    return {
      id: uid, username: uname[0] && uname[0].username, name: profile[0] && profile[0].name,
      bio: profile[0] && profile[0].bio, verses, followers, following,
    };
  });

tool('verse_engagement', 'Likes and saves count for a verse (by id or image url). May be 0 or unavailable if row-level security hides them.',
  { id: { type: 'string' }, url: { type: 'string' } }, [],
  async (a) => {
    let url = a.url && String(a.url).slice(0, 600);
    if (!url && a.id) {
      const rows = await sb('verses', { select: 'url', filters: [['id', `eq.${clean(a.id)}`]], limit: 1 });
      url = rows[0] && rows[0].url;
    }
    if (!url) throw new Error('Provide a valid id or url');
    const safe = (p) => p.catch((e) => `unavailable: ${e.message.slice(0, 120)}`);
    const [likes, saves] = await Promise.all([
      safe(sbCount('verse_likes', [['image_url', `eq.${url}`]])),
      safe(sbCount('saved_images', [['image_url', `eq.${url}`]])),
    ]);
    return { url, likes, saves };
  });

tool('site_status', 'Visit the deployed site: status, size and title of its main page.', {}, [],
  async (a, req) => {
    const r = await fetchSite(req, '/');
    const title = /<title>([^<]*)<\/title>/i.exec(r.text);
    return {
      url: r.url, status: r.status, content_type: r.type,
      chars: r.text.length, lines: r.text.split('\n').length, title: title && title[1],
    };
  });

tool('read_site_lines', 'Read a line range of a file on the deployed site (default /index.html). Max 400 lines and 30000 characters per call.',
  {
    path: { type: 'string', description: 'Default /index.html' },
    start_line: { type: 'integer', description: 'Default 1' },
    end_line: { type: 'integer', description: 'Default start_line + 199' },
  }, [],
  async (a, req) => {
    const r = await fetchSite(req, a.path || '/index.html');
    const lines = r.text.split('\n');
    const start = clamp(a.start_line, 1, Math.max(1, lines.length), 1);
    const end = Math.min(lines.length, clamp(a.end_line, start, start + 399, start + 199));
    let content = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n');
    const truncated = content.length > 30000;
    if (truncated) content = content.slice(0, 30000);
    return { url: r.url, status: r.status, total_lines: lines.length, start_line: start, end_line: end, truncated, content };
  });

tool('search_site_source', 'Search a file on the deployed site for text (case-insensitive) and return matching lines with context.',
  {
    query: { type: 'string' },
    path: { type: 'string', description: 'Default /index.html' },
    context: { type: 'integer', description: 'Lines of context, 0-5, default 1' },
    max_matches: { type: 'integer', description: '1-30, default 10' },
  }, ['query'],
  async (a, req) => {
    const q = String(a.query || '').toLowerCase();
    if (!q) throw new Error('query is empty');
    const r = await fetchSite(req, a.path || '/index.html');
    const lines = r.text.split('\n');
    const ctx = clamp(a.context, 0, 5, 1), max = clamp(a.max_matches, 1, 30, 10);
    const matches = [];
    let total = 0;
    lines.forEach((l, i) => {
      if (!l.toLowerCase().includes(q)) return;
      total++;
      if (matches.length < max) {
        matches.push({
          line: i + 1,
          text: lines.slice(Math.max(0, i - ctx), i + ctx + 1).map((t, k) => `${Math.max(0, i - ctx) + k + 1}: ${t.slice(0, 300)}`).join('\n'),
        });
      }
    });
    return { url: r.url, status: r.status, total_matches: total, shown: matches.length, matches };
  });

// Admin tools: only listed when MCP_SECRET and SUPABASE_SERVICE_KEY are both set.
tool('analytics_summary', 'Admin: page view analytics for the last N days (top pages, countries, devices, viewed images).',
  { days: { type: 'integer', description: '1-30, default 7' } }, [],
  async (a) => {
    const since = new Date(Date.now() - clamp(a.days, 1, 30, 7) * 86400000).toISOString();
    const rows = await sb('page_views', {
      admin: true, filters: [['created_at', `gte.${since}`]], order: 'created_at.desc', limit: 1000,
    });
    const top = (key, n = 8) => {
      const m = {};
      rows.forEach((r) => { const v = r[key]; if (v) m[v] = (m[v] || 0) + 1; });
      return Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, n).map(([name, views]) => ({ name, views }));
    };
    const imgs = {};
    rows.filter((r) => r.event === 'image_view' && r.image_url).forEach((r) => {
      const k = r.image_title || r.image_url;
      imgs[k] = (imgs[k] || 0) + 1;
    });
    return {
      since, rows_analyzed: rows.length, capped_at_1000: rows.length === 1000,
      unique_sessions: new Set(rows.map((r) => r.session_id)).size,
      top_pages: top('page'), top_countries: top('country'), devices: top('device'),
      top_images: Object.entries(imgs).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([title, views]) => ({ title, views })),
    };
  }, { admin: true });

tool('recent_app_errors', 'Admin: most recent client-side