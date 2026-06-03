const fs = require('fs');
const html = fs.readFileSync('/Users/opalx14/Desktop/dom_dump.html', 'utf8');
let re = /class="([^"]+)"[^>]*aria-label="([^"]+)"/g;
let m;
let s = new Set();
while(m = re.exec(html)) {
  s.add(m[1] + " => " + m[2]);
}
console.log([...s].join('\n'));
