import { NotFoundError } from '../http/errors.ts';
import { parseInteger, requireValue } from './parse.ts';
import type { Action, ActionContext, ActionRegistry } from './registry.ts';

async function resolveClip(context: ActionContext, name: string | undefined) {
  const clip = await context.clips.get(requireValue(name, 'clip file name'));
  return { uri: `${context.publicBaseUrl}${clip.uri}`, durationMs: clip.durationMs };
}

function parseVolume(value: string | undefined, fallback: number): number {
  return value === undefined || value === ''
    ? fallback
    : parseInteger(value, 'volume', { min: 0, max: 100 });
}

/** `/{room}/clip/{file}[/{volume}]` */
const clip: Action = async (context, values) => {
  const resolved = await resolveClip(context, values[0]);
  await context.announcer.announce(
    { kind: 'player', player: context.player },
    { ...resolved, volume: parseVolume(values[1], context.settings.announceVolume) },
  );
};

/** `/clipall/{file}[/{volume}]` */
const clipAll: Action = async (context, values) => {
  const resolved = await resolveClip(context, values[0]);
  await context.announcer.announce(
    { kind: 'all' },
    { ...resolved, volume: parseVolume(values[1], context.settings.announceVolume) },
  );
};

/** `/clippreset/{preset}/{file}` */
const clipPreset: Action = async (context, values) => {
  const presetName = requireValue(values[0], 'preset name');
  const preset = context.presets.get(presetName);
  if (!preset) {
    throw new NotFoundError(`No preset named '${presetName}'`);
  }

  const resolved = await resolveClip(context, values[1]);
  await context.announcer.announce({ kind: 'preset', preset }, resolved);
};

export function registerClipActions(registry: ActionRegistry): void {
  registry.register('clip', clip, {
    usage: '/{room}/clip/{file}[/{volume}]',
    description: 'Play a clip from the clips folder in the room, then restore what was playing.',
  });
  registry.register('clipall', clipAll, {
    usage: '/clipall/{file}[/{volume}]',
    description: 'Play a clip on every player, then restore all groups.',
  });
  registry.register('clippreset', clipPreset, {
    usage: '/clippreset/{preset}/{file}',
    description: 'Play a clip on the rooms (and volumes) of a preset, then restore.',
  });
}
