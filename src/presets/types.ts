import { z } from 'zod';

import { ConfigError } from '../config/errors.ts';
import type { Preset } from '../discovery/types.ts';

export type { Preset, PresetPlayer } from '../discovery/types.ts';

const presetPlayerSchema = z.object({
  roomName: z.string().min(1),
  volume: z.union([z.number().int().min(0).max(100), z.string().regex(/^[+-]?\d+$/)]).optional(),
  mute: z.boolean().optional(),
});

/**
 * A preset file. Unknown keys are kept (people park alternative player lists there); `repeat`
 * accepts the documented `all` / `one` / `none` plus booleans for older files.
 */
export const presetSchema = z.looseObject({
  players: z.array(presetPlayerSchema).min(1),
  pauseOthers: z.boolean().optional(),
  playMode: z
    .object({
      repeat: z
        .union([z.enum(['none', 'all', 'one']), z.boolean()])
        .transform((value) => (typeof value === 'boolean' ? (value ? 'all' : 'none') : value))
        .optional(),
      shuffle: z.boolean().optional(),
      crossfade: z.boolean().optional(),
    })
    .optional(),
  uri: z.string().optional(),
  metadata: z.string().optional(),
  favorite: z.string().optional(),
  playlist: z.string().optional(),
  trackNo: z.number().int().min(1).optional(),
  elapsedTime: z.number().min(0).optional(),
  sleep: z.number().min(0).optional(),
  state: z.string().optional(),
});

/** A validated preset plus whatever extra keys the file carried. */
export type ParsedPreset = Preset & Record<string, unknown>;

/** Validates a parsed preset (from a file or an inline JSON request value). */
export function parsePreset(value: unknown, name = 'preset'): ParsedPreset {
  const result = presetSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigError(
      `Invalid ${name}`,
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  return result.data;
}
