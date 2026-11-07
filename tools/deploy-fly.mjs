// Deploys the website to the Fly app `magpiereply-site` (Tokyo) through Fly's Machines API.
// It runs the stock nginx image and sends the site's files with the machine config,
// so no image build or flyctl is needed.
//
//   FLY_API_TOKEN=... node tools/deploy-fly.mjs
//
// Running it again updates the files on the existing machine.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = 'magpiereply-site';
const ORG = 'personal';
const REGION = 'nrt';
const IMAGE = 'nginx:1.27-alpine';
const MACHINES_API = 'https://api.machines.dev/v1';
const GRAPHQL_API = 'https://api.fly.io/graphql';
const WEB_ROOT = '/usr/share/nginx/html';
const SKIP = new Set(['partials', 'tools', 'README.md']);

const token = process.env.FLY_API_TOKEN;
if (!token) throw new Error('Set FLY_API_TOKEN first.');

const siteRoot = fileURLToPath(new URL('..', import.meta.url));

const NGINX_CONFIG = `server {
  listen 80;
  root ${WEB_ROOT};
  index index.html;
  absolute_redirect off;
  error_page 404 /404.html;

  gzip on;
  gzip_types text/css application/javascript image/svg+xml application/xml text/plain;

  location / {
    try_files $uri $uri/ =404;
  }

  location ~* \\.(css|js|svg)$ {
    add_header Cache-Control "public, max-age=3600";
  }
}
`;

async function call(method, path, body) {
  const response = await fetch(MACHINES_API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

async function graphql(query, variables) {
  const response = await fetch(GRAPHQL_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (result.errors) throw new Error(JSON.stringify(result.errors));
  return result.data;
}

function siteFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files.push(...siteFiles(path));
    } else {
      const rel = relative(siteRoot, path).split(sep).join('/');
      files.push({ guest_path: `${WEB_ROOT}/${rel}`, raw_value: readFileSync(path).toString('base64') });
    }
  }
  return files;
}

async function ensureApp() {
  const found = await fetch(`${MACHINES_API}/apps/${APP}`, { headers: { Authorization: `Bearer ${token}` } });
  if (found.ok) return;
  await call('POST', '/apps', { app_name: APP, org_slug: ORG });
  console.log(`created app ${APP}`);
}

async function ensureIps() {
  const data = await graphql('query($name: String!) { app(name: $name) { ipAddresses { nodes { type } } } }', { name: APP });
  const types = data.app.ipAddresses.nodes.map((ip) => ip.type);
  const mutation = 'mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address } } }';
  if (!types.includes('shared_v4')) {
    await graphql(mutation, { input: { appId: APP, type: 'shared_v4' } });
    console.log('allocated a shared IPv4 address');
  }
  if (!types.includes('v6')) {
    await graphql(mutation, { input: { appId: APP, type: 'v6' } });
    console.log('allocated an IPv6 address');
  }
}

function machineConfig() {
  return {
    image: IMAGE,
    guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
    files: [{ guest_path: '/etc/nginx/conf.d/default.conf', raw_value: Buffer.from(NGINX_CONFIG).toString('base64') }, ...siteFiles(siteRoot)],
    services: [
      {
        protocol: 'tcp',
        internal_port: 80,
        autostop: 'stop',
        autostart: true,
        min_machines_running: 0,
        ports: [
          { port: 80, handlers: ['http'], force_https: true },
          { port: 443, handlers: ['tls', 'http'] },
        ],
        checks: [{ type: 'http', interval: '30s', timeout: '5s', grace_period: '5s', method: 'GET', path: '/' }],
      },
    ],
    restart: { policy: 'on-failure' },
  };
}

async function deployMachine() {
  const machines = await call('GET', `/apps/${APP}/machines`);
  const config = machineConfig();
  console.log(`sending ${config.files.length - 1} site files`);
  let machine;
  if (machines.length === 0) {
    machine = await call('POST', `/apps/${APP}/machines`, { region: REGION, config });
    console.log(`created machine ${machine.id}`);
  } else {
    machine = await call('POST', `/apps/${APP}/machines/${machines[0].id}`, { config });
    console.log(`updated machine ${machine.id}`);
  }
  await call('GET', `/apps/${APP}/machines/${machine.id}/wait?state=started&timeout=60`);
  console.log(`started: https://${APP}.fly.dev`);
}

await ensureApp();
await ensureIps();
await deployMachine();
