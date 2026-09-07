# Changelog

## 2.0.0 (2026-09)

A rewrite of the fork for 2026: TypeScript on Node 24 (no build step), Hono for HTTP, pino for
logging, zod-validated settings, `node:test` unit tests with a coverage gate, and CI on Node 24
and 26. The vendored `sonos-discovery` library now lives in `src/discovery`.

### Behaviour changes visible to clients

- Errors carry meaningful status codes: unknown action, room, preset, favorite, playlist or clip
  is 404; bad input (undecodable segment, non-numeric volume, unknown sub-action) is 400; no
  system discovered yet is 503; anything but `GET` is 405 with `Allow: GET`. The body is always
  `{"status":"error","error":"..."}` and no longer includes a stack trace.
- A command the player refuses answers 502 with the UPnP error code and its meaning
  (`Seek was rejected by the player: UPnP error 711 (Illegal seek target ...)`); a player that
  does not answer in time is 504; a command that needs a group coordinator on a member is 409;
  a missing favorite or playlist is 404. 500 now only means a bug in this server. Every failure
  is logged with method, path, status and the error details (see the README).
- A phrase containing a newline (a multi-line announcement) is routed correctly. The app runs
  Hono on TrieRouter rather than the default SmartRouter: SmartRouter settles on RegExpRouter,
  whose wildcard cannot match a decoded line terminator, so such a request previously fell
  through to a bare 404 without ever reaching the dispatcher.
- A request url longer than roughly 16 KB is rejected by Node with 431. A very long `say`
  phrase is the only realistic way to reach that.
- CORS runs before authentication, so browser preflights succeed without credentials.
- `/docs` (Swagger UI) is gone; `/` renders an index generated from the registered actions.
- Text-to-speech is AWS Polly only. VoiceRSS, Microsoft, Google, macOS `say` and ElevenLabs
  were removed. In `say/{phrase}/{voice}/{volume}` a non-numeric second segment is a Polly voice
  id. The TTS cache uses new file names, so every phrase is synthesized once more.
- The single-file `presets.json` is no longer loaded; only files in the presets folder are.
- Pandora support was removed.
- Announcements (`say*`, `clip*`) are serialized: overlapping requests play one after another
  instead of interrupting each other and corrupting the saved player state.
- `/events` sends a `: ping` comment every 30 seconds.
- The library search says "The music library has not been loaded yet" instead of crashing
  when `/musicsearch/library/...` is used before `/musicsearch/library/load`.

### Found by the live test suite (September 2026)

- `pauseall` is best effort: a group that refuses to pause (a TV input, for instance) no longer
  fails the whole request. The response lists `paused` rooms and `failed` ones with the reason,
  and `resumeall` resumes only what actually paused.
- `tunein` and `bbcsounds` retry `Play` once, a second later, when the player answers UPnP 701
  because it is still switching to the new stream.
- Breaking a player out of its group is retried once after a timeout, and a failed announcement
  restore is retried once, so a player busy regrouping no longer leaves a room on the clip.
- A new live integration suite (`npm run test:live`, see the README) exercises every action
  against the real system and verifies the house is restored afterwards.

### Announcements rebuilt (September 2026)

- `say*` and `clip*` answer with what happened: `{ status, announcement: { id, state, rooms,
clip, restore, warnings, timings } }`. `restore: 'partial'` with a warning per room replaces a
  silent 200 when a room could not be put back.
- Presets are honoured: `saypreset` / `clippreset` pause the other groups only when the preset
  says `pauseOthers: true` (the default). Before, every announcement paused the whole house and
  captured and restored every zone, whether it took part or not. Only zones that are actually
  playing are paused, and only the rooms an announcement touched are restored: a player that
  left a group rejoins it, a paused group gets one `play`, everything else is left alone.
- Faster: text-to-speech starts at submission and overlaps the regrouping; joins, volumes and
  pauses go out four at a time; the end of the clip is detected from the player's first event
  rather than after album-art lookups; a player that already stands alone is no longer told to
  leave its group first. Every stage is timed and logged.
- `saypreset` and `clippreset` take an optional volume after the phrase / file (the README always
  said so; the code refused it).
- Long phrases are split at paragraph and sentence boundaries, synthesized in parallel and joined
  into one clip; Polly's 3000-character limit no longer applies to a request. Polly failures map
  to 400 (bad SSML, unknown voice/engine pair), 503 with `Retry-After` (throttled, or credentials
  missing), 504 (timeout) or 502, never 500. The cache key now hashes the normalized SSML, so
  phrases are synthesized once more; old files are kept.
- More than `announce.maxQueued` (10) waiting announcements → 503 with `Retry-After`. On
  shutdown (`systemctl restart sonos`) a playing announcement is stopped and its rooms restored
  before the process exits (`announce.shutdownDrainMs`, 15 s; the unit's `TimeoutStopSec` is
  25 s).
- Every response carries `X-Request-Id` (a caller's is echoed) and every log line of a request,
  including the announcement it queued, carries the same id.
- Generated speech is served with `Cache-Control: immutable`; clips are cacheable for an hour.

### Announcement API, priority and history (September 2026)

- `POST /announce` queues an announcement from JSON: `text`, `ssml` or `clip`; a target of
  `"all"`, `{ "preset": name }`, or rooms (`["Kitchen", { "name": "Office", "volume": 20 }]`);
  `volume`, `voice`, `engine`, `pauseOthers`, `priority` and an `idempotencyKey`. It answers
  202 with the id and a `Location` at once, or 200 with the result when `wait` is true.
  `GET /announce`, `GET /announce/:id` and `DELETE /announce/:id` list, read and cancel;
  `POST /tts` synthesizes a clip ahead of time. See the README for the shapes.
- Priority: an `urgent` announcement (a doorbell) goes ahead of the queue and interrupts a
  playing `normal` one, which resumes from a second before it was paused once the urgent one is
  done. Results carry `priority` and `interruptions`.
- History: every announcement is recorded in `cache/announcements.sqlite` (state, target,
  text preview, request id, result or error; 90 days by default), which is what `GET /announce`
  reads and what makes an `idempotencyKey` a "do not play this twice" within
  `announce.idempotencyWindowMs` (10 minutes).
- `/events` and the webhook carry a new `announcement` event for every state change
  (`queued`, `starting`, `playing`, `interrupted`, `restoring`, `done`, `failed`, `cancelled`).
- `npm run smoke:announce` rings a doorbell into the middle of a briefing on a running server.

### Configuration

- Secrets and ports can come from environment variables or a `.env` file (see `.env.example`);
  AWS credentials are read by the AWS SDK's default chain and never stored in the settings
  object. `settings.json` is still read (JSON5) and unknown keys are reported at startup.
- New `discoveryHosts` / `SONOS_DISCOVERY_HOSTS` for networks where SSDP multicast cannot
  reach the players.
- New `announce` block (`maxQueued`, `topologyTimeoutMs`, `restoreVerifyMs`, `shutdownDrainMs`,
  `resumeRewindMs`, `idempotencyWindowMs`), `history` block (`enabled`, `retentionDays`;
  `SONOS_HISTORY_ENABLED`) and `aws.maxConcurrency`, `aws.timeoutMs`, `aws.chunkTargetChars`
  for text-to-speech.
- `LOG_LEVEL` replaces `NODE_LOG_LEVEL`; `LOG_FORMAT=json` emits one JSON object per line.
- `deploy.sh` requires Node 24 on the Pi, never copies `.env` (provision it once with `scp`)
  and runs the server with `node src/main.ts`.
