/** A generated (or cached) clip that players can fetch from this server. */
export interface Clip {
  /** Path on this server, e.g. `/tts/polly-abc.mp3`. */
  uri: string;
  durationMs: number;
  /** Whether the clip already existed on disk. */
  cached?: boolean;
  /** Time spent synthesizing, in milliseconds; 0 for a cached clip. */
  synthMs?: number;
  /** How many pieces the text was synthesized in. */
  chunks?: number;
}

export interface TtsRequest {
  phrase: string;
  /** Provider-specific voice id; the provider's default when omitted. */
  voice?: string | undefined;
  /** Provider-specific engine name; the provider's default when omitted. */
  engine?: string | undefined;
  /** Abandons the synthesis (e.g. the request was cancelled). */
  signal?: AbortSignal | undefined;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(request: TtsRequest): Promise<Clip>;
}
