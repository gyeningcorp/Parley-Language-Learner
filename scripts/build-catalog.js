'use strict';
// Talks to the standalone server so generation always has one durable queue.
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run catalog:build -- --languages all|es-MX,fr-FR [--url http://127.0.0.1:3000]\nRequires PARLEY_ADMIN_TOKEN. Starts a resumable background job; follow it in Course studio.'); return;
  }
  const option = name => args[args.indexOf(name) + 1];
  if (!args.includes('--languages') || !option('--languages') || option('--languages').startsWith('--')) throw new Error('Specify --languages all or a comma-separated list.');
  if (!process.env.PARLEY_ADMIN_TOKEN) throw new Error('Set PARLEY_ADMIN_TOKEN in the server environment or .env.');
  const base = new URL(args.includes('--url') ? option('--url') : 'http://127.0.0.1:3000');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('Use HTTPS for a remote server.');
  const selected = option('--languages');
  const res = await fetch(new URL('/api/jobs', base), { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PARLEY_ADMIN_TOKEN}` },
    body: JSON.stringify({ languages: selected === 'all' ? 'all' : selected.split(',').map(s => s.trim()) }) });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Course build could not start.');
  console.log(`Build ${result.job.id}: ${result.job.total} lesson slots. Follow progress in Course studio. It skips saved lessons and resumes after a server restart.`);
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
