/** A generated (or cached) clip that players can fetch from this server. */
export interface Clip {
  /** Path on this server, e.g. `/tts/polly-abc.mp3`. */
  uri: string;
  durationMs: number;
}

export interface TtsRequest {
  phrase: string;
  /** Provider-specific voice id; the provider's default when omitted. */
  voice?: string | undefined;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(request: TtsRequest): Promise<Clip>;
}
