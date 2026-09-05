import { z } from 'zod';

import { LOG_LEVELS } from '../logger.ts';

export const POLLY_ENGINES = ['standard', 'neural', 'long-form', 'generative'] as const;
export type PollyEngine = (typeof POLLY_ENGINES)[number];

const port = z.coerce.number().int().min(1).max(65535);

/**
 * Everything the app can be configured with. Values come from settings.json (JSON5) with
 * environment overrides applied on top (see load.ts); unknown top-level keys are dropped with a
 * warning. Secrets are best left out of the file: AWS credentials are read by the AWS SDK from
 * its own environment variables when `aws.credentials` is absent.
 */
export const settingsSchema = z.object({
  port: port.default(5005),
  ip: z.string().min(1).default('0.0.0.0'),
  securePort: port.default(5006),
  https: z
    .object({
      key: z.string().optional(),
      cert: z.string().optional(),
      pfx: z.string().optional(),
      passphrase: z.string().optional(),
    })
    .optional(),
  auth: z
    .object({
      username: z.string().min(1),
      password: z.string().min(1),
    })
    .optional(),
  announceVolume: z.coerce.number().int().min(0).max(100).default(40),
  cacheDir: z.string().min(1).default('cache'),
  webroot: z.string().min(1).default('static'),
  presetDir: z.string().min(1).default('presets'),
  household: z.string().optional(),
  webhook: z.url().optional(),
  webhookType: z.string().min(1).default('type'),
  webhookData: z.string().min(1).default('data'),
  webhookHeaderName: z.string().optional(),
  webhookHeaderContents: z.string().optional(),
  aws: z
    .object({
      credentials: z
        .object({
          region: z.string().optional(),
          accessKeyId: z.string().optional(),
          secretAccessKey: z.string().optional(),
        })
        .optional(),
      /** Legacy name for `voice`, still honoured. */
      name: z.string().optional(),
      voice: z.string().optional(),
      engine: z.enum(POLLY_ENGINES).default('neural'),
    })
    .optional(),
  spotify: z
    .object({
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
    })
    .optional(),
  library: z
    .object({
      randomQueueLimit: z.coerce.number().int().min(1).default(50),
    })
    .default({ randomQueueLimit: 50 }),
  soundcloud: z.string().optional(),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  logFormat: z.enum(['pretty', 'json']).default('pretty'),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsInput = z.input<typeof settingsSchema>;

export const SETTINGS_KEYS: readonly string[] = Object.keys(settingsSchema.shape);
