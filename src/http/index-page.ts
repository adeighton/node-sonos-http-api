import type { ActionRegistry } from '../actions/registry.ts';

export interface IndexPageInput {
  registry: ActionRegistry;
  version: string;
  roomNames: string[];
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The landing page: every registered action with its usage, generated so it can never go stale. */
export function renderIndexHtml(input: IndexPageInput): string {
  const rows = input.registry
    .list()
    .map(
      (entry) => `<tr>
  <td><code>${escapeHtml(entry.name)}</code>${
    entry.aliases.length > 0
      ? `<br><small>also ${entry.aliases.map((alias) => `<code>${escapeHtml(alias)}</code>`).join(', ')}</small>`
      : ''
  }</td>
  <td><code>${escapeHtml(entry.meta.usage)}</code></td>
  <td>${escapeHtml(entry.meta.description)}</td>
</tr>`,
    )
    .join('\n');

  const rooms =
    input.roomNames.length === 0
      ? '<p><em>No players discovered yet.</em></p>'
      : `<ul>${input.roomNames.map((room) => `<li><a href="/${encodeURIComponent(room)}/state"><code>${escapeHtml(room)}</code></a></li>`).join('')}</ul>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sonos HTTP API</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 64rem; padding: 0 1rem; color: #222; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: .4rem .6rem; border-bottom: 1px solid #ddd; }
  code { background: #f4f4f4; padding: .1rem .3rem; border-radius: .2rem; }
  small { color: #666; }
</style>
</head>
<body>
<h1>Sonos HTTP API <small>v${escapeHtml(input.version)}</small></h1>
<p>Requests are <code>GET /{room}/{action}/{values...}</code>; actions that do not need a room accept <code>GET /{action}/{values...}</code>.
Room names are URL-encoded (<code>1.%20Kitchen</code>) and matched case-insensitively. Live events stream from <a href="/events"><code>/events</code></a>.</p>
<h2>Rooms</h2>
${rooms}
<h2>Actions</h2>
<table>
<thead><tr><th>Action</th><th>Usage</th><th>Description</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}
