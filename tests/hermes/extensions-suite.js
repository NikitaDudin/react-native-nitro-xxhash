/* global watchObject, watchedObjectAlive, clearWatchedObjects, collectGarbage, runFileHashForTest */

function bytesHex(bytes) {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

// Keep the default string path equivalent to every supported spelling of seed zero.
// These fixtures cover empty/ASCII text, Cyrillic, CJK, emoji, NUL and lone surrogates.
for (const index of [0, 1, 2, 3, 4, 5, 12, 13, 15]) {
  const { input } = ORIGINAL[index];
  for (const [algorithm, hash] of Object.entries(methods)) {
    const expected = VECTORS[algorithm]['0']['string-' + index];
    const label = algorithm + '/string-' + index;
    equal(hash(input), expected, 'default string/' + label);
    for (const [mode, seed] of [
      ['undefined', undefined],
      ['number', 0],
      ['negative-zero', -0],
      ['bigint', 0n],
    ])
      equal(hash(input, seed), expected, 'zero string/' + mode + '/' + label);
    equal(hash(input, { seed: 0 }), expected, 'zero string options/' + label);
    equal(hash(input, { seed: 0n, output: 'hex' }), expected, 'zero string hex options/' + label);
    equal(bytesHex(hash(input, { output: 'bytes' })), expected, 'default string bytes/' + label);
    equal(
      hash(input, { seed: 0n, output: 'bigint' }),
      BigInt('0x' + expected),
      'zero string bigint/' + label,
    );
  }
}

for (const [algorithm, seeds] of Object.entries(VECTORS)) {
  const hash = methods[algorithm];
  for (const [seedString, cases] of Object.entries(seeds)) {
    const seed = BigInt(seedString);
    for (const [name, expected] of Object.entries(cases)) {
      const bytes = name.startsWith('string-')
        ? Uint8Array.from(
            ORIGINAL[Number(name.slice('string-'.length))].utf8.match(/../g) || [],
            (pair) => parseInt(pair, 16),
          )
        : Uint8Array.from({ length: Number(name) }, (_, index) => (index * 131 + 17) % 256);
      const label = algorithm + '/' + seedString + '/' + name;
      equal(bytesHex(hash(bytes, { seed, output: 'bytes' })), expected, 'format bytes/' + label);
      equal(
        hash(bytes, { seed, output: 'bigint' }),
        BigInt('0x' + expected),
        'format bigint/' + label,
      );
      const hasher = api.createHasher(algorithm, seed);
      let clone;
      try {
        const split = Math.floor(bytes.length / 2);
        hasher.update(bytes.subarray(0, split));
        clone = hasher.clone();
        clone.update(bytes.subarray(split));
        equal(clone.digest(), expected, 'cloned prefix/' + label);
        equal(bytesHex(clone.digest('bytes')), expected, 'stream bytes/' + label);
        equal(clone.digest('bigint'), BigInt('0x' + expected), 'stream bigint/' + label);
        hasher.dispose();
        clone.reset().update(bytes);
        equal(clone.digest(), expected, 'clone seed and independent lifetime/' + label);
        clone.reset(0).update(bytes);
        equal(clone.digest(), hash(bytes), 'clone reset seed/' + label);
      } finally {
        hasher.dispose();
        if (clone) clone.dispose();
      }
    }
  }
  const base = api.createHasher(algorithm, 42n).update('common/');
  const branch = base.clone();
  try {
    base.update('left');
    branch.update('right');
    equal(base.digest(), hash('common/left', 42n), 'original clone branch/' + algorithm);
    equal(branch.digest(), hash('common/right', 42n), 'independent clone branch/' + algorithm);
    throws(() => branch.digest('invalid'), 'invalid stream output/' + algorithm);
    equal(
      branch.digest(),
      hash('common/right', 42n),
      'invalid output preserves state/' + algorithm,
    );
  } finally {
    base.dispose();
    branch.dispose();
  }
  throws(() => base.clone(), 'clone disposed state/' + algorithm);
}

function harnessAbortController() {
  const listeners = new Set();
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener) {
      if (type === 'abort') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'abort') listeners.delete(listener);
    },
  };
  return {
    signal,
    listeners,
    abort(reason) {
      signal.aborted = true;
      signal.reason = reason;
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

function harnessDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function collectWatchedObjects() {
  for (let count = 0; count < 8; count++) {
    await Promise.resolve();
    collectGarbage();
  }
}

function memorySource(read, cleanup, readable, stats) {
  const owner = { payload: new ArrayBuffer(1024 * 1024) };
  const next = () => read;
  const close = () => {
    stats.closed++;
    return cleanup;
  };
  let source;
  if (readable) {
    Object.assign(owner, {
      read: next,
      cancel: close,
      releaseLock() {
        stats.released++;
        if (stats.cannotRelease) throw new Error('Read still pending');
      },
    });
    source = { getReader: () => owner };
  } else {
    Object.assign(owner, { next, return: close });
    source = { [Symbol.asyncIterator]: () => owner };
  }
  watchObject('source', source);
  watchObject('owner', owner);
  watchObject('payload', owner.payload);
  return source;
}

function memoryFileWork(pending, stats) {
  return {
    result: () => pending,
    cancel() {
      stats.cancelled++;
    },
  };
}

globalThis.__xxhashAsyncDone = false;
globalThis.__xxhashAsyncError = undefined;
(async () => {
  const bytes = Uint8Array.from(
    { length: 2 * 1024 * 1024 },
    (_, index) => (index * 131 + 17) % 256,
  );
  const fileMethods = {
    xxh32: api.xxh32File,
    xxh64: api.xxh64File,
    'xxh3-64': api.xxh3_64File,
    'xxh3-128': api.xxh3_128File,
  };
  for (const [algorithm, hash] of Object.entries(methods)) {
    const expected = hash(bytes, 42n);
    const parts = [bytes.subarray(0, 17), new DataView(bytes.buffer, 17, 131), bytes.subarray(148)];
    const source = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: () =>
            Promise.resolve(
              index < parts.length ? { value: parts[index++], done: false } : { done: true },
            ),
        };
      },
    };
    equal(
      await api.hashStream(source, { algorithm, seed: 42n }),
      expected,
      'async iterable/' + algorithm,
    );
    equal(
      bytesHex(await api.hashStream(source, { algorithm, seed: 42n, output: 'bytes' })),
      expected,
      'async iterable bytes/' + algorithm,
    );
    equal(
      await api.hashStream(source, { algorithm, seed: 42n, output: 'bigint' }),
      BigInt('0x' + expected),
      'async iterable bigint/' + algorithm,
    );
    let released = 0;
    const readable = {
      getReader() {
        let index = 0;
        return {
          read: () =>
            Promise.resolve(
              index < parts.length ? { value: parts[index++], done: false } : { done: true },
            ),
          releaseLock() {
            released++;
          },
          cancel() {
            throw new Error('A completed reader must not be cancelled');
          },
        };
      },
    };
    equal(
      await api.hashStream(readable, { algorithm, seed: 42n }),
      expected,
      'readable protocol/' + algorithm,
    );
    equal(released, 1, 'readable releases lock/' + algorithm);
    equal(
      await fileMethods[algorithm](fileFixturePath, { seed: 42n }),
      expected,
      'file hex/' + algorithm,
    );
    equal(
      bytesHex(await fileMethods[algorithm](fileFixturePath, { seed: 42n, output: 'bytes' })),
      expected,
      'file bytes/' + algorithm,
    );
    const active = harnessAbortController();
    equal(
      await fileMethods[algorithm](fileFixturePath, {
        seed: 42n,
        output: 'bigint',
        signal: active.signal,
      }),
      BigInt('0x' + expected),
      'cancellable task success/' + algorithm,
    );
    equal(active.listeners.size, 0, 'file listeners released/' + algorithm);
    const task = raw.startFileHash(fileFixturePath, algorithm, '42');
    const result = task.result();
    task.cancel();
    task.cancel();
    try {
      equal(await result, expected, 'task completed before cancellation/' + algorithm);
    } catch (error) {
      equal(
        error.message.includes('File hashing cancelled'),
        true,
        'native cancellation/' + algorithm,
      );
    }
  }
  const preaborted = harnessAbortController();
  preaborted.abort('already cancelled');
  try {
    await api.xxh3_128File(fileFixturePath, { signal: preaborted.signal });
    throw new Error('Preaborted file unexpectedly succeeded');
  } catch (error) {
    equal(error.name, 'AbortError', 'preaborted file error');
    equal(error.cause, 'already cancelled', 'preaborted file reason');
  }
  const controller = harnessAbortController();
  let returned = 0;
  const source = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          controller.abort('stop waiting');
          return new Promise(() => {});
        },
        return() {
          returned++;
          return Promise.resolve({ done: true });
        },
      };
    },
  };
  try {
    await api.hashStream(source, { signal: controller.signal });
    throw new Error('Aborted stream unexpectedly succeeded');
  } catch (error) {
    equal(error.name, 'AbortError', 'pending iterator cancellation');
    equal(error.cause, 'stop waiting', 'pending iterator cancellation reason');
  }
  equal(returned, 1, 'cancelled iterator closes');
  equal(controller.listeners.size, 0, 'stream listeners released');
  for (const readable of [false, true]) {
    let reads = 0;
    let nextGets = 0;
    let releases = 0;
    const method = (fn) => {
      Object.defineProperty(fn, 'call', {
        get() {
          throw new Error('Protocol methods must be invoked directly');
        },
      });
      return fn;
    };
    const next = method(() => {
      const step = reads++ === 0 ? { done: false, value: 'protocol' } : { done: true };
      const pending = Promise.resolve(step);
      Object.defineProperty(step, 'then', {
        get() {
          throw new Error('Await must not re-assimilate a fulfilled iterator result');
        },
      });
      return pending;
    });
    const source = readable
      ? {
          getReader: method(() => ({
            read: next,
            cancel: method(() => {
              throw new Error('Completed reader must not cancel');
            }),
            releaseLock: method(() => {
              releases++;
            }),
          })),
        }
      : {
          [Symbol.asyncIterator]: method(() => ({
            get next() {
              if (++nextGets !== 1) throw new Error('Iterator next must be acquired once');
              return next;
            },
          })),
        };
    equal(await api.hashStream(source), api.xxh3_128('protocol'), 'source protocol/' + readable);
    equal(readable ? releases : nextGets, 1, 'source protocol ownership/' + readable);
  }
  const thenError = new Error('Source Promise then getter failed');
  const throwingPromise = (value) => {
    const pending = Promise.resolve(value);
    Object.defineProperty(pending, 'then', {
      get() {
        throw thenError;
      },
    });
    return pending;
  };
  // Some Hermes versions expose JS-backed Promises. Match their bare-await
  // behavior while ensuring an assimilation error cannot leave our helper pending.
  const baseline = await (async () => await throwingPromise({ done: true }))().then(
    () => ({ ignoresOwnThen: true }),
    (error) => ({ ignoresOwnThen: false, error }),
  );
  for (const readable of [false, true]) {
    let reads = 0;
    let closed = 0;
    let releases = 0;
    const next = () =>
      reads++ === 0
        ? throwingPromise({ done: false, value: 'protocol' })
        : Promise.resolve({ done: true });
    const close = () => {
      closed++;
      return throwingPromise({ done: true });
    };
    const source = readable
      ? {
          getReader: () => ({
            read: next,
            cancel: close,
            releaseLock() {
              releases++;
            },
          }),
        }
      : {
          [Symbol.asyncIterator]: () => ({ next, return: close }),
        };
    const outcome = await api.hashStream(source).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    if (baseline.ignoresOwnThen) {
      equal(outcome.value, api.xxh3_128('protocol'), 'native Promise reaction/' + readable);
      equal(closed, 0, 'completed Promise source stays open/' + readable);
    } else {
      equal(
        outcome.error,
        thenError,
        'Promise assimilation rejects instead of hanging/' + readable,
      );
      equal(closed, 1, 'Promise assimilation failure closes source/' + readable);
    }
    equal(releases, readable ? 1 : 0, 'Promise assimilation reader release/' + readable);
  }
  for (const readable of [false, true]) {
    for (const done of [false, true]) {
      const controller = harnessAbortController();
      let closed = 0;
      let releases = 0;
      const step = {
        get done() {
          controller.abort('abort in done getter');
          return done;
        },
        get value() {
          throw new Error('Aborting done getter must prevent chunk access');
        },
      };
      const next = () => Promise.resolve(step);
      const close = () => {
        closed++;
      };
      const source = readable
        ? {
            getReader: () => ({
              read: next,
              cancel: close,
              releaseLock() {
                releases++;
              },
            }),
          }
        : {
            [Symbol.asyncIterator]: () => ({ next, return: close }),
          };
      const outcome = await api.hashStream(source, { signal: controller.signal }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const label = readable + '/' + done;
      equal(outcome.error.name, 'AbortError', 'done getter cancellation/' + label);
      equal(outcome.error.cause, 'abort in done getter', 'done getter abort reason/' + label);
      equal(closed, done ? 0 : 1, 'only incomplete sources close/' + label);
      equal(releases, readable ? 1 : 0, 'done getter reader release/' + label);
      equal(controller.listeners.size, 0, 'done getter listener cleanup/' + label);
    }
  }
  let coldReads = 0;
  let coldObservations = 0;
  let coldReleases = 0;
  const coldSource = {
    getReader: () => ({
      read() {
        const index = ++coldReads;
        return {
          then(resolve) {
            coldObservations++;
            resolve(
              index === 1 ? { done: false, value: 'cold-' + coldObservations } : { done: true },
            );
          },
        };
      },
      cancel() {
        throw new Error('Completed cold reader must not cancel');
      },
      releaseLock() {
        coldReleases++;
      },
    }),
  };
  equal(await api.hashStream(coldSource), api.xxh3_128('cold-1'), 'cold thenable first resolution');
  equal(coldReads, 2, 'cold thenable read count');
  equal(coldObservations, 2, 'cold thenable observed once per read');
  equal(coldReleases, 1, 'cold thenable reader released');
  for (const readable of [false, true]) {
    for (const hungRead of [false, true]) {
      clearWatchedObjects();
      const pending = harnessDeferred();
      const stats = { closed: 0, released: 0 };
      await (async () => {
        const controller = harnessAbortController();
        const reason = { payload: new ArrayBuffer(1024 * 1024) };
        const source = memorySource(
          hungRead ? pending.promise : Promise.resolve({ done: false, value: [] }),
          hungRead ? undefined : pending.promise,
          readable,
          stats,
        );
        if (hungRead) {
          watchObject('signal', controller.signal);
          watchObject('reason', reason);
        }
        const result = api.hashStream(source, { signal: controller.signal });
        if (hungRead) controller.abort(reason);
        await result.then(
          () => {
            throw new Error('Memory source unexpectedly succeeded');
          },
          (error) =>
            equal(error.name, hungRead ? 'AbortError' : 'TypeError', 'memory source error'),
        );
      })();
      await collectWatchedObjects();
      const labels = hungRead
        ? ['source', 'owner', 'payload', 'signal', 'reason']
        : ['source', 'owner', 'payload'];
      for (const label of labels) {
        equal(
          watchedObjectAlive(label),
          false,
          'released ' + label + '/' + readable + '/' + hungRead,
        );
      }
      equal(stats.closed, 1, 'memory source closes once');
      equal(stats.released, readable ? 1 : 0, 'memory reader releases once');
      pending.reject(new Error('Late source/cleanup failure'));
      await Promise.resolve();
      clearWatchedObjects();
    }
  }
  clearWatchedObjects();
  const pendingRead = harnessDeferred();
  const pendingCleanup = harnessDeferred();
  const releaseStats = { closed: 0, released: 0, cannotRelease: true };
  await (async () => {
    const controller = harnessAbortController();
    const reason = { payload: new ArrayBuffer(1024 * 1024) };
    const source = memorySource(pendingRead.promise, pendingCleanup.promise, true, releaseStats);
    watchObject('signal', controller.signal);
    watchObject('reason', reason);
    const result = api.hashStream(source, { signal: controller.signal });
    controller.abort(reason);
    await result.then(
      () => {
        throw new Error('Pending reader unexpectedly succeeded');
      },
      (error) => equal(error.name, 'AbortError', 'pending reader error'),
    );
  })();
  await collectWatchedObjects();
  equal(watchedObjectAlive('owner'), true, 'retain reader only for release retry');
  equal(watchedObjectAlive('signal'), false, 'retry does not retain signal');
  equal(watchedObjectAlive('reason'), false, 'retry does not retain abort reason');
  equal(releaseStats.released, 1, 'initial pending-reader release attempted');
  releaseStats.cannotRelease = false;
  pendingRead.resolve({ done: false, value: 'late' });
  await collectWatchedObjects();
  equal(releaseStats.released, 2, 'pending reader release retried');
  for (const label of ['source', 'owner', 'payload', 'signal', 'reason']) {
    equal(watchedObjectAlive(label), false, 'release retry detaches ' + label);
  }
  pendingCleanup.reject(new Error('Late pending-reader cleanup failure'));
  await Promise.resolve();
  clearWatchedObjects();
  const delayedCancel = harnessDeferred();
  let delayedReleases = 0;
  let delayedCancelCalls = 0;
  let canReleaseAfterCancel = false;
  await api
    .hashStream({
      getReader: () => ({
        read: () => Promise.resolve({ done: false, value: [] }),
        cancel() {
          delayedCancelCalls++;
          return delayedCancel.promise;
        },
        releaseLock() {
          delayedReleases++;
          if (!canReleaseAfterCancel) throw new Error('Cancellation still pending');
        },
      }),
    })
    .then(
      () => {
        throw new Error('Invalid no-signal chunk unexpectedly succeeded');
      },
      (error) => equal(error.name, 'TypeError', 'no-signal source error'),
    );
  equal(delayedCancelCalls, 1, 'no-signal error cancels reader once');
  equal(delayedReleases, 1, 'no-signal error attempts reader release');
  canReleaseAfterCancel = true;
  delayedCancel.resolve();
  await collectWatchedObjects();
  equal(delayedReleases, 2, 'no-signal cleanup retries reader release');
  const pendingFile = harnessDeferred();
  const fileStats = { cancelled: 0 };
  await (async () => {
    const controller = harnessAbortController();
    const reason = { payload: new ArrayBuffer(1024 * 1024) };
    const work = memoryFileWork(pendingFile.promise, fileStats);
    watchObject('signal', controller.signal);
    watchObject('reason', reason);
    const result = runFileHashForTest(controller.signal, () => work);
    controller.abort(reason);
    await result.then(
      () => {
        throw new Error('Cancelled file work unexpectedly succeeded');
      },
      (error) => equal(error.name, 'AbortError', 'synthetic file cancellation'),
    );
  })();
  await collectWatchedObjects();
  equal(watchedObjectAlive('signal'), false, 'cancelled file drops signal before worker settles');
  equal(watchedObjectAlive('reason'), false, 'cancelled file drops reason before worker settles');
  equal(fileStats.cancelled, 1, 'synthetic file cancels once');
  pendingFile.reject(new Error('Late synthetic file failure'));
  await Promise.resolve();
  clearWatchedObjects();
  const firstBlocker = harnessDeferred();
  const secondBlocker = harnessDeferred();
  const blockerStats = { started: 0, cancelled: 0 };
  const blockers = [firstBlocker, secondBlocker].map((pending) =>
    runFileHashForTest(undefined, () => {
      blockerStats.started++;
      return memoryFileWork(pending.promise, blockerStats);
    }),
  );
  equal(blockerStats.started, 2, 'synthetic blockers occupy both file permits');
  let queuedStarts = 0;
  await (async () => {
    const controller = harnessAbortController();
    const reason = { payload: new ArrayBuffer(1024 * 1024) };
    watchObject('signal', controller.signal);
    watchObject('reason', reason);
    const result = runFileHashForTest(controller.signal, () => {
      queuedStarts++;
      throw new Error('Aborted queued file must not start');
    });
    controller.abort(reason);
    await result.then(
      () => {
        throw new Error('Queued file unexpectedly succeeded');
      },
      (error) => equal(error.name, 'AbortError', 'queued file cancellation'),
    );
  })();
  await collectWatchedObjects();
  equal(watchedObjectAlive('signal'), false, 'queued cancellation drops signal');
  equal(watchedObjectAlive('reason'), false, 'queued cancellation drops reason');
  equal(queuedStarts, 0, 'cancelled queued job never starts');
  firstBlocker.resolve('first');
  secondBlocker.resolve('second');
  await Promise.all(blockers);
  clearWatchedObjects();
  const cursorGates = [harnessDeferred(), harnessDeferred(), harnessDeferred()];
  const cursorStarts = [];
  const cursorActive = cursorGates.slice(0, 2).map((gate, index) =>
    runFileHashForTest(undefined, () => {
      cursorStarts.push(index === 0 ? 'A' : 'B');
      return memoryFileWork(gate.promise, {});
    }),
  );
  const cursorAdmitted = runFileHashForTest(undefined, () => {
    cursorStarts.push('C');
    return memoryFileWork(cursorGates[2].promise, {});
  });
  const cursorControllers = [harnessAbortController(), harnessAbortController()];
  const cursorCancelled = cursorControllers.map((controller) =>
    runFileHashForTest(controller.signal, () => {
      throw new Error('Cancelled cursor tail must not start');
    }).then(
      () => {
        throw new Error('Cancelled cursor tail unexpectedly succeeded');
      },
      (error) => equal(error.name, 'AbortError', 'cursor tail cancellation'),
    ),
  );
  cursorGates[0].resolve('A');
  await cursorActive[0];
  equal(cursorStarts.join(','), 'A,B,C', 'cursor admitted a prefix before tail cancellation');
  cursorControllers.forEach((controller) => controller.abort());
  let cursorChild;
  const cursorNewWave = runFileHashForTest(undefined, () => {
    cursorStarts.push('F');
    cursorChild = runFileHashForTest(undefined, () => {
      cursorStarts.push('G');
      return memoryFileWork(Promise.resolve('G'), {});
    });
    return memoryFileWork(Promise.resolve('F'), {});
  });
  cursorGates[1].resolve('B');
  await cursorNewWave;
  await cursorChild;
  equal(
    cursorStarts.join(','),
    'A,B,C,F,G',
    'cursor resets for new waves and reentrant insertions',
  );
  cursorGates[2].resolve('C');
  await Promise.all([...cursorActive, cursorAdmitted, ...cursorCancelled]);
  print(
    JSON.stringify({
      checks,
      extensions: [
        'clone',
        'bytes',
        'bigint',
        'asyncIterable',
        'readableProtocol',
        'nativeFileTask',
      ],
      engine: 'Hermes',
    }),
  );
})().then(
  () => {
    globalThis.__xxhashAsyncDone = true;
  },
  (error) => {
    globalThis.__xxhashAsyncError = error.stack || String(error);
    globalThis.__xxhashAsyncDone = true;
  },
);
