'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { LessonStore, createProvider, validateLesson, atomicJSON } = require('../server/lessons');
const { Jobs } = require('../server/jobs');
const { languages, seed } = require('../server/catalog');
const token = 'test-administrator-token-123456789';
const fixture = () => ({ ...structuredClone(seed('es-MX', 2)), goal: 'Introduce yourself and ask someone their name.' });
const waitFor = async condition => {
  for (let i = 0; i < 1000; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Timed out waiting for course build.');
};
async function setup(t, options = {}) {
  const testRoot = path.resolve(__dirname, '../.test-data');
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'parley-test-'));
  const app = await createApp({ dataDir: dir, adminToken: token, configured: true, provider: async () => fixture(), ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); if (!path.resolve(dir).startsWith(testRoot + path.sep)) throw Error('Invalid test cleanup path'); await fs.rm(dir, { recursive: true, force: true }); });
  const request = async (url, data, admin = false, headers = {}) => {
    const res = await fetch(base + url, { ...(data !== undefined ? { method: 'POST', body: JSON.stringify(data) } : {}),
      headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
    const body = await res.json(); return { status: res.status, body, headers: res.headers };
  };
  return { ...app, dir, base, request };
}
test('full language catalog has exactly 30 slots per listed language and honest availability', async t => {
  const app = await setup(t);
  const result = await app.request('/api/catalog');
  assert.equal(result.status, 200); assert.equal(result.body.languages.length, languages.size);
  assert.ok(languages.size > 100);
  assert.ok(result.body.languages.every(l => l.total === 30 && l.ready === l.available.length && l.complete === (l.ready === 30)));
  assert.equal(result.body.languages.find(l => l.code === 'es-MX').ready, 30);
  assert.equal(result.body.languages.find(l => l.code === 'zu-ZA').ready, 0);
});
test('standalone serves lessons without any hosted artifact runtime; secrets and source are not public', async t => {
  const app = await setup(t);
  const html = await (await fetch(app.base)).text();
  assert.ok(html.includes('Course studio')); assert.doesNotMatch(html, /claude\.use|window\.claude|OPENAI_API_KEY=/i);
  assert.equal((await app.request('/api/courses/es-MX')).body.lessons[2].title, 'Who are you?');
  for (const route of ['/.env', '/server/index.js', '/data/jobs.json', '/package.json']) assert.equal((await fetch(app.base + route)).status, 404);
});
test('paid generation requires admin access and rejects cross-origin writes', async t => {
  const app = await setup(t);
  assert.equal((await app.request('/api/lessons/generate', { code: 'fr-FR', id: 2 })).status, 401);
  assert.equal((await app.request('/api/lessons/generate', { code: 'fr-FR', id: 2 }, true, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await app.request('/api/admin/session', { token: 'wrong' })).status, 401);
  const login = await app.request('/api/admin/session', { token });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await app.request('/api/status', undefined, false, { Cookie: cookie })).body.admin, true);
  assert.equal((await app.request('/api/admin/logout', {}, false, { Cookie: cookie })).status, 200);
  assert.equal((await app.request('/api/status', undefined, false, { Cookie: cookie })).body.admin, false);
});
test('unconfigured model has a clear error and never reports a completed catalog', async t => {
  const app = await setup(t, { configured: false });
  assert.equal((await app.request('/api/status')).body.generationConfigured, false);
  assert.equal((await app.request('/api/jobs', { languages: 'all' }, true)).status, 503);
  assert.equal((await app.request('/api/lessons/generate', { code: 'fr-FR', id: 2 }, true)).status, 503);
});
test('sequential generation persists, deduplicates concurrent work, and reuses saved lessons', async t => {
  let calls = 0; const prompts = [];
  const app = await setup(t, { provider: async p => { calls++; prompts.push(p); await new Promise(r => setTimeout(r, 10)); return fixture(); } });
  assert.equal((await app.request('/api/lessons/generate', { code: 'fr-FR', id: 3 }, true)).status, 409);
  const [a, b] = await Promise.all([app.store.generate('fr-FR', 2), app.store.generate('fr-FR', 2)]);
  assert.equal(calls, 1); assert.equal(a.title, b.title);
  const disk = JSON.parse(await fs.readFile(app.store.file('fr-FR', 2), 'utf8'));
  assert.equal(disk.reviewStatus, 'unreviewed'); assert.equal(disk.language, 'fr-FR');
  await app.store.generate('fr-FR', 2); assert.equal(calls, 1);
  await app.store.generate('fr-FR', 3); assert.equal(calls, 2);
  assert.match(prompts[1], /me llamo/); // The saved previous lesson is supplied as course context.
  const restored = new LessonStore(app.dir, () => { throw Error('Must not regenerate'); });
  assert.equal((await restored.get('fr-FR', 2)).title, a.title);
});
test('invalid provider output is rejected before saving', async t => {
  const app = await setup(t, { provider: async () => ({ title: 'Not a lesson', items: [] }) });
  assert.equal((await app.request('/api/lessons/generate', { code: 'fr-FR', id: 2 }, true)).status, 422);
  assert.equal(await app.store.get('fr-FR', 2), null);
  const invalid = fixture(); invalid.items[1].t = invalid.items[0].t;
  assert.throws(() => validateLesson(invalid), /distinct|Backward/);
});
test('topic context stays at the learner course level and shared course forms stay neutral', async t => {
  const prompts = [];
  const app = await setup(t, { provider: async p => { prompts.push(p); return fixture(); } });
  await app.store.generate('fr-FR', 2, { gender: 'female' });
  assert.match(prompts[0], /gender preference: neutral/);
  await app.store.generate('es-MX', 1, { topic: 'At the café', gender: 'female' });
  assert.match(prompts[1], /gender preference: female/);
  assert.match(prompts[1], /known phrases.*\n\(none\)/);
  assert.doesNotMatch(prompts[1], /me quedé/);
});
test('OpenAI request uses server credentials and strict Responses structured output; failures are sanitized', async () => {
  let request;
  const provider = createProvider({ key: 'test-key', fetchImpl: async (url, options) => {
    request = { url, ...options };
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(fixture()) }] }] }) };
  } });
  const lesson = await provider('Course prompt');
  const body = JSON.parse(request.body);
  assert.equal(request.url, 'https://api.openai.com/v1/responses'); assert.equal(body.store, false);
  assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.text.format.strict, true);
  assert.equal(lesson.reviewStatus, 'unreviewed'); assert.equal(request.headers.Authorization, 'Bearer test-key');
  await assert.rejects(createProvider({ key: '' })('x'), /OPENAI_API_KEY/);
  await assert.rejects(createProvider({ key: 'test-key', fetchImpl: async () => ({ ok: false, status: 401 }) })('x'), e => !e.message.includes('test-key') && e.status === 502);
});
test('catalog jobs fill all 30 lessons for a language and skip existing content', async t => {
  let calls = 0;
  const app = await setup(t, { provider: async () => { calls++; return fixture(); } });
  const response = await app.request('/api/jobs', { languages: ['fr-FR'] }, true);
  assert.equal(response.status, 202);
  await waitFor(() => app.jobs.jobs[0].status === 'completed');
  assert.equal(calls, 29); assert.equal(Object.keys(await app.store.course('fr-FR')).length, 30);
  await app.jobs.create(['fr-FR']); await waitFor(() => app.jobs.jobs[0].status === 'completed');
  assert.equal(calls, 29); assert.equal(app.jobs.jobs[0].checked, 30);
});
test('failed course builds resume after restart without losing saved lessons', async t => {
  let calls = 0;
  const app = await setup(t, { provider: async () => { calls++; if (calls === 2) throw Object.assign(new Error('Rate limited'), { status: 429 }); return fixture(); } });
  await app.jobs.create(['fr-FR']); await waitFor(() => app.jobs.jobs[0].status === 'failed');
  assert.equal(Object.keys(await app.store.course('fr-FR')).length, 2);
  const saved = JSON.parse(await fs.readFile(app.jobs.file, 'utf8')); saved[0].status = 'running'; await atomicJSON(app.jobs.file, saved);
  const recovered = new Jobs(new LessonStore(app.dir, async () => fixture()));
  await recovered.init(); await waitFor(() => recovered.jobs[0].status === 'completed'); await recovered.close();
  assert.equal(Object.keys(await app.store.course('fr-FR')).length, 30);
});
test('all-language jobs enumerate every language and 30 slots; invalid paths cannot reach disk', async t => {
  const app = await setup(t);
  app.jobs.kick = () => {};
  const result = await app.request('/api/jobs', { languages: 'all' }, true);
  assert.equal(result.body.job.total, languages.size * 30);
  assert.equal(new Set(result.body.job.languages).size, languages.size);
  assert.equal((await app.request('/api/courses/not-a-language')).status, 400);
  for (const id of [0, 31, '../secret', 1.5]) await assert.rejects(app.store.get('es-MX', id));
});
test('all included lessons pass structural checks and Spanish has a full thirty-lesson path', () => {
  for (const code of languages.keys()) for (let id = 1; id <= 30; id++) {
    const lesson = seed(code, id);
    if (code === 'es-MX') assert.ok(lesson, `Missing Spanish lesson ${id}`);
    if (lesson) assert.doesNotThrow(() => validateLesson({ ...lesson, goal: lesson.goal || 'Complete this lesson.' }), `${code} lesson ${id}`);
  }
});
