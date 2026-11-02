'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({});
vm.runInContext(['src/content.js', 'src/course.js', 'src/course-es.js'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n') +
  '\nglobalThis.catalog = { languages: LANGS, syllabus: SYLLABUS, builtin: BUILTIN, course: COURSE };', context);
const catalog = JSON.parse(JSON.stringify(context.catalog));
const languages = new Map(catalog.languages.map(l => [l.code, l]));
function seed(code, id) { return catalog.course[code]?.[id] || (Number(id) === 1 ? catalog.builtin[code] : null) || null; }
module.exports = { ...catalog, languages, seed };
