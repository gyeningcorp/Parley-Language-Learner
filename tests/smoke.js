// Smoke test: runs full lessons at 60x speed in headless Chromium with mock voices.
// Usage: npm test   (requires: npm install && npx playwright install chromium)
const path = require('path');
const { chromium } = require('playwright');

const PAGE = 'file://' + path.resolve(__dirname, '../index.html');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.addInitScript(() => {
    window.__parleySpeed = 60;
    const V = (name, lang, uri) => ({ name, lang, voiceURI: uri, localService: true, default: false });
    const voices = [
      V('Paulina', 'es-MX', 'com.apple.voice.compact.es-MX.Paulina'),
      V('Paulina (Enhanced)', 'es-MX', 'com.apple.voice.enhanced.es-MX.Paulina'),
      V('Mónica (Premium)', 'es-ES', 'com.apple.voice.premium.es-ES.Monica'),
      V('Bad News', 'en-US', 'com.apple.speech.synthesis.voice.BadNews'),
      V('Ava (Premium)', 'en-US', 'com.apple.voice.premium.en-US.Ava'),
      V('Kyoko (Enhanced)', 'ja-JP', 'com.apple.voice.enhanced.ja-JP.Kyoko'),
    ];
    window.__spoken = [];
    window.SpeechSynthesisUtterance = class { constructor(t) { Object.assign(this, { text: t, rate: 1, pitch: 1, volume: 1, voice: null, lang: '' }); } };
    speechSynthesis.getVoices = () => voices;
    speechSynthesis.speak = u => { window.__spoken.push({ t: u.text, v: u.voice && u.voice.name, pitch: u.pitch }); setTimeout(() => u.onstart && u.onstart(), 1); setTimeout(() => u.onend && u.onend(), 5); };
    speechSynthesis.cancel = () => {};
  });

  await page.goto(PAGE);
  await page.waitForTimeout(1200);

  // Voice ranking: clearest voice first, novelty voices excluded.
  const ranked = await page.evaluate(() => ({ es: TTS.forLang('es-MX').map(v => v.name), en: TTS.forLang('en-US').map(v => v.name) }));
  check('Enhanced voice ranked first', ranked.es[0] === 'Paulina (Enhanced)', ranked.es.join(' > '));
  check('Novelty voice excluded', !ranked.en.includes('Bad News'), ranked.en.join(' > '));

  // Every built-in drill can be matched to the items it uses.
  const unmatched = await page.evaluate(() => Object.entries(BUILTIN).flatMap(([code, L]) =>
    L.drills.filter(d => !L.items.some(i => __parley.contains(d.t, i.t))).map(d => code + ': ' + d.t)));
  check('Drills reference lesson items', unmatched.length === 0, unmatched.join('; '));

  // Hands-free lesson, Spanish.
  await page.evaluate(() => { __parley.S.settings.mode = 'handsfree'; __parley.startSession('lesson', 'es-MX', '1'); });
  await page.waitForSelector('#home:not([hidden]) .summary', { timeout: 120000 });
  const es = await page.evaluate(() => { const P = __parley.prog('es-MX'); return { done: !!P.done['1'], n: Object.keys(P.items).length }; });
  check('Hands-free lesson completes', es.done && es.n === 20, JSON.stringify(es));
  const pitches = await page.evaluate(() => [...new Set(__spoken.filter(s => s.t.trim()).map(s => s.pitch))]);
  check('No pitch shifting', pitches.length === 1 && pitches[0] === 1, JSON.stringify(pitches));

  // Active lesson, Japanese, with one miss in six.
  await page.evaluate(() => {
    __parley.S.settings.mode = 'active'; let n = 0;
    setInterval(() => { const X = __parley.X; if (X && X.onGrade) X.onGrade(++n % 6 !== 3); }, 30);
    __parley.startSession('lesson', 'ja-JP', '1');
  });
  await page.waitForFunction(() => !__parley.X, null, { timeout: 120000 });
  const ja = await page.evaluate(() => { const P = __parley.prog('ja-JP'); const it = Object.values(P.items); return { done: !!P.done['1'], lapsed: it.filter(i => i.lapses).length }; });
  check('Active lesson completes with misses', ja.done && ja.lapsed > 0, JSON.stringify(ja));

  // Review moves successful items up the ladder (1 day -> 5 days).
  await page.evaluate(() => {
    const P = __parley.prog('es-MX'); for (const it of Object.values(P.items)) it.due = Date.now() - 1000;
    __parley.S.settings.mode = 'handsfree'; __parley.startSession('review', 'es-MX');
  });
  await page.waitForFunction(() => !__parley.X, null, { timeout: 120000 });
  const days = await page.evaluate(() => Math.round((Math.min(...Object.values(__parley.prog('es-MX').items).map(i => i.due)) - Date.now()) / 864e5));
  check('Review schedules next gap at 5 days', days === 5, days + ' days');

  check('No page errors', errors.length === 0, errors.join('; '));
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
