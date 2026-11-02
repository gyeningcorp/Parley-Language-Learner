// Assembles src/ into a single self-contained index.html.
// Usage: node build.js
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

const html = read('src/shell.html')
  .replace('/*CONTENT*/', () => read('src/content.js') + '\n' + read('src/course.js'))
  .replace('/*APP*/', () => read('src/app.js'));

fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log(`index.html written (${(html.length / 1024).toFixed(0)} KB)`);
