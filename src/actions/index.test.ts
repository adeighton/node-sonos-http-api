import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createActionRegistry } from './index.ts';

/** The action names of the original API (from lib/actions), minus the retired providers. */
const LEGACY_NAMES = [
  'add',
  'bass',
  'bbcsounds',
  'clearqueue',
  'crossfade',
  'debug',
  'favorite',
  'favorites',
  'favourite',
  'favourites',
  'groupmute',
  'groupunmute',
  'groupvolume',
  'isolate',
  'join',
  'leave',
  'linein',
  'lockvolumes',
  'mute',
  'mutegroup',
  'next',
  'nightmode',
  'pause',
  'pauseall',
  'play',
  'playlist',
  'playlists',
  'playpause',
  'preset',
  'previous',
  'queue',
  'reindex',
  'repeat',
  'resumeall',
  'seek',
  'services',
  'setavtransporturi',
  'shuffle',
  'sleep',
  'speechenhancement',
  'state',
  'sub',
  'timeseek',
  'togglemute',
  'trackseek',
  'treble',
  'tunein',
  'ungroup',
  'unlockvolumes',
  'unmute',
  'unmutegroup',
  'volume',
  'zones',
];

describe('createActionRegistry', () => {
  it('registers every legacy action name ported so far', () => {
    const registry = createActionRegistry();
    const names = registry.names();

    for (const name of LEGACY_NAMES) {
      assert.ok(names.includes(name), `${name} is registered`);
    }
    for (const entry of registry.list()) {
      assert.ok(entry.meta.usage.startsWith('/'), `${entry.name} has a usage line`);
      assert.ok(entry.meta.description.length > 0, `${entry.name} has a description`);
    }
  });
});
