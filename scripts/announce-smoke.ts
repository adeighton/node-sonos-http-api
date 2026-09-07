/**
 * A smoke test of the announcement API against a running server, for a quick check after a
 * deploy: queues a briefing to one room, rings a doorbell into the middle of it, and prints
 * what the server reports until both are done.
 *
 *   SONOS_API=http://man-in-the-ceiling.local:5005 SONOS_ROOM="1. Kitchen" npm run smoke:announce
 */
/* eslint-disable no-console -- a command-line script reports on stdout */
const api = process.env.SONOS_API ?? 'http://127.0.0.1:5005';
const room = process.env.SONOS_ROOM ?? '1. Kitchen';
const volume = Number(process.env.SONOS_VOLUME ?? '15');

const BRIEFING =
  'Good morning. This is the announcement smoke test. It talks for a little while so that the ' +
  'doorbell can interrupt it. The first meeting is at nine, lunch is at half past twelve, and ' +
  'the plants would like some water. That is all for now; have a good day.';

interface Entry {
  id: string;
  state: string;
  result?: { interruptions: number; restore: string; warnings: string[]; timings: unknown };
  error?: string;
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(new URL(path, api), init);
  const body: unknown = await response.json();
  if (!response.ok && response.status !== 202) {
    throw new Error(
      `${init?.method ?? 'GET'} ${path} → ${response.status} ${JSON.stringify(body)}`,
    );
  }

  return body;
}

async function announce(body: Record<string, unknown>): Promise<string> {
  const { id } = (await call('/announce', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })) as { id: string };
  return id;
}

async function follow(label: string, id: string, until: (entry: Entry) => boolean): Promise<Entry> {
  let last = '';
  for (;;) {
    const entry = (await call(`/announce/${id}`)) as Entry;
    if (entry.state !== last) {
      console.log(`${new Date().toISOString()} ${label}: ${entry.state}`);
      last = entry.state;
    }

    if (until(entry) || ['done', 'failed', 'cancelled'].includes(entry.state)) {
      return entry;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const briefing = await announce({ text: BRIEFING, target: [room], volume });
await follow('briefing', briefing, (entry) => entry.state === 'playing');
await new Promise((resolve) => setTimeout(resolve, 4000));
const doorbell = await announce({
  clip: 'TacoBellBong.mp3',
  target: [room],
  volume,
  priority: 'urgent',
});
await follow('doorbell', doorbell, () => false);
const finished = await follow('briefing', briefing, () => false);
console.log(JSON.stringify(finished.result ?? finished.error, null, 2));
