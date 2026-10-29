const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { runCompatibility, resolveNitroDirectory } = require('../compat/apply.cjs');
const definitions = require('../compat/patches.json');

const ROOT = resolve(__dirname, '..');
const CLI = join(ROOT, 'compat/cli.cjs');
const INSTALLED =
  process.env.NITRO_REGISTRY_SOURCE ||
  dirname(require.resolve('react-native-nitro-modules/package.json'));
const targetPaths = () => [...new Set(definitions.targets.map((target) => target.path))];

function replaceTargets(source, relativePath, from = 'original', to = 'patched', eol = '\n') {
  for (const target of definitions.targets.filter((entry) => entry.path === relativePath)) {
    source = source.replace(target[from].replaceAll('\n', eol), () =>
      target[to].replaceAll('\n', eol),
    );
  }
  return source;
}

function temporary(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'nitro-xxhash-compat-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(directory, version = '0.37.1') {
  fs.mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(join(INSTALLED, 'package.json'), 'utf8'));
  fs.writeFileSync(join(directory, 'package.json'), JSON.stringify({ ...manifest, version }));
  for (const relativePath of targetPaths()) {
    const path = join(directory, relativePath);
    fs.mkdirSync(dirname(path), { recursive: true });
    const source = fs.readFileSync(join(INSTALLED, relativePath), 'utf8');
    // A maintainer may already have explicitly applied our compatibility helper.
    // Undo only that exact hunk in the disposable fixture, never node_modules.
    const clean = replaceTargets(source, relativePath, 'patched', 'original');
    for (const target of definitions.targets.filter((entry) => entry.path === relativePath))
      assert(
        clean.includes(target.original),
        `Installed Nitro source is not a known fixture: ${relativePath}`,
      );
    fs.writeFileSync(path, clean);
  }
  return fs.realpathSync(directory);
}

function snapshot(directory) {
  return targetPaths().map((relativePath) =>
    fs.readFileSync(join(directory, relativePath), 'utf8'),
  );
}

function patchOne(directory, index, transform = (value) => value) {
  const target = definitions.targets[index];
  const path = join(directory, target.path);
  const source = fs.readFileSync(path, 'utf8');
  fs.writeFileSync(path, source.replace(target.original, transform(target.patched)));
}

function cli(arguments_, cwd) {
  return spawnSync(process.execPath, [CLI, ...arguments_], { cwd, encoding: 'utf8' });
}

test('applies every known compatibility target and preserves unrelated patches', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const before = snapshot(directory);
  for (const relativePath of targetPaths()) {
    fs.appendFileSync(
      join(directory, relativePath),
      '\n// Unrelated application patch stays intact.\n',
    );
  }
  const result = runCompatibility({ nitroPath: directory });
  assert.equal(result.status, 'applied');
  for (const [index, relativePath] of targetPaths().entries()) {
    const expected =
      replaceTargets(before[index], relativePath) +
      '\n// Unrelated application patch stays intact.\n';
    assert.equal(fs.readFileSync(join(directory, relativePath), 'utf8'), expected);
  }
  const fixed = snapshot(directory);
  assert.equal(runCompatibility({ nitroPath: directory }).status, 'already-fixed');
  assert.equal(runCompatibility({ nitroPath: directory, check: true }).status, 'already-fixed');
  assert.deepEqual(snapshot(directory), fixed);
});

test('--check reports needs/fixed without writing and repeated apply is harmless', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const before = snapshot(directory);
  const needed = cli(['--check', '--nitro-path', directory], directory);
  assert.equal(needed.status, 1, needed.stderr);
  assert.match(needed.stdout, /needs the compatibility repairs/);
  assert.deepEqual(snapshot(directory), before);
  const applied = cli(['--nitro-path', directory], directory);
  assert.equal(applied.status, 0, applied.stderr);
  const fixed = snapshot(directory);
  assert.equal(cli(['--nitro-path', directory], directory).status, 0);
  assert.equal(cli(['--check', '--nitro-path', directory], directory).status, 0);
  assert.deepEqual(snapshot(directory), fixed);
});

