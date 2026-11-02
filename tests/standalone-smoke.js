'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { seed } = require('../server/catalog');
async function main() {
  const testRoot = path.resolve(__dirname, '../.test-data');
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'browser-'));
  const token = 'browser-test-admin-token-123456789';
  let calls = 0;
  const app = await createApp({ dataDir: dir, adminToken: token, configured: true, provider: async () => {
    calls++; return { ...structuredClone(seed('es-MX', 2)), title: 'Test provider lesson', goal: 'Test course flow.' };
  } });
  let browser;
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => __parley.Backend.available);
    assert.ok((await page.locator('#home').innerText()).includes('30 of 30 lessons available'));
    assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
    if (process.env.PARLEY_SCREENSHOT) await page.screenshot({ path: process.env.PARLEY_SCREENSHOT, fullPage: true });
    await page.getByRole('button', { name: 'Course studio', exact: true }).click();
    await page.locator('#adminToken').fill(token);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Build all 110 courses', exact: true }).waitFor();
    const cookies = await page.context().cookies(base + '/api');
    assert.equal(cookies.find(c => c.name === 'parley_admin').httpOnly, true);
    assert.equal(await page.evaluate(token => JSON.stringify(localStorage).includes(token), token), false);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: /Change language, current:/ }).click();
    await page.locator('#langSearch').fill('French');
    await page.locator('.langlist button').filter({ hasText: 'French' }).first().click();
    await page.waitForFunction(() => __parley.Backend.lessons['fr-FR']?.[1]);
    await page.getByRole('button', { name: 'Course studio', exact: true }).click();
    await page.getByRole('button', { name: 'Build French to Lesson 30', exact: true }).click();
    await page.getByText('Course build: completed', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(calls, 29);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await page.waitForFunction(() => Object.keys(__parley.Backend.lessons['fr-FR'] || {}).length === 30);
    assert.ok((await page.locator('#home').innerText()).includes('30 of 30 lessons available'));
    assert.ok((await page.locator('#home').innerText()).includes('Test provider lesson'));
    assert.equal(await page.evaluate(() => typeof window.claude), 'undefined');
    assert.deepEqual(errors, []);
    console.log('PASS  Standalone browser → administrator session → French course job → saved 30 lessons → reload, without a hosted artifact runtime');
  } finally {
    if (browser) await browser.close();
    await app.close();
    if (!path.resolve(dir).startsWith(testRoot + path.sep)) throw Error('Invalid test cleanup path');
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
