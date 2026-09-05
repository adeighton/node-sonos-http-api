/**
 * Lets pending promise callbacks run. Useful with `mock.timers`: ticking a fake timer runs the
 * timer callback synchronously, but any `await` inside it needs the microtask queue drained
 * before the next assertion. Uses setImmediate, which mock.timers leaves untouched unless asked.
 */
export async function flushPromises(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
