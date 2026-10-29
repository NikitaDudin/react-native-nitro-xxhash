import createAbortError from './createAbortError';

async function readWithoutAbort(pending: unknown): Promise<{ value: unknown }> {
  return { value: await pending };
}

/** Keep a pending source reaction separate from wait()'s caller and resolvers. */
function observeRead(
  pending: unknown,
  complete: (value: unknown) => void,
  fail: (error: unknown) => void,
): void {
  const observer = (async () => {
    try {
      complete(await pending);
    } catch (error) {
      fail(error);
    }
  })();
  // Hermes can reject an async function before its local catch runs.
  void observer.then(undefined, fail);
}

/** One listener and one pending read, rather than one retained abort race per chunk. */
export default class HashStreamAbort {
  private signal: AbortSignal | undefined;
  private error: Error | undefined;
  private resolvePending: ((result: { value: unknown }) => void) | undefined;
  private rejectPending: ((error: unknown) => void) | undefined;
  private notifyPending: (() => void) | undefined;
  // Prototype bindings avoid retaining constructor arguments in Hermes closures.
  private readonly completeObserver = this.completeRead.bind(this);
  private readonly rejectObserver = this.failRead.bind(this);
  private readonly onAbort = this.abort.bind(this);

  private notifySettled(): void {
    const notify = this.notifyPending;
    this.notifyPending = undefined;
    notify?.();
  }

  private fail(error: unknown): void {
    const reject = this.rejectPending;
    this.resolvePending = undefined;
    this.rejectPending = undefined;
    reject?.(error);
  }

  private completeRead(value: unknown): void {
    this.notifySettled();
    if (!this.resolvePending) return;
    try {
      this.throwIfAborted();
    } catch (error) {
      this.fail(error);
      return;
    }
    const resolve = this.resolvePending;
    this.resolvePending = undefined;
    this.rejectPending = undefined;
    // Box the value so a fulfilled result's later then property is not read.
    resolve?.({ value });
  }

  private failRead(error: unknown): void {
    this.notifySettled();
    this.fail(error);
  }

  private abort(): void {
    if (!this.error && this.signal) this.error = createAbortError(this.signal);
    if (this.error) this.fail(this.error);
  }

  constructor(signal?: AbortSignal) {
    this.signal = signal;
    if (!signal) return;
    if (signal.aborted) throw createAbortError(signal);
    try {
      signal.addEventListener('abort', this.onAbort, { once: true });
      this.throwIfAborted();
    } catch (error) {
      try {
        signal.removeEventListener('abort', this.onAbort);
      } catch {
        // Preserve the original signal/setup failure.
      }
      throw error;
    }
  }

  throwIfAborted(): void {
    if (this.signal?.aborted) this.onAbort();
    if (this.error) throw this.error;
  }

  wait<T>(operation: () => T | PromiseLike<T>, onSettled?: () => void): Promise<{ value: T }>;
  wait(operation: () => unknown, onSettled?: () => void): Promise<{ value: unknown }> {
    // Without cancellation there is no early exit while a read remains pending,
    // so neither detachable resolvers nor a deferred reader-release hook is needed.
    if (this.signal === undefined) return readWithoutAbort(operation());
    this.throwIfAborted();
    return new Promise<{ value: unknown }>((resolve, reject) => {
      this.resolvePending = resolve;
      this.rejectPending = reject;
      this.notifyPending = onSettled;
      let pending: unknown;
      try {
        pending = operation();
      } catch (error) {
        this.failRead(error);
        return;
      }
      observeRead(pending, this.completeObserver, this.rejectObserver);
      try {
        // The source may have aborted synchronously inside read()/next(). Its
        // pending result is already observed, even if cancellation won the race.
        this.throwIfAborted();
      } catch (error) {
        this.fail(error);
      }
    });
  }

  dispose(): void {
    const signal = this.signal;
    this.signal = undefined;
    this.error = undefined;
    this.resolvePending = undefined;
    this.rejectPending = undefined;
    signal?.removeEventListener('abort', this.onAbort);
  }
}
