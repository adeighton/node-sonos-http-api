import { silentLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';

export interface WebhookSettings {
  webhook?: string | undefined;
  webhookType: string;
  webhookData: string;
  webhookHeaderName?: string | undefined;
  webhookHeaderContents?: string | undefined;
}

/** The JSON document sent to webhooks and `/events`: `{ [webhookType]: type, [webhookData]: data }`. */
export function buildEventBody(settings: WebhookSettings, type: string, data: unknown): string {
  return JSON.stringify({ [settings.webhookType]: type, [settings.webhookData]: data });
}

export type WebhookNotifier = (body: string) => Promise<void>;

export interface WebhookDeps {
  settings: WebhookSettings;
  fetch?: typeof fetch;
  logger?: Logger;
  timeoutMs?: number;
}

/** POSTs event bodies to the configured webhook; failures are logged, never thrown. */
export function createWebhookNotifier(deps: WebhookDeps): WebhookNotifier | undefined {
  const url = deps.settings.webhook;
  if (!url) {
    return undefined;
  }

  const fetchImpl = deps.fetch ?? fetch;
  const logger = deps.logger ?? silentLogger;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (deps.settings.webhookHeaderName && deps.settings.webhookHeaderContents) {
    headers[deps.settings.webhookHeaderName] = deps.settings.webhookHeaderContents;
  }

  return async (body) => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'webhook answered with an error status');
      }
    } catch (error) {
      logger.warn(
        { err: error, url },
        'could not reach the webhook endpoint; verify that the receiving end is up',
      );
    }
  };
}
