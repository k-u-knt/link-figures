/**
 * Lets the event loop run (a macrotask), so long work does not freeze the window. A MessageChannel message, not
 * `setTimeout(0)` or `requestAnimationFrame`: a hidden or background window throttles timers (to once a second, and
 * once a minute after a while) and runs no animation frames at all, which would stretch an export to minutes or stall
 * it until the window is shown; messages are not throttled. `setTimeout(0)` where there is no MessageChannel.
 */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel !== "function") return new Promise<void>((resolve) => setTimeout(resolve, 0));
  return new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      port2.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

/** Whether `promise` settles (either way) within `ms`; resolves false once `ms` has passed without it. */
export function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}
