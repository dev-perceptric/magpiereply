import { Hono } from 'hono';
import { z } from 'zod';
import type { AppClient } from './chatwoot.js';
import { decrypt, hashHookId } from './crypto.js';
import type { Db } from './db.js';
import { closeDraft, findTeamByPanelHash, latestDraft, reopenDraft, type Team } from './repo.js';

// The drafts side panel: a Dashboard App inside MagpieReply's conversation view. Its address carries the team's
// long random panel key (only the hash is stored). Teammates see the latest draft and can send, edit or discard it.
// Sending is the only way a draft reaches a customer, and it always takes a person's click.

export interface PanelDeps {
  db: Db;
  encryptionKey: string;
  appClientFor: (botToken: string) => AppClient;
  // The app's own address: the only page allowed to frame the panel and to send it context.
  publicAppUrl: string;
}

const SendBody = z.object({ content: z.string().trim().min(1).max(10_000), actedBy: z.string().trim().min(1).max(200) });
const DiscardBody = z.object({ actedBy: z.string().trim().min(1).max(200) });
const Id = z.coerce.number().int().positive();

export function createPanelRoutes(deps: PanelDeps): Hono {
  const panel = new Hono();
  const appOrigin = new URL(deps.publicAppUrl).origin;

  async function teamFor(key: string): Promise<Team | null> {
    return findTeamByPanelHash(deps.db, hashHookId(key));
  }

  panel.get('/:key', async c => {
    if (!(await teamFor(c.req.param('key')))) return c.text('Not found', 404);
    c.header('content-security-policy', `frame-ancestors ${appOrigin}`);
    c.header('cache-control', 'no-store');
    return c.html(panelPage(appOrigin));
  });

  panel.get('/:key/conversations/:conversationId/draft', async c => {
    const team = await teamFor(c.req.param('key'));
    const conversationId = Id.safeParse(c.req.param('conversationId'));
    if (!team) return c.json({ error: 'not found' }, 404);
    if (!conversationId.success) return c.json({ error: 'invalid conversation' }, 422);
    return c.json({ draft: await latestDraft(deps.db, team.id, conversationId.data) });
  });

  panel.post('/:key/drafts/:draftId/send', async c => {
    const team = await teamFor(c.req.param('key'));
    const draftId = Id.safeParse(c.req.param('draftId'));
    const body = SendBody.safeParse(await c.req.json().catch(() => null));
    if (!team) return c.json({ error: 'not found' }, 404);
    if (!draftId.success || !body.success) return c.json({ error: 'invalid request' }, 422);

    // Claim the draft first, so a double click or two teammates can never send it twice.
    const draft = await closeDraft(deps.db, {
      teamId: team.id,
      draftId: draftId.data,
      status: 'sent',
      sentContent: body.data.content,
      actedBy: body.data.actedBy,
    });
    if (!draft) return c.json({ error: 'This draft was already handled.' }, 409);

    try {
      const app = deps.appClientFor(decrypt(team.botTokenEnc, deps.encryptionKey));
      await app.sendReply(team.accountId, draft.conversationId, body.data.content);
    } catch {
      await reopenDraft(deps.db, team.id, draft.id);
      return c.json({ error: "The reply didn't go out. Try again." }, 502);
    }
    return c.json({ draft });
  });

  panel.post('/:key/drafts/:draftId/discard', async c => {
    const team = await teamFor(c.req.param('key'));
    const draftId = Id.safeParse(c.req.param('draftId'));
    const body = DiscardBody.safeParse(await c.req.json().catch(() => null));
    if (!team) return c.json({ error: 'not found' }, 404);
    if (!draftId.success || !body.success) return c.json({ error: 'invalid request' }, 422);

    const draft = await closeDraft(deps.db, { teamId: team.id, draftId: draftId.data, status: 'discarded', actedBy: body.data.actedBy });
    if (!draft) return c.json({ error: 'This draft was already handled.' }, 409);
    return c.json({ draft });
  });

  return panel;
}

