// Sets up and checks the Parlant trial's MCP gateway (docs/phase-0.md, Day 6). Node 22, no packages.
//   node gateway/trial.mjs add-stripe     adds Stripe's MCP server to the gateway (Stripe sign-in)
//   node gateway/trial.mjs make-server    makes the test team's virtual server from Stripe's tools
//   node gateway/trial.mjs check [email]  lists the tools, then looks up a test customer's payments
// Reads GATEWAY_URL (default https://magpie-gateway.fly.dev) and GATEWAY_TOKEN, or asks for the token.
// The token must belong to the gateway user who signed in to Stripe: Stripe's sign-in is kept per user.
import { createInterface } from 'node:readline/promises';

const STRIPE = {
  name: 'stripe',
  url: 'https://mcp.stripe.com',
  issuer: 'https://access.stripe.com/mcp',
};
const SERVER_NAME = 'trial-team';
const DEFAULT_CHECK_EMAIL = 'maya.alvarez@example.com';

const gatewayUrl = (process.env.GATEWAY_URL ?? 'https://magpie-gateway.fly.dev').replace(/\/$/, '');
const [command, argument] = process.argv.slice(2);
const commands = { 'add-stripe': addStripe, 'make-server': makeServer, check };
if (!commands[command]) {
  console.error('Usage: node gateway/trial.mjs add-stripe | make-server | check [email]');
  process.exit(1);
}
const token = process.env.GATEWAY_TOKEN ?? (await askHidden('Gateway API token: '));
await commands[command](argument);

async function api(method, path, body) {
  const response = await fetch(gatewayUrl + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function findStripeGateway() {
  const gateways = await api('GET', '/gateways?include_pagination=false');
  return gateways.find(gateway => gateway.name === STRIPE.name);
}

async function addStripe() {
  let gateway = await findStripeGateway();
  if (gateway) {
    console.log(`Stripe is already added (gateway ${gateway.id}).`);
  } else {
    gateway = await api('POST', '/gateways', {
      name: STRIPE.name,
      url: STRIPE.url,
      transport: 'STREAMABLEHTTP',
      auth_type: 'oauth',
      oauth_config: {
        grant_type: 'authorization_code',
        issuer: STRIPE.issuer,
        redirect_uri: `${gatewayUrl}/oauth/callback`,
        scopes: ['mcp'],
      },
    });
    console.log(`Added Stripe (gateway ${gateway.id}).`);
  }
  console.log(`Next: open ${gatewayUrl}/admin, go to Gateways, click Authorize on "stripe",`);
  console.log('sign in to Stripe and pick the test-mode sandbox, then click Fetch tools.');
  console.log('Then run: node gateway/trial.mjs make-server');
}

async function makeServer() {
  const gateway = await findStripeGateway();
  if (!gateway) throw new Error('Stripe is not added yet. Run: node gateway/trial.mjs add-stripe');
  const tools = await api('GET', '/tools?include_pagination=false');
  const stripeTools = tools.filter(tool => (tool.gatewayId ?? tool.gateway_id) === gateway.id);
  if (stripeTools.length === 0) {
    throw new Error('Stripe has no tools yet. Authorize Stripe and click Fetch tools in the gateway admin first.');
  }

  const servers = await api('GET', '/servers?include_pagination=false');
  let server = servers.find(entry => entry.name === SERVER_NAME);
  const toolIds = stripeTools.map(tool => tool.id);
  if (server) {
    server = await api('PUT', `/servers/${server.id}`, { associated_tools: toolIds });
    console.log(`Updated the "${SERVER_NAME}" server.`);
  } else {
    server = await api('POST', '/servers', {
      server: { name: SERVER_NAME, description: 'Parlant trial test team: Stripe in test mode', associated_tools: toolIds },
    });
    console.log(`Made the "${SERVER_NAME}" server.`);
  }
  console.log(`${stripeTools.length} Stripe tools: ${stripeTools.map(tool => tool.originalName ?? tool.original_name).join(', ')}`);
  console.log(`MCP address: ${gatewayUrl}/servers/${server.id}/mcp`);
}

// A small MCP client over Streamable HTTP: JSON-RPC posts, answered as JSON or as an event stream.
function createMcpClient(url) {
  let sessionId;
  let nextId = 1;

  async function post(message) {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(message) });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    const text = await response.text();
    if (!response.ok) throw new Error(`${message.method} answered ${response.status}: ${text}`);
    if (message.id === undefined) return null;
    const replies = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => JSON.parse(line.slice(5)))
      : [JSON.parse(text)];
    const reply = replies.find(entry => entry.id === message.id);
    if (!reply) throw new Error(`${message.method} got no reply`);
    if (reply.error) throw new Error(`${message.method} failed: ${JSON.stringify(reply.error)}`);
    return reply.result;
  }

  return {
    request: (method, params) => post({ jsonrpc: '2.0', id: nextId++, method, params }),
    notify: method => post({ jsonrpc: '2.0', method }),
  };
}

async function timed(label, run) {
  const started = Date.now();
  const result = await run();
  console.log(`${label}: ${Date.now() - started} ms`);
  return result;
}

function resultText(result) {
  return (result.content ?? [])
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

async function check(email = DEFAULT_CHECK_EMAIL) {
  const servers = await api('GET', '/servers?include_pagination=false');
  const server = servers.find(entry => entry.name === SERVER_NAME);
  if (!server) throw new Error(`No "${SERVER_NAME}" server yet. Run: node gateway/trial.mjs make-server`);

  const mcp = createMcpClient(`${gatewayUrl}/servers/${server.id}/mcp`);
  await timed('initialize', () =>
    mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'magpie-trial-check', version: '1.0.0' },
    }),
  );
  await mcp.notify('notifications/initialized');
  const { tools } = await timed('tools/list', () => mcp.request('tools/list', {}));
  console.log(`${tools.length} tools: ${tools.map(tool => tool.name).join(', ')}`);

  const listCustomers = tools.find(tool => /list[_-]customers$/.test(tool.name));
  const listPayments = tools.find(tool => /list[_-]payment[_-]intents$/.test(tool.name));
  if (!listCustomers || !listPayments) {
    throw new Error('Stripe tools for listing customers and payments not found. Check the tool names above.');
  }

  const customers = await timed(`${listCustomers.name} (${email})`, () =>
    mcp.request('tools/call', { name: listCustomers.name, arguments: { email } }),
  );
  const customerText = resultText(customers);
  console.log(customerText);
  const customerId = customerText.match(/cus_[A-Za-z0-9]+/)?.[0];
  if (!customerId) throw new Error(`No Stripe customer found for ${email}. Create the test customers first.`);

  const payments = await timed(`${listPayments.name} (${customerId})`, () =>
    mcp.request('tools/call', { name: listPayments.name, arguments: { customer: customerId } }),
  );
  console.log(resultText(payments));
}

async function askHidden(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Hide what's typed so the token doesn't show on screen or in scrollback.
  prompt._writeToOutput = text => {
    if (text.includes(question)) prompt.output.write(question);
  };
  const answer = await prompt.question(question);
  prompt.close();
  process.stdout.write('\n');
  return answer.trim();
}
