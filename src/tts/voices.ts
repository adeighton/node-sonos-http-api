/**
 * The Polly voices, from one DescribeVoices call cached for a day: which engines each supports,
 * so a voice/engine mismatch is a clear 400 instead of a synthesis failure, and the whole list,
 * so a client can offer the voices that exist rather than a free-text field (see GET /voices).
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

/** One Polly voice, as `DescribeVoices` describes it. */
export interface PollyVoice {
  id: string;
  gender: string;
  language: string;
  languageName: string;
  engines: string[];
}

const DAY_MS = 86_400_000;

export class VoiceCatalog {
  readonly #client: PollyClientLike;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #logger: Logger;
  #voices: Map<string, PollyVoice> | undefined;
  #fetchedAt = 0;
  #loading: Promise<Map<string, PollyVoice> | undefined> | undefined;

  constructor(options: VoiceCatalogOptions) {
    this.#client = options.client;
    this.#ttlMs = options.ttlMs ?? DAY_MS;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? silentLogger;
  }

  /** Whether `voice` can be synthesized with `engine`; `unknown` when Polly could not be asked. */
  async supports(voice: string, engine: string): Promise<VoiceSupport> {
    const voices = await this.#load();
    if (!voices) {
      return 'unknown';
    }

    return voices.get(voice)?.engines.includes(engine) ? 'yes' : 'no';
  }

  /** The engines of `voice`, empty when unknown. */
  async enginesFor(voice: string): Promise<string[]> {
    return [...((await this.#load())?.get(voice)?.engines ?? [])];
  }

  /** Every voice Polly offers; empty when the list could not be fetched. */
  async list(): Promise<PollyVoice[]> {
    return [...((await this.#load())?.values() ?? [])];
  }

  #load(): Promise<Map<string, PollyVoice> | undefined> {
    if (this.#voices && this.#now() - this.#fetchedAt < this.#ttlMs) {
      return Promise.resolve(this.#voices);
    }

    this.#loading ??= this.#fetch().finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  async #fetch(): Promise<Map<string, PollyVoice> | undefined> {
    try {
      const response = await this.#client.send(new DescribeVoicesCommand({}));
      const voices = new Map<string, PollyVoice>();
      for (const voice of response.Voices ?? []) {
        if (voice.Id) {
          voices.set(voice.Id, {
            id: voice.Id,
            gender: voice.Gender ?? 'Unknown',
            language: voice.LanguageCode ?? '',
            languageName: voice.LanguageName ?? '',
            engines: [...(voice.SupportedEngines ?? [])],
          });
        }
      }

      if (voices.size === 0) {
        // Polly always has voices; an empty answer means we should not judge anything by it.
        this.#logger.warn('Polly listed no voices; skipping the engine check');
        return undefined;
      }

      this.#voices = voices;
      this.#fetchedAt = this.#now();
      return voices;
    } catch (error) {
      this.#logger.warn({ err: error }, 'could not list Polly voices; skipping the engine check');
      return undefined;
    }
  }
}
