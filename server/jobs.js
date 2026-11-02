'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicJSON } = require('./lessons');
const { languages } = require('./catalog');
class Jobs {
  constructor(store) { this.store = store; this.file = path.join(store.dir, 'jobs.json'); this.jobs = []; this.running = false; this.stopping = false; this.writes = Promise.resolve(); }
  async init() {
    try { this.jobs = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const job of this.jobs) if (job.status === 'running') job.status = 'queued';
    this.kick();
  }
  save() {
    const copy = JSON.parse(JSON.stringify(this.jobs));
    this.writes = this.writes.then(() => atomicJSON(this.file, copy));
    return this.writes;
  }
  async create(codes) {
    if (!Array.isArray(codes) || !codes.length || codes.some(c => !languages.has(c)))
      throw Object.assign(new Error('Select one or more listed languages.'), { status: 400 });
    if (this.jobs.some(j => ['queued', 'running'].includes(j.status)))
      throw Object.assign(new Error('A course build is already running. Pause it before starting another.'), { status: 409 });
    const selected = [...new Set(codes)];
    const job = { id: randomUUID(), languages: selected, total: selected.length * 30, checked: 0, generated: 0,
      status: 'queued', current: null, error: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.jobs = [job, ...this.jobs].slice(0, 50);
    await this.save(); this.kick(); return job;
  }
  async action(id, action) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) throw Object.assign(new Error('Course build not found.'), { status: 404 });
    if (action === 'pause' && ['queued', 'running'].includes(job.status)) job.status = 'paused';
    else if (action === 'resume' && ['paused', 'failed'].includes(job.status)) {
      if (this.jobs.some(j => j.id !== id && ['queued', 'running'].includes(j.status))) throw Object.assign(new Error('Another course build is running.'), { status: 409 });
      job.status = 'queued'; job.error = ''; job.checked = 0;
    } else throw Object.assign(new Error('This action is not available for the course build.'), { status: 409 });
    job.updatedAt = new Date().toISOString(); await this.save(); this.kick(); return job;
  }
  kick() {
    if (this.running || this.stopping) return;
    this.running = true;
    this.task = this.pump().catch(e => { this.error = e; }).finally(() => {
      this.running = false;
      if (!this.error && this.jobs.some(j => j.status === 'queued')) this.kick();
    });
  }
  async pump() {
    for (const job of this.jobs) {
      if (job.status !== 'queued' || this.stopping) continue;
      job.status = 'running'; job.checked = 0; await this.save();
      try {
        outer: for (const code of job.languages) for (let id = 1; id <= 30; id++) {
          if (job.status !== 'running' || this.stopping) break outer;
          job.current = { code, lesson: id }; job.updatedAt = new Date().toISOString(); await this.save();
          if (!await this.store.get(code, id)) { await this.store.generate(code, id); job.generated++; }
          job.checked++; await this.save();
        }
        if (job.status === 'running') job.status = this.stopping ? 'queued' : 'completed';
        if (job.status === 'completed') job.current = null;
      } catch (e) { job.status = 'failed'; job.error = e.status ? e.message : 'Course build could not save or read lesson data. Check server storage.'; }
      job.updatedAt = new Date().toISOString(); await this.save();
    }
  }
  async close() { this.stopping = true; await this.task; await this.writes; }
}
module.exports = { Jobs };