test('mixed state repairs only the missing hunk', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  patchOne(directory, 0);
  const first = snapshot(directory)[0];
  assert.equal(runCompatibility({ nitroPath: directory, check: true }).status, 'needs-patch');
  assert.equal(runCompatibility({ nitroPath: directory }).status, 'applied');
  assert.equal(snapshot(directory)[0], first);
  assert.equal(runCompatibility({ nitroPath: directory, check: true }).status, 'already-fixed');
});

test('independent hunks in one file are staged together and preserve both repairs', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const extra = {
    path: definitions.targets[0].path,
    signature: 'static inline int compatibilityFixture() {',
    original: 'static inline int compatibilityFixture() {\n  return 1;\n}',
    patched: 'static inline int compatibilityFixture() {\n  return 2;\n}',
  };
  fs.appendFileSync(join(directory, extra.path), '\n' + extra.original + '\n');
  definitions.targets.push(extra);
  t.after(() => definitions.targets.pop());
  const before = snapshot(directory);
  let writes = 0;
  const io = {
    ...fs,
    writeFileSync(...arguments_) {
      writes += 1;
      return fs.writeFileSync(...arguments_);
    },
  };
  const result = runCompatibility({ nitroPath: directory, io });
  assert.equal(result.files.length, targetPaths().length);
  assert.equal(writes, targetPaths().length, 'Stage exactly one combined replacement per file');
  targetPaths().forEach((relativePath, index) => {
    assert.equal(snapshot(directory)[index], replaceTargets(before[index], relativePath));
  });
  assert.equal(runCompatibility({ nitroPath: directory }).status, 'already-fixed');
});

test('an unknown later hunk in the same file rejects before staging earlier repairs', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const extra = {
    path: definitions.targets[0].path,
    signature: 'static inline int compatibilityFixture() {',
    original: 'static inline int compatibilityFixture() {\n  return 1;\n}',
    patched: 'static inline int compatibilityFixture() {\n  return 2;\n}',
  };
  fs.appendFileSync(
    join(directory, extra.path),
    '\n' + extra.original.replace('return 1', 'return 3') + '\n',
  );
  definitions.targets.push(extra);
  t.after(() => definitions.targets.pop());
  const before = snapshot(directory);
  const io = {
    ...fs,
    openSync: () => assert.fail('Every hunk must pass preflight before staging'),
  };
  assert.throws(() => runCompatibility({ nitroPath: directory, io }), /Unexpected source/);
  assert.deepEqual(snapshot(directory), before);
});

test('recognizes existing app and upstream comment variants without rewriting either file', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  patchOne(directory, 0, (source) =>
    source.replace(
      '  try {',
      '  // Xcode 27 Swift C++ interop otherwise emits an iOS 18+ libc++ symbol.\n  try {',
    ),
  );
  patchOne(directory, 1, (source) =>
    source.replace(
      '      try {',
      '      // TODO: Switch to std::make_exception_ptr when upstream compatibility allows.\n      try {',
    ),
  );
  for (let index = 2; index < definitions.targets.length; index += 1) patchOne(directory, index);
  const before = snapshot(directory);
  assert.equal(runCompatibility({ nitroPath: directory }).status, 'already-fixed');
  assert.deepEqual(snapshot(directory), before);
});

test('preserves CRLF without rewriting unrelated line endings', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  for (const relativePath of targetPaths()) {
    const path = join(directory, relativePath);
    fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replaceAll('\n', '\r\n'));
  }
  const before = snapshot(directory);
  assert.equal(runCompatibility({ nitroPath: directory }).status, 'applied');
  targetPaths().forEach((relativePath, index) => {
    assert.equal(
      snapshot(directory)[index],
      replaceTargets(before[index], relativePath, 'original', 'patched', '\r\n'),
    );
  });
});

test('refuses another package name or version before changing files', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'), '0.37.2');
  const before = snapshot(directory);
  assert.throws(
    () => runCompatibility({ nitroPath: directory }),
    /Expected react-native-nitro-modules@0.37.1/,
  );
  assert.equal(cli(['--check', '--nitro-path', directory], directory).status, 2);
  assert.deepEqual(snapshot(directory), before);
  const path = join(directory, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
  fs.writeFileSync(
    path,
    JSON.stringify({ ...manifest, name: 'different-package', version: '0.37.1' }),
  );
  assert.throws(() => runCompatibility({ nitroPath: directory }), /different-package@0.37.1/);
  assert.deepEqual(snapshot(directory), before);
});

