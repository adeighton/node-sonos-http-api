import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fakeFetch } from '../testing/fake-fetch.ts';
import { ArgumentError, UnknownServiceError } from './errors.ts';
import { createArtLookup, getServiceId } from './music-services.ts';
import { createDeezerArtService, parseDeezerTrackId } from './services/deezer.ts';
import {
  DEFAULT_SOUNDCLOUD_CLIENT_ID,
  createSoundcloudArtService,
  parseSoundcloudTrackId,
} from './services/soundcloud.ts';

const DEEZER_URI = 'x-sonosprog-http:tr-flac%3a3134041.flac?sid=2&flags=8224&sn=7';
const SOUNDCLOUD_URI = 'x-sonos-http:track%3a232202756.mp3?sid=160&flags=8224&sn=10';

describe('getServiceId', () => {
  it('extracts the sid query parameter', () => {
    assert.equal(getServiceId(DEEZER_URI), '2');
    assert.equal(getServiceId(SOUNDCLOUD_URI), '160');
    assert.equal(getServiceId('x-rincon-queue:RINCON_1#0'), undefined);
  });
});

describe('deezer art service', () => {
  it('parses the track id', () => {
    assert.equal(parseDeezerTrackId(DEEZER_URI), '3134041');
    assert.throws(() => parseDeezerTrackId('x-rincon-queue:RINCON_1#0'), ArgumentError);
  });

  it('fetches the big cover from the Deezer API', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.deezer.com/track/3134041': {
        body: { album: { cover_big: 'https://cdn-images.dzcdn.net/cover/500x500.jpg' } },
      },
    });
    const service = createDeezerArtService({ fetch, timeoutMs: 100 });

    const art = await service.tryGetHighResArt(DEEZER_URI);

    assert.equal(art, 'https://cdn-images.dzcdn.net/cover/500x500.jpg');
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
  });

  it('rejects on non-2xx answers and resolves undefined when there is no cover', async () => {
    const { fetch } = fakeFetch({
      'https://api.deezer.com/track/1': { status: 404, body: { error: 'no such track' } },
      'https://api.deezer.com/track/2': { body: { album: {} } },
    });
    const service = createDeezerArtService({ fetch, timeoutMs: 100 });

    await assert.rejects(service.tryGetHighResArt('x-sonosprog-http:tr%3a1.flac?sid=2'), /404/);
    assert.equal(await service.tryGetHighResArt('x-sonosprog-http:tr%3a2.flac?sid=2'), undefined);
  });
});

describe('soundcloud art service', () => {
  it('parses the track id', () => {
    assert.equal(parseSoundcloudTrackId(SOUNDCLOUD_URI), '232202756');
    assert.throws(() => parseSoundcloudTrackId(DEEZER_URI), ArgumentError);
  });

  it('requests the track with the client id and upsizes the artwork', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.soundcloud.com/tracks/232202756*': {
        body: { artwork_url: 'https://i1.sndcdn.com/artworks-000022486019-txiq8s-large.jpg' },
      },
    });
    const service = createSoundcloudArtService({ fetch, timeoutMs: 100, clientId: 'my-client' });

    const art = await service.tryGetHighResArt(SOUNDCLOUD_URI);

    assert.equal(art, 'https://i1.sndcdn.com/artworks-000022486019-txiq8s-t500x500.jpg');
    assert.equal(calls[0]?.url, 'https://api.soundcloud.com/tracks/232202756?client_id=my-client');
  });

  it('falls back to the default client id and tolerates missing artwork', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.soundcloud.com/tracks/232202756*': { body: { artwork_url: null } },
    });
    const service = createSoundcloudArtService({ fetch, timeoutMs: 100 });

    assert.equal(await service.tryGetHighResArt(SOUNDCLOUD_URI), undefined);
    assert.ok(calls[0]?.url.endsWith(`client_id=${DEFAULT_SOUNDCLOUD_CLIENT_ID}`));
  });

  it('rejects on non-2xx answers', async () => {
    const { fetch } = fakeFetch({
      'https://api.soundcloud.com/tracks/232202756*': { status: 401, body: 'unauthorized' },
    });
    const service = createSoundcloudArtService({ fetch, timeoutMs: 100 });

    await assert.rejects(service.tryGetHighResArt(SOUNDCLOUD_URI), /401/);
  });
});

describe('createArtLookup', () => {
  it('passes http(s) uris through untouched', async () => {
    const lookup = createArtLookup({ fetch: fakeFetch({}).fetch });

    assert.equal(await lookup('https://host/art.jpg'), 'https://host/art.jpg');
  });

  it('routes by service id to Deezer and SoundCloud', async () => {
    const { fetch } = fakeFetch({
      'https://api.deezer.com/track/3134041': { body: { album: { cover_big: 'deezer.jpg' } } },
      'https://api.soundcloud.com/tracks/232202756*': { body: { artwork_url: 'sc-large.jpg' } },
    });
    const lookup = createArtLookup({ fetch });

    assert.equal(await lookup(DEEZER_URI), 'deezer.jpg');
    assert.equal(await lookup(SOUNDCLOUD_URI), 'sc-t500x500.jpg');
  });

  it('rejects with UnknownServiceError for services it does not know', async () => {
    const lookup = createArtLookup({ fetch: fakeFetch({}).fetch });

    await assert.rejects(
      lookup('x-sonos-spotify:spotify%3atrack%3aabc?sid=9&flags=8224&sn=9'),
      (error: unknown) => {
        assert.ok(error instanceof UnknownServiceError);
        assert.equal(error.serviceName, '9');
        return true;
      },
    );
    await assert.rejects(lookup('x-rincon-queue:RINCON_1#0'), UnknownServiceError);
  });

  it('accepts a custom service table', async () => {
    const lookup = createArtLookup({
      services: { 42: { tryGetHighResArt: () => Promise.resolve('custom.jpg') } },
    });

    assert.equal(await lookup('x-custom:track?sid=42'), 'custom.jpg');
  });
});
