const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { sourceManifest, verifySourceManifest } = require('./source-manifest.cjs');
const {
  ROOT,
  filesUnder,
  nitroHeaderMap,
  requiredExecutable,
  run,
  withTemporaryDirectory,
} = require('../../../scripts/native-test-utils.cjs');

const revision = 'f31b65a2d6d005016c5d23dcdfd8a750fb5995ff';
const releaseHash = 'bfd045d2176c953f8f259c04cf111089475b9d7463a2cb36b2e343ff3cce9b0a';
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const read = (file) => fs.readFileSync(file, 'utf8');
const hashFile = (file) => sha256(fs.readFileSync(file));

function integer(name, fallback, minimum, maximum, environment) {
  const value = Number(environment[name] || fallback);
  assert(Number.isInteger(value) && value >= minimum && value <= maximum, `Invalid ${name}`);
  return value;
}

function readSettings(environment = process.env) {
  const profile = environment.BENCHMARK_PROFILE || 'latency';
  assert(
    ['latency', 'bulk', 'cold', 'large', 'ablation'].includes(profile),
    'Unknown benchmark profile',
  );
  const settings = {
    profile,
    rounds: integer(
      'BENCHMARK_ROUNDS',
      profile === 'latency' ? 15 : profile === 'cold' ? 1 : profile === 'ablation' ? 7 : 5,
      1,
      100,
      environment,
    ),
    targetMs: integer(
      'BENCHMARK_TARGET_MS',
      profile === 'ablation' ? 20 : 30,
      5,
      1000,
      environment,
    ),
    processes: integer('BENCHMARK_PROCESSES', profile === 'cold' ? 20 : 3, 1, 40, environment),
  };
  if (profile === 'cold' && settings.rounds !== 1)
    throw new Error(
      'Cold first-use measurements require exactly one round per fresh process; vary BENCHMARK_PROCESSES instead',
    );
  return settings;
}

function quantile(values, fraction) {
  const ordered = values.slice().sort((a, b) => a - b);
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  return ordered[lower] + (ordered[Math.ceil(position)] - ordered[lower]) * (position - lower);
}

function sampleUnits(sample) {
  const large = sample.kind === 'large-chunks' || sample.kind === 'large-file';
  return {
    bytesPerCall: sample.chunkBytes ?? sample.bytes,
    batchCalls: sample.batchCalls ?? (large ? sample.calls : undefined),
  };
}