test('all-file preflight rejects unknown second method without writing the first file', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const target = definitions.targets[1];
  const path = join(directory, target.path);
  fs.writeFileSync(
    path,
    fs
      .readFileSync(path, 'utf8')
      .replace(
        target.original,
        target.original.replace('std::runtime_error(message)', 'std::logic_error(message)'),
      ),
  );
  const before = snapshot(directory);
  const io = { ...fs, writeFileSync: () => assert.fail('Preflight must not write any file') };
  assert.throws(
    () => runCompatibility({ nitroPath: directory, io }),
    /Unexpected source in cpp\/core\/Promise.hpp/,
  );
  assert.deepEqual(snapshot(directory), before);
});

test('commented and raw-string patch examples cannot hide an unknown active method', (t) => {
  const temporaryRoot = temporary(t);
  const target = definitions.targets[0];
  const examples = [
    `/* Saved upstream example:\n${target.patched}\n*/`,
    `constexpr auto savedExample = R"saved(\n${target.patched}\n)saved";`,
    `#if 0\n${target.patched}\n#endif`,
    `#ifdef SOME_PLATFORM\n${target.patched}\n#endif`,
  ];
  examples.forEach((example, index) => {
    const directory = fixture(join(temporaryRoot, String(index)));
    patchOne(directory, 1);
    const path = join(directory, target.path);
    const source = fs
      .readFileSync(path, 'utf8')
      .replace(target.signature, target.signature.replace(' {', '  {'));
    fs.writeFileSync(path, source + '\n' + example + '\n');
    const before = snapshot(directory);
    assert.throws(
      () => runCompatibility({ nitroPath: directory, check: true }),
      /exactly one known method signature/,
    );
    assert.throws(
      () => runCompatibility({ nitroPath: directory }),
      /exactly one known method signature/,
    );
    assert.deepEqual(snapshot(directory), before);
    assert.equal(cli(['--check', '--nitro-path', directory], directory).status, 2);
  });
});

test('phase-2 line splicing cannot turn saved examples into apparently active patched methods', (t) => {
  const temporaryRoot = temporary(t);
  const target = definitions.targets[0];
  for (const [index, spacing] of ['', ' \t'].entries()) {
    const directory = fixture(join(temporaryRoot, String(index)));
    patchOne(directory, 1);
    const path = join(directory, target.path);
    const backslash = String.fromCharCode(92);
    const splice = backslash + spacing + '\n';
    const hidden =
      '/' + splice + '* Saved upstream example:\n' + target.patched + '\n*' + splice + '/';
    const active = fs
      .readFileSync(path, 'utf8')
      .replace(target.signature, target.signature.replace(' {', '  {'));
    fs.writeFileSync(path, active + '\n' + hidden + '\n');
    const before = snapshot(directory);
    const io = {
      ...fs,
      openSync: () => assert.fail('Line-continuation preflight must not create any file'),
    };
    assert.throws(
      () => runCompatibility({ nitroPath: directory, check: true, io }),
      /Unsupported C\+\+ line continuation.*No files were changed/,
    );
    assert.throws(
      () => runCompatibility({ nitroPath: directory, io }),
      /Unsupported C\+\+ line continuation.*No files were changed/,
    );
    assert.deepEqual(snapshot(directory), before);
    const result = cli(['--check', '--nitro-path', directory], directory);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unsupported C\+\+ line continuation/);
  }
});

test('saved snippets and numeric separators outside the active method remain untouched', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const target = definitions.targets[0];
  const path = join(directory, target.path);
  const examples = `\n/* Saved old code:\n${target.original}\n*/\nconstexpr auto savedExample = R"saved(\n${target.original}\n)saved";\n#if 0\n${target.original}\n#endif\nconstexpr auto pageSize = 4'096;\nconstexpr auto digit = u8'1';\n`;
  const before = fs.readFileSync(path, 'utf8') + examples;
  fs.writeFileSync(path, before);
  assert.equal(runCompatibility({ nitroPath: directory }).status, 'applied');
  assert.equal(fs.readFileSync(path, 'utf8'), before.replace(target.original, target.patched));
  assert.equal(runCompatibility({ nitroPath: directory, check: true }).status, 'already-fixed');
});

