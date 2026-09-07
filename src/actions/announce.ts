import type { AnnounceTarget, AnnouncementSpec, PreparedClip } from '../announce/types.ts';
import type { Preset } from '../discovery/types.ts';
import { NotFoundError } from '../http/errors.ts';
import { parseInteger, requireValue } from './parse.ts';
import type { Action, ActionContext, ActionRegistry } from './registry.ts';

export interface SayArguments {
  phrase: string;
  voice: string | undefined;
  /** Absent when the request gave none and the caller has no default (a preset's own volumes). */
  volume: number | undefined;
}

function parseVolume(value: string | undefined, fallback: number | undefined): number | undefined {
  return value === undefined || value === ''
    ? fallback
    : parseInteger(value, 'volume', { min: 0, max: 100 });
}

/**
 * `{phrase}[/{volume}]` or `{phrase}/{voice}[/{volume}]`: a numeric second value is the volume,
 * anything else names a voice.
 */
export function parseSayArguments(
  values: string[],
  defaultVolume: number | undefined,
): SayArguments {
  const phrase = requireValue(values[0], 'phrase');
  const second = values[1];
  if (second !== undefined && second !== '' && !/^\d+$/.test(second)) {
    return { phrase, voice: second, volume: parseVolume(values[2], defaultVolume) };
  }

  return { phrase, voice: undefined, volume: parseVolume(second, defaultVolume) };
}

function requirePreset(
  context: ActionContext,
  name: string | undefined,
): { kind: 'preset'; preset: Preset; name: string } {
  const presetName = requireValue(name, 'preset name');
  const preset = context.presets.get(presetName);
  if (!preset) {
    throw new NotFoundError(`No preset named '${presetName}'`);
  }

  return { kind: 'preset', preset, name: presetName };
}

/** The first line of a phrase, shortened, for the history. */
export function textPreview(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function speech(context: ActionContext, args: SayArguments): () => Promise<PreparedClip> {
  return async () => {
    const clip = await context.tts.speak({ phrase: args.phrase, voice: args.voice });
    return {
      uri: `${context.publicBaseUrl}${clip.uri}`,
      durationMs: clip.durationMs,
      cached: clip.cached,
    };
  };
}

/** Looks the clip up now (a missing file is a 404 before any speaker is touched). */
async function clipFile(
  context: ActionContext,
  name: string | undefined,
): Promise<() => Promise<PreparedClip>> {
  const clip = await context.clips.get(requireValue(name, 'clip file name'));
  const prepared = { uri: `${context.publicBaseUrl}${clip.uri}`, durationMs: clip.durationMs };
  return () => Promise.resolve(prepared);
}

/** Submits the announcement and answers once the rooms are restored. */
async function announce(
  context: ActionContext,
  source: string,
  target: AnnounceTarget,
  spec: Pick<AnnouncementSpec, 'prepare' | 'volume' | 'textPreview'>,
): Promise<unknown> {
  const handle = context.announcer.submit({
    ...spec,
    target,
    source,
    requestId: context.requestId,
  });
  return { status: 'success', announcement: await handle.done };
}

/** `/{room}/say/{phrase}[/{voice}][/{volume}]` */
const say: Action = async (context, values) => {
  const args = parseSayArguments(values, context.settings.announceVolume);
  return announce(
    context,
    'say',
    { kind: 'player', player: context.player },
    { prepare: speech(context, args), volume: args.volume, textPreview: textPreview(args.phrase) },
  );
};

/** `/sayall/{phrase}[/{voice}][/{volume}]` */
const sayAll: Action = async (context, values) => {
  const args = parseSayArguments(values, context.settings.announceVolume);
  return announce(
    context,
    'sayall',
    { kind: 'all' },
    { prepare: speech(context, args), volume: args.volume, textPreview: textPreview(args.phrase) },
  );
};

/** `/saypreset/{preset}/{phrase}[/{voice}][/{volume}]`: the preset's volumes unless one is given. */
const sayPreset: Action = async (context, values) => {
  const target = requirePreset(context, values[0]);
  const args = parseSayArguments(values.slice(1), undefined);
  return announce(context, 'saypreset', target, {
    prepare: speech(context, args),
    volume: args.volume,
    textPreview: textPreview(args.phrase),
  });
};

/** `/{room}/clip/{file}[/{volume}]` */
const clip: Action = async (context, values) =>
  announce(
    context,
    'clip',
    { kind: 'player', player: context.player },
    {
      prepare: await clipFile(context, values[0]),
      volume: parseVolume(values[1], context.settings.announceVolume),
      textPreview: values[0],
    },
  );

/** `/clipall/{file}[/{volume}]` */
const clipAll: Action = async (context, values) =>
  announce(
    context,
    'clipall',
    { kind: 'all' },
    {
      prepare: await clipFile(context, values[0]),
      volume: parseVolume(values[1], context.settings.announceVolume),
      textPreview: values[0],
    },
  );

/** `/clippreset/{preset}/{file}[/{volume}]` */
const clipPreset: Action = async (context, values) => {
  const target = requirePreset(context, values[0]);
  return announce(context, 'clippreset', target, {
    prepare: await clipFile(context, values[1]),
    volume: parseVolume(values[2], undefined),
    textPreview: values[1],
  });
};

export function registerAnnounceActions(registry: ActionRegistry): void {
  registry.register('say', say, {
    usage: '/{room}/say/{phrase}[/{voice}][/{volume}]',
    description: 'Speak a phrase in the room, then restore what was playing.',
  });
  registry.register('sayall', sayAll, {
    usage: '/sayall/{phrase}[/{voice}][/{volume}]',
    description: 'Speak a phrase on every player, then restore all groups.',
  });
  registry.register('saypreset', sayPreset, {
    usage: '/saypreset/{preset}/{phrase}[/{voice}][/{volume}]',
    description: 'Speak a phrase on the rooms (and volumes) of a preset, then restore.',
  });
  registry.register('clip', clip, {
    usage: '/{room}/clip/{file}[/{volume}]',
    description: 'Play a clip from the clips folder in the room, then restore what was playing.',
  });
  registry.register('clipall', clipAll, {
    usage: '/clipall/{file}[/{volume}]',
    description: 'Play a clip on every player, then restore all groups.',
  });
  registry.register('clippreset', clipPreset, {
    usage: '/clippreset/{preset}/{file}[/{volume}]',
    description: 'Play a clip on the rooms (and volumes) of a preset, then restore.',
  });
}
