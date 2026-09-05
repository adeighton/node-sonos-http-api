import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { describe, it } from 'node:test';

import { decode } from 'html-entities';

import { SOAP_ACTIONS } from '../discovery/soap.ts';
import { BadRequestError } from '../http/errors.ts';
import { createActionContext } from '../testing/action-context.ts';
import { fixturePath } from '../testing/fixtures.ts';
import { ActionRegistry } from './registry.ts';
import { registerStreamingActions, spotifyUriAndMetadata } from './streaming.ts';

function setup() {
  const registry = new ActionRegistry();
  registerStreamingActions(registry);
  const ctx = createActionContext();
  ctx.system.availableServices = { Spotify: { id: 9, capabilities: 0, type: 2311 } };
  const kitchen = ctx.rooms.get('Kitchen');
  assert.ok(kitchen);
  const run = (name: string, values: string[]) => {
    const action = registry.get(name);
    assert.ok(action, `action ${name}`);
    return action(ctx.context, values);
  };
  return { ...ctx, kitchen, run };
}

describe('streaming actions', () => {
  it('queue appends, next inserts after the current track', async () => {
    const { run, kitchen } = setup();
    await kitchen.player.handleLastChange({
      transportstate: { val: 'PLAYING' },
      currenttrack: { val: '2' },
    });
    kitchen.soap.calls.length = 0;

    await run('spotify', ['queue', 'spotify:track:abc']);
    await run('spotify', ['next', 'spotify:track:abc']);

    assert.deepEqual(
      kitchen.soap.calls.map((call) => [
        call.action,
        call.values?.enqueueAsNext,
        call.values?.desiredFirstTrackNumberEnqueued,
      ]),
      [
        [SOAP_ACTIONS.AddURIToQueue, 0, 0],
        [SOAP_ACTIONS.AddURIToQueue, 1, 3],
      ],
    );
    assert.equal(
      kitchen.soap.calls[0]?.values?.uri,
      'x-sonos-spotify:spotify%3Atrack%3Aabc?sid=9&amp;flags=32&amp;sn=1',
    );
  });

  it('now switches to the queue, seeks to the enqueued track and plays', async () => {
    const { run, kitchen } = setup();
    await kitchen.player.handleLastChange({
      currenttrack: { val: '2' },
      avtransporturi: { val: 'x-rincon-mp3radio://x' },
    });
    kitchen.soap.queueResponse(createReadStream(fixturePath('addURIToQueue.xml')));
    // The fixture reports track 1 as the first enqueued position.
    await run('spotify', ['now', 'spotify:album:xyz']);

    assert.deepEqual(
      kitchen.soap.calls.map((call) => call.action),
      [
        SOAP_ACTIONS.SetAVTransportURI,
        SOAP_ACTIONS.AddURIToQueue,
        SOAP_ACTIONS.Seek,
        SOAP_ACTIONS.Play,
      ],
    );
    assert.equal(kitchen.soap.calls[0]?.values?.uri, `x-rincon-queue:${kitchen.player.uuid}#0`);
    assert.equal(
      kitchen.soap.calls[1]?.values?.uri,
      'x-rincon-cpcontainer:0006206cspotify%3Aalbum%3Axyz',
    );
    assert.deepEqual(kitchen.soap.calls[2]?.values, { unit: 'TRACK_NR', value: 1 });
  });

  it('now keeps the queue transport and falls back to the requested position', async () => {
    const { run, kitchen } = setup();
    await kitchen.player.handleLastChange({
      transportstate: { val: 'PLAYING' },
      currenttrack: { val: '5' },
      avtransporturi: { val: `x-rincon-queue:${kitchen.player.uuid}#0` },
    });
    kitchen.soap.calls.length = 0;

    await run('spotify', ['now', 'spotify:track:abc']);

    assert.deepEqual(
      kitchen.soap.calls.map((call) => call.action),
      [SOAP_ACTIONS.AddURIToQueue, SOAP_ACTIONS.Seek, SOAP_ACTIONS.Play],
    );
    assert.deepEqual(kitchen.soap.calls[1]?.values, { unit: 'TRACK_NR', value: 6 });
  });

  it('validates the sub-action and the spotify uri', async () => {
    const { run, kitchen } = setup();
    await assert.rejects(run('spotify', ['later', 'spotify:track:abc']), BadRequestError);
    await assert.rejects(run('spotify', ['queue']), BadRequestError);
    await assert.rejects(run('spotify', ['queue', 'https://open.spotify.com/x']), BadRequestError);
    assert.equal(kitchen.soap.calls.length, 0);
    const { metadata } = spotifyUriAndMetadata('spotify:track:abc', 9, 2311);
    assert.match(metadata, /id="00030020spotify%3Atrack%3Aabc"/);
    assert.match(metadata, /SA_RINCON2311_X_#Svc2311-0-Token/);
  });

  it('builds Apple Music uris and metadata per item type', async () => {
    const { run, kitchen } = setup();
    await run('applemusic', ['queue', 'song:123']);
    await run('applemusic', ['queue', 'album:456']);
    await run('applemusic', ['queue', 'playlist:pl.789']);

    assert.deepEqual(
      kitchen.soap.calls.map((call) => call.values?.uri),
      [
        'x-sonos-http:song%3A123.mp4?sid=204&amp;flags=8224&amp;sn=4',
        'x-rincon-cpcontainer:0004206calbum%3A456',
        'x-rincon-cpcontainer:1006206cplaylist%3Apl.789',
      ],
    );
    assert.match(
      decode(String(kitchen.soap.calls[0]?.values?.metadata), { level: 'xml' }),
      /id="00032020song%3A123" parentID="0004206calbum%3a"/,
    );
    assert.match(
      decode(String(kitchen.soap.calls[1]?.values?.metadata), { level: 'xml' }),
      /id="0004206calbum%3A456" parentID="00020000album%3a"/,
    );
    assert.match(
      decode(String(kitchen.soap.calls[2]?.values?.metadata), { level: 'xml' }),
      /playlistContainer\.#PlaylistView/,
    );
    assert.match(
      decode(String(kitchen.soap.calls[2]?.values?.metadata), { level: 'xml' }),
      /SA_RINCON52231_X_#Svc52231-0-Token/,
    );
    await assert.rejects(run('applemusic', ['queue', 'video:1']), BadRequestError);
    await assert.rejects(run('applemusic', ['queue', 'song:']), BadRequestError);
  });

  it('builds Amazon Music uris and metadata', async () => {
    const { run, kitchen } = setup();
    await run('amazonmusic', ['queue', 'song:B01']);
    await run('amazonmusic', ['queue', 'album:B02']);

    assert.deepEqual(
      kitchen.soap.calls.map((call) => call.values?.uri),
      [
        'x-sonosapi-hls-static:catalog%2ftracks%2fB01%2f%3falbumAsin%3dB01JDKZWK0?sid=201&amp;flags=0&amp;sn=4',
        'x-rincon-cpcontainer:1004206ccatalog%2falbums%2fB02%2f%23album_desc?sid=201&amp;flags=8300&amp;sn=4',
      ],
    );
    assert.match(
      decode(String(kitchen.soap.calls[0]?.values?.metadata), { level: 'xml' }),
      /id="10030000catalog%2ftracks%2fB01%2f%3falbumAsin%3d"/,
    );
    assert.match(
      decode(String(kitchen.soap.calls[1]?.values?.metadata), { level: 'xml' }),
      /id="1004206ccatalogB02%2f%23album_desc" parentID="10052064catalog%2fartists%2f"/,
    );
    assert.match(
      decode(String(kitchen.soap.calls[1]?.values?.metadata), { level: 'xml' }),
      /SA_RINCON51463_X_#Svc51463-0-Token/,
    );
    await assert.rejects(run('amazonmusic', ['queue', 'playlist:1']), BadRequestError);
  });

  it('builds Napster and Aldi life uris with their own service ids', async () => {
    const { run, kitchen } = setup();
    await run('napster', ['queue', 'song:tra.1']);
    await run('napster', ['queue', 'album:alb.2']);
    await run('aldilifemusic', ['queue', 'song:tra.1']);

    assert.deepEqual(
      kitchen.soap.calls.map((call) => call.values?.uri),
      [
        'x-sonos-http:ondemand_track%3a%3atra.tra.1%7cv1%7cALBUM%7calb.mp4?sid=203&amp;flags=8224&amp;sn=13',
        'x-rincon-cpcontainer:100420ecexplore%3aalbum%3a%3aAlb.alb.2',
        'x-sonos-http:ondemand_track%3a%3atra.tra.1%7cv1%7cALBUM%7calb.mp4?sid=216&amp;flags=8224&amp;sn=13',
      ],
    );
    assert.match(
      decode(String(kitchen.soap.calls[0]?.values?.metadata), { level: 'xml' }),
      /SA_RINCON51975_X_#Svc51975-0-Token/,
    );
    assert.match(
      decode(String(kitchen.soap.calls[1]?.values?.metadata), { level: 'xml' }),
      /id="100420ecalb.2" parentID="100420ecexplore%3aalbum%3a"/,
    );
    assert.match(
      decode(String(kitchen.soap.calls[2]?.values?.metadata), { level: 'xml' }),
      /SA_RINCON55303_X_#Svc55303-0-Token/,
    );
  });
});