test('line-continuation comments cannot hide statements in an apparently fixed method', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  patchOne(directory, 0, (source) =>
    source.replace(
      '    throw std::runtime_error(message);',
      '    // This continuation hides the throw. ' +
        String.fromCharCode(92) +
        '\n    throw std::runtime_error(message);',
    ),
  );
  patchOne(directory, 1);
  const before = snapshot(directory);
  assert.throws(
    () => runCompatibility({ nitroPath: directory, check: true }),
    /Unsupported C\+\+ line continuation/,
  );
  assert.deepEqual(snapshot(directory), before);
});

test('refuses duplicate or missing signatures instead of selecting a different hunk', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const target = definitions.targets[0];
  const path = join(directory, target.path);
  fs.appendFileSync(path, `\n${target.original}\n`);
  const duplicate = snapshot(directory);
  assert.throws(
    () => runCompatibility({ nitroPath: directory }),
    /exactly one known method signature/,
  );
  assert.deepEqual(snapshot(directory), duplicate);
  fs.writeFileSync(
    path,
    fs.readFileSync(path, 'utf8').replaceAll('makeException(', 'differentHelper('),
  );
  const missing = snapshot(directory);
  assert.throws(
    () => runCompatibility({ nitroPath: directory }),
    /exactly one known method signature/,
  );
  assert.deepEqual(snapshot(directory), missing);
});

test('a partially failed second staging write leaves both target files intact', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const before = snapshot(directory);
  let writes = 0;
  const io = {
    ...fs,
    writeFileSync(path, value, encoding) {
      writes += 1;
      if (writes === 2) {
        fs.writeFileSync(path, value.slice(0, 100), encoding);
        throw Object.assign(new Error('injected disk write failure'), { code: 'EIO' });
      }
      return fs.writeFileSync(path, value, encoding);
    },
  };
  assert.throws(
    () => runCompatibility({ nitroPath: directory, io }),
    /All attempted changes were rolled back/,
  );
  assert.equal(writes, 2);
  assert.deepEqual(snapshot(directory), before);
});

test('stages both replacements before renaming and rolls back a failed second rename', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const before = snapshot(directory);
  let writes = 0;
  let renames = 0;
  const io = {
    ...fs,
    writeFileSync(...arguments_) {
      writes += 1;
      return fs.writeFileSync(...arguments_);
    },
    renameSync(...arguments_) {
      renames += 1;
      if (renames === 1)
        assert.equal(
          writes,
          targetPaths().length,
          'All replacements must be staged before the first rename',
        );
      if (renames === 2) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      return fs.renameSync(...arguments_);
    },
  };
  assert.throws(
    () => runCompatibility({ nitroPath: directory, io }),
    /All attempted changes were rolled back/,
  );
  assert.equal(renames, 3);
  assert.deepEqual(snapshot(directory), before);
  for (const target of definitions.targets) {
    assert.equal(
      fs
        .readdirSync(dirname(join(directory, target.path)))
        .some((name) => name.startsWith('.nitro-xxhash-compat-')),
      false,
    );
  }
});

test('atomic replacement preserves permissions and never mutates shared hardlinked package files', (t) => {
  const temporaryRoot = temporary(t);
  const directory = fixture(join(temporaryRoot, 'nitro'));
  const before = snapshot(directory);
  const aliases = targetPaths().map((relativePath, index) => {
    const path = join(directory, relativePath);
    const alias = join(temporaryRoot, `shared-store-file-${index}.hpp`);
    fs.chmodSync(path, 0o640);
    fs.linkSync(path, alias);
    assert.equal(fs.statSync(path).nlink, 2);
    return alias;
  });
  assert.equal(runCompatibility({ nitroPath: directory }).status, 'applied');
  targetPaths().forEach((relativePath, index) => {
    const path = join(directory, relativePath);
    assert.equal(fs.readFileSync(aliases[index], 'utf8'), before[index]);
    assert.equal(fs.statSync(path).nlink, 1);
    assert.equal(fs.statSync(path).mode & 0o777, 0o640);
    assert.equal(fs.readFileSync(path, 'utf8'), replaceTargets(before[index], relativePath));
  });
});

