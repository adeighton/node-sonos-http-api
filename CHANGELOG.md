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

### Configuration

- Secrets and ports can come from environment variables or a `.env` file (see `.env.example`);
  AWS credentials are read by the AWS SDK's default chain and never stored in the settings
  object. `settings.json` is still read (JSON5) and unknown keys are reported at startup.
- New `discoveryHosts` / `SONOS_DISCOVERY_HOSTS` for networks where SSDP multicast cannot
  reach the players.
- `LOG_LEVEL` replaces `NODE_LOG_LEVEL`; `LOG_FORMAT=json` emits one JSON object per line.
- `deploy.sh` requires Node 24 on the Pi, never copies `.env` (provision it once with `scp`)
  and runs the server with `node src/main.ts`.
