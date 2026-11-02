'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { timingSafeEqual, randomBytes } = require('node:crypto');
const { LessonStore, createProvider } = require('./lessons');
const { Jobs } = require('./jobs');
const { languages } = require('./catalog');
const root = path.resolve(__dirname, '..');
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
async function createApp(options = {}) {
  const adminToken = options.adminToken ?? process.env.PARLEY_ADMIN_TOKEN;
  if (adminToken && adminToken.length < 24) throw new Error('PARLEY_ADMIN_TOKEN must have at least 24 characters.');
  const configured = options.configured ?? Boolean(process.env.OPENAI_API_KEY);
  const store = options.store || new LessonStore(options.dataDir || process.env.PARLEY_DATA_DIR || path.join(root, 'data'), options.provider || createProvider());
  const jobs = new Jobs(store);
  const sessions = new Map();
  const attempts = new Map();
  let generating = false;
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const limited = (key, count, ms) => {
    const now = Date.now(); const bucket = attempts.get(key);
    if (!bucket || bucket.until < now) {
      if (attempts.size > 10000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
      attempts.set(key, { n: 1, until: now + ms }); return false;
    }
    return ++bucket.n > count;
  };
  const auth = req => {
    if (!adminToken) return false;
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (equal(bearer, adminToken)) return true;
    const sid = /(?:^|;\s*)parley_admin=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    return sid && (sessions.get(sid) || 0) > Date.now();
  };
  const body = async req => {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Use a JSON request body.'), { status: 415 });
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16000) throw Object.assign(new Error('Request body too large.'), { status: 413 }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('Malformed JSON.'), { status: 400 }); }
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
        if (req.method === 'POST') {
          // Cookie-authenticated writes must originate on this host; CLI bearer requests have no Origin.
          const expectedOrigin = process.env.PARLEY_PUBLIC_ORIGIN || `http://${req.headers.host}`;
          if (req.headers.origin && req.headers.origin !== expectedOrigin) return json(res, 403, { error: 'Cross-origin writes are not allowed.' });
        }
        if (req.method === 'GET' && url.pathname === '/api/status')
          return json(res, 200, { standalone: true, generationConfigured: configured, adminConfigured: Boolean(adminToken), admin: Boolean(auth(req)) });
        if (req.method === 'GET' && url.pathname === '/api/catalog') return json(res, 200, { languages: await store.manifest() });
        const courseMatch = /^\/api\/courses\/([A-Za-z0-9-]+)$/.exec(url.pathname);
        if (req.method === 'GET' && courseMatch) return json(res, 200, { lessons: await store.course(courseMatch[1]) });
        if (req.method === 'POST' && url.pathname === '/api/admin/session') {
          if (limited(`login:${req.socket.remoteAddress}`, 8, 60000)) return json(res, 429, { error: 'Too many login attempts. Try again in a minute.' });
          const input = await body(req);
          if (!adminToken || !equal(input.token, adminToken)) return json(res, 401, { error: 'Invalid administrator token or administrator access is not configured.' });
          for (const [id, until] of sessions) if (until < Date.now()) sessions.delete(id);
          if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
          const id = randomBytes(32).toString('hex'); sessions.set(id, Date.now() + 8 * 3600000);
          const secure = process.env.PARLEY_PUBLIC_ORIGIN?.startsWith('https:') ? '; Secure' : '';
          return json(res, 200, { admin: true }, { 'Set-Cookie': `parley_admin=${id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800${secure}` });
        }
        if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
          const id = /(?:^|;\s*)parley_admin=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1]; sessions.delete(id);
          return json(res, 200, { admin: false }, { 'Set-Cookie': 'parley_admin=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0' });
        }
        if (!auth(req)) return json(res, 401, { error: 'Administrator access is required to generate lessons. Existing lessons are free to open.' });
        if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, { jobs: jobs.jobs, storageError: Boolean(jobs.error) });
        if (req.method === 'POST' && url.pathname === '/api/jobs') {
          if (!configured) return json(res, 503, { error: 'Configure OPENAI_API_KEY on the server before building courses.' });
          if (generating) return json(res, 409, { error: 'A lesson is being generated. Try again when it finishes.' });
          const input = await body(req);
          const codes = input.languages === 'all' ? [...languages.keys()] : input.languages;
          return json(res, 202, { job: await jobs.create(codes) });
        }
        const jobMatch = /^\/api\/jobs\/([a-f0-9-]+)\/(pause|resume)$/.exec(url.pathname);
        if (req.method === 'POST' && jobMatch) {
          if (jobMatch[2] === 'resume' && !configured) return json(res, 503, { error: 'Configure the server model key before resuming.' });
          if (jobMatch[2] === 'resume' && generating) return json(res, 409, { error: 'A lesson is still being generated.' });
          return json(res, 200, { job: await jobs.action(jobMatch[1], jobMatch[2]) });
        }
        if (req.method === 'POST' && url.pathname === '/api/lessons/generate') {
          if (!configured) return json(res, 503, { error: 'Configure OPENAI_API_KEY on the server before generating lessons.' });
          if (generating || jobs.jobs.some(j => ['running', 'queued'].includes(j.status))) return json(res, 409, { error: 'A course build is running. Pause it before generating a single lesson.' });
          if (limited('generation', 10, 60000)) return json(res, 429, { error: 'Please wait before generating more lessons.' });
          const input = await body(req);
          if (input.topic != null && (typeof input.topic !== 'string' || input.topic.trim().length < 3 || input.topic.length > 120)) return json(res, 400, { error: 'A topic must contain 3–120 characters.' });
          if (input.gender && !['neutral', 'male', 'female'].includes(input.gender)) return json(res, 400, { error: 'Invalid speaker preference.' });
          generating = true;
          try { return json(res, 200, { lesson: await store.generate(input.code, input.id, { topic: input.topic?.trim(), gender: input.gender }) }); }
          finally { generating = false; }
        }
        return json(res, 404, { error: 'Endpoint not found.' });
      }
      // Deliberate allowlist: never serve server code, secrets, jobs or data paths.
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
      if (!['/', '/index.html'].includes(url.pathname)) return json(res, 404, { error: 'Not found.' });
      const content = await fs.readFile(path.join(root, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'The server could not complete this request. Check its data directory and retry.' });
      else res.end();
    }
  });
  server.requestTimeout = 200000;
  await jobs.init();
  return { server, store, jobs, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await jobs.close(); } };
}
if (require.main === module) {
  createApp().then(app => {
    const host = process.env.HOST || '127.0.0.1'; const port = Number(process.env.PORT || 3000);
    app.server.listen(port, host, () => console.log(`Parley listening on http://${host}:${port}`));
    const shutdown = async () => { await app.close(); process.exit(0); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  }).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { createApp };
