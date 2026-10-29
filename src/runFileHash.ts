import createAbortError from './createAbortError';

interface FileHashWork {
  result(): PromiseLike<string>;
  cancel?(): void;
}

interface FileHashJob {
  start?: () => FileHashWork;
  work?: FileHashWork;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve?: (hex: string) => void;
  reject?: (error: unknown) => void;
  active: boolean;
  completed: boolean;
  settled: boolean;
  cancelled: boolean;
  previous: FileHashJob | undefined;
  next: FileHashJob | undefined;
}

let head: FileHashJob | undefined;
let tail: FileHashJob | undefined;
const concurrency = 2;
let active = 0;
let draining = false;

function removePending(job: FileHashJob): void {
  if (job !== head && job.previous === undefined) return;
  const previous = job.previous;
  const next = job.next;
  if (previous) previous.next = next;
  else head = next;
  if (next) next.previous = previous;
  else tail = previous;
  job.previous = undefined;
  job.next = undefined;
}

function enqueue(job: FileHashJob): void {
  job.previous = tail;
  if (tail) tail.next = job;
  else head = job;
  tail = job;
}

function settle(job: FileHashJob, success: boolean, value: unknown): void {
  if (job.settled) return;
  job.settled = true;
  const signal = job.signal;
  const onAbort = job.onAbort;
  const resolve = job.resolve;
  const reject = job.reject;
  job.signal = undefined;
  job.onAbort = undefined;
  job.resolve = undefined;
  job.reject = undefined;
  job.start = undefined;
  try {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  } catch {
    // Preserve the result when a custom signal's cleanup fails.
  }
  if (success) resolve?.(value as string);
  else reject?.(value);
}

function cancel(job: FileHashJob): void {
  if (!job.work || job.cancelled) return;
  job.cancelled = true;
  const work = job.work;
  job.work = undefined;
  try {
    work.cancel?.();
  } catch {
    // AbortError and the eventual native settlement remain authoritative.
  }
}

function abort(job: FileHashJob): void {
  if (job.settled || !job.signal) return;
  const error = createAbortError(job.signal);
  removePending(job);
  cancel(job);
  settle(job, false, error);
}

function complete(job: FileHashJob, success: boolean, value: unknown): void {
  if (job.completed) return;
  job.completed = true;
  job.work = undefined;
  if (job.active) {
    job.active = false;
    active -= 1;
  }
  settle(job, success, value);
  drain();
}

// This observer retains only its native result and small job record. An abort
// detaches the signal, public resolvers and source arguments from that record.
async function observe(result: PromiseLike<string>, job: FileHashJob): Promise<void> {
  try {
    complete(job, true, await result);
  } catch (error) {
    complete(job, false, error);
  }
}

function failObserver(job: FileHashJob, error: unknown): void {
  complete(job, false, error);
}

function drain(): void {
  if (draining) return;
  draining = true;
  try {
    while (active < concurrency && head) {
      const job = head;
      removePending(job);
      job.active = true;
      active += 1;
      try {
        const work = job.start!();
        job.start = undefined;
        job.work = work;
        if (job.settled) cancel(job);
        // Observe exactly once, including aborts inside native initialization.
        const observer = observe(work.result(), job);
        void observer.then(undefined, failObserver.bind(undefined, job));
        if (job.signal?.aborted) abort(job);
      } catch (error) {
        cancel(job);
        complete(job, false, error);
      }
    }
  } finally {
    draining = false;
  }
}

/** Queue in JS and keep the native permit until the worker actually finishes. */
export default function runFileHash(
  signal: AbortSignal | undefined,
  start: () => FileHashWork,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const job: FileHashJob = {
      start,
      signal,
      resolve,
      reject,
      active: false,
      completed: false,
      settled: false,
      cancelled: false,
      previous: undefined,
      next: undefined,
    };
    if (signal) {
      job.onAbort = abort.bind(undefined, job);
      try {
        signal.addEventListener('abort', job.onAbort, { once: true });
        if (signal.aborted) abort(job);
      } catch (error) {
        settle(job, false, error);
      }
    }
    if (job.settled) return;
    enqueue(job);
    drain();
  });
}