function summarize(processes) {
  const samples = processes.flatMap((process, index) =>
    process.samples.map((sample) => ({ ...sample, process: index })),
  );
  const groups = new Map();
  for (const sample of samples) {
    const units = sampleUnits(sample);
    const key = `${sample.kind}/${sample.bytes}/${sample.width}/${units.bytesPerCall}/${units.batchCalls ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  return [...groups.values()]
    .map((group) => {
      const result = {
        kind: group[0].kind,
        bytes: group[0].bytes,
        width: group[0].width,
        ...sampleUnits(group[0]),
      };
      for (const name of ['ours', 'theirs']) {
        const selected = group.filter((sample) => sample.implementation === name);
        if (!selected.length) {
          result[name] = null;
          continue;
        }
        const values = selected.map((sample) => sample.nsPerCall);
        result[name] = {
          medianNs: quantile(values, 0.5),
          p10Ns: quantile(values, 0.1),
          p90Ns: quantile(values, 0.9),
          medianMs: quantile(
            selected.map((sample) => sample.elapsedMs),
            0.5,
          ),
        };
      }
      result.oursOverTheirs =
        result.ours && result.theirs ? result.ours.medianNs / result.theirs.medianNs : null;
      result.processRatios = processes.map((_, index) => {
        const samples = group.filter((sample) => sample.process === index);
        if (
          !['ours', 'theirs'].every((name) =>
            samples.some((sample) => sample.implementation === name),
          )
        )
          return null;
        const median = (name) =>
          quantile(
            samples
              .filter((sample) => sample.implementation === name)
              .map((sample) => sample.nsPerCall),
            0.5,
          );
        return median('ours') / median('theirs');
      });
      return result;
    })
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.bytes - b.bytes ||
        a.width - b.width ||
        (a.batchCalls || 0) - (b.batchCalls || 0),
    );
}

function formatSummary(entry) {
  const large = entry.kind === 'large-chunks' || entry.kind === 'large-file';
  let size = `${entry.bytes} bytes`;
  if (entry.kind === 'large-chunks')
    size += ` total (${entry.batchCalls} calls × ${entry.bytesPerCall} bytes)`;
  else if (large) size += ' total';
  else if (entry.batchCalls) size += ` ${entry.batchCalls} calls`;
  const duration = (value) => {
    if (!value) return 'N/A';
    return large
      ? `${value.medianMs.toFixed(3)} ms total`
      : `${(value.medianNs / 1000).toFixed(3)} us/call`;
  };
  const ratio = entry.oursOverTheirs === null ? 'N/A' : entry.oursOverTheirs.toFixed(3);
  return (
    `${entry.kind} ${size} XXH3-${entry.width}: ours ${duration(entry.ours)}, ` +
    `theirs ${duration(entry.theirs)}, ours/theirs ${ratio}`
  );
}

function makeBundle(competitor, destination, settings) {
  const modules = [];
  const add = (id, source) =>
    modules.push(`${JSON.stringify(id)}: function(module,exports,require){\n${source}\n}`);
  const transpileSource = (source) =>
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
  const transpile = (file) => transpileSource(read(file));
  for (const directory of ['src', 'native']) {
    for (const file of filesUnder(path.join(ROOT, directory), (file) => file.endsWith('.ts'))) {
      add('/' + path.relative(ROOT, file).slice(0, -3).split(path.sep).join('/'), transpile(file));
    }
  }
  add('/index', transpile(path.join(ROOT, 'index.ts')));
  add('/competitor', transpile(path.join(competitor, 'src/index.tsx')));
  const suite = settings.profile === 'latency' ? 'suite' : `${settings.profile}-suite`;
  add('/suite', read(path.join(__dirname, `${suite}.cjs`)));
  const baseline =
    settings.profile === 'ablation'
      ? JSON.parse(read(path.join(__dirname, 'ablation-baseline.json')))
      : { modules: [] };
  const baselineFactories = baseline.modules.map((entry) => {
    assert.equal(
      sha256(entry.source),
      entry.sourceSha256,
      'Frozen baseline source checksum differs',
    );
    return `${JSON.stringify(entry.id)}: function(module,exports,require){\n${transpileSource(entry.source)}\n}`;
  });
  const correctness = JSON.parse(read(path.join(ROOT, 'tests/vectors.json'))).strings.map(
    (fixture) => ({
      input: fixture.input,
      xxh3_64: fixture['64'],
      xxh3_128: fixture['128'],
    }),
  );
  const performance = [];
  for (const bytes of [1, 16, 64, 256, 1024, 16384, 65536, 1048576]) {
    for (const [kind, unit] of [
      ['ascii', 'abcdefghijklmnopqrstuvwxyz0123456789_-'],
      ['unicode', 'aБ中😀'],
    ]) {
      if (kind === 'unicode' && bytes === 1) continue;
      const repeat = Math.floor((bytes - 1) / Buffer.byteLength(unit));
      const tail = (bytes - 1) % Buffer.byteLength(unit);
      for (let index = 0; index < 16; index++) {
        const value = String.fromCharCode(65 + index) + unit.repeat(repeat) + 'x'.repeat(tail);
        assert.equal(Buffer.byteLength(value), bytes);
      }
      performance.push({ kind, bytes, unit, repeat, tail });
    }
  }
  fs.writeFileSync(
    destination,
    `
const modules={${modules.join(',\n')}};
const baselineFactories={${baselineFactories.join(',\n')}};
function makeLoader(overrides={},baseline=false) {
const cache=Object.create(null);
function load(request,parent='/index') {
 if(request==='react-native-nitro-modules') return {NitroModules:NitroModulesProxy};
 if(request==='react-native') return {Platform:{OS:'ios'},NativeModules:{},TurboModuleRegistry:{get(){throw Error('Unexpected competitor initialization')},getEnforcing(){throw Error('Unexpected Nitro initialization')}}};
 let id=request;
 if(id[0]==='.') {
   const normalized=[];
   for(const part of (parent.slice(0,parent.lastIndexOf('/'))+'/'+id).split('/')) {
     if(!part||part==='.')continue;
     if(part==='..')normalized.pop();else normalized.push(part);
   }
   id='/'+normalized.join('/');
 }
 if(Object.prototype.hasOwnProperty.call(overrides,id)) return overrides[id];
 if(cache[id])return cache[id].exports;
 const factory=baseline&&baselineFactories[id] ? baselineFactories[id] : modules[id];
 if(!factory)throw Error('Missing module '+id);
 const module={exports:{}};cache[id]=module;
 factory(module,module.exports,(next)=>load(next,id));
 return module.exports;
}
return load;
}
const load=makeLoader();
const settings=${JSON.stringify(settings)};
if(settings.profile==='ablation') load('/suite')((overrides,baseline=true)=>makeLoader(overrides,baseline),benchmarkNow,print,settings);
else if(settings.profile==='cold') load('/suite')(load,benchmarkNow,print,settings);
else if(settings.profile==='large') load('/suite')(load('/index'),load('/competitor'),benchmarkNow,print,settings,readBenchmarkString,readBenchmarkChunks,benchmarkFilePath);
else load('/suite')(load('/index'),load('/competitor'),benchmarkNow,print,${JSON.stringify({ correctness, performance })},settings);
`,
  );
  if (settings.profile === 'cold') return { cases: 3, expectedSamples: 6 };
  if (settings.profile === 'ablation')
    return { cases: 'available runtime stages', expectedSamples: null };
  if (settings.profile === 'bulk')
    return { cases: 18, stringsPerCase: 65_536, expectedSamples: 18 * settings.rounds * 2 };
  if (settings.profile === 'large')
    return { cases: 6, bytes: 500_000_000, expectedSamples: 6 * settings.rounds };
  return {
    correctnessVectors: correctness.length,
    cases: performance.length * 2,
    stringsPerCase: 16,
    expectedSamples: performance.length * 2 * settings.rounds * 2,
  };
}

function main() {
  const settings = readSettings();
  const { profile } = settings;
  assert.equal(
    process.platform,
    'darwin',
    'This benchmark requires the matching macOS release Hermes SDK',
  );
  assert(
    process.env.HERMES_ROOT && process.env.XXHASH_COMPETITOR_ROOT,
    'Set HERMES_ROOT and XXHASH_COMPETITOR_ROOT',
  );
  const hermes = path.resolve(process.env.HERMES_ROOT);
  const competitor = path.resolve(process.env.XXHASH_COMPETITOR_ROOT);
  const output = path.resolve(process.argv[2] || 'string-benchmark-results.json');
  const framework = path.join(hermes, 'Library/Frameworks/macosx');
  assert.equal(
    hashFile(path.join(framework, 'hermesvm.framework/hermesvm')),
    releaseHash,
    'Use the pinned Release Hermes framework, not a debug or different SDK',
  );
  assert(
    fs
      .readFileSync(path.join(hermes, 'include/jsi/jsi.h'))
      .equals(
        fs.readFileSync(path.join(ROOT, 'node_modules/react-native/ReactCommon/jsi/jsi/jsi.h')),
      ),
    'Hermes and React Native JSI headers differ',
  );
  assert.equal(run('git', ['-C', competitor, 'rev-parse', 'HEAD']).stdout.trim(), revision);
  assert.equal(
    run('git', ['-C', competitor, 'status', '--porcelain', '--untracked-files=no']).stdout.trim(),
    '',
    'Competitor source must be unmodified',
  );
  const compiler = requiredExecutable(process.env.CXX || 'clang++');
  const cCompiler = requiredExecutable(process.env.CC || 'clang');
  const hermesc = path.join(ROOT, 'node_modules/hermes-compiler/hermesc/osx-bin/hermesc');
  const hermescVersion = run(hermesc, ['--version']).stdout;
  assert(hermescVersion.includes('260318099.0.4'), 'Use a matching Hermes bytecode compiler');
  const productionScopes = ['index.ts', 'src', 'native', 'cpp', 'nitrogen/generated'];
  const sourceHashes = sourceManifest(ROOT, productionScopes);
  const benchmarkScopes = [path.relative(ROOT, __dirname)];
  const benchmarkSourceHashes = sourceManifest(ROOT, benchmarkScopes);
  const flags = [
    '-std=c++20',
    '-O3',
    '-DNDEBUG',
    '-fblocks',
    '-pthread',
    '-Wno-deprecated-declarations',
  ];
  withTemporaryDirectory('nitro-xxhash-string-benchmark-', (work) => {
    let fixture;
    let largeFixture;
    if (profile === 'large') {
      fixture = process.env.BENCHMARK_FILE
        ? path.resolve(process.env.BENCHMARK_FILE)
        : path.join(work, 'ascii-500000000.txt');
      if (!process.env.BENCHMARK_FILE)
        run(process.execPath, [path.join(__dirname, 'generate-file.cjs'), fixture]);
      assert.equal(fs.statSync(fixture).size, 500_000_000, 'Expected the exact 500 MB fixture');
      const hash = crypto.createHash('sha256');
      const descriptor = fs.openSync(fixture, 'r');
      const block = Buffer.alloc(1024 * 1024);
      try {
        let bytes;
        while ((bytes = fs.readSync(descriptor, block, 0, block.length, null)) > 0)
          hash.update(block.subarray(0, bytes));
      } finally {
        fs.closeSync(descriptor);
      }
      const checksum = hash.digest('hex');
      assert.equal(
        checksum,
        'b91095591ac8d7ae012050619010f4e628b7446dc1c6731f11cd068b18041b59',
        'Large fixture content differs',
      );
      largeFixture = {
        bytes: 500_000_000,
        sha256: checksum,
        chunkBytes: 250_000_000,
        xxh3_64: 'bbbb815f432b43af',
        xxh3_128: 'fa42d5cb1bfe7843bbbb815f432b43af',
        cache: 'naturally warmed by generation, checksum and correctness verification',
      };
    }
    const nitro = path.join(ROOT, 'node_modules/react-native-nitro-modules');
    const nitroScopes = ['cpp', 'ios/platform', 'ios/threading'];
    const nitroSourceHashes = sourceManifest(nitro, nitroScopes);
    const includes = nitroHeaderMap(
      path.join(nitro, 'cpp'),
      path.join(work, 'include/NitroModules'),
    );
    const arguments_ = [
      ...flags,
      '-I',
      path.join(hermes, 'include'),
      '-I',
      path.join(work, 'include'),
      '-I',
      path.join(ROOT, 'cpp'),
      '-I',
      path.join(ROOT, 'nitrogen/generated/shared/c++'),
      '-I',
      path.join(nitro, 'ios/threading'),
    ];
    for (const directory of includes) arguments_.push('-I', directory);
    const sources = filesUnder(
      path.join(nitro, 'cpp'),
      (file) =>
        file.endsWith('.cpp') &&
        !path.relative(path.join(nitro, 'cpp'), file).split(path.sep).includes('views'),
    );
    for (const directory of [
      path.join(nitro, 'ios/platform'),
      path.join(nitro, 'ios/threading'),
      path.join(ROOT, 'nitrogen/generated/shared/c++'),
      path.join(ROOT, 'cpp'),
    ]) {
      sources.push(
        ...filesUnder(
          directory,
          (file) => path.dirname(file) === directory && file.endsWith('.cpp'),
        ),
      );
    }
    const competitorObject = path.join(work, 'competitor-xxhash.o');
    run(cCompiler, [
      '-O3',
      '-DNDEBUG',
      '-std=c11',
      '-c',
      path.join(competitor, 'cpp/xxhash.c'),
      '-o',
      competitorObject,
    ]);
    sources.push(
      path.join(competitor, 'cpp/react-native-xxhash.cpp'),
      path.join(__dirname, 'host.cpp'),
    );
    const binary = path.join(work, 'host');
    console.log('Building both original implementations with -O3 and Release Hermes');
    run(
      compiler,
      [
        ...arguments_,
        ...sources,
        competitorObject,
        '-F',
        framework,
        '-framework',
        'hermesvm',
        '-framework',
        'Foundation',
        `-Wl,-rpath,${framework}`,
        '-o',
        binary,
      ],
      { stdio: 'inherit', timeout: 300_000 },
    );
    const processes = [];
    let fixtureSummary;
    for (let index = 0; index < settings.processes; index++) {
      const source = path.join(work, `bundle-${index}.js`);
      const bytecode = path.join(work, `bundle-${index}.hbc`);
      fixtureSummary = makeBundle(competitor, source, {
        ...settings,
        coldWidth: index % 2 === 0 ? 64 : 128,
        seed: 0x27ab421 + (profile === 'cold' ? Math.floor(index / 2) : index),
      });
      run(hermesc, ['-O', '-emit-binary', '-out', bytecode, source]);
      console.log(
        `Measuring fresh process ${index + 1}/${settings.processes}, ${fixtureSummary.cases} cases, ${settings.rounds} rounds`,
      );
      const result = run(binary, fixture ? [bytecode, fixture] : [bytecode], { timeout: 600_000 });
      const events = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const complete = events.filter((event) => event.event === 'result');
      assert.equal(complete.length, 1);
      assert.equal(
        complete[0].samples.length,
        fixtureSummary.expectedSamples ?? complete[0].cases * settings.rounds,
      );
      processes.push(complete[0]);
      console.log(
        `Process ${index + 1}: ${complete[0].checks} correctness checks, ${complete[0].samples.length} timed batches`,
      );
    }
    verifySourceManifest(ROOT, productionScopes, sourceHashes, 'Production source');
    verifySourceManifest(nitro, nitroScopes, nitroSourceHashes, 'Nitro source');
    verifySourceManifest(ROOT, benchmarkScopes, benchmarkSourceHashes, 'Benchmark source');
    assert.equal(run('git', ['-C', competitor, 'rev-parse', 'HEAD']).stdout.trim(), revision);
    assert.equal(
      run('git', ['-C', competitor, 'status', '--porcelain', '--untracked-files=no']).stdout.trim(),
      '',
      'Competitor source changed during measurement',
    );
    const result = {
      measuredAt: new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      cpu: os.cpus()[0].model,
      os: os.release(),
      compiler: run(compiler, ['--version']).stdout,
      flags,
      hermesVersion: '260318099.0.4',
      hermesFlavor: 'release',
      hermesBinarySha256: releaseHash,
      hermescVersion,
      competitorRevision: revision,
      competitorVersion: JSON.parse(read(path.join(competitor, 'package.json'))).version,
      ourVersion: JSON.parse(read(path.join(ROOT, 'package.json'))).version,
      ourTreeSha256: sha256(JSON.stringify(sourceHashes)),
      sourceHashes,
      benchmarkSourceHashes,
      nitroSourceHashes,
      ablationBaseline:
        profile === 'ablation'
          ? (() => {
              const control = JSON.parse(read(path.join(__dirname, 'ablation-baseline.json')));
              return {
                productionTreeSha256: control.productionTreeSha256,
                modules: control.modules.map(({ id, sourceSha256 }) => ({ id, sourceSha256 })),
              };
            })()
          : undefined,
      largeFixture,
      fixtureSummary,
      settings,
      processes,
      summary: summarize(processes),
    };
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    for (const entry of result.summary) console.log(formatSummary(entry));
    console.log(`Raw samples and provenance: ${output}`);
  });
}

if (require.main === module) main();
module.exports = { summarize, formatSummary, readSettings };