// One small page, no build step. Colors and type follow MagpieReply's brand (#0943b0, Inter).
function panelPage(appOrigin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Magpie</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --brand: #0943b0; --brand-hover: #07368f; --text: #1f2328; --muted: #646b73; --line: #e4e7eb; --card: #ffffff; --page: #f7f8fa; --soft: #eef3fc; --warn: #8a5300; --warn-soft: #fff6e5; }
  :root[data-theme="dark"] { --brand: #5b8def; --brand-hover: #7aa3f2; --text: #e8eaed; --muted: #9aa1a9; --line: #2c3036; --card: #1b1e22; --page: #131518; --soft: #1d2a42; --warn: #f0b75c; --warn-soft: #33270f; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font: 14px/1.5 Inter, system-ui, sans-serif; color: var(--text); background: var(--page); }
  h1 { margin: 0 0 12px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  textarea { width: 100%; min-height: 160px; resize: vertical; border: 1px solid var(--line); border-radius: 6px; padding: 10px; font: inherit; color: inherit; background: var(--card); }
  textarea:focus { outline: 2px solid var(--brand); outline-offset: 1px; }
  .tag { display: inline-block; margin: 8px 0 0; padding: 4px 8px; border-radius: 4px; font-size: 12px; background: var(--soft); }
  .tag.warn { background: var(--warn-soft); color: var(--warn); }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  button { font: inherit; font-weight: 500; border-radius: 6px; padding: 7px 14px; cursor: pointer; border: 1px solid var(--line); background: var(--card); color: var(--text); }
  button.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
  button.primary:hover { background: var(--brand-hover); }
  button:disabled { opacity: .5; cursor: default; }
  .muted { color: var(--muted); }
  .error { color: #c62828; margin-top: 8px; }
  p { margin: 0; overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>Magpie draft</h1>
<div id="view" class="muted">Open a conversation to see its draft.</div>
<script>
(function () {
  var APP_ORIGIN = ${JSON.stringify(appOrigin)};
  var base = location.pathname.replace(/\\/$/, '');
  var view = document.getElementById('view');
  var context = null, shownId = null, timer = null;

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    if (text != null) node.textContent = text;
    return node;
  }

  function agentName() { return (context && context.currentAgent && context.currentAgent.name) || 'A teammate'; }

  function render(draft) {
    view.className = '';
    view.textContent = '';
    if (!draft) { view.className = 'muted'; view.textContent = 'No draft yet. Magpie writes one when the customer sends a message.'; shownId = null; return; }
    if (draft.status !== 'pending') {
      var done = { sent: 'Sent.', discarded: 'Discarded.', replaced: 'A newer draft replaced this one.' }[draft.status];
      view.className = 'muted'; view.textContent = done; shownId = draft.id; return;
    }
    if (shownId === draft.id) return; // keep what the teammate is typing
    shownId = draft.id;
    var card = el('div', { class: 'card' });
    var box = el('textarea', { 'aria-label': 'Draft reply' });
    box.value = draft.reply || '';
    card.appendChild(box);
    (draft.proposals || []).forEach(function (p) {
      var who = p.approval === 'staff_approves' ? 'needs a teammate to approve' : 'needs the customer to confirm';
      card.appendChild(el('div', { class: 'tag' }, 'Refund ' + p.amount + ' for ' + p.charge_id + ', ' + who));
    });
    if (draft.handoff) card.appendChild(el('div', { class: 'tag warn' }, 'Suggests handing off to ' + draft.handoff.team + ': ' + draft.handoff.reason));
    var row = el('div', { class: 'row' });
    var send = el('button', { class: 'primary', type: 'button' }, 'Send');
    var copy = el('button', { type: 'button' }, 'Copy');
    var discard = el('button', { type: 'button' }, 'Discard');
    var error = el('div', { class: 'error', role: 'alert' });
    row.appendChild(send); row.appendChild(copy); row.appendChild(discard);
    card.appendChild(row); card.appendChild(error);
    view.appendChild(card);

    function act(path, body, button) {
      error.textContent = '';
      [send, copy, discard].forEach(function (b) { b.disabled = true; });
      fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (res) {
          if (!res.ok) { error.textContent = res.data.error || 'Something went wrong.'; [send, copy, discard].forEach(function (b) { b.disabled = false; }); return; }
          shownId = null; render(res.data.draft);
        })
        .catch(function () { error.textContent = 'Something went wrong. Try again.'; [send, copy, discard].forEach(function (b) { b.disabled = false; }); });
    }
    send.onclick = function () { act('/drafts/' + draft.id + '/send', { content: box.value, actedBy: agentName() }, send); };
    discard.onclick = function () { act('/drafts/' + draft.id + '/discard', { actedBy: agentName() }, discard); };
    copy.onclick = function () {
      navigator.clipboard.writeText(box.value).then(function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1500); });
    };
  }

  function load() {
    if (!context || !context.conversation || !context.conversation.id) return;
    fetch(base + '/conversations/' + encodeURIComponent(context.conversation.id) + '/draft')
      .then(function (r) { return r.json(); })
      .then(function (data) { render(data.draft); })
      .catch(function () {});
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== APP_ORIGIN) return;
    var message;
    try { message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch (e) { return; }
    if (!message || message.event !== 'appContext') return;
    var before = context && context.conversation && context.conversation.id;
    var after = message.data && message.data.conversation && message.data.conversation.id;
    var changed = before !== after;
    context = message.data;
    document.documentElement.dataset.theme = context.theme === 'dark' ? 'dark' : 'light';
    if (changed) shownId = null;
    load();
    clearInterval(timer);
    timer = setInterval(load, 5000);
  });
  window.parent.postMessage('chatwoot-dashboard-app:fetch-info', APP_ORIGIN);
})();
</script>
</body>
</html>`;
}
