import { z } from 'zod';

import { POLLY_ENGINES } from '../config/schema.ts';
import { BadRequestError } from './errors.ts';

const volume = z.number().int().min(0).max(100);

const room = z.object({ name: z.string().min(1), volume: volume.optional() });

/** Rooms may be plain names or `{ name, volume }`; the first one leads the group. */
const rooms = z.array(z.union([z.string().min(1), room])).min(1);

const target = z.union([
  z.literal('all'),
  z.object({ preset: z.string().min(1) }),
  z.object({ rooms }),
  rooms,
]);

const speech = {
  /** Plain text, read as given (escaped for SSML, paragraphs become pauses). */
  text: z.string().min(1).max(20_000).optional(),
  /** A complete `<speak>` document. */
  ssml: z.string().min(1).max(20_000).optional(),
  voice: z.string().min(1).optional(),
  engine: z.enum(POLLY_ENGINES).optional(),
};

/** `POST /announce` */
export const announceBodySchema = z
  .object({
    ...speech,
    /** A file name in the clips folder, instead of speech. */
    clip: z.string().min(1).optional(),
    target,
    volume: volume.optional(),
    priority: z.enum(['normal', 'urgent']).default('normal'),
    pauseOthers: z.boolean().optional(),
    /** Answer when the rooms are restored (200 with the result) instead of at once (202). */
    wait: z.boolean().default(false),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .refine((body) => [body.text, body.ssml, body.clip].filter((v) => v !== undefined).length === 1, {
    message: 'Give exactly one of text, ssml or clip',
  });

export type AnnounceBody = z.infer<typeof announceBodySchema>;
export type AnnounceTargetBody = AnnounceBody['target'];

/** `GET /announce?limit=&state=` */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  state: z
    .enum([
      'queued',
      'starting',
      'playing',
      'interrupted',
      'restoring',
      'done',
      'failed',
      'cancelled',
    ])
    .optional(),
});

/** `POST /tts` */
export const ttsBodySchema = z
  .object(speech)
  .refine((body) => (body.text === undefined) !== (body.ssml === undefined), {
    message: 'Give exactly one of text or ssml',
  });

export type TtsBody = z.infer<typeof ttsBodySchema>;

/** Validates a parsed JSON body, turning zod issues into one readable 400. */
export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const problems = result.error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message,
  );
  throw new BadRequestError(`Invalid request body: ${problems.join('; ')}`);
}

/** Rooms in the order given, names normalized to `{ name, volume? }`. */
export function roomsOf(body: AnnounceTargetBody): Array<z.infer<typeof room>> | undefined {
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && 'rooms' in body
      ? body.rooms
      : undefined;
  return list?.map((entry) => (typeof entry === 'string' ? { name: entry } : entry));
}