test('read-only failure gives patched-dependency guidance and restores earlier changes', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const before = snapshot(directory);
  const blocked = join(directory, definitions.targets[1].path);
  const io = {
    ...fs,
    openSync(path, ...arguments_) {
      if (dirname(path) === dirname(blocked))
        throw Object.assign(new Error('read-only package store'), { code: 'EROFS' });
      return fs.openSync(path, ...arguments_);
    },
  };
  assert.throws(
    () => runCompatibility({ nitroPath: directory, io }),
    /patched-dependency workflow/,
  );
  assert.deepEqual(snapshot(directory), before);
});

test('an exclusive-open collision never deletes a file the helper did not create', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const before = snapshot(directory);
  let foreignPath;
  const io = {
    ...fs,
    openSync(path) {
      foreignPath = path;
      fs.writeFileSync(path, 'pre-existing temporary file');
      throw Object.assign(new Error('exclusive-open collision'), { code: 'EEXIST' });
    },
  };
  assert.throws(() => runCompatibility({ nitroPath: directory, io }), /exclusive-open collision/);
  assert.equal(fs.readFileSync(foreignPath, 'utf8'), 'pre-existing temporary file');
  assert.deepEqual(snapshot(directory), before);
});

test('rollback preserves another process edits and reports the remaining changed file', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const firstPath = join(directory, definitions.targets[0].path);
  const before = snapshot(directory);
  let replacements = 0;
  let concurrent;
  const io = {
    ...fs,
    renameSync(...arguments_) {
      replacements += 1;
      if (replacements === 2) {
        concurrent = fs.readFileSync(firstPath, 'utf8') + '\n// Another process new patch.\n';
        fs.writeFileSync(firstPath, concurrent);
        throw Object.assign(new Error('second replacement failed'), { code: 'EIO' });
      }
      return fs.renameSync(...arguments_);
    },
  };
  assert.throws(() => runCompatibility({ nitroPath: directory, io }), /Changed by another process/);
  assert.equal(fs.readFileSync(firstPath, 'utf8'), concurrent);
  assert.equal(snapshot(directory)[1], before[1]);
});

test('rollback never replaces an equivalent patched file installed by another process', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const firstPath = join(directory, definitions.targets[0].path);
  const before = snapshot(directory);
  let replacements = 0;
  const io = {
    ...fs,
    renameSync(...arguments_) {
      replacements += 1;
      if (replacements === 2) {
        const other = firstPath + '.other-process';
        fs.writeFileSync(other, fs.readFileSync(firstPath));
        fs.renameSync(other, firstPath);
        throw Object.assign(new Error('second replacement failed'), { code: 'EIO' });
      }
      return fs.renameSync(...arguments_);
    },
  };
  assert.throws(() => runCompatibility({ nitroPath: directory, io }), /Changed by another process/);
  assert.equal(
    fs.readFileSync(firstPath, 'utf8'),
    before[0].replace(definitions.targets[0].original, definitions.targets[0].patched),
  );
  assert.equal(snapshot(directory)[1], before[1]);
});

test('resolves the consumer dependency before the helper fallback', (t) => {
  const temporaryRoot = temporary(t);
  const consumer = join(temporaryRoot, 'consumer');
  const installedHelper = join(
    temporaryRoot,
    'fallback/node_modules/react-native-nitro-xxhash/compat',
  );
  const consumerNitro = fixture(join(consumer, 'node_modules/react-native-nitro-modules'));
  const fallbackNitro = fixture(
    join(temporaryRoot, 'fallback/node_modules/react-native-nitro-modules'),
  );
  fs.mkdirSync(installedHelper, { recursive: true });
  const fallbackBefore = snapshot(fallbackNitro);
  assert.equal(
    resolveNitroDirectory({ cwd: consumer, helperDirectory: installedHelper }),
    consumerNitro,
  );
  assert.equal(
    runCompatibility({ cwd: consumer, helperDirectory: installedHelper }).directory,
    consumerNitro,
  );
  assert.deepEqual(snapshot(fallbackNitro), fallbackBefore);
  const outsideProject = join(temporaryRoot, 'outside');
  fs.mkdirSync(outsideProject);
  assert.equal(
    resolveNitroDirectory({ cwd: outsideProject, helperDirectory: installedHelper }),
    fallbackNitro,
  );
});

