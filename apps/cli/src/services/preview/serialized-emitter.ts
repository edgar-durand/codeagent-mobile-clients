/**
 * Orders a stream of fire-and-forget event POSTs.
 *
 * Same shape and purpose as `makeSerializedBatonPoster` (`baton/wire-baton.ts`)
 * — kept as its own module rather than imported from `baton/` because the baton
 * is local-session-only and preview runs everywhere; coupling the two would put
 * a local-only module on the codespace path for no reason.
 *
 * Why preview needs it: the backend does a `findActiveSessionByPlugin` lookup
 * per event with variable latency, so two POSTs fired concurrently can be
 * handled — and republished on the SSE bus — in the wrong order. Preview emits
 * events back-to-back (the reuse guard sends a `READY_DETECTED` progress
 * immediately before `preview_ready`), and a progress handled AFTER the ready
 * used to DELETE the `preview:<sessionId>` reconnect snapshot the ready had
 * just written — the user reopened the session to an empty state while their
 * preview was still serving.
 *
 * A rejected POST is swallowed so one failure can't break the chain for every
 * later event: these are best-effort lifecycle notifications, and dropping the
 * rest of a preview's events would be strictly worse than dropping one.
 */
export function makeSerializedEmitter<A>(
  post: (args: A) => Promise<unknown>,
): (args: A) => void {
  let chain: Promise<void> = Promise.resolve();
  return (args: A): void => {
    chain = chain.then(() => post(args)).then(
      () => undefined,
      () => undefined,
    );
    void chain;
  };
}
