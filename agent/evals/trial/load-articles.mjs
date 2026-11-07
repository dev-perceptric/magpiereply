// Loads the trial's sample help articles (articles/*.md) into a MagpieReply help center.
//   APP_URL=https://app.magpiereply.com node agent/evals/trial/load-articles.mjs --account <id>
// Asks for an administrator API key (Profile settings → Access token), or reads APP_ADMIN_TOKEN.
// Creates the "tidewell" portal and its categories if they're missing, then adds each article
// as published. Articles whose slug already exists are skipped, so it's safe to run again.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PORTAL = { name: 'Tidewell Coffee Help Center', slug: 'tidewell' };
const CATEGORIES = [
  { slug: 'orders-shipping', name: 'Orders and shipping' },
  { slug: 'returns-refunds', name: 'Returns and refunds' },
  { slug: 'billing-payments', name: 'Billing and payments' },
  { slug: 'subscriptions', name: 'Subscriptions' },
  { slug: 'account', name: 'Your account' },
];
// Article slugs are unique across the whole app, so they carry the portal's name.
const ARTICLE_SLUG_PREFIX = 'tidewell-';

const { values } = parseArgs({ options: { account: { type: 'string' } } });
const accountId = Number(values.account);
if (!Number.isInteger(accountId) || accountId <= 0) {
  console.error('Usage: APP_URL=<app address> node agent/evals/trial/load-articles.mjs --account <id>');
  process.exit(1);
}

const appUrl = process.env.APP_URL ?? 'https://app.magpiereply.com';
const token = process.env.APP_ADMIN_TOKEN ?? (await askHidden('Admin API key: '));
const accountPath = `/api/v1/accounts/${accountId}`;

async function call(method, path, body) {
  const response = await fetch(new URL(path, appUrl), {
    method,
    headers: { api_access_token: token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
}

async function callOk(method, path, body) {
  const result = await call(method, path, body);
  if (result.status >= 300) {
    throw new Error(`${method} ${path} answered ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

function readArticles() {
  const folder = join(fileURLToPath(new URL('.', import.meta.url)), 'articles');
  return readdirSync(folder)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => {
      const text = readFileSync(join(folder, name), 'utf8');
      const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) throw new Error(`${name} has no front matter`);
      const fields = Object.fromEntries(
        match[1].split('\n').map(line => {
          const at = line.indexOf(':');
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
      );
      return { slug: ARTICLE_SLUG_PREFIX + name.replace(/\.md$/, ''), ...fields, content: match[2].trim() };
    });
}

async function ensurePortal() {
  const existing = await call('GET', `${accountPath}/portals/${PORTAL.slug}`);
  if (existing.status === 200) return;
  await callOk('POST', `${accountPath}/portals`, { portal: PORTAL });
  console.log(`created portal ${PORTAL.slug}`);
}

async function ensureCategories() {
  const listed = await callOk('GET', `${accountPath}/portals/${PORTAL.slug}/categories?locale=en`);
  const idsBySlug = new Map(listed.payload.map(category => [category.slug, category.id]));
  for (const category of CATEGORIES) {
    if (idsBySlug.has(category.slug)) continue;
    const created = await callOk('POST', `${accountPath}/portals/${PORTAL.slug}/categories`, {
      category: { ...category, locale: 'en' },
    });
    idsBySlug.set(category.slug, created.payload.id);
    console.log(`created category ${category.slug}`);
  }
  return idsBySlug;
}

async function existingArticleSlugs() {
  const slugs = new Set();
  for (let page = 1; ; page += 1) {
    const listed = await callOk('GET', `${accountPath}/portals/${PORTAL.slug}/articles?locale=en&page=${page}`);
    if (listed.payload.length === 0) return slugs;
    for (const article of listed.payload) slugs.add(article.slug);
  }
}

const profile = await callOk('GET', '/api/v1/profile');
await ensurePortal();
const categoryIds = await ensureCategories();
const existing = await existingArticleSlugs();

let added = 0;
for (const article of readArticles()) {
  if (existing.has(article.slug)) {
    console.log(`skipped ${article.slug} (already there)`);
    continue;
  }
  const categoryId = categoryIds.get(article.category);
  if (!categoryId) throw new Error(`${article.slug} has an unknown category: ${article.category}`);
  await callOk('POST', `${accountPath}/portals/${PORTAL.slug}/articles`, {
    article: {
      title: article.title,
      slug: article.slug,
      description: article.description,
      content: article.content,
      category_id: categoryId,
      author_id: profile.id,
      locale: 'en',
      status: 'published',
    },
  });
  added += 1;
  console.log(`added ${article.slug}`);
}
console.log(`done: ${added} added`);

async function askHidden(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  prompt._writeToOutput = text => {
    if (text.startsWith(question)) process.stdout.write(question);
  };
  const answer = await prompt.question(question);
  prompt.close();
  process.stdout.write('\n');
  return answer.trim();
}