test('unsupported consumer version never falls back to the helper dependency', (t) => {
  const temporaryRoot = temporary(t);
  const consumer = join(temporaryRoot, 'consumer');
  const installedHelper = join(
    temporaryRoot,
    'fallback/node_modules/react-native-nitro-xxhash/compat',
  );
  const consumerNitro = fixture(
    join(consumer, 'node_modules/react-native-nitro-modules'),
    '0.38.0',
  );
  const fallbackNitro = fixture(
    join(temporaryRoot, 'fallback/node_modules/react-native-nitro-modules'),
  );
  fs.mkdirSync(installedHelper, { recursive: true });
  const consumerBefore = snapshot(consumerNitro);
  const fallbackBefore = snapshot(fallbackNitro);
  assert.throws(
    () => runCompatibility({ cwd: consumer, helperDirectory: installedHelper }),
    /found react-native-nitro-modules@0.38.0/,
  );
  assert.deepEqual(snapshot(consumerNitro), consumerBefore);
  assert.deepEqual(snapshot(fallbackNitro), fallbackBefore);
});

test('explicit relative --nitro-path selects the intended hoisted/pnpm dependency', (t) => {
  const temporaryRoot = temporary(t);
  const cwd = join(temporaryRoot, 'consumer');
  fs.mkdirSync(cwd);
  const selected = fixture(join(temporaryRoot, 'pnpm-store/nitro'));
  const result = cli(['--nitro-path', '../pnpm-store/nitro'], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(runCompatibility({ nitroPath: selected, check: true }).status, 'already-fixed');
});

test('fails clearly when neither resolution location has Nitro', (t) => {
  const temporaryRoot = temporary(t);
  assert.throws(
    () => runCompatibility({ cwd: temporaryRoot, helperDirectory: temporaryRoot }),
    /Cannot locate react-native-nitro-modules/,
  );
});

test('CLI rejects bad arguments; help works without any installed dependency', (t) => {
  const cwd = temporary(t);
  const help = cli(['--help'], cwd);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /exit 0 fixed, 1 needs patch, 2 error/);
  for (const arguments_ of [
    ['--unknown'],
    ['unexpected'],
    ['--nitro-path'],
    ['--nitro-path', '--check'],
    ['--check', '--check'],
    ['--nitro-path', cwd, '--nitro-path', cwd],
  ]) {
    const result = cli(arguments_, cwd);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /nitro-xxhash-compat:/);
  }
});

test('importing helper or CLI never modifies dependencies, writes output or runs commands', (t) => {
  const temporaryRoot = temporary(t);
  const directory = fixture(join(temporaryRoot, 'node_modules/react-native-nitro-modules'));
  const before = snapshot(directory);
  const script = `require(${JSON.stringify(join(ROOT, 'compat/apply.cjs'))}); require(${JSON.stringify(CLI)});`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: temporaryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(snapshot(directory), before);
  assert.equal(runCompatibility({ nitroPath: directory, check: true }).status, 'needs-patch');
});

test('unknown cache source rejects before creating any staged file or changing iOS fixes', (t) => {
  const directory = fixture(join(temporary(t), 'nitro'));
  const target = definitions.targets.find((entry) => entry.path === 'cpp/jsi/JSICache.hpp');
  const targetPath = join(directory, target.path);
  fs.writeFileSync(
    targetPath,
    fs
      .readFileSync(targetPath, 'utf8')
      .replace('new jsi::Value(std::move(value))', 'new jsi::Value(value)'),
  );
  const before = snapshot(directory);
  const io = { ...fs, openSync: () => assert.fail('Unknown cache sources must not stage a file') };
  assert.throws(
    () => runCompatibility({ nitroPath: directory, io }),
    /Unexpected source in cpp\/jsi\/JSICache.hpp/,
  );
  assert.deepEqual(snapshot(directory), before);
});
