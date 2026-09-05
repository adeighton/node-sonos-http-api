import type { ConfigError } from '../config/errors.ts';
import { BadRequestError, NotFoundError } from '../http/errors.ts';
import { parsePreset } from '../presets/types.ts';
import type { Preset } from '../presets/types.ts';
import type { Action, ActionRegistry } from './registry.ts';

/** Resolves `/preset/{name}` or an inline `/preset/{json}` value to a preset. */
export function resolvePreset(
  context: { presets: { get(name: string): Preset | undefined; names(): string[] } },
  value: string,
): Preset {
  if (value.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new BadRequestError(`Inline preset is not valid JSON: ${(error as Error).message}`);
    }

    try {
      return parsePreset(parsed, 'inline preset');
    } catch (error) {
      throw new BadRequestError((error as ConfigError).message, { cause: error });
    }
  }

  const preset = context.presets.get(value);
  if (!preset) {
    throw new NotFoundError(
      `No preset named '${value}'. Available presets: ${context.presets.names().join(', ') || '(none)'}`,
    );
  }

  return preset;
}

/** `/preset` lists the presets; `/preset/{name|json}` applies one. */
const preset: Action = async ({ system, presets }, values) => {
  const value = values[0];
  if (value === undefined || value === '') {
    return presets.names();
  }

  await system.applyPreset(resolvePreset({ presets }, value));
};

export function registerPresetActions(registry: ActionRegistry): void {
  registry.register('preset', preset, {
    usage: '/preset/{name|json}',
    description:
      'Apply a preset from the presets folder (or an inline JSON preset); without a value, list the preset names.',
  });
}
