import type { HashStreamSource } from './HashStreamSource';

const apply = Reflect.apply;

export interface HashSource {
  validate(): void;
  next(): unknown;
  settled?: () => void;
  close(reason: unknown): void;
  release(): void;
}

/** Await only the returned value, without retaining the source operation's closure. */
function observeCleanupValue(pending: unknown, settled?: () => void): void {
  let notified = false;
  const complete = (): void => {
    if (notified) return;
    notified = true;
    settled?.();
  };
  const observer = (async () => {
    try {
      await pending;
    } catch {
      // Cleanup cannot replace the failure which initiated it.
    }
    complete();
  })();
  // Observe engine-level async rejection too, preserving normal cleanup timing.
  void observer.then(undefined, complete);
}

/** Observe cleanup without allowing a hung return()/cancel() to delay rejection. */
function observeCleanup(operation: () => unknown, settled?: () => void): void {
  let pending: unknown;
  try {
    pending = operation();
  } catch {
    settled?.();
    return;
  }
  observeCleanupValue(pending, settled);
}

interface ReaderRelease {
  reader: Record<PropertyKey, unknown> | undefined;
  requested: boolean;
}

function releaseReader(state: ReaderRelease): void {
  state.requested = true;
  const reader = state.reader;
  if (!reader) return;
  const releaseLock = reader.releaseLock;
  if (typeof releaseLock !== 'function') throw new TypeError('Expected reader.releaseLock()');
  const result: unknown = apply(releaseLock, reader, []);
  // Pending read/cancel observers may outlive the released reader indefinitely.
  state.reader = undefined;
  observeCleanupValue(result);
}

function retryReaderRelease(state: ReaderRelease): void {
  if (!state.requested || !state.reader) return;
  try {
    releaseReader(state);
  } catch {
    // A nonstandard reader can retain its lock until a pending read settles.
  }
}

function object(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/** Acquisition is separate from validation so the caller can clean up a bad reader/iterator. */
export default function createHashSource(source: HashStreamSource): HashSource {
  if (!object(source)) throw new TypeError('Expected an AsyncIterable or ReadableStream');
  const sourceObject: Record<PropertyKey, unknown> = source;
  const getReader = sourceObject.getReader;
  if (typeof getReader === 'function') {
    const reader: unknown = apply(getReader, source, []);
    if (!object(reader)) throw new TypeError('Expected a ReadableStream reader');
    const releaseState: ReaderRelease = { reader, requested: false };
    // A bound module function retains only this detachable record, not reader's scope.
    const retryRelease = retryReaderRelease.bind(undefined, releaseState);
    return {
      validate() {
        if (typeof reader.read !== 'function') throw new TypeError('Expected reader.read()');
        if (typeof reader.cancel !== 'function') throw new TypeError('Expected reader.cancel()');
        if (typeof reader.releaseLock !== 'function')
          throw new TypeError('Expected reader.releaseLock()');
      },
      next(): unknown {
        const read = reader.read;
        if (typeof read !== 'function') throw new TypeError('Expected reader.read()');
        // The caller observes this result once and notifies settled(), so cold
        // thenables cannot start a second read while tracking lock cleanup.
        return apply(read, reader, []);
      },
      settled: retryRelease,
      close(reason) {
        observeCleanup(() => {
          const cancel = reader.cancel;
          if (typeof cancel !== 'function') throw new TypeError('Expected reader.cancel()');
          return apply(cancel, reader, [reason]);
        }, retryRelease);
      },
      release() {
        releaseReader(releaseState);
      },
    };
  }
  const getIterator = source[Symbol.asyncIterator];
  if (typeof getIterator !== 'function')
    throw new TypeError('Expected an AsyncIterable or ReadableStream');
  const iterator: unknown = apply(getIterator, source, []);
  if (!object(iterator)) throw new TypeError('Expected an asynchronous iterator');
  let next: unknown;
  return {
    validate() {
      // An iterator record captures next once; getters and later mutations must
      // not acquire a different method for each step.
      next = iterator.next;
      if (typeof next !== 'function') throw new TypeError('Expected iterator.next()');
    },
    next(): unknown {
      if (typeof next !== 'function') throw new TypeError('Expected iterator.next()');
      return apply(next, iterator, []);
    },
    close() {
      observeCleanup(() => {
        const close = iterator.return;
        if (close === undefined) return;
        if (typeof close !== 'function') throw new TypeError('Expected iterator.return()');
        return apply(close, iterator, []);
      });
    },
    release() {},
  };
}
