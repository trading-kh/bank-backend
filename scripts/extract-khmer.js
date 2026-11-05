// Extract string literals containing Khmer from source files.
// Usage: node extract-khmer.js <file...>
const fs = require('fs');

const KHMER = /[\u1780-\u17FF]/;

function stringsFrom(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let buf = '';
      while (j < n) {
        const d = src[j];
        if (d === '\\') { buf += d + (src[j + 1] || ''); j += 2; continue; }
        if (d === quote) break;
        if (d === '\n') break;
        buf += d;
        j++;
      }
      const line = src.slice(0, i).split('\n').length;
      if (KHMER.test(buf)) out.push({ line, text: buf });
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, 'utf8');
  const hits = stringsFrom(src);
  console.log('### ' + f + ' (' + hits.length + ')');
  for (const h of hits) {
    console.log(h.line + '\t' + JSON.stringify(h.text));
  }
}
