// Copies the shared nav and footer from partials/ into every page.
// Run after editing a partial: node tools/sync-chrome.mjs
// Each page marks the spots with <!-- nav --><!-- /nav --> and <!-- footer --><!-- /footer -->.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nav = readFileSync(join(root, 'partials/nav.html'), 'utf8').trim();
const footer = readFileSync(join(root, 'partials/footer.html'), 'utf8').trim();
const skip = new Set(['partials', 'tools', 'assets', 'dist', 'node_modules']);

function findPages(dir) {
  const pages = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!skip.has(name)) pages.push(...findPages(path));
    } else if (name.endsWith('.html')) {
      pages.push(path);
    }
  }
  return pages;
}

// The page's own address, like "/pricing/", so its nav link can be marked as current.
function pageUrl(path) {
  const rel = relative(root, path).split(sep).join('/');
  if (rel === 'index.html') return '/';
  return '/' + rel.replace(/index\.html$/, '');
}

function markCurrent(html, url) {
  return html.replace(`<a href="${url}">`, `<a href="${url}" aria-current="page">`);
}

function fill(html, name, block) {
  const pattern = new RegExp(`<!-- ${name} -->[\\s\\S]*?<!-- /${name} -->`);
  if (!pattern.test(html)) throw new Error(`missing <!-- ${name} --> markers`);
  return html.replace(pattern, `<!-- ${name} -->\n${block}\n<!-- /${name} -->`);
}

for (const path of findPages(root)) {
  const url = pageUrl(path);
  let html = readFileSync(path, 'utf8');
  html = fill(html, 'nav', markCurrent(nav, url));
  html = fill(html, 'footer', footer);
  writeFileSync(path, html);
  console.log('synced', relative(root, path));
}
