'use strict';
/* ================= Parley: audio-first spaced-recall trainer ================= */
const SPEED = window.__parleySpeed || 1;            // test hook: compresses waits
const SESSION_IV = [5, 25, 120, 600];               // in-lesson gaps (seconds)
const LONG_IV = [1, 5, 25, 120, 730];               // later reviews (days)
const LADDER = ['5s','25s','2m','10m','1d','5d','25d','4mo','2y'];
const DAY = 864e5;
const $ = s => document.querySelector(s);
const h = (tag, attrs, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const pick = a => a[Math.floor(Math.random() * a.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtTime = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

/* ---------- text helpers ---------- */
const DENSE = /[฀-໿က-႟ក-៿぀-ヿ㐀-鿿豈-﫿가-힯]/;
const norm = s => String(s || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
const itemKey = (code, t) => code + '|' + norm(t);
function contains(sentence, item) {
  const a = norm(sentence), b = norm(item);
  if (!b) return false;
  if (DENSE.test(b)) { const bb = b.replace(/ /g, ''); return [...bb].length >= 2 && a.replace(/ /g, '').includes(bb); }
  const at = a.split(' '), bt = b.split(' ');
  for (let i = 0; i + bt.length <= at.length; i++) if (bt.every((w, j) => at[i + j] === w)) return true;
  return false;
}
function estimate(text, rate = 1) {
  const s = String(text || ''); const dense = [...s].filter(c => DENSE.test(c)).length;
  return (0.45 + dense * 0.24 + (s.length - dense) * 0.072) / Math.max(0.4, rate);
}

/* ---------- state + storage ---------- */
const DEFAULTS = { think: 5, rate: 0.9, mode: 'handsfree', roman: true, dlgText: false, gender: 'neutral', voices: {} };
let S = { settings: { ...DEFAULTS }, lang: 'es-MX', custom: [], progress: {}, lessons: {}, updatedAt: 0 };
const LS = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
function loadLocal() {
  const st = LS.get('parley.v1'); if (st) { Object.assign(S, st); S.settings = { ...DEFAULTS, ...(st.settings || {}) }; }
  S.lessons = LS.get('parley.v1.lessons') || {};
  S.progress = S.progress || {};
}
function saveMeta() {
  S.updatedAt = Date.now();
  LS.set('parley.v1', { settings: S.settings, lang: S.lang, custom: S.custom, progress: S.progress, updatedAt: S.updatedAt });
}
function prog(code) {
  if (!S.progress[code]) S.progress[code] = { done: {}, items: {}, updatedAt: 0 };
  return S.progress[code];
}
function saveProg(code) { const P = prog(code); P.updatedAt = Date.now(); saveMeta();  }
function saveLesson(code, id, L) {
  (S.lessons[code] = S.lessons[code] || {})[id] = L;
  LS.set('parley.v1.lessons', S.lessons);
}
function getLesson(code, id) { return Backend.lessons[code]?.[id] || COURSE[code]?.[id] || S.lessons[code]?.[id] || (String(id) === '1' ? BUILTIN[code] : null) || null; }
function langInfo(code) {
  return LANGS.find(l => l.code === code) || S.custom.find(l => l.code === code) || { code, name: code, native: '' };
}
const cur = () => langInfo(S.lang);

/* ---------- standalone service ---------- */
const Backend = {
  available: false, configured: false, admin: false, lessons: {}, manifest: [],
  async request(path, data, signal) {
    const res = await fetch(path, { credentials: 'same-origin', signal,
      ...(data !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
    let result;
    try { result = await res.json(); } catch { throw new Error('The Parley service did not return a valid response.'); }
    if (!res.ok) throw new Error(result.error || 'The Parley service could not complete this request.');
    return result;
  },
  async loadLanguage(code) {
    if (!this.available || !LANGS.some(l => l.code === code)) return;
    try {
      const result = await this.request('/api/courses/' + encodeURIComponent(code));
      if (S.lang !== code) return;
      this.lessons = { [code]: result.lessons || {} }; renderHome();
    } catch (e) { renderHome(null, { genError: e.message }); }
  },
  async init() {
    if (!/^https?:$/.test(location.protocol)) return;
    try {
      const status = await this.request('/api/status', undefined, AbortSignal.timeout(5000));
      this.available = status.standalone === true; this.configured = status.generationConfigured; this.admin = status.admin;
      if (!this.available) return;
      await this.loadLanguage(S.lang);
      const catalog = await this.request('/api/catalog'); this.manifest = catalog.languages || []; renderHome();
    } catch { this.available = false; renderHome(); }
  }
};

/* ---------- speech ---------- */
const TTS = {
  ok: 'speechSynthesis' in window, voices: [], cur: null,
  load() { try { const v = speechSynthesis.getVoices(); if (v && v.length) this.voices = v; } catch {} },
  init() {
    if (!this.ok) return;
    this.load();
    try { speechSynthesis.addEventListener('voiceschanged', () => { this.load(); renderVoice(); }); } catch {}
    setTimeout(() => { this.load(); renderVoice(); }, 900);
  },
  /* Rank voices by clarity. Neural / premium / enhanced voices are far clearer than the
     compact defaults most devices ship with; novelty voices are dropped entirely. */
  quality(v) {
    const n = (v.name + ' ' + (v.voiceURI || '')).toLowerCase();
    if (/albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|eloquence|good news|hysterical|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox|grandma|grandpa|rocko|shelley|\bflo\b|\breed\b|\bsandy\b|\beddy\b/.test(n)) return { s: -10, tier: 'Novelty' };
    let s = 0, tier = 'Standard';
    if (/premium/.test(n)) { s = 6; tier = 'Premium'; }
    else if (/enhanced/.test(n)) { s = 5; tier = 'Enhanced'; }
    else if (/neural|natural|online|wavenet|journey|studio/.test(n)) { s = 5; tier = 'Natural'; }
    else if (/siri/.test(n)) { s = 4; tier = 'Siri'; }
    else if (/google/.test(n)) { s = 3; tier = 'Google'; }
    else if (/compact|espeak|pico/.test(n)) { s = -1; tier = 'Basic'; }
    if (v.localService) s += 0.3;
    return { s, tier };
  },
  forLang(code) {
    if (!code || code.startsWith('x-')) return [];
    const c = code.toLowerCase(), base = c.split('-')[0];
    const L = v => (v.lang || '').toLowerCase().replace(/_/g, '-');
    let vs;
    if (c === 'zh-hk') vs = this.voices.filter(v => /^(zh-hk|yue)/.test(L(v)));
    else if (base === 'zh') vs = this.voices.filter(v => /^(zh|cmn)/.test(L(v)) && !/^(zh-hk|yue)/.test(L(v)));
    else if (base === 'fil') vs = this.voices.filter(v => /^(fil|tl)/.test(L(v)));
    else if (base === 'nb') vs = this.voices.filter(v => /^(nb|no|nn)/.test(L(v)));
    else vs = this.voices.filter(v => L(v).split('-')[0] === base);
    const rank = v => this.quality(v).s + (L(v) === c ? 2 : 0);
    vs = vs.filter(v => this.quality(v).s > -10).sort((a, b) => rank(b) - rank(a));
    const pref = S.settings.voices?.[code];
    if (pref) { const i = vs.findIndex(v => (v.voiceURI || v.name) === pref); if (i > 0) vs.unshift(vs.splice(i, 1)[0]); }
    return vs;
  },
  /* Second speaker in dialogues: a different person of similar quality, never a worse voice. */
  voiceFor(code, idx) {
    const l = this.forLang(code); if (!l.length) return null;
    if (!idx) return l[0];
    const who = v => v.name.replace(/\s*\(.*?\)\s*/g, '').trim();
    const q0 = this.quality(l[0]).s;
    return l.find(v => who(v) !== who(l[0]) && this.quality(v).s >= q0 - 1) || l[0];
  },
  has(code) { return this.forLang(code).length > 0; },
  unlock() { if (!this.ok) return; try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {} },
  speak(text, { lang, rate = 1, voiceIdx = 0 } = {}) {
    return new Promise(res => {
      const est = estimate(text, rate) * 1000;
      if (!this.ok || !text) { setTimeout(() => res({ interrupted: false, silent: true }), est / SPEED); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang; u.rate = rate; u.pitch = 1; u.volume = 1;
      const v = this.voiceFor(lang, voiceIdx); if (v) { try { u.voice = v; u.lang = v.lang; } catch {} }
      let done = false, started = false, t1, t2;
      const finish = r => { if (done) return; done = true; clearTimeout(t1); clearTimeout(t2); if (this.cur && this.cur.finish === finish) this.cur = null; setSpeaking(false); res(r); };
      u.onstart = () => { started = true; setSpeaking(true); };
      u.onend = () => finish({ interrupted: false });
      u.onerror = e => finish({ interrupted: e && (e.error === 'interrupted' || e.error === 'canceled') && !!this.cancelling });
      t1 = setTimeout(() => { if (!started) t2 = setTimeout(() => finish({ interrupted: false, silent: true }), Math.max(0, est - 1200) / SPEED); }, 1200 / SPEED);
      setTimeout(() => finish({ interrupted: false }), (est * 2.5 + 5000) / SPEED);
      this.cur = { finish };
      try { speechSynthesis.speak(u); } catch { finish({ interrupted: false, silent: true }); }
    });
  },
  cancel() {
    this.cancelling = true;
    try { speechSynthesis.cancel(); } catch {}
    if (this.cur) this.cur.finish({ interrupted: true });
    setTimeout(() => { this.cancelling = false; }, 50);
  }
};
function setSpeaking(on) { const e = $('#spk'); if (e) e.hidden = !on; }

/* ---------- session engine ---------- */
const ABORT = { abort: true };
let X = null;
function clock() {
  const now = performance.now();
  return ((now - X.t0 - X.pausedMs - (X.paused ? now - X.pausedAt : 0)) / 1000) * SPEED;
}
function check() { if (!X || X.aborted) throw ABORT; }
async function gate() { while (X && X.paused) { check(); await sleep(100); } check(); }

const NAR = { lang: 'en-US' };
const NAR_RATE = 0.95;
async function say(text, who = 'nar', o = {}) {
  if (!text) return;
  for (;;) {
    await gate();
    const tgt = who !== 'nar';
    const rate = tgt ? S.settings.rate * (o.slow ? 0.82 : 1) : NAR_RATE;
    if (tgt) X.lastTarget = text;
    if (tgt && X.silentTarget) { await wait(estimate(text, rate)); return; }
    const r = await TTS.speak(text, { lang: tgt ? X.ttsLang : NAR.lang, rate, voiceIdx: o.voice || 0 });
    check();
    if (!r.interrupted) return;
  }
}
function wait(sec, { skippable = false, ring = false } = {}) {
  return new Promise((res, rej) => {
    let remaining = sec * 1000, last = performance.now();
    const total = remaining;
    X.skip = false;
    const tick = () => {
      if (!X || X.aborted) return rej(ABORT);
      const now = performance.now();
      if (!X.paused) remaining -= (now - last) * SPEED;
      last = now;
      if (ring) setRing(Math.max(0, remaining / total), remaining);
      if (skippable && X.skip) { X.skip = false; return res('skip'); }
      if (remaining <= 0) return res('done');
      setTimeout(tick, 60);
    };
    tick();
  });
}
const repeatPause = t => Math.min(7, estimate(t, S.settings.rate) * 1.25 + 1.4);

const P_INTRO = [e => `Here's how to say "${e}".`, e => `Now, "${e}".`, e => `Next: "${e}". Listen.`, e => `Here is "${e}".`];
const P_REPEAT = ['Repeat after the speaker.', 'Say it out loud.', 'Your turn.', 'Say it with the speaker.'];
const P_BUILD = ['Build it up from the end.', "Let's take it from the back.", 'Piece by piece, from the end.'];
const P_RECALL = [e => `How do you say "${e}"?`, e => `Say "${e}".`, e => `Do you remember how to say "${e}"?`, e => `Try: "${e}".`, e => `How would you say "${e}"?`];
const P_DRILL = [e => `Now put it together. Try saying: "${e}".`, e => `You can say this already: "${e}".`, e => `Combine what you know: "${e}".`];

function mkCard(base, src) {
  const need = src === 'review' ? 1 : base.kind === 'drill' ? 3 : 4;
  return { key: base.key, kind: base.kind || 'item', t: base.t, r: base.r || '', en: base.en, note: base.note || '', build: base.build || [],
    src, iv: SESSION_IV, step: 0, need, wins: 0, lapses: 0, reps: 0, intro: src === 'review', due: src === 'review' ? -1 : Infinity,
    done: false, uses: [], stage: base.stage ?? -1, early: !!base.early };
}

function buildLessonSession(code, id) {
  const L = getLesson(code, id); if (!L) return null;
  const P = prog(code); const now = Date.now();
  const replay = !!P.done[id];
  const cards = [];
  const thisKeys = new Set([...L.items.map(i => itemKey(code, i.t)), ...L.drills.map(d => itemKey(code, d.t))]);
  Object.entries(P.items).filter(([k, it]) => it.due <= now && !thisKeys.has(k)).sort((a, b) => a[1].due - b[1].due).slice(0, 8)
    .forEach(([k, it]) => cards.push(mkCard({ ...it, key: k }, 'review')));
  // Recycle recent course material even when tomorrow's review is not due.
  // Early practice must not advance the long-term review date.
  const reviewKeys = new Set(cards.map(c => c.key));
  Object.entries(P.items).filter(([k]) => !thisKeys.has(k) && !reviewKeys.has(k))
    .sort((a, b) => (b[1].last || 0) - (a[1].last || 0)).slice(0, Math.max(0, 6 - cards.length))
    .forEach(([k, it]) => cards.push(mkCard({ ...it, key: k, early: true }, 'review')));
  const fresh = [];
  for (const i of L.items) { const k = itemKey(code, i.t); if (!replay && P.items[k] && P.items[k].lesson !== String(id)) continue; fresh.push(mkCard({ ...i, kind: 'item', key: k }, 'new')); }
  for (const d of L.drills) { const k = itemKey(code, d.t); if (!replay && P.items[k] && P.items[k].lesson !== String(id)) continue; fresh.push(mkCard({ ...d, kind: 'drill', key: k }, 'new')); }
  const seen = new Set(); const uniq = fresh.filter(c => !seen.has(c.key) && seen.add(c.key));
  const items = uniq.filter(c => c.kind === 'item');
  for (const d of uniq.filter(c => c.kind === 'drill')) d.uses = items.filter(i => contains(d.t, i.t)).map(i => i.key);
  cards.push(...uniq);
  return { lesson: L, cards, replay };
}

function buildReviewSession(code) {
  const P = prog(code); const now = Date.now();
  let list = Object.entries(P.items).filter(([, it]) => it.due <= now).sort((a, b) => a[1].due - b[1].due).slice(0, 30);
  let early = false;
  if (!list.length) { early = true; list = Object.entries(P.items).sort((a, b) => a[1].due - b[1].due).slice(0, 15); }
  if (!list.length) return null;
  return { lesson: null, cards: list.map(([k, it]) => mkCard({ ...it, key: k, early }, 'review')), early };
}

async function startSession(kind, code, id) {
  const built = kind === 'review' ? buildReviewSession(code) : buildLessonSession(code, id);
  if (!built) return;
  TTS.unlock();
  const L = langInfo(code);
  X = { kind, code, id: String(id || ''), L, ttsLang: code.startsWith('x-') ? '' : code, lesson: built.lesson, cards: built.cards, replay: built.replay,
    t0: performance.now(), pausedMs: 0, paused: false, aborted: false, finished: false, tipIdx: 0, introduced: 0, lastNewKind: 'drill',
    mode: S.settings.mode, byKey: Object.fromEntries(built.cards.map(c => [c.key, c])), stats: { ok: 0, miss: 0 } };
  X.silentTarget = !X.ttsLang || !TTS.ok || (TTS.voices.length > 0 && !TTS.has(X.ttsLang));
  showPlayer();
  if (X.silentTarget) { const el = $('#pTip'); el.textContent = `No ${L.name} voice on this device, so ${L.name} is shown as text. Read it aloud during the pauses.`; el.hidden = false; setTimeout(() => { el.hidden = true; }, 9000); }
  try { X.wake = await navigator.wakeLock?.request('screen'); } catch {}
  X.timer = setInterval(() => { if (X && !X.paused) $('#pTime').textContent = fmtTime(clock() / SPEED); }, 1000);
  try {
    if (kind === 'lesson') await runLesson(); else await runReview();
    X.finished = true;
  } catch (e) { if (e !== ABORT) console.error(e); }
  const result = commit();
  endSession(result);
}

async function runLesson() {
  const L = X.lesson;
  phase('Get ready', 'Guided audio lesson');
  await say(`Welcome to your ${X.L.name} lesson. Listen, then speak out loud during each pause. Try to answer before the speaker. You can pause at any time.`);
  if (L.goal) await say(L.goal);
  if (L.dialogue.length) {
    phase('Listen', 'Conversation');
    await say(`Lesson ${X.id.startsWith('c') ? '' : X.id + '. '}${L.title}. First, listen to a short conversation in ${X.L.name}. You don't need to understand it yet.`);
    await playDialogue(S.settings.dlgText);
  }
  if (X.cards.some(c => c.src === 'review')) { phase('Warm-up', 'Review'); await say("Let's warm up with a few things from before."); }
  await core();
  if (L.dialogue.length) await roleplay();
  if (L.dialogue.length) {
    phase('Listen again', 'Conversation');
    await say("Now listen to the conversation again. This time, you'll understand it.");
    await playDialogue(true);
  }
  await say("That's the end of this lesson. Well done.");
}
async function roleplay() {
  phase('Your conversation', 'Take the part of speaker A');
  await say('Now take part in the conversation. You are speaker A. Use the English cue to answer out loud. Then compare with the speaker.');
  for (const line of X.lesson.dialogue) {
    check();
    if (line.s === 'A') {
      showCard({ tag: 'Your turn', cue: line.en, target: line.t, roman: line.r, veiled: true, recall: true });
      await say(line.en);
      showThinking(true);
      await wait(S.settings.think + Math.min(4, estimate(line.t) * 0.5), { skippable: true, ring: true });
      showThinking(false); reveal();
      await say(line.t, 'tgt');
      await wait(repeatPause(line.t));
    } else {
      showCard({ tag: 'Listen to your partner', cue: '', target: line.t, roman: line.r });
      await say(line.t, 'tgt', { voice: 1 });
      await wait(0.6);
    }
  }
}
async function runReview() {
  phase('Review', X.cards[0]?.early ? 'Extra practice' : 'Due today');
  await say(`Review time. ${X.cards.length} phrases in ${X.L.name}.`);
  await core();
  await say('Review complete.');
}

async function core() {
  for (;;) {
    check();
    const now = clock();
    const pending = X.cards.filter(c => c.intro && !c.done);
    const due = pending.filter(c => c.due <= now).sort((a, b) => a.due - b.due);
    if (due.length) { await recall(due[0]); continue; }
    const shaky = pending.filter(c => c.wins < 1).length;
    const nx = shaky < 3 ? nextNew() : null;
    if (nx) {
      if (nx.kind === 'drill') await recall(nx, true); else await introduce(nx);
      X.lastNewKind = nx.kind;
      continue;
    }
    if (!pending.length) { if (nextNew()) { const n2 = nextNew(); if (n2.kind === 'drill') await recall(n2, true); else await introduce(n2); continue; } break; }
    pending.sort((a, b) => a.due - b.due);
    // Do not collapse the spacing by immediately testing the next pending card.
    // Fill the gap with a listening passage, then allow a quiet recall break.
    if (X.lesson?.dialogue.length && pending[0].due - clock() > 35 && X.listeningBreakDue !== pending[0].due) {
      X.listeningBreakDue = pending[0].due;
      phase('Listening break', 'Let the phrases settle');
      await playDialogue(false);
    }
    const gap = pending[0].due - clock();
    if (gap > 0) {
      phase('Recall break', 'Next speaking prompt soon');
      showCard({ tag: 'Recall break', cue: 'Relax and listen for the next prompt.', target: '', roman: '' });
      await wait(Math.min(gap, 20));
    }
  }
}
function nextNew() {
  const fresh = X.cards.filter(c => !c.intro && c.src === 'new');
  if (!fresh.length) return null;
  const items = fresh.filter(c => c.kind === 'item');
  const ready = fresh.filter(c => c.kind === 'drill' && c.uses.every(k => { const u = X.byKey[k]; return !u || (u.intro && u.wins >= 1); }));
  if (ready.length && (X.lastNewKind === 'item' || !items.length)) return ready[0];
  if (items.length) return items[0];
  return fresh[0];
}

async function introduce(c) {
  c.intro = true; X.current = c; X.introduced++;
  phase('New phrase', 'Listen and repeat');
  showCard({ tag: 'New', cue: c.en, target: c.t, roman: c.r, veiled: false });
  ladderFor(c);
  await say(pick(P_INTRO)(c.en));
  await say(c.t, 'tgt');
  await say(X.introduced <= 3 ? P_REPEAT[0] : pick(P_REPEAT));
  await say(c.t, 'tgt', { slow: true });
  await wait(repeatPause(c.t));
  if (c.build.length > 1) {
    await say(pick(P_BUILD));
    for (const ch of c.build) {
      setBuild(ch);
      await say(ch, 'tgt', { slow: true });
      await wait(repeatPause(ch));
    }
    setBuild('');
  }
  if (c.note) { setNote(c.note); await say(c.note); }
  await say(c.t, 'tgt');
  await wait(repeatPause(c.t));
  setNote('');
  c.step = 0; c.due = clock() + c.iv[0];
  await maybeTip();
}
async function maybeTip() {
  const tips = X.lesson?.tips || [];
  if (X.tipIdx < tips.length && X.introduced > 0 && X.introduced % 4 === 0) {
    const tip = tips[X.tipIdx++];
    const el = $('#pTip'); el.textContent = 'Tip: ' + tip; el.hidden = false;
    await say(tip);
    setTimeout(() => { el.hidden = true; }, 6000 / SPEED);
  }
}

async function recall(c, first = false) {
  c.intro = true; X.current = c;
  const isDrill = c.kind === 'drill';
  phase(first ? 'Put it together' : c.src === 'review' ? 'Review' : 'Recall', isDrill ? 'Build a sentence' : 'Say it before you hear it');
  showCard({ tag: first ? 'Combine' : 'Recall', cue: c.en, target: c.t, roman: c.r, veiled: true, recall: true });
  ladderFor(c);
  await say(first ? pick(P_DRILL)(c.en) : pick(P_RECALL)(c.en));
  showThinking(true);
  const think = S.settings.think + Math.min(4, estimate(c.t, 1) * 0.5);
  await wait(think, { skippable: true, ring: true });
  showThinking(false);
  reveal();
  await say(c.t, 'tgt');
  let ok = true;
  if (S.settings.mode === 'active') {
    ok = await awaitGrade();
    await say(c.t, 'tgt');
    await wait(repeatPause(c.t) * 0.8);
  } else {
    await wait(repeatPause(c.t));
    if (c.wins < 2) { await say(c.t, 'tgt'); await wait(repeatPause(c.t) * 0.8); }
  }
  grade(c, ok);
}
function grade(c, ok) {
  const now = clock(); c.reps++;
  if (ok) {
    X.stats.ok++; c.wins++;
    if (c.wins >= c.need) c.done = true;
    else { c.step = Math.min(c.step + 1, c.iv.length - 1); c.due = now + c.iv[c.step]; }
  } else {
    X.stats.miss++; c.lapses++;
    c.need = Math.max(c.need, c.wins + 2);
    c.step = 0; c.due = now + c.iv[0];
  }
  updateProgress();
}
function awaitGrade() {
  return new Promise((res, rej) => {
    $('#ctrls').hidden = true; $('#grade').hidden = false;
    X.onGrade = v => { X.onGrade = null; X.onAbort = null; $('#grade').hidden = true; $('#ctrls').hidden = false; res(v); };
    X.onAbort = () => { X.onGrade = null; X.onAbort = null; $('#grade').hidden = true; $('#ctrls').hidden = false; rej(ABORT); };
  });
}

async function playDialogue(showText) {
  const L = X.lesson;
  $('#cardView').hidden = true; const box = $('#dlgView'); box.hidden = false; box.replaceChildren();
  const rows = L.dialogue.map(d => {
    const el = h('div', { class: 'line ' + (d.s === 'B' ? 'b' : 'a') + (showText ? '' : ' veil') },
      h('div', { class: 'who' }, d.s),
      h('div', null, h('div', { class: 'lt', dir: 'auto', lang: X.code }, d.t), S.settings.roman && d.r ? h('div', { class: 'lr' }, d.r) : null, h('div', { class: 'le' }, d.en)));
    box.append(el); return el;
  });
  for (let i = 0; i < L.dialogue.length; i++) {
    rows.forEach(r => r.classList.remove('cur')); rows[i].classList.add('cur');
    rows[i].scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    const d = L.dialogue[i];
    await say(d.t, 'tgt', { voice: d.s === 'B' ? 1 : 0 });
    await wait(0.6);
  }
  rows.forEach(r => r.classList.remove('cur'));
  await wait(0.8);
  box.hidden = true; $('#cardView').hidden = false;
}

function commit() {
  if (!X) return null;
  const P = prog(X.code); const now = Date.now();
  const learned = [];
  for (const c of X.cards) {
    if (!c.intro || c.reps === 0 && c.src === 'new' && !c.done && c.kind === 'drill') continue;
    const prev = P.items[c.key];
    const it = prev || { t: c.t, r: c.r, en: c.en, kind: c.kind, lesson: X.kind === 'lesson' ? X.id : '', stage: 0, due: now, reps: 0, lapses: 0 };
    it.t = c.t; it.r = c.r; it.en = c.en; it.reps = (it.reps || 0) + c.reps; it.lapses = (it.lapses || 0) + c.lapses;
    if (c.src === 'new') {
      if (!prev) learned.push(c);
      if (!prev || c.lapses) { it.stage = 0; it.due = c.done || c.wins > 0 ? now + LONG_IV[0] * DAY : now; }
    } else if (c.done || c.lapses) {
      if (c.lapses) { it.stage = 0; it.due = now + LONG_IV[0] * DAY; }
      else if (!c.early) { it.stage = Math.min((it.stage ?? 0) + 1, LONG_IV.length - 1); it.due = now + LONG_IV[it.stage] * DAY; }
    }
    it.last = now;
    P.items[c.key] = it;
  }
  const total = X.cards.reduce((s, c) => s + c.need, 0), got = X.cards.reduce((s, c) => s + Math.min(c.wins, c.need), 0);
  const frac = total ? got / total : 0;
  const acc = X.stats.ok + X.stats.miss ? X.stats.ok / (X.stats.ok + X.stats.miss) : 1;
  if (X.kind === 'lesson' && X.finished) P.done[X.id] = { at: now, acc: X.mode === 'active' ? Math.round(acc * 100) : null, mode: X.mode };
  saveProg(X.code);
  return { kind: X.kind, id: X.id, code: X.code, learned, acc, mode: X.mode, minutes: clock() / SPEED / 60, finished: X.finished, frac, reviewed: X.cards.filter(c => c.src === 'review' && c.reps).length };
}
function endSession(result) {
  if (!X) return;
  clearInterval(X.timer);
  try { X.wake?.release(); } catch {}
  X = null;
  TTS.cancel();
  $('#player').hidden = true; $('#home').hidden = false;
  renderHome(result);
  window.scrollTo(0, 0);
}

/* ---------- player UI ---------- */
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
function showPlayer() {
  $('#home').hidden = true; $('#player').hidden = false; $('#layer').replaceChildren();
  $('#pLesson').textContent = X.kind === 'review' ? `${X.L.name} · Review` : `${X.L.name} · ${X.id.startsWith('c') ? 'Your topic' : 'Lesson ' + X.id}: ${X.lesson.title}`;
  $('#pTime').textContent = '0:00'; $('#pTip').hidden = true; $('#grade').hidden = true; $('#ctrls').hidden = false;
  $('#bPause').innerHTML = PAUSE_ICON; $('#bPause').setAttribute('aria-label', 'Pause');
  $('#bReveal').hidden = S.settings.mode !== 'active';
  $('#bReveal').disabled = true;
  $('#cTarget').setAttribute('lang', X.code);
  $('#dlgView').hidden = true; $('#cardView').hidden = false;
  showCard({ tag: '', cue: 'Get ready', target: '', roman: '' });
  renderLadder($('#pLadder'), -1);
  updateProgress();
  window.scrollTo(0, 0);
}
function phase(a, b) { $('#pPhase').textContent = a; }
function showCard({ tag, cue, target, roman, veiled, recall }) {
  const t = $('#cTag'); t.textContent = tag || ''; t.className = 'tag' + (recall ? ' recall' : '');
  $('#cCue').textContent = cue || '';
  const tg = $('#cTarget'); tg.textContent = target || ''; tg.classList.toggle('veiled', !!veiled);
  $('#cRoman').textContent = S.settings.roman ? (roman || '') : '';
  $('#cRoman').style.visibility = veiled ? 'hidden' : 'visible';
  $('#cBuild').textContent = ''; $('#cNote').textContent = '';
}
function reveal() { $('#cTarget').classList.remove('veiled'); $('#cRoman').style.visibility = 'visible'; }
function setBuild(t) { $('#cBuild').textContent = t ? '… ' + t : ''; }
function setNote(t) { $('#cNote').textContent = t || ''; }
function showThinking(on) {
  $('#ring').hidden = !on; $('#bReveal').disabled = !on;
  if (on) setRing(1, 0);
}
function setRing(frac, remainingMs) {
  $('#ringArc').style.strokeDashoffset = String(238.76 * (1 - frac));
  $('#ringTxt').textContent = remainingMs > 0 ? Math.ceil(remainingMs / 1000) + 's' : 'say it';
}
function updateProgress() {
  if (!X) return;
  const total = X.cards.reduce((s, c) => s + c.need, 0), got = X.cards.reduce((s, c) => s + Math.min(c.wins, c.need), 0);
  $('#pProg').style.width = (total ? (got / total) * 100 : 0) + '%';
}
function ladderFor(c) {
  const idx = c.src === 'review' ? 4 + Math.max(0, Math.min(4, (c.stage ?? 0) + (c.early ? 0 : 1))) : c.wins >= c.need - 1 ? 4 : Math.min(c.step, 3);
  renderLadder($('#pLadder'), idx);
}
function renderLadder(el, on) {
  el.replaceChildren(...LADDER.map((l, i) => h('div', { class: 'rung' + (i === on ? ' on' : i < on ? ' past' : '') },
    h('div', { class: 'bar', style: `height:${10 + i * 5}px` }), h('div', { class: 'lbl' }, l))));
}

/* player controls */
function togglePause() {
  if (!X) return;
  if (!X.paused) { X.paused = true; X.pausedAt = performance.now(); TTS.cancel(); $('#bPause').innerHTML = PLAY_ICON; $('#bPause').setAttribute('aria-label', 'Resume'); }
  else { X.pausedMs += performance.now() - X.pausedAt; X.paused = false; $('#bPause').innerHTML = PAUSE_ICON; $('#bPause').setAttribute('aria-label', 'Pause'); }
}
function abortSession() {
  if (!X) return;
  X.aborted = true; X.paused = false; TTS.cancel();
  if (X.onAbort) X.onAbort();
}
$('#bPause').addEventListener('click', togglePause);
$('#bReveal').addEventListener('click', () => { if (X) X.skip = true; });
$('#bReplay').addEventListener('click', () => { if (X && X.lastTarget && !TTS.cur) TTS.speak(X.lastTarget, { lang: X.ttsLang, rate: S.settings.rate }); });
$('#bGot').addEventListener('click', () => X?.onGrade?.(true));
$('#bMiss').addEventListener('click', () => X?.onGrade?.(false));
$('#pExit').addEventListener('click', () => {
  if (!X) return;
  const wasPaused = X.paused; if (!wasPaused) togglePause();
  sheet('End this session?', h('div', { class: 'body' },
    h('p', { class: 'muted', style: 'margin:0' }, 'Phrases you have already practiced are saved and scheduled for review.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => { closeSheet(); if (X && X.paused && !wasPaused) togglePause(); } }, 'Keep going'),
      h('button', { class: 'btn danger', onclick: () => { closeSheet(); abortSession(); } }, 'End session'))));
});
document.addEventListener('keydown', e => {
  if (!X || $('#layer').childElementCount || e.target.matches('input,textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === 'ArrowRight' || e.key === 'Enter') { if (X.onGrade) X.onGrade(true); else X.skip = true; }
  else if (e.key === 'ArrowLeft') { if (X.onGrade) X.onGrade(false); }
  else if (e.key === 'r') $('#bReplay').click();
});

/* ---------- standalone lesson generation ---------- */
function normLesson(raw, title) {
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const arr = v => (Array.isArray(v) ? v : []);
  const L = { v: 1, title: str(raw?.title) || title || 'Lesson', ai: true,
    dialogue: arr(raw?.dialogue).map(d => ({ s: str(d?.s).toUpperCase() === 'B' ? 'B' : 'A', t: str(d?.t), r: str(d?.r), en: str(d?.en) })).filter(d => d.t).slice(0, 12),
    items: arr(raw?.items).map(i => ({ t: str(i?.t), r: str(i?.r), en: str(i?.en), note: str(i?.note), build: arr(i?.build).map(str).filter(Boolean).slice(0, 4) })).filter(i => i.t && i.en).slice(0, 14),
    drills: arr(raw?.drills).map(d => ({ t: str(d?.t), r: str(d?.r), en: str(d?.en) })).filter(d => d.t && d.en).slice(0, 12),
    tips: arr(raw?.tips).map(str).filter(Boolean).slice(0, 3) };
  for (const i of L.items) {
    if (i.build.length && norm(i.build[i.build.length - 1]) !== norm(i.t)) i.build.push(i.t);
    if (i.build.length < 2) i.build = [];
  }
  if (L.items.length < 3) throw { code: 'bad_lesson', message: 'The lesson came back incomplete.' };
  return L;
}
let GEN = null;
async function generateLesson(code, id, topic) {
  if (GEN) return;
  if (!Backend.available) { renderHome(null, { genError: 'Open Parley through its standalone server to prepare lessons. Included lessons and your own practice work offline.' }); return; }
  if (!Backend.admin) { openCourseStudio(); return; }
  GEN = { code, id, ctl: new AbortController(), chars: 0 }; renderHome();
  try {
    const result = await Backend.request('/api/lessons/generate', { code, id: topic ? stats(code).next : Number(id), topic, gender: S.settings.gender }, GEN.ctl.signal);
    const L = normLesson(result.lesson, topic); L.reviewStatus = 'unreviewed';
    if (topic) { L.topic = topic; saveLesson(code, id, L); }
    else { (Backend.lessons[code] = Backend.lessons[code] || {})[id] = L; }
    GEN = null; renderHome(null, { readyId: id });
  } catch (e) { GEN = null; renderHome(null, { genError: e.name === 'AbortError' ? 'Request stopped. A numbered lesson may still finish on the server; refresh before retrying.' : e.message }); }
}

/* ---------- home ---------- */
function stats(code) {
  const P = prog(code); const now = Date.now(); const items = Object.values(P.items);
  const next = (() => { for (let n = 1; n <= 30; n++) if (!P.done[n]) return n; return 30; })();
  return { learned: items.length, due: items.filter(i => i.due <= now).length, done: Object.keys(P.done).filter(k => /^\d+$/.test(k)).length, next };
}
const GET_VOICES = 'For the clearest audio, download a Premium or Enhanced voice. iPhone: Settings › Accessibility › Spoken Content › Voices, pick the language, tap a voice marked Enhanced or Premium. Android: your phone’s text-to-speech settings. Then reopen this page.';
const isBasic = v => v && ['Basic', 'Standard'].includes(TTS.quality(v).tier);
function voiceLabel(v) {
  const { tier } = TTS.quality(v);
  return v.name + (v.name.toLowerCase().includes(tier.toLowerCase()) ? '' : ` · ${tier}`) + ` · ${v.lang}`;
}
function sampleFor(code) {
  const learned = Object.values(prog(code).items).find(i => i.kind === 'drill') || Object.values(prog(code).items)[0];
  if (learned) return learned.t;
  const b = BUILTIN[code]; if (b) return b.dialogue[2]?.t || b.items[0].t;
  return langInfo(code).native || 'Hello';
}
function renderVoice() {
  const el = $('#voiceLine'); if (!el) return;
  const code = S.lang; const v = TTS.forLang(code)[0];
  const text = v ? `Voice: ${voiceLabel(v)}` :
    TTS.ok ? (TTS.voices.length ? `No ${cur().name} voice on this device, so lessons show text instead. ${GET_VOICES}` : 'Checking this device’s voices…')
           : 'This browser has no speech engine. Text and timing still work.';
  el.replaceChildren(h('span', { class: 'dot' + (v && !isBasic(v) ? '' : ' warn') }),
    h('span', { style: 'flex:1' }, text, v && isBasic(v) ? h('span', { class: 'muted' }, ' — a clearer voice can be downloaded.') : null),
    ...(TTS.voices.length ? [h('button', { class: 'linkbtn', onclick: () => openSettings('voices') }, 'Change voice')] : []));
}
function lessonState(code, n) {
  const P = prog(code);
  if (P.done[n]) return 'done';
  return getLesson(code, n) ? 'ready' : 'write';
}
function onLessonTap(code, id, topic) {
  if (GEN) return;
  if (getLesson(code, id)) return startSession('lesson', code, id);
  generateLesson(code, id, topic);
}
function renderHome(result, flags = {}) {
  const root = $('#home'); if (!root || X) return;
  const L = cur(); const st = stats(L.code); const P = prog(L.code);
  const nextState = lessonState(L.code, st.next);
  const nextT = (getLesson(L.code, st.next)?.title) || theme(st.next).title;
  const kids = [];
  kids.push(h('header', { class: 'top' },
    h('div', { class: 'brand' }, 'Parley', h('small', null, 'audio · spaced recall')),
    h('button', { class: 'chip', onclick: openLangs, 'aria-label': 'Change language, current: ' + L.name }, h('span', { class: 'cl' }, L.name), h('span', { class: 'chev' })),
    h('button', { class: 'icon', onclick: () => openSettings(), 'aria-label': 'Settings' })));
  const gear = kids[0].lastChild; gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
  kids[0].querySelector('.chev').innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';

  if (result) kids.push(summaryPanel(result));

  const hero = h('section', { class: 'panel hero' },
    h('div', null, h('h1', null, L.name), L.native ? h('div', { class: 'native', lang: L.code }, L.native) : null),
    h('div', { class: 'tip' }, h('b', null, 'Listen. Think. Speak.'),
      h('div', null, 'One guided lesson at a time. Answer aloud during the pauses, build phrases from the end, then join the conversation.')),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', null, `${st.done}/30`), h('span', null, 'lessons done')),
      h('div', { class: 'stat' }, h('b', null, st.learned), h('span', null, 'phrases learned')),
      h('div', { class: 'stat due' }, h('b', null, st.due), h('span', null, 'due for review'))));
  if (GEN && GEN.code === L.code) {
    hero.append(h('div', { class: 'gen' },
      h('div', null, h('b', null, `Writing ${/^c/.test(GEN.id) ? 'your topic lesson' : 'Lesson ' + GEN.id} for ${L.name}…`)),
      h('div', { class: 'muted', role: 'status', style: 'font-size:13px' }, 'Your lesson is being prepared. This can take a few minutes.'),
      h('button', { class: 'btn', onclick: () => GEN?.ctl.abort() }, 'Stop waiting')));
  } else {
    const label = nextState === 'write' ? `Prepare Lesson ${st.next}` : `${P.done[st.next] ? 'Replay' : 'Start'} Lesson ${st.next}`;
    const sub = nextState === 'write' ? `${nextT} · generated on demand` : `${nextT} · guided audio · go at your pace`;
    const ready = flags.readyId && getLesson(L.code, flags.readyId);
    hero.append(ready
      ? h('button', { class: 'btn primary', onclick: () => startSession('lesson', L.code, flags.readyId) }, h('span', null, `Lesson ready: start ${/^c/.test(flags.readyId) ? ready.title : 'Lesson ' + flags.readyId}`), h('span', { class: 'sub' }, `${ready.items.length} new phrases · ${ready.drills.length} combinations`))
      : h('button', { class: 'btn primary', onclick: () => onLessonTap(L.code, String(st.next)) }, h('span', null, label), h('span', { class: 'sub' }, sub)));
    hero.append(h('div', { class: 'row' },
      h('button', { class: 'btn', disabled: st.learned === 0, onclick: () => startSession('review', L.code) }, st.due ? `Review ${st.due} due` : 'Extra practice'),
      h('button', { class: 'btn', onclick: openTopic }, 'Lesson on any topic')));
    if (flags.genError) hero.append(h('div', { class: 'err' }, flags.genError));
  }
  hero.append(h('div', { class: 'voice', id: 'voiceLine' }));
  kids.push(hero);
  kids.push(h('section', { class: 'panel' }, h('h2', null, 'Your practice studio'),
    h('button', { class: 'btn', onclick: openCourseStudio }, 'Course studio'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: openPhrasebook }, 'Phrasebook'),
      h('button', { class: 'btn', onclick: openLessonBuilder }, 'Create a lesson'))));

  const custom = Object.entries(S.lessons[L.code] || {}).filter(([k]) => k.startsWith('c'));
  if (custom.length) {
    kids.push(h('section', { class: 'panel' }, h('h2', null, 'Your topics'),
      h('ul', { class: 'lessons' }, custom.map(([k, l]) => h('li', null, h('button', { onclick: () => startSession('lesson', L.code, k) },
        h('span', { class: 'n' }, '·'), h('span', { class: 't' }, l.title), h('span', { class: 'pill ' + (P.done[k] ? 'done' : 'ready') }, P.done[k] ? 'Done' : 'Ready')))))));
  }

  const rows = [];
  const upto = Math.max(30, st.next);
  for (let n = 1; n <= upto; n++) {
    const s = lessonState(L.code, n); const isNext = n === st.next;
    const title = getLesson(L.code, n)?.title || theme(n).title;
    rows.push(h('li', null, h('button', { onclick: () => onLessonTap(L.code, String(n)), disabled: !!GEN },
      h('span', { class: 'n' }, String(n).padStart(2, '0')), h('span', { class: 't' }, title),
      h('span', { class: 'pill ' + (s === 'done' ? 'done' : isNext ? 'next' : s === 'ready' ? 'ready' : '') }, s === 'done' ? (P.done[n].acc == null ? 'Completed' : `Done ${P.done[n].acc}%`) : isNext ? 'Next' : s === 'ready' ? (getLesson(L.code, n)?.reviewStatus === 'unreviewed' ? 'Draft' : 'Ready') : 'Prepare'))));
  }
  kids.push(h('section', { class: 'panel' }, h('h2', null, 'Course'), h('p', { class: 'muted', style: 'margin:0;font-size:14px' },
    `${Array.from({ length: 30 }, (_, i) => getLesson(L.code, i + 1)).filter(Boolean).length} of 30 lessons available. Follow the course in order, ideally one lesson per day. Course studio prepares missing lessons and saves them on your Parley server.`),
    h('ul', { class: 'lessons' }, rows)));

  const lad = h('div', { class: 'ladder' }); renderLadder(lad, -1);
  kids.push(h('section', { class: 'panel' }, h('h2', null, 'How a lesson works'),
    h('div', { class: 'method' },
      h('div', null, h('span', { class: 'k' }, '01'), h('div', null, h('h3', null, 'Answer before you hear it'), h('p', null, 'You hear an English cue, then a pause. Say the phrase out loud before the native voice gives it. Pulling it from memory is what makes it stick.'))),
      h('div', null, h('span', { class: 'k' }, '02'), h('div', null, h('h3', null, 'Graduated recall'), h('p', null, 'Each phrase returns at growing gaps: 5 seconds, 25 seconds, 2 minutes, 10 minutes, then 1 day, 5 days, 25 days, 4 months and 2 years. A miss sends it back to a short gap.'))),
      h('div', null, h('span', { class: 'k' }, '03'), h('div', null, h('h3', null, 'Build long words from the end'), h('p', null, 'Longer phrases are taught backwards: “favor”, then “por favor”. Each piece keeps the natural stress and melody of the whole.'))),
      h('div', null, h('span', { class: 'k' }, '04'), h('div', null, h('h3', null, 'A small core, used at once'), h('p', null, 'About a dozen high-frequency phrases per lesson, recombined into new sentences you build yourself, then heard in a real conversation.')))),
    h('div', null, lad, h('div', { class: 'ladder-cap' }, h('span', null, 'in this lesson'), h('span', null, 'future reviews')))));
  kids.push(h('p', { class: 'muted', style: 'font-size:12px;margin:0' }, 'Audio uses your device’s voices; availability varies by language. Generated lessons are AI drafts and need language review. Your learning progress is saved in this browser. Course content is stored on your Parley server.'));
  root.replaceChildren(...kids);
  renderVoice();
}
function summaryPanel(r) {
  const score = r.mode === 'handsfree' ? 'Audio practice' : `${Math.round(r.acc * 100)}%`;
  const measure = r.mode === 'handsfree' ? 'Answers heard; recall was not graded' : 'Self-graded recall accuracy';
  if (r.kind === 'review') {
    return h('section', { class: 'panel summary' }, h('div', { class: 'tag' }, 'Review finished'),
      h('h2', null, score), h('div', { class: 'muted' }, `${measure}. ${r.reviewed} phrases practiced in ${Math.max(1, Math.round(r.minutes))} min.`));
  }
  return h('section', { class: 'panel summary' }, h('div', { class: 'tag' }, r.finished ? 'Lesson complete' : 'Session ended early'),
    h('h2', null, score), h('div', { class: 'muted' }, `${measure} · ${Math.max(1, Math.round(r.minutes))} min`),
    r.learned.length ? h('ul', { class: 'wordlist' }, r.learned.slice(0, 14).map(c => h('li', null, h('span', { class: 'w', dir: 'auto', lang: r.code }, c.t), h('span', { class: 'muted' }, c.en)))) : null,
    h('div', { class: 'muted', style: 'font-size:14px' }, r.finished
      ? (r.mode === 'active' && r.acc < 0.8 ? 'Repeat this lesson before moving on. Aim to answer comfortably before the speaker.' : 'Come back tomorrow for review and your next lesson. Repeat today if the answers still feel difficult.')
      : 'Phrase practice saved. Repeat the lesson to finish it.'),
    h('button', { class: 'btn', onclick: () => startSession('lesson', r.code, r.id) }, 'Repeat this lesson'));
}

/* ---------- sheets ---------- */
function sheet(title, body) {
  const close = h('button', { class: 'icon', 'aria-label': 'Close', onclick: () => { closeSheet(); if (X && X.paused) togglePause(); } });
  close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const scrim = h('div', { class: 'scrim', onclick: e => { if (e.target === scrim) close.click(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('header', null, h('h2', null, title), close), body));
  $('#layer').replaceChildren(scrim);
  return scrim;
}
function closeSheet() { $('#layer').replaceChildren(); }
function openLangs() {
  const list = h('ul', { class: 'langlist' });
  const q = h('input', { class: 'search', id: 'langSearch', type: 'search', placeholder: 'Search 110+ languages, or type any language', autocomplete: 'off' });
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const all = [...LANGS, ...S.custom];
    const started = all.filter(l => Object.keys(prog(l.code).items).length && l.code !== S.lang);
    let shown = all.filter(l => !s || l.name.toLowerCase().includes(s) || l.native.toLowerCase().includes(s) || l.code.toLowerCase().startsWith(s));
    if (!s) shown = [all.find(l => l.code === S.lang) || cur(), ...started, ...shown.filter(l => l.code !== S.lang && !started.includes(l))];
    const btn = l => h('li', null, h('button', { onclick: () => choose(l) },
      h('span', { class: 'nm' + (l.code === S.lang ? ' sel' : '') }, l.name), h('span', { class: 'nt', lang: l.code }, l.native),
      h('span', { class: 'dot' + (TTS.has(l.code) ? '' : ' warn'), title: TTS.has(l.code) ? 'Voice available' : 'No voice on this device' })));
    const items = shown.map(btn);
    if (s && !all.some(l => l.name.toLowerCase() === s)) {
      const name = q.value.trim().replace(/\s+/g, ' ');
      items.push(h('li', null, h('button', { onclick: () => {
        const code = 'x-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
        const l = { code, name: name.charAt(0).toUpperCase() + name.slice(1), native: '' };
        if (!S.custom.some(c => c.code === code)) S.custom.push(l);
        choose(l);
      } }, h('span', { class: 'nm' }, `Learn “${name}”`), h('span', { class: 'nt' }, 'Custom text practice; course generation supports listed languages'))));
    }
    list.replaceChildren(...items);
  };
  const choose = l => { S.lang = l.code; saveMeta(); closeSheet(); renderHome(); Backend.loadLanguage(l.code); };
  q.addEventListener('input', draw);
  sheet('Choose a language', h('div', { class: 'body' }, q, h('div', { class: 'muted', style: 'font-size:12px;display:flex;gap:12px' },
    h('span', null, h('span', { class: 'dot', style: 'display:inline-block;margin:0 4px 0 0' }), 'voice on this device'),
    h('span', null, h('span', { class: 'dot warn', style: 'display:inline-block;margin:0 4px 0 0' }), 'text only')), list));
  draw();
}
function seg(id, value, opts, onchange) {
  const wrap = h('div', { class: 'seg', id, role: 'group' });
  const draw = v => wrap.replaceChildren(...opts.map(([val, label]) => h('button', { 'aria-pressed': String(v === val), onclick: () => { onchange(val); draw(val); } }, label)));
  draw(value); return wrap;
}
function voiceField(code, label, sample, rate) {
  const list = TTS.forLang(code);
  const id = 'voice-' + code.replace(/[^A-Za-z0-9-]/g, '');
  if (!list.length) return h('div', { class: 'field' }, h('label', null, label), h('div', { class: 'hint' }, `No voice for this language on this device. ${GET_VOICES}`));
  const sel = h('select', { class: 'search', id });
  for (const v of list) sel.append(h('option', { value: v.voiceURI || v.name }, voiceLabel(v)));
  sel.value = list[0].voiceURI || list[0].name;
  const play = () => { TTS.cancel(); setTimeout(() => TTS.speak(sample, { lang: code, rate }), 60); };
  sel.addEventListener('change', () => { S.settings.voices = { ...(S.settings.voices || {}), [code]: sel.value }; saveMeta(); renderVoice(); play(); });
  const best = list.reduce((m, v) => Math.max(m, TTS.quality(v).s), -9);
  return h('div', { class: 'field' }, h('label', { for: id }, label),
    h('div', { class: 'row' }, h('div', { style: 'flex:1 1 200px;min-width:0' }, sel), h('button', { class: 'btn', onclick: play, style: 'flex:0 0 auto' }, 'Play sample')),
    best < 3 ? h('div', { class: 'hint' }, 'Only basic voices are installed for this language. ' + GET_VOICES) : null);
}
function openSettings(focus) {
  const s = S.settings;
  const set = (k, v) => { s[k] = v; saveMeta(); };
  const thinkOut = h('span', { class: 'mono' }, s.think + 's');
  const rateOut = h('span', { class: 'mono' }, s.rate.toFixed(2) + '×');
  const think = h('input', { type: 'range', id: 'setThink', min: 2, max: 10, step: 1, value: s.think });
  think.addEventListener('input', () => { thinkOut.textContent = think.value + 's'; set('think', +think.value); });
  const rate = h('input', { type: 'range', id: 'setRate', min: 0.6, max: 1.1, step: 0.05, value: s.rate });
  rate.addEventListener('input', () => { rateOut.textContent = (+rate.value).toFixed(2) + '×'; set('rate', +rate.value); });
  const L = cur();
  const confirmBox = h('div', { class: 'row' });
  const resetBtn = h('button', { class: 'btn danger', onclick: () => {
    confirmBox.replaceChildren(h('span', { class: 'muted', style: 'flex-basis:100%;font-size:14px' }, `Erase this browser's ${L.name} progress and custom lessons? Server courses are kept.`),
      h('button', { class: 'btn', onclick: () => confirmBox.replaceChildren(resetBtn) }, 'Cancel'),
      h('button', { class: 'btn danger', onclick: () => {
        S.progress[L.code] = { done: {}, items: {}, updatedAt: Date.now() };
        delete S.lessons[L.code]; LS.set('parley.v1.lessons', S.lessons); saveProg(L.code); closeSheet(); renderHome(); } }, 'Erase'));
  } }, `Reset ${L.name} progress`);
  confirmBox.append(resetBtn);
  const voices = h('div', { class: 'field', id: 'voiceSettings', style: 'gap:14px' },
    h('h3', null, 'Voices'),
    voiceField(L.code, `${L.name} speaker`, sampleFor(L.code), s.rate),
    voiceField(NAR.lang, 'English narrator', 'How do you say “thank you”? Say it out loud, then listen.', NAR_RATE),
    h('div', { class: 'hint' }, 'Voices are ranked clearest first: Premium, Enhanced and Natural voices sound far better than Basic ones. The second speaker in conversations uses the next-best voice.'));
  sheet('Settings', h('div', { class: 'body' },
    voices,
    h('div', { class: 'field' }, h('label', null, 'Mode'), seg('setMode', s.mode, [['active', 'Active (tap to grade)'], ['handsfree', 'Hands-free']], v => set('mode', v)),
      h('div', { class: 'hint' }, 'Hands-free runs like an audio course: no tapping, every answer counts as heard. Active lets you mark misses so they come back sooner.')),
    h('div', { class: 'field' }, h('label', { for: 'setThink' }, 'Time to answer ', thinkOut), think, h('div', { class: 'hint' }, 'The pause after each cue. Longer phrases get a little extra.')),
    h('div', { class: 'field' }, h('label', { for: 'setRate' }, 'Native speech speed ', rateOut), rate),
    h('div', { class: 'field' }, h('label', null, 'Show romanization'), seg('setRoman', s.roman, [[true, 'On'], [false, 'Off']], v => set('roman', v))),
    h('div', { class: 'field' }, h('label', null, 'Opening conversation'), seg('setDlg', s.dlgText, [[false, 'Audio only'], [true, 'Show text']], v => set('dlgText', v)),
      h('div', { class: 'hint' }, 'The first listen is meant to be heard, not read. The closing listen always shows text.')),
    h('div', { class: 'field' }, h('label', null, 'Your forms (for gendered languages)'), seg('setGender', s.gender, [['neutral', 'Neutral'], ['male', 'Male'], ['female', 'Female']], v => set('gender', v)),
      h('div', { class: 'hint' }, 'Applies to custom lessons prepared from now on. Numbered courses use neutral forms.')),
    confirmBox));
  if (focus === 'voices') setTimeout(() => $('#voiceSettings select')?.focus(), 80);
}
function parsePhraseLines(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 3 || lines.length > 14) throw new Error('Add between 3 and 14 phrases.');
  const seen = new Set();
  return lines.map((line, n) => {
    const fields = line.split('|').map(s => s.trim());
    if (fields.length < 2 || fields.length > 3 || !fields[0] || !fields[1])
      throw new Error(`Line ${n + 1}: use English cue | translation | optional romanization.`);
    if (fields.some(f => f.length > 300)) throw new Error(`Line ${n + 1}: keep each field under 300 characters.`);
    const key = norm(fields[1]);
    if (seen.has(key)) throw new Error(`Line ${n + 1}: duplicate translation.`);
    seen.add(key);
    return { en: fields[0], t: fields[1], r: fields[2] || '', build: [], note: '' };
  });
}
function openLessonBuilder() {
  const code = S.lang;
  const title = h('input', { class: 'search', id: 'lessonTitle', maxlength: 80, placeholder: 'My travel essentials' });
  const phrases = h('textarea', { class: 'search', id: 'lessonPhrases', rows: 8, maxlength: 15000,
    placeholder: 'hello | hola\nthank you | gracias\nplease | por favor' });
  const error = h('div', { class: 'err', role: 'alert' });
  sheet('Create a lesson', h('div', { class: 'body' },
    h('p', { class: 'muted' }, `Create a ${langInfo(code).name} audio lesson using translations you trust. Works offline.`),
    h('label', { for: 'lessonTitle' }, 'Lesson title'), title,
    h('label', { for: 'lessonPhrases' }, 'Phrases'),
    h('p', { class: 'muted' }, 'One phrase per line: English cue | translation | optional romanization. Add 3–14 phrases.'),
    phrases, error, h('button', { class: 'btn primary', onclick: () => {
      try {
        if (!title.value.trim()) throw new Error('Give your lesson a title.');
        const items = parsePhraseLines(phrases.value);
        const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        saveLesson(code, id, { v: 1, title: title.value.trim(), ai: false, items, drills: [], dialogue: [], tips: [] });
        closeSheet(); renderHome(null, { readyId: id });
      } catch (e) { error.textContent = e.message; }
    } }, 'Save lesson')));
  title.focus();
}
function openPhrasebook() {
  const code = S.lang;
  const q = h('input', { class: 'search', type: 'search', 'aria-label': 'Search phrases', placeholder: 'Search translations or English cues' });
  const filter = h('select', { class: 'search', 'aria-label': 'Filter phrases' },
    h('option', { value: 'all' }, 'All learned phrases'), h('option', { value: 'due' }, 'Due for review'));
  const list = h('ul', { class: 'wordlist' });
  const count = h('div', { class: 'muted', role: 'status' });
  const draw = () => {
    const query = norm(q.value);
    const items = Object.values(prog(code).items).filter(i =>
      (filter.value !== 'due' || i.due <= Date.now()) &&
      (!query || [i.t, i.en, i.r].some(v => norm(v).includes(query))))
      .sort((a, b) => a.en.localeCompare(b.en));
    count.textContent = items.length ? `${items.length} phrases` : 'No matching phrases. Complete a lesson to grow your phrasebook.';
    list.replaceChildren(...items.map(i => h('li', null,
      h('div', null, h('div', { class: 'w', dir: 'auto', lang: code }, i.t),
        S.settings.roman && i.r ? h('div', { class: 'muted' }, i.r) : null,
        h('div', null, i.en), h('small', { class: 'muted' }, i.due <= Date.now() ? 'Due for review' : 'Review ' + new Date(i.due).toLocaleDateString())),
      h('button', { class: 'btn', 'aria-label': 'Listen: ' + i.en, onclick: () => {
        TTS.cancel(); TTS.speak(i.t, { lang: code, rate: S.settings.rate });
      } }, 'Listen'))));
  };
  q.addEventListener('input', draw); filter.addEventListener('change', draw);
  sheet('Your phrasebook', h('div', { class: 'body' }, q, filter, count, list));
  draw(); q.focus();
}
function openTopic() {
  const L = cur();
  const inp = h('input', { class: 'search', id: 'topicIn', placeholder: 'e.g. checking in at the airport', maxlength: 120 });
  const err = h('div', { class: 'err' });
  const go = () => {
    const t = inp.value.trim(); if (t.length < 3) { err.textContent = 'Describe the situation in a few words.'; return; }
    if (!Backend.available) { err.textContent = 'Open Parley through its standalone server to prepare a topic lesson.'; return; }
    closeSheet(); generateLesson(L.code, 'c' + Date.now().toString(36), t);
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  sheet('Lesson on any topic', h('div', { class: 'body' },
    h('p', { class: 'muted', style: 'margin:0;font-size:14px' }, `Parley prepares a ${L.name} lesson for your situation, using earlier course material as context for your current lesson level.`),
    inp, err, h('button', { class: 'btn primary', onclick: go }, h('span', null, 'Write this lesson'))));
  setTimeout(() => inp.focus(), 50);
}

async function openCourseStudio() {
  const body = h('div', { class: 'body' });
  sheet('Course studio', body);
  const error = h('div', { class: 'err', role: 'alert' });
  const refresh = async () => {
    if (!body.isConnected) return;
    body.replaceChildren(h('p', { class: 'muted' }, 'Loading your course library…'));
    if (!Backend.available) {
      body.replaceChildren(h('p', null, 'Open Parley through its standalone server to prepare and save full courses. Included lessons and your own phrase lessons work without a server.'));
      return;
    }
    try {
      const status = await Backend.request('/api/status'); Backend.admin = status.admin; Backend.configured = status.generationConfigured;
      if (!status.admin) {
        const token = h('input', { class: 'search', type: 'password', id: 'adminToken', autocomplete: 'off' });
        body.replaceChildren(h('p', null, 'Administrator access prepares new courses. Learners do not need to sign in to open saved lessons.'),
          h('label', { for: 'adminToken' }, 'Administrator token'), token, error,
          h('button', { class: 'btn primary', onclick: async () => {
            try { await Backend.request('/api/admin/session', { token: token.value }); token.value = ''; refresh(); }
            catch (e) { error.textContent = e.message; }
          } }, 'Sign in'));
        token.focus(); return;
      }
      const catalog = await Backend.request('/api/catalog'); Backend.manifest = catalog.languages;
      const data = await Backend.request('/api/jobs');
      const available = catalog.languages.reduce((n, l) => n + l.ready, 0);
      const total = catalog.languages.length * 30;
      const progress = h('div', { role: 'status' }, `${available.toLocaleString()} / ${total.toLocaleString()} lessons available across ${catalog.languages.length} languages.`);
      const jobBox = h('div', { class: 'field' });
      const busy = data.jobs.some(j => ['queued', 'running'].includes(j.status));
      const postJob = async languages => {
        try { await Backend.request('/api/jobs', { languages }); await refresh(); }
        catch (e) { error.textContent = e.message; }
      };
      body.replaceChildren(progress,
        h('p', { class: 'muted' }, 'Each course has 30 sequential lessons. Builds reuse earlier vocabulary, skip saved lessons, and resume after a server restart. Generated translations are drafts awaiting language review.'),
        status.generationConfigured ? h('p', { class: 'muted' }, 'New lessons use the model account configured on your server.')
          : h('p', { class: 'err' }, 'Generation is not connected. Configure OPENAI_API_KEY on the server to build missing lessons.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', disabled: busy || !status.generationConfigured || !LANGS.some(l => l.code === S.lang), onclick: () => postJob([S.lang]) }, `Build ${cur().name} to Lesson 30`),
          h('button', { class: 'btn', disabled: busy || !status.generationConfigured, onclick: () => postJob('all') }, `Build all ${catalog.languages.length} courses`)),
        error, jobBox,
        h('details', null, h('summary', null, 'Language coverage'), h('ul', { class: 'wordlist' }, catalog.languages.map(l =>
          h('li', null, h('span', null, l.name), h('span', null, `${l.ready}/30`))))),
        h('button', { class: 'btn', onclick: async () => { await Backend.loadLanguage(S.lang); refresh(); } }, 'Refresh library'),
        h('button', { class: 'btn', onclick: async () => { await Backend.request('/api/admin/logout', {}); Backend.admin = false; refresh(); } }, 'Sign out'));
      const drawJobs = jobs => {
        jobBox.replaceChildren(...jobs.slice(0, 5).map(job => h('div', { class: 'panel' },
          h('b', null, `Course build: ${job.status}`),
          h('div', null, `${job.checked}/${job.total} lessons checked · ${job.generated} newly generated`),
          job.current ? h('div', null, `${langInfo(job.current.code).name} · Lesson ${job.current.lesson}`) : null,
          job.error ? h('div', { class: 'err' }, job.error) : null,
          ['running', 'queued', 'paused', 'failed'].includes(job.status) ? h('button', { class: 'btn', onclick: async () => {
            const action = ['paused', 'failed'].includes(job.status) ? 'resume' : 'pause';
            try { await Backend.request(`/api/jobs/${job.id}/${action}`, {}); refresh(); }
            catch (e) { error.textContent = e.message; }
          } }, ['paused', 'failed'].includes(job.status) ? 'Resume build' : 'Pause after current lesson') : null)));
      };
      drawJobs(data.jobs);
      const poll = async () => {
        if (!jobBox.isConnected) return;
        try {
          const latest = await Backend.request('/api/jobs');
          if (!jobBox.isConnected) return;
          drawJobs(latest.jobs);
          if (latest.jobs.some(j => ['queued', 'running'].includes(j.status))) setTimeout(poll, 2500);
          else if (busy) { await Backend.loadLanguage(S.lang); refresh(); }
        } catch (e) { if (error.isConnected) error.textContent = e.message; }
      };
      if (busy) setTimeout(poll, 2500);
    } catch (e) { body.replaceChildren(h('p', { class: 'err' }, e.message)); }
  };
  await refresh();
}

/* ---------- boot ---------- */
loadLocal();
TTS.init();
renderHome();
Backend.init();
window.__parley = { S, startSession, prog, getLesson, contains, normLesson, Backend, get X() { return X; } };
