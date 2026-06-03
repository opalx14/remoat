const fs = require('fs');
const { JSDOM } = require("jsdom");
const html = fs.readFileSync('/Users/opalx14/Desktop/dom_dump.html', 'utf8');
const dom = new JSDOM(html);
const document = dom.window.document;

const els = document.querySelectorAll('*');
els.forEach(el => {
  if (el.children.length === 0) {
    const txt = (el.textContent || '').trim().toLowerCase();
    if (txt.includes('claude') || txt.includes('gpt-') || txt.includes('gemini')) {
      console.log('MODEL TEXT:', txt);
      console.log('CLASS:', el.className);
      console.log('PARENT CLASS:', el.parentElement && el.parentElement.className);
    }
  }
});
