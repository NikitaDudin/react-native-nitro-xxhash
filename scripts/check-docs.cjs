const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'lib/index.d.ts');
assert(fs.existsSync(entry), 'Run npm run build before checking documentation examples.');
const expoDirectory = path.dirname(require.resolve('expo/package.json'));
const integrationTypes = Object.fromEntries(
  ['expo-asset', 'expo-file-system'].map((name) => {
    const manifest = require.resolve(`${name}/package.json`, { paths: [expoDirectory] });
    const { types } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert(types, `${name} must expose declarations for documentation examples.`);
    return [name, [path.resolve(path.dirname(manifest), types)]];
  }),
);

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const file = path.join(directory, item.name);
    return item.isDirectory() ? markdownFiles(file) : /\.mdx?$/.test(file) ? [file] : [];
  });
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-xxhash-doc-examples-'));
try {
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), 'dir');
  const examples = [];
  for (const file of [path.join(root, 'README.md'), ...markdownFiles(path.join(root, 'docs'))]) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^```(ts|typescript)([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm)) {
      if (/\bapi-signature\b/.test(match[2])) continue;
      const filename = path.join(temporary, `example-${examples.length + 1}.ts`);
      const line = source.slice(0, match.index).split('\n').length + 1;
      const origin = `${path.relative(root, file)}:${line}`;
      fs.writeFileSync(filename, `${match[3]}\nexport {};\n`);
      examples.push({ filename, origin, streams: /\bfrom\s*['"]expo\/fetch['"]/.test(match[3]) });
    }
  }
  assert(examples.length > 0, 'No executable TypeScript documentation examples found.');
  const diagnostics = [];
  for (const streams of [false, true]) {
    const group = examples.filter((example) => example.streams === streams);
    if (!group.length) continue;
    const files = group.map(({ filename }) => filename);
    const paths = { 'react-native-nitro-xxhash': [entry], ...integrationTypes };
    if (streams) {
      const streamTypes = require.resolve('web-streams-polyfill/types/ponyfill.d.ts', {
        paths: [path.join(root, 'website')],
      });
      paths['web-streams-polyfill'] = [streamTypes];
      const ambient = path.join(temporary, 'expo-stream-types.d.ts');
      // Expo exposes a global stream type. Supply real stream declarations only
      // to its examples; bare RN examples must remain independent of that global.
      fs.writeFileSync(
        ambient,
        "import type { ReadableStream as Stream } from 'web-streams-polyfill';\n" +
          'declare global { type ReadableStream<R = unknown> = Stream<R>; }\n',
      );
      files.push(ambient);
    }
    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: true,
      noEmit: true,
      lib: ['lib.esnext.d.ts'],
      types: ['react-native'],
      paths,
    });
    assert(
      !program
        .getSourceFiles()
        .some((file) => /[/\\]lib\.dom(?:\.[^/\\]+)?\.d\.ts$/.test(file.fileName)),
      'Documentation examples must not load DOM ambient declarations.',
    );
    assert(
      !program.getSourceFiles().some((file) => /[/\\]@types[/\\]node[/\\]/.test(file.fileName)),
      'Documentation examples must not load Node ambient declarations.',
    );
    diagnostics.push(...ts.getPreEmitDiagnostics(program));
  }
  if (diagnostics.length) {
    for (const diagnostic of diagnostics) {
      const example = examples.find(({ filename }) => filename === diagnostic.file?.fileName);
      const location = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start || 0);
      console.error(
        `${example?.origin || diagnostic.file?.fileName || 'Documentation'} ` +
          `${location ? `(example line ${location.line + 1}) ` : ''}` +
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Checked ${examples.length} TypeScript documentation examples against public declarations.`,
    );
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
