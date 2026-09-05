import type { Preset } from '../discovery/types.ts';
import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { parseInteger, requireValue } from './parse.ts';
import type { Action, ActionContext, ActionRegistry } from './registry.ts';

export interface SayArguments {
  phrase: string;
  voice: string | undefined;
  volume: number;
}

/**
 * `/say/{phrase}[/{volume}]` or `/say/{phrase}/{voice}[/{volume}]`: a numeric second value is
 * the volume, anything else names a voice.
 */
export function parseSayArguments(values: string[], defaultVolume: number): SayArguments {
  const phrase = requireValue(values[0], 'phrase');
  const second = values[1];
  if (second === undefined || second === '') {
    return { phrase, voice: undefined, volume: defaultVolume };
  }

  if (/^\d+$/.test(second)) {
    return {
      phrase,
      voice: undefined,
      volume: parseInteger(second, 'volume', { min: 0, max: 100 }),
    };
  }

  const third = values[2];
  return {
    phrase,
    voice: second,
    volume:
      third === undefined || third === ''
        ? defaultVolume
        : parseInteger(third, 'volume', { min: 0, max: 100 }),
  };
}

async function speak(context: ActionContext, phrase: string, voice: string | undefined) {
  const clip = await context.tts.speak({ phrase, voice });
  return { uri: `${context.publicBaseUrl}${clip.uri}`, durationMs: clip.durationMs };
}

const say: Action = async (context, values) => {
  const args = parseSayArguments(values, context.settings.announceVolume);
  const clip = await speak(context, args.phrase, args.voice);
  await context.announcer.announce(
    { kind: 'player', player: context.player },
    { ...clip, volume: args.volume },
  );
};

const sayAll: Action = async (context, values) => {
  const args = parseSayArguments(values, context.settings.announceVolume);
  const clip = await speak(context, args.phrase, args.voice);
  await context.announcer.announce({ kind: 'all' }, { ...clip, volume: args.volume });
};

function requirePreset(context: ActionContext, name: string | undefined): Preset {
  const presetName = requireValue(name, 'preset name');
  const preset = context.presets.get(presetName);
  if (!preset) {
    throw new NotFoundError(`No preset named '${presetName}'`);
  }

  return preset;
}

/** `/saypreset/{preset}/{phrase}[/{voice}]`: the preset supplies rooms and volumes. */
const sayPreset: Action = async (context, values) => {
  const preset = requirePreset(context, values[0]);
  const phrase = requireValue(values[1], 'phrase');
  const voice = values[2] === undefined || values[2] === '' ? undefined : values[2];
  if (voice !== undefined && /^\d+$/.test(voice)) {
    throw new BadRequestError(
      'saypreset takes rooms and volumes from the preset; the third value is a voice name',
    );
  }

  const clip = await speak(context, phrase, voice);
  await context.announcer.announce({ kind: 'preset', preset }, clip);
};

export function registerSayActions(registry: ActionRegistry): void {
  registry.register('say', say, {
    usage: '/{room}/say/{phrase}[/{voice}][/{volume}]',
    description: 'Speak a phrase in the room, then restore what was playing.',
  });
  registry.register('sayall', sayAll, {
    usage: '/sayall/{phrase}[/{voice}][/{volume}]',
    description: 'Speak a phrase on every player, then restore all groups.',
  });
  registry.register('saypreset', sayPreset, {
    usage: '/saypreset/{preset}/{phrase}[/{voice}]',
    description: 'Speak a phrase on the rooms (and volumes) of a preset, then restore.',
  });
}
