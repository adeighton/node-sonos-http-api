/**
 * Which engines each Polly voice supports, from one DescribeVoices call cached for a day, so a
 * voice/engine mismatch is a clear 400 instead of a synthesis failure.
 */
import { DescribeVoicesCommand } from '@aws-sdk/client-polly';

import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';
import type { PollyClientLike } from './polly.ts';

export interface VoiceCatalogOptions {
  client: PollyClientLike;
  /** How long the list is trusted; default one day. */
  ttlMs?: number;
  now?: () => number;
  logger?: Logger;
}

export type VoiceSupport = 'yes' | 'no' | 'unknown';

const DAY_MS = 86_400_000;

export class VoiceCatalog {
  readonly #client: PollyClientLike;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #logger: Logger;
  #engines: Map<string, string[]> | undefined;
  #fetchedAt = 0;
  #loading: Promise<Map<string, string[]> | undefined> | undefined;

  constructor(options: VoiceCatalogOptions) {
    this.#client = options.client;
    this.#ttlMs = options.ttlMs ?? DAY_MS;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? silentLogger;
  }

  /** Whether `voice` can be synthesized with `engine`; `unknown` when Polly could not be asked. */
  async supports(voice: string, engine: string): Promise<VoiceSupport> {
    const engines = await this.#load();
    if (!engines) {
      return 'unknown';
    }

    return engines.get(voice)?.includes(engine) ? 'yes' : 'no';
  }

  /** The engines of `voice`, empty when unknown. */
  async enginesFor(voice: string): Promise<string[]> {
    return [...((await this.#load())?.get(voice) ?? [])];
  }

  #load(): Promise<Map<string, string[]> | undefined> {
    if (this.#engines && this.#now() - this.#fetchedAt < this.#ttlMs) {
      return Promise.resolve(this.#engines);
    }

    this.#loading ??= this.#fetch().finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  async #fetch(): Promise<Map<string, string[]> | undefined> {
    try {
      const response = await this.#client.send(new DescribeVoicesCommand({}));
      const engines = new Map<string, string[]>();
      for (const voice of response.Voices ?? []) {
        if (voice.Id) {
          engines.set(voice.Id, [...(voice.SupportedEngines ?? [])]);
        }
      }

      if (engines.size === 0) {
        // Polly always has voices; an empty answer means we should not judge anything by it.
        this.#logger.warn('Polly listed no voices; skipping the engine check');
        return undefined;
      }

      this.#engines = engines;
      this.#fetchedAt = this.#now();
      return engines;
    } catch (error) {
      this.#logger.warn({ err: error }, 'could not list Polly voices; skipping the engine check');
      return undefined;
    }
  }
}
