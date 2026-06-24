/**
 * Await `p`, but give up after `ms`. Resolves with the value when it
 * settles in time, or `undefined` on timeout / rejection. Never throws
 * — used to bound a best-effort flush on shutdown so a wedged POST can
 * never hang process teardown.
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}
