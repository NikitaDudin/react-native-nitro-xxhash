const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, run, withTemporaryDirectory } = require('../scripts/native-test-utils.cjs');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const entry = process.env.NITRO_XXHASH_TEST_LIB
  ? path.resolve(process.env.NITRO_XXHASH_TEST_LIB, 'index.d.ts')
  : path.resolve(ROOT, manifest.types);

for (const mode of ['react-native', 'node']) {
  test(`public declarations support exact optional properties in ${mode} without DOM`, () => {
    assert(fs.existsSync(entry), 'Build declarations with npm run build before testing types');
    withTemporaryDirectory('nitro-xxhash-public-types-', (temporary) => {
      const modules = path.join(temporary, 'node_modules');
      const dependency = path.join(modules, manifest.name);
      fs.mkdirSync(dependency, { recursive: true });
      // Copy declarations alone, so source files cannot hide a broken public entry.
      fs.cpSync(path.dirname(entry), path.join(dependency, path.dirname(manifest.types)), {
        recursive: true,
        filter: (file) => fs.statSync(file).isDirectory() || file.endsWith('.d.ts'),
      });
      fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify(manifest));
      fs.symlinkSync(path.join(ROOT, 'node_modules/@types'), path.join(modules, '@types'), 'dir');
      if (mode === 'react-native')
        fs.symlinkSync(
          path.join(ROOT, 'node_modules/react-native'),
          path.join(modules, 'react-native'),
          'dir',
        );
      fs.copyFileSync(
        path.join(ROOT, 'tests/types/public-consumer.ts'),
        path.join(temporary, 'public.ts'),
      );
      if (mode === 'node')
        fs.copyFileSync(
          path.join(ROOT, 'tests/types/node-reader-consumer.ts'),
          path.join(temporary, 'node.ts'),
        );
      const configuration = {
        compilerOptions: {
          target: 'ES2020',
          module: 'Node16',
          moduleResolution: 'Node16',
          strict: true,
          exactOptionalPropertyTypes: true,
          lib: ['ESNext'],
          types: mode === 'node' ? ['node'] : ['react', 'react-native'],
          // RN's own declarations have independently reproducible baseline errors.
          skipLibCheck: mode === 'react-native',
          noEmit: true,
        },
        files: mode === 'node' ? ['public.ts', 'node.ts'] : ['public.ts'],
      };
      const project = path.join(temporary, 'tsconfig.json');
      fs.writeFileSync(project, JSON.stringify(configuration));
      const result = run(process.execPath, [
        require.resolve('typescript/bin/tsc'),
        '-p',
        project,
        '--listFiles',
      ]);
      assert(
        !/[/\\]lib\.dom(?:\.[^/\\]+)?\.d\.ts/.test(result.stdout),
        'DOM types must stay absent',
      );
      if (mode === 'react-native')
        assert(
          !result.stdout.includes('/@types/node/'),
          'RN consumer must not load Node ambient types',
        );
      assert(result.stdout.includes(path.join(dependency, manifest.types.replace(/^\.\//, ''))));
    });
  });
}
