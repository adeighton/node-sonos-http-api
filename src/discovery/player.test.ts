import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { fixturePath, readJsonFixture } from '../testing/fixtures.ts';
import { createTestPlayer } from '../testing/test-player.ts';
import { REPEAT_MODE } from './player-state.ts';
import { SOAP_ACTIONS } from './soap.ts';
import type { LastChangeData } from './types.ts';

const AV = 'http://192.168.1.151:1400/MediaRenderer/AVTransport/Control';
const RC = 'http://192.168.1.151:1400/MediaRenderer/RenderingControl/Control';
const GRC = 'http://192.168.1.151:1400/MediaRenderer/GroupRenderingControl/Control';
const CD = 'http://192.168.1.151:1400/MediaServer/ContentDirectory/Control';

function lastChange(fixture: string): LastChangeData {
  return readJsonFixture<LastChangeData>(fixture);
}

describe('Player', () => {
  it('exposes name, uuid and base url from the zone member data', () => {
    const { player } = createTestPlayer();

    assert.equal(player.roomName, 'Kitchen');
    assert.equal(player.uuid, 'RINCON_00000000000001400');
    assert.equal(player.baseUrl, 'http://192.168.1.151:1400');
    assert.equal(player.coordinator, player);
    assert.equal(player.hasSub, false);
  });

  it('flags a connected SUB from the channel map', () => {
    const { player } = createTestPlayer({
      channelmapset: 'RINCON_20000000000001400:LF,RF;RINCON_10000000000001400:SW,SW',
    });

    assert.equal(player.hasSub, true);
  });

  it('subscribes to the four notification endpoints and disposes them', async () => {
    const { player, subscribers } = createTestPlayer();

    assert.deepEqual(
      subscribers.map((subscriber) => subscriber.url),
      [
        'http://192.168.1.151:1400/MediaRenderer/AVTransport/Event',
        'http://192.168.1.151:1400/MediaRenderer/RenderingControl/Event',
        'http://192.168.1.151:1400/MediaRenderer/GroupRenderingControl/Event',
        'http://192.168.1.151:1400/MediaServer/ContentDirectory/Event',
      ],
    );
    assert.ok(
      subscribers.every((subscriber) => subscriber.notificationUrl === 'http://127.0.0.2/'),
    );

    await player.dispose();

    assert.ok(subscribers.every((subscriber) => subscriber.dispose.mock.callCount() === 1));
  });

  describe('transport-state updates', () => {
    it('updates state, tracks and transport uri for queue playback', async () => {
      const artLookup = mock.fn((_uri: string) => Promise.resolve('http://example.org/image'));
      artLookup.mock.mockImplementationOnce(() => Promise.resolve('http://example.org/image1'), 0);
      artLookup.mock.mockImplementationOnce(() => Promise.resolve('http://example.org/image2'), 1);
      const { player, system } = createTestPlayer({ artLookup });
      system.addStandalone(player);
      const event = once(player, 'transport-state');

      await player.handleLastChange(lastChange('avtransportlastchange.json'));
      await event;

      assert.equal(player.state.playbackState, 'PLAYING');
      assert.equal(player.state.trackNo, 43);
      assert.deepEqual(player.state.currentTrack, {
        artist: 'Johannes Brahms',
        title: 'Intermezzo No. 3 in C-sharp minor, Op. 117 - Andante con moto',
        album: 'Glenn Gould plays Brahms: 4 Ballades op. 10; 2 Rhapsodies op. 79; 10 Intermezzi',
        albumArtUri:
          '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a5qAFqkXoQd2RfjZ2j1ay0w%3fsid%3d9%26flags%3d8224%26sn%3d9',
        absoluteAlbumArtUri: 'http://example.org/image1',
        duration: 318,
        uri: 'x-sonos-spotify:spotify%3atrack%3a5qAFqkXoQd2RfjZ2j1ay0w?sid=9&flags=8224&sn=9',
        trackUri: 'x-sonos-spotify:spotify%3atrack%3a5qAFqkXoQd2RfjZ2j1ay0w?sid=9&flags=8224&sn=9',
        type: 'track',
        stationName: '',
      });
      assert.deepEqual(player.state.nextTrack, {
        artist: 'Coheed and Cambria',
        title: 'Here To Mars',
        album: 'The Color Before The Sun',
        albumArtUri:
          '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a0Ap3aOVU7LItcHIFiRF8lY%3fsid%3d9%26flags%3d8224%26sn%3d9',
        absoluteAlbumArtUri: 'http://example.org/image2',
        duration: 241,
        uri: 'x-sonos-spotify:spotify%3atrack%3a0Ap3aOVU7LItcHIFiRF8lY?sid=9&flags=8224&sn=9',
      });
      assert.deepEqual(player.state.playMode, { repeat: 'all', shuffle: true, crossfade: true });
      assert.equal(player.avTransportUri, 'x-rincon-queue:RINCON_00000000000001400#0');
      assert.equal(player.avTransportUriMetadata, '');
      assert.equal(system.eventsOf('transport-state').length, 1);
    });

    it('requests GetPositionInfo and derives the elapsed time', async () => {
      mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
      try {
        const { player, soap, system } = createTestPlayer();
        system.addStandalone(player);
        soap.queueResponse(createReadStream(fixturePath('getpositioninfo.xml')));

        await player.handleLastChange(lastChange('avtransportlastchange.json'));

        assert.deepEqual(soap.callArgs(0), [AV, SOAP_ACTIONS.GetPositionInfo, undefined]);
        assert.equal(player.state.elapsedTime, 142);
        mock.timers.tick(6000);
        assert.equal(player.state.elapsedTime, 148, 'elapsed time keeps counting while playing');
        assert.equal(player.state.elapsedTimeFormatted, '00:02:28');
      } finally {
        mock.timers.reset();
      }
    });

    it('does not report position for grouped members or while transitioning', async () => {
      const { player, soap } = createTestPlayer();
      const transportState = mock.fn();
      player.on('transport-state', transportState);

      const grouped = lastChange('avtransportlastchange.json');
      grouped.avtransporturi = { val: 'x-rincon:RINCON_ANOTHER' };
      await player.handleLastChange(grouped);

      const transitioning = lastChange('avtransportlastchange.json');
      transitioning.transportstate = { val: 'TRANSITIONING' };
      await player.handleLastChange(transitioning);

      assert.equal(soap.calls.length, 0);
      assert.equal(transportState.mock.callCount(), 0);
    });

    it('handles radio playback: station name, artist fallback and player-relative art', async () => {
      const { player } = createTestPlayer();

      await player.handleLastChange(lastChange('avtransportlastchange_radio.json'));

      assert.equal(player.state.playbackState, 'PLAYING');
      assert.equal(player.state.trackNo, 1);
      assert.deepEqual(player.state.currentTrack, {
        stationName: 'Lugna Favoriter',
        title: 'Leona Lewis - Bleeding Love',
        album: undefined,
        artist: 'Lugna Favoriter',
        albumArtUri: '/getaa?s=1&u=x-sonosapi-stream%3as17553%3fsid%3d254%26flags%3d8224%26sn%3d0',
        absoluteAlbumArtUri:
          'http://192.168.1.151:1400/getaa?s=1&u=x-sonosapi-stream%3as17553%3fsid%3d254%26flags%3d8224%26sn%3d0',
        duration: 0,
        uri: 'x-sonosapi-stream:s17553?sid=254&flags=8224&sn=0',
        trackUri: 'x-sonosapi-stream:s17553?sid=254&flags=8224&sn=0',
        type: 'radio',
      });
      assert.deepEqual(player.state.nextTrack, {
        artist: '',
        title: '',
        album: '',
        albumArtUri: '',
        duration: 0,
        uri: '',
      });
      assert.equal(player.avTransportUri, 'x-sonosapi-stream:s17553?sid=254&flags=8224&sn=0');
      assert.ok(player.avTransportUriMetadata.startsWith('<DIDL-Lite'));
    });

    it('handles custom mp3 radio streams', async () => {
      const { player } = createTestPlayer();

      await player.handleLastChange(lastChange('avtransportlastchange_custom_radio.json'));

      assert.deepEqual(player.state.currentTrack, {
        stationName: 'buddha',
        title: 'Orelha Negra - M.I.R.I.A.M.',
        album: undefined,
        artist: 'buddha',
        albumArtUri: undefined,
        duration: 0,
        uri: 'x-rincon-mp3radio://sc01.scahw.com.au:80/buddha_32',
        trackUri: 'aac://sc01.scahw.com.au:80/buddha_32',
        type: 'radio',
      });
      assert.equal(player.avTransportUri, 'x-rincon-mp3radio://sc01.scahw.com.au:80/buddha_32');
    });

    it('does not crash on Google Cast or AirPlay metadata', async () => {
      const { player } = createTestPlayer();

      await player.handleLastChange(lastChange('avtransportlastchange_google_cast.json'));
      await player.handleLastChange(lastChange('avtransportlastchange_airplay.json'));

      assert.equal(player.state.playbackState, 'PLAYING');
    });

    it('takes album art from the enqueued metadata for DLNA servers', async () => {
      const { player } = createTestPlayer();

      await player.handleLastChange(lastChange('avtransportlastchange_subsonic.json'));

      assert.equal(
        player.state.currentTrack.absoluteAlbumArtUri,
        'http://192.168.200.20:4040/coverArt.view?id=9381&auth=1583337699&size=300',
      );
    });

    it('keeps an already absolute album art url', async () => {
      const { player } = createTestPlayer();
      const data = lastChange('avtransportlastchange_radio.json');
      data.currenttrackmetadata = {
        val: '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="-1" parentID="-1" restricted="true"><res protocolInfo="sonos.com-http:*:application/octet-stream:*">x-sonosapi-stream:s20308?sid=254&amp;flags=32</res><r:streamContent>P5 STHLM - Sebastian Ingrosso - Dark River</r:streamContent><r:radioShowMd></r:radioShowMd><upnp:albumArtURI>http://absolute.url/for/test</upnp:albumArtURI><dc:title>x-sonosapi-stream:s20308?sid=254&amp;flags=32</dc:title><upnp:class>object.item</upnp:class></item></DIDL-Lite>',
      };

      await player.handleLastChange(data);

      assert.equal(player.state.currentTrack.absoluteAlbumArtUri, 'http://absolute.url/for/test');
    });

    it('logs and survives a failing GetPositionInfo', async () => {
      const { player, soap } = createTestPlayer();
      soap.queueFailure(new Error('player unreachable'));

      await player.handleLastChange(lastChange('avtransportlastchange.json'));

      assert.equal(player.state.playbackState, 'PLAYING');
    });
  });

  describe('rendering control updates', () => {
    it('updates volume, equalizer, fixed output and emits events', async () => {
      const { player, system } = createTestPlayer();
      system.addStandalone(player);
      const volumeChange = mock.fn();
      player.on('volume-change', volumeChange);

      await player.handleLastChange(lastChange('renderingControlLastChange.json'));

      assert.equal(player.state.volume, 12);
      assert.equal(player.groupState.volume, 12);
      assert.equal(player.outputFixed, false);
      assert.equal(player.state.equalizer.loudness, true);
      assert.equal(player.state.equalizer.bass, 3);
      assert.equal(player.state.equalizer.treble, -2);
      assert.equal(player.state.equalizer.speechEnhancement, true);
      assert.equal(player.state.equalizer.nightMode, true);
      assert.deepEqual(volumeChange.mock.calls[0]?.arguments[0], {
        uuid: 'RINCON_00000000000001400',
        previousVolume: 0,
        newVolume: 12,
        roomName: 'Kitchen',
      });
      assert.equal(system.eventsOf('volume-change').length, 1);
    });

    it('reads fixed output and mute', async () => {
      const { player, system } = createTestPlayer();
      const data = lastChange('renderingControlLastChange.json');
      data.outputfixed = { val: '1' };
      data.mute = [{ channel: 'Master', val: '1' }];

      await player.handleLastChange(data);

      assert.equal(player.outputFixed, true);
      assert.equal(player.state.mute, true);
      assert.deepEqual(
        system.emitted.map((recorded) => recorded.event),
        ['mute-change', 'volume-change'],
      );
    });

    it('accepts a single volume channel that is not an array', async () => {
      const { player } = createTestPlayer();

      await player.handleLastChange({ volume: { channel: 'Master', val: '7' } });

      assert.equal(player.state.volume, 7);
    });
  });

  describe('sub updates', () => {
    it('updates gain, crossover, polarity and enabled', async () => {
      const { player } = createTestPlayer({ channelmapset: 'RINCON_1:LF,RF;RINCON_2:SW,SW' });

      await player.handleLastChange(lastChange('sublastchange.json'));

      assert.deepEqual(player.sub, { gain: -3, crossover: 90, polarity: 0, enabled: true });
      assert.deepEqual(player.state.sub, { gain: -3, crossover: 90, polarity: 0, enabled: true });
    });

    it('omits sub state from players without a SUB', async () => {
      const { player } = createTestPlayer();

      await player.handleLastChange(lastChange('sublastchange.json'));

      assert.equal(player.state.sub, undefined);
    });
  });

  it('handles group mute notifications', () => {
    const { player, system } = createTestPlayer();
    const groupMute = mock.fn();
    player.on('group-mute', groupMute);

    player.handleGroupMute('1');

    assert.equal(player.groupState.mute, true);
    assert.deepEqual(groupMute.mock.calls[0]?.arguments[0], {
      uuid: 'RINCON_00000000000001400',
      previousMute: false,
      newMute: true,
      roomName: 'Kitchen',
    });
    assert.equal(system.emitted[0]?.event, 'group-mute');
  });

  describe('commands', () => {
    const simpleCases = [
      { action: SOAP_ACTIONS.Play, method: 'play' },
      { action: SOAP_ACTIONS.Pause, method: 'pause' },
      { action: SOAP_ACTIONS.Stop, method: 'stop' },
      { action: SOAP_ACTIONS.Next, method: 'nextTrack' },
      { action: SOAP_ACTIONS.Previous, method: 'previousTrack' },
      {
        action: SOAP_ACTIONS.BecomeCoordinatorOfStandaloneGroup,
        method: 'becomeCoordinatorOfStandaloneGroup',
      },
      { action: SOAP_ACTIONS.RemoveAllTracksFromQueue, method: 'clearQueue' },
    ] as const;
    for (const { action, method } of simpleCases) {
      it(`${method} invokes ${action.split('#')[1] ?? action}`, async () => {
        const { player, soap } = createTestPlayer();
        await player[method]();
        assert.deepEqual(soap.callArgs(0), [AV, action, undefined]);
      });
    }

    it('refreshShareIndex targets the content directory', async () => {
      const { player, soap } = createTestPlayer();
      await player.refreshShareIndex();
      assert.deepEqual(soap.callArgs(0), [CD, SOAP_ACTIONS.RefreshShareIndex, undefined]);
    });

    const volumeCases: Array<[number | string, number]> = [
      [10, 10],
      ['10', 10],
      ['+1', 6],
      ['-1', 4],
      ['-9', 0],
      [150, 100],
    ];
    for (const [input, expected] of volumeCases) {
      it(`setVolume(${String(input)}) from 5 sets ${expected}`, async () => {
        const { player, soap } = createTestPlayer();
        await player.handleLastChange({ volume: [{ channel: 'Master', val: '5' }] });

        await player.setVolume(input);

        assert.equal(player.state.volume, expected);
        assert.deepEqual(soap.callArgs(0), [RC, SOAP_ACTIONS.Volume, { volume: expected }]);
      });
    }

    it('setVolume is a no-op when the output is fixed', async () => {
      const { player, soap } = createTestPlayer();
      player.outputFixed = true;

      await player.setVolume(10);

      assert.equal(soap.calls.length, 0);
    });

    it('mute / unMute / group mute', async () => {
      const { player, soap } = createTestPlayer();
      await player.mute();
      await player.unMute();
      await player.muteGroup();
      await player.unMuteGroup();

      assert.deepEqual(soap.callArgs(0), [RC, SOAP_ACTIONS.Mute, { mute: 1 }]);
      assert.deepEqual(soap.callArgs(1), [RC, SOAP_ACTIONS.Mute, { mute: 0 }]);
      assert.deepEqual(soap.callArgs(2), [GRC, SOAP_ACTIONS.GroupMute, { mute: 1 }]);
      assert.deepEqual(soap.callArgs(3), [GRC, SOAP_ACTIONS.GroupMute, { mute: 0 }]);
    });

    it('seeks by time and by track', async () => {
      const { player, soap } = createTestPlayer();
      await player.timeSeek(120);
      await player.trackSeek(12);

      assert.deepEqual(soap.callArgs(0), [
        AV,
        SOAP_ACTIONS.Seek,
        { unit: 'REL_TIME', value: '00:02:00' },
      ]);
      assert.deepEqual(soap.callArgs(1), [AV, SOAP_ACTIONS.Seek, { unit: 'TRACK_NR', value: 12 }]);
    });

    it('queue editing commands', async () => {
      const { player, soap } = createTestPlayer();
      await player.removeTrackFromQueue(13);
      await player.removeTrackRangeFromQueue(2, 3);
      await player.reorderTracksInQueue(4, 1, 2);
      await player.saveQueue('Dinner & <Friends>');

      assert.deepEqual(soap.callArgs(0), [AV, SOAP_ACTIONS.RemoveTrackFromQueue, { track: 13 }]);
      assert.deepEqual(soap.callArgs(1), [
        AV,
        SOAP_ACTIONS.RemoveTrackRangeFromQueue,
        { startIndex: 2, numberOfTracks: 3 },
      ]);
      assert.deepEqual(soap.callArgs(2), [
        AV,
        SOAP_ACTIONS.ReorderTracksInQueue,
        { startIndex: 4, numberOfTracks: 1, insertBefore: 2 },
      ]);
      assert.deepEqual(soap.callArgs(3), [
        AV,
        SOAP_ACTIONS.SaveQueue,
        { title: 'Dinner &amp; &lt;Friends&gt;' },
      ]);
    });

    it('setBass / setTreble', async () => {
      const { player, soap } = createTestPlayer();
      await player.setBass(2);
      await player.setTreble(-2);

      assert.deepEqual(soap.callArgs(0), [RC, SOAP_ACTIONS.SetBass, { level: 2 }]);
      assert.deepEqual(soap.callArgs(1), [RC, SOAP_ACTIONS.SetTreble, { level: -2 }]);
    });

    describe('play mode', () => {
      async function playerWithPlayMode(currentPlayMode: string) {
        const created = createTestPlayer();
        const data = lastChange('avtransportlastchange.json');
        data.avtransporturi = { val: 'x-rincon:RINCON_OTHER' }; // grouped: skips position lookup
        data.currentplaymode = { val: currentPlayMode };
        await created.player.handleLastChange(data);
        return created;
      }

      it('repeat with no other state', async () => {
        const { player, soap } = createTestPlayer();
        await player.repeat(true);
        assert.deepEqual(soap.callArgs(0), [
          AV,
          SOAP_ACTIONS.SetPlayMode,
          { playMode: 'REPEAT_ALL' },
        ]);
        assert.equal(soap.calls.length, 1);
      });

      it('repeat keeps shuffle on', async () => {
        const { player, soap } = await playerWithPlayMode('SHUFFLE_NOREPEAT');

        await player.repeat(true);

        assert.deepEqual(soap.callArgs(0), [AV, SOAP_ACTIONS.SetPlayMode, { playMode: 'SHUFFLE' }]);
      });

      it('shuffle on with no other state', async () => {
        const { player, soap } = createTestPlayer();
        await player.shuffle(true);
        assert.deepEqual(soap.callArgs(0), [
          AV,
          SOAP_ACTIONS.SetPlayMode,
          { playMode: 'SHUFFLE_NOREPEAT' },
        ]);
      });

      it('shuffle keeps repeat all', async () => {
        const { player, soap } = await playerWithPlayMode('REPEAT_ALL');

        await player.shuffle(true);

        assert.deepEqual(soap.callArgs(0), [AV, SOAP_ACTIONS.SetPlayMode, { playMode: 'SHUFFLE' }]);
      });

      it('repeat accepts explicit modes', async () => {
        const { player, soap } = createTestPlayer();
        await player.repeat(REPEAT_MODE.ONE);
        assert.deepEqual(soap.callArgs(0), [
          AV,
          SOAP_ACTIONS.SetPlayMode,
          { playMode: 'REPEAT_ONE' },
        ]);
      });

      it('crossfade on and off', async () => {
        const { player, soap } = createTestPlayer();
        await player.crossfade(true);
        await player.crossfade(false);
        assert.deepEqual(soap.callArgs(0), [
          AV,
          SOAP_ACTIONS.SetCrossfadeMode,
          { crossfadeMode: 1 },
        ]);
        assert.deepEqual(soap.callArgs(1), [
          AV,
          SOAP_ACTIONS.SetCrossfadeMode,
          { crossfadeMode: 0 },
        ]);
      });

      it('still sets crossfade when the play mode call fails', async () => {
        const { player, soap } = createTestPlayer();
        soap.queueFailure(new Error('radio station'));

        await player.setPlayMode({ repeat: REPEAT_MODE.NONE, crossfade: true });

        assert.equal(soap.calls.length, 2);
        assert.equal(soap.calls[1]?.action, SOAP_ACTIONS.SetCrossfadeMode);
      });
    });

    it('sleep formats the duration and clears with 0', async () => {
      const { player, soap } = createTestPlayer();
      await player.sleep(120);
      await player.sleep(0);

      assert.deepEqual(soap.callArgs(0), [
        AV,
        SOAP_ACTIONS.ConfigureSleepTimer,
        { time: '00:02:00' },
      ]);
      assert.deepEqual(soap.callArgs(1), [AV, SOAP_ACTIONS.ConfigureSleepTimer, { time: '' }]);
    });

    it('setAVTransport encodes entities and remembers the uri', async () => {
      const { player, soap } = createTestPlayer();
      await player.setAVTransport('x-rincon:RINCON_00000000000001400', '<DIDL-Lite></DIDL-Lite>');
      await player.setAVTransport('x-rincon:RINCON_00000000000001400');

      assert.deepEqual(soap.callArgs(0), [
        AV,
        SOAP_ACTIONS.SetAVTransportURI,
        {
          uri: 'x-rincon:RINCON_00000000000001400',
          metadata: '&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;',
        },
      ]);
      assert.deepEqual(soap.callArgs(1), [
        AV,
        SOAP_ACTIONS.SetAVTransportURI,
        { uri: 'x-rincon:RINCON_00000000000001400', metadata: '' },
      ]);
      assert.equal(player.avTransportUri, 'x-rincon:RINCON_00000000000001400');
      assert.equal(player.avTransportUriMetadata, '');
    });

    it('addURIToQueue encodes and parses the response', async () => {
      const { player, soap } = createTestPlayer();
      soap.queueResponse(createReadStream(fixturePath('addURIToQueue.xml')));

      const result = await player.addURIToQueue(
        'x-rincon:RINCON_00000000000001400',
        '<DIDL-Lite></DIDL-Lite>',
      );

      assert.deepEqual(result, {
        firsttracknumberenqueued: '1',
        newqueuelength: '1',
        numtracksadded: '1',
      });
      assert.deepEqual(soap.callArgs(0), [
        AV,
        SOAP_ACTIONS.AddURIToQueue,
        {
          uri: 'x-rincon:RINCON_00000000000001400',
          metadata: '&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;',
          enqueueAsNext: 0,
          desiredFirstTrackNumberEnqueued: 0,
        },
      ]);
    });

    it('addMultipleURIsToQueue joins encoded uris and metadata', async () => {
      const { player, soap } = createTestPlayer();

      await player.addMultipleURIsToQueue([['a&b', '<m>'], ['c']], 'container', undefined, true);

      assert.deepEqual(soap.callArgs(0), [
        AV,
        SOAP_ACTIONS.AddMultipleURIsToQueue,
        {
          amount: 2,
          uris: 'a&amp;b c',
          metadatas: '&lt;m&gt; ',
          containerURI: 'container',
          containerMetadata: '',
          desiredFirstTrackNumberEnqueued: 0,
          enqueueAsNext: 1,
        },
      ]);
    });

    it('subwoofer commands validate their ranges', async () => {
      const { player, soap } = createTestPlayer();
      await player.subEnable();
      await player.subDisable();
      await player.subGain(-3);
      await player.subCrossover(90);
      await player.subPolarity(1);
      await player.subPolarity(5);
      await assert.rejects(player.subGain(16), RangeError);
      await assert.rejects(player.subCrossover(30), RangeError);

      const setEq = (eqType: string, value: number) => [RC, SOAP_ACTIONS.SetEQ, { eqType, value }];
      assert.deepEqual(soap.callArgs(0), setEq('SubEnable', 1));
      assert.deepEqual(soap.callArgs(1), setEq('SubEnable', 0));
      assert.deepEqual(soap.callArgs(2), setEq('SubGain', -3));
      assert.deepEqual(soap.callArgs(3), setEq('SubCrossover', 90));
      assert.deepEqual(soap.callArgs(4), setEq('SubPolarity', 1));
      assert.deepEqual(soap.callArgs(5), setEq('SubPolarity', 0));
      assert.equal(soap.calls.length, 6);
    });

    it('nightMode and speechEnhancement use SetEQ', async () => {
      const { player, soap } = createTestPlayer();
      await player.nightMode(true);
      await player.nightMode(false);
      await player.speechEnhancement(true);

      assert.deepEqual(soap.callArgs(0), [
        RC,
        SOAP_ACTIONS.SetEQ,
        { eqType: 'NightMode', value: '1' },
      ]);
      assert.deepEqual(soap.callArgs(1), [
        RC,
        SOAP_ACTIONS.SetEQ,
        { eqType: 'NightMode', value: '0' },
      ]);
      assert.deepEqual(soap.callArgs(2), [
        RC,
        SOAP_ACTIONS.SetEQ,
        { eqType: 'DialogLevel', value: '1' },
      ]);
    });
  });

  describe('browsing', () => {
    it('getQueue without arguments browses everything', async () => {
      const { player, soap } = createTestPlayer();
      soap.queueResponse(createReadStream(fixturePath('queue.xml')));

      const queue = await player.getQueue();

      assert.equal(soap.calls.length, 1);
      assert.deepEqual(soap.calls[0]?.values, { objectId: 'Q:0', startIndex: 0, limit: 0 });
      assert.ok(queue.length > 0);
      assert.deepEqual(queue[0], {
        uri: 'x-sonos-spotify:spotify%3atrack%3a2uAWmcvujYUNTPCIb2VYKH?sid=9&flags=8224&sn=2',
        artist: 'Deftones',
        metadata: undefined,
        albumTrackNumber: undefined,
        title: 'Prayers/Triangles',
        album: 'Prayers/Triangles',
        albumArtUri:
          '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a2uAWmcvujYUNTPCIb2VYKH%3fsid%3d9%26flags%3d8224%26sn%3d2',
      });
    });

    it('getQueue with limit and offset browses one page', async () => {
      const { player, soap } = createTestPlayer();
      soap.queueResponse(createReadStream(fixturePath('queue.xml')));
      await player.getQueue(10, 100);
      assert.deepEqual(soap.calls[0]?.values, { objectId: 'Q:0', startIndex: 100, limit: 10 });

      soap.queueResponse(createReadStream(fixturePath('queue.xml')));
      await player.getQueue(10);
      assert.deepEqual(soap.calls[1]?.values, { objectId: 'Q:0', startIndex: 0, limit: 10 });
    });

    it('browse parses playlists with container album art arrays', async () => {
      const { player, soap } = createTestPlayer();
      soap.queueResponse(createReadStream(fixturePath('playlists.xml')));

      const result = await player.browse('SQ:');

      assert.equal(result.startIndex, 0);
      assert.equal(result.numberReturned, 2);
      assert.equal(result.totalMatches, 2);
      assert.deepEqual(result.items[0], {
        uri: 'file:///jffs/settings/savedqueues.rsq#2',
        title: 'Morgon',
        artist: undefined,
        albumArtUri: [
          '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a35N1AduT1LDo3deLfYniTY%3fsid%3d9%26flags%3d0',
          '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a1MQYow43CGLYMECVSjTpCM%3fsid%3d9%26flags%3d0',
          '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a4QWMYALvB1m4Um8ytjZR9m%3fsid%3d9%26flags%3d0',
          '/getaa?s=1&u=x-sonos-spotify%3aspotify%253atrack%253a1d62ECx2DlaBmhOLymrVGc%3fsid%3d9%26flags%3d0',
        ],
      });
    });

    it('browseAll pages until every item is collected', async () => {
      const { player, soap } = createTestPlayer();
      const page = (start: number, returned: number, total: number) =>
        Readable.from([
          `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Result>&lt;DIDL-Lite&gt;&lt;item id="${start}"&gt;&lt;dc:title&gt;Track ${start}&lt;/dc:title&gt;&lt;res&gt;uri-${start}&lt;/res&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</Result><NumberReturned>${returned}</NumberReturned><TotalMatches>${total}</TotalMatches></u:BrowseResponse></s:Body></s:Envelope>`,
        ]);
      soap.queueResponse(page(0, 1, 2));
      soap.queueResponse(page(1, 1, 2));

      const items = await player.browseAll('FV:2');

      assert.deepEqual(
        items.map((item) => item.title),
        ['Track 0', 'Track 1'],
      );
      assert.deepEqual(soap.calls[1]?.values, { objectId: 'FV:2', startIndex: 1, limit: 0 });
    });

    it('browseAll rejects an invalid payload instead of looping', async () => {
      const { player } = createTestPlayer();

      await assert.rejects(player.browseAll('SQ:'), /invalid payload/);
    });
  });

  describe('group volume', () => {
    beforeEach(() => {
      mock.timers.enable({ apis: ['setTimeout'] });
    });
    afterEach(() => {
      mock.timers.reset();
    });

    async function groupOfThree() {
      const { system } = createTestPlayer();
      const a = createTestPlayer({ system, roomName: 'A', uuid: 'RINCON_A' }).player;
      const b = createTestPlayer({ system, roomName: 'B', uuid: 'RINCON_B' }).player;
      const c = createTestPlayer({ system, roomName: 'C', uuid: 'RINCON_C' }).player;
      const members = [a, b, c] as const;
      const volumes = [15, 20, 30];
      for (const [index, member] of members.entries()) {
        await member.handleLastChange({
          volume: [{ channel: 'Master', val: String(volumes[index]) }],
        });
      }
      const coordinator = createTestPlayer({
        system,
        roomName: 'Coordinator',
        uuid: '123456789',
      }).player;
      system.zones.push({
        uuid: '123456789',
        id: '123456789:1',
        coordinator,
        members: [...members],
      });
      for (const member of members) {
        member.coordinator = coordinator;
      }
      return { system, coordinator, members };
    }

    it('recalculates the group volume and emits group-volume once, debounced', async () => {
      const { system, coordinator } = await groupOfThree();
      const groupVolume = mock.fn();
      coordinator.on('group-volume', groupVolume);
      coordinator.groupState.volume = 10;

      coordinator.recalculateGroupVolume();
      coordinator.recalculateGroupVolume();
      assert.equal(coordinator.groupState.volume, 22);
      assert.equal(groupVolume.mock.callCount(), 0);

      mock.timers.tick(100);

      assert.equal(groupVolume.mock.callCount(), 1);
      assert.deepEqual(groupVolume.mock.calls[0]?.arguments[0], {
        uuid: '123456789',
        oldVolume: 10,
        newVolume: 22,
        roomName: 'Coordinator',
      });
      assert.equal(system.eventsOf('group-volume').length, 1);
    });

    it('ignores fixed-output members and zones it does not coordinate', async () => {
      const { coordinator, members } = await groupOfThree();
      coordinator.groupState.volume = 10;
      for (const member of members) {
        member.outputFixed = true;
      }

      coordinator.recalculateGroupVolume();
      members[0].recalculateGroupVolume();

      assert.equal(coordinator.groupState.volume, 10);
    });

    it('sets a fixed group volume proportionally', async () => {
      const { coordinator, members } = await groupOfThree();
      coordinator.groupState.volume = 22;

      await coordinator.setGroupVolume(10);

      assert.deepEqual(
        members.map((member) => member.state.volume),
        [7, 10, 14],
      );
      assert.equal(coordinator.groupState.volume, 10);
    });

    it('applies a negative relative group volume proportionally', async () => {
      const { coordinator, members } = await groupOfThree();
      coordinator.groupState.volume = 22;

      await coordinator.setGroupVolume('-5');

      assert.deepEqual(
        members.map((member) => member.state.volume),
        [12, 16, 24],
      );
      assert.equal(coordinator.groupState.volume, 17);
    });

    it('applies a positive relative group volume as a delta', async () => {
      const { coordinator, members } = await groupOfThree();
      coordinator.groupState.volume = 22;

      await coordinator.setGroupVolume('+5');

      assert.deepEqual(
        members.map((member) => member.state.volume),
        [20, 25, 35],
      );
      assert.equal(coordinator.groupState.volume, 27);
    });

    it('mutes everyone when the target is below 1', async () => {
      const { coordinator, members } = await groupOfThree();
      coordinator.groupState.volume = 22;

      await coordinator.setGroupVolume(0);

      assert.deepEqual(
        members.map((member) => member.state.volume),
        [0, 0, 0],
      );
    });

    it('rejects when the player is not a coordinator', async () => {
      const { members } = await groupOfThree();

      await assert.rejects(members[0].setGroupVolume(10), /not the coordinator/);
    });
  });

  describe('replaceWithFavorite', () => {
    const streamingFavorite = {
      title: 'A soundtrack for coding',
      uri: 'x-rincon-cpcontainer:1006006cspotify%3auser%3amill%3aplaylist%3a4mxd3BBHjZ4gBlBnbusntN',
      albumArtUri: 'http://spotify-static-resources.s3.amazonaws.com/img/playlist_default.png',
      metadata:
        '<DIDL-Lite><item id="1006006c"><dc:title>A soundtrack for coding</dc:title></item></DIDL-Lite>',
    };
    const radioFavorite = {
      title: 'Metropol 93,8',
      uri: 'x-sonosapi-stream:s20308?sid=254&flags=32',
      albumArtUri: 'http://d1i6vahw24eb07.cloudfront.net/s20308q.gif',
      metadata:
        '<DIDL-Lite><item id="F00090020s20308"><dc:title>Metropol 93,8</dc:title></item></DIDL-Lite>',
    };

    it('queues a streaming favorite and switches to the queue', async () => {
      const { player, soap, system } = createTestPlayer();
      system.favorites = [streamingFavorite, radioFavorite];
      soap.queueResponse(Readable.from([])); // RemoveAllTracksFromQueue
      soap.queueResponse(createReadStream(fixturePath('addURIToQueue.xml'))); // AddURIToQueue

      await player.replaceWithFavorite('a SOUNDTRACK for coding');

      assert.equal(system.getFavorites.mock.callCount(), 1);
      assert.deepEqual(
        soap.calls.map((call) => call.action),
        [
          SOAP_ACTIONS.RemoveAllTracksFromQueue,
          SOAP_ACTIONS.AddURIToQueue,
          SOAP_ACTIONS.SetAVTransportURI,
        ],
      );
      assert.equal(soap.calls[1]?.values?.uri, streamingFavorite.uri);
      assert.equal(soap.calls[2]?.values?.uri, 'x-rincon-queue:RINCON_00000000000001400#0');
      assert.equal(soap.calls[2]?.values?.metadata, '');
    });

    it('plays a radio favorite directly with its metadata', async () => {
      const { player, soap, system } = createTestPlayer();
      system.favorites = [radioFavorite];

      await player.replaceWithFavorite(radioFavorite.uri);

      assert.equal(soap.calls.length, 1);
      assert.equal(soap.calls[0]?.action, SOAP_ACTIONS.SetAVTransportURI);
      assert.equal(soap.calls[0]?.values?.uri, 'x-sonosapi-stream:s20308?sid=254&amp;flags=32');
      assert.ok(String(soap.calls[0]?.values?.metadata).startsWith('&lt;DIDL-Lite'));
      assert.equal(player.avTransportUri, radioFavorite.uri, 'remembered unencoded');
    });

    it('skips SetAVTransport when the favorite is already playing', async () => {
      const { player, soap, system } = createTestPlayer();
      system.favorites = [radioFavorite];
      await player.setAVTransport(radioFavorite.uri, radioFavorite.metadata);
      soap.calls.length = 0;

      await player.replaceWithFavorite(radioFavorite.title);

      assert.equal(soap.calls.length, 0);
    });

    it('rejects when the favorite is not found', async () => {
      const { player, system } = createTestPlayer();
      system.favorites = [];

      await assert.rejects(player.replaceWithFavorite('some favorite'), /Favorite not found/);
    });
  });

  describe('replaceWithPlaylist', () => {
    it('queues the playlist and plays the queue', async () => {
      const { player, soap, system } = createTestPlayer();
      system.playlists = [{ title: 'Morgon', uri: 'file:///jffs/settings/savedqueues.rsq#2' }];
      soap.queueResponse(Readable.from([])); // RemoveAllTracksFromQueue
      soap.queueResponse(createReadStream(fixturePath('addURIToQueue.xml'))); // AddURIToQueue

      await player.replaceWithPlaylist('morgon');

      assert.deepEqual(
        soap.calls.map((call) => call.action),
        [
          SOAP_ACTIONS.RemoveAllTracksFromQueue,
          SOAP_ACTIONS.AddURIToQueue,
          SOAP_ACTIONS.SetAVTransportURI,
        ],
      );
      assert.equal(soap.calls[1]?.values?.uri, 'file:///jffs/settings/savedqueues.rsq#2');
      assert.equal(soap.calls[2]?.values?.uri, 'x-rincon-queue:RINCON_00000000000001400#0');
    });

    it('rejects when the playlist is not found', async () => {
      const { player } = createTestPlayer();

      await assert.rejects(player.replaceWithPlaylist('nope'), /Playlist not found/);
    });
  });

  it('serializes to JSON through the coordinator', () => {
    const { player } = createTestPlayer();
    player.groupState.volume = 3;

    const json = player.toJSON();

    assert.equal(json.uuid, 'RINCON_00000000000001400');
    assert.equal(json.coordinator, 'RINCON_00000000000001400');
    assert.equal(json.roomName, 'Kitchen');
    assert.deepEqual(json.groupState, { volume: 3, mute: false });
    assert.equal((json.state as { playbackState: string }).playbackState, 'STOPPED');
  });

  it('debugSnapshot returns an independent copy of the internal state', async () => {
    const { player } = createTestPlayer();
    await player.handleLastChange({ volume: [{ channel: 'Master', val: '9' }] });

    const snapshot = player.debugSnapshot();
    snapshot.volume = 50;

    assert.equal(player.state.volume, 9);
    assert.equal(snapshot.relTime, 0);
  });
});
