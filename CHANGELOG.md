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
- A room playing its TV input is left alone: never paused by `pauseOthers` (Sonos refuses, and
  the old code silently ignored that) and skipped by `sayall` / `clipall` / `"target": "all"`,
  which used to pull the TV into the announcement group and could leave it on the clip. Naming
  the room still announces there.
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
- `GET /health` (no credentials): 200 with version, uptime, discovery, text-to-speech and queue
  facts once the players are known; 503 while starting or shutting down.
- Fixed: a briefing-length text failed to synthesize with
  `ERR_HTTP2_SESSION_ERROR: Session closed with error code 1` while short phrases never did.
  Long text was being split into pieces and sent to Polly concurrently, multiplexed on one fresh
  HTTP/2 session; Polly allows one stream per connection (`SETTINGS_MAX_CONCURRENT_STREAMS = 1`)
  and answers the extra streams on a new connection — before its settings have arrived — with
  `GOAWAY PROTOCOL_ERROR`, which took the whole session down. The splitting is gone: a phrase is
  one `SynthesizeSpeech` request, which is also how Polly wants it (it shapes the prosody of the
  whole text), and its limit — 3,000 billed characters, 6,000 with SSML — is now the only one,
  enforced up front with a 400 naming the numbers. The chunker, the MP3 joiner, the concurrency
  limiter and the `aws.maxConcurrency` / `aws.chunkTargetChars` settings were removed with it,
  and `POST /tts` no longer reports `chunks`. A connection dropped while the audio is still being
  read is retried like one dropped during the request.
- Fixed: `discoveryHosts` now rotates through the list, one host per attempt. Every host was
  asked at once, but the first `#init` to run claims the system and the rest return at its
  guard, so only the first entry was ever really tried — a single unplugged player blocked the
  whole list indefinitely.
- Announcements are refused with the "no Sonos system has been discovered yet" 503 (and
  `Retry-After: 5`) while no players are known, instead of a 400 claiming the preset's rooms are
  unknown.
- Fixed: an announcement whose clip was never heard playing (the player could not fetch it, or
  its events went missing) reported a clean `done`. The result now carries a warning saying the
  rooms may have been silent, so `done` means observed, not assumed.
- Fixed: the announcement's `SetAVTransportURI` and `Play` are retried the way the radio actions
  already retried theirs — a player asked to play right after a transport change refuses with
  UPnP 701 until it has switched, and one busy regrouping can answer late.
- Fixed: an announcement whose clip cannot be prepared (an unknown voice, a missing file) no
  longer groups the rooms and restores them for nothing; it fails before any speaker is touched.
- Fixed: the first announcement after a long quiet spell could fail with
  `Polly failed: Session closed with error code 1`. The Polly client speaks HTTP/2 and pools one
  session per region with no idle timeout, so a server that synthesizes once a day reached for a
  session that had been idle since yesterday and had long since been dropped; the AWS SDK does
  not class `ERR_HTTP2_SESSION_ERROR` as retryable, so the announcement failed outright. Idle
  sessions are now closed after 60 s (`aws.sessionTimeoutMs`), a dropped connection is retried
  once, and connection failures answer 503 with `Retry-After` and name their cause
  (`Could not reach Polly (ERR_HTTP2_SESSION_ERROR); try again shortly`) instead of a 502 that
  read as Polly's fault.
- `GET /voices` serves the Polly voice catalog (id, gender, language, supported engines) from the
  same day-long cache the server validates against, so a client can offer a dropdown instead of a
  free-text voice name; 200 with an empty list when Polly is not configured or unreachable.

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
