# Contributing

Use Node.js 24.3+ within the 24.x line or Node.js 26+ and npm for repository development. The package and development tooling follow the [RN 0.88 baseline](docs/compatibility.md#versions-and-platform-baseline), with matching SDK tools pinned for development. Native checks require clang++ with ASan/UBSan runtimes and a JDK. All test and validation runners use Node.js.

## Local checks

```sh
npm ci
node compat/cli.cjs
npm run specs
npm run lint
npm run lint:native:prepare
npm run lint:native
npm run typecheck
npm run typecheck:runtime
npm run build
npm run test:types
npm run test:expo
node --test tests/native/strings/*.test.cjs
npm test
npm run test:bindings
npm run test:file-executor
npm run test:threadpool-startup
npm run test:nitro-cache
npm run test:android-loader
npm run format:check
npm run format:native:check
npm run check:specs
npm run check:package
```

`node compat/cli.cjs` is the repository equivalent of the consumer's `nitro-xxhash-compat` command. Repeat it after installing dependencies. The [compatibility guide](docs/compatibility.md#nitro-0371-repairs) explains inspection mode, package-manager patch workflows and the required rebuild of Nitro and its native consumers.

The root is the publishable package. Change specs in `src/specs/*.nitro.ts` and handwritten native sources, then run `npm run specs`. Include regenerated `nitrogen/generated` files with the source change; never edit them manually. `npm run check:specs` verifies reproducibility.

ESLint checks TypeScript and JavaScript; Prettier owns repository text formatting. `npm ci` installs the pinned clang-format and clang-tidy binaries, so keep optional dependencies enabled. Use `npm run lint:fix`, `npm run format` and `npm run format:native` to apply fixes. Native formatting includes handwritten C++/Java and C++ tests; generated bindings and the vendored xxHash header are excluded. `CLANG_FORMAT` and `CLANG_TIDY` can select existing binaries.

`lint:native:prepare` downloads checksum-pinned fbjni/Hermes AARs and extracts headers into `node_modules/.cache/nitro-xxhash-lint`. Update those pins when changing the RN development dependency. `lint:native` checks the shared/scalar C++, JNI bootstrap, Hermes host and native tests. Preserve its deliberate analyzer-failure probes. `FBJNI_INCLUDE_DIR` and `HERMES_INCLUDE_DIR`/`HERMES_ROOT` can select matching headers.

The JS suites cover public API behavior, stream cleanup and cancellation ownership. Native suites cover algorithms, ranges, cloned state, file operations and concurrency. `test:android-loader` checks the real Java loader on a host JVM. `test:nitro-cache` and `test:nitro-registry` use isolated SDK copies; preserve that isolation when changing fixtures.

The Expo config plugin is published with the package and uses Expo's config plugin APIs only during native generation. Keep app config evaluation free of dependency writes, reuse the guarded compatibility helper and preserve repeatable prebuild behavior. Run `npm run validate:expo` for the isolated Expo SDK 58 prebuild check. When changing the plugin, check both platform selections, repeated generation, `--no-clean`, `"check"` mode, conflicting Nitro sources and the opt-in AGP 9 properties. Prebuild validation does not replace full native builds. Consumer configuration belongs in the [Expo setup guide](docs/compatibility.md#expo-prebuild).

For additional race checks, use `NITRO_CACHE_TSAN=1 npm run test:nitro-cache` or `NITRO_REGISTRY_TSAN=1 npm run test:nitro-registry`. Add `NITRO_REGISTRY_DEBUG=1` for cold Debug registry concurrency. Linux worker-startup fault injection requires Clang's shared ASan runtime for the compiler target.

## Native platform checks

### Example application

The [example application](example/README.md) consumes the actual npm archive and exercises strings, offset byte views, files and incremental state through the native module:

```sh
npm run example:setup
npm run example:typecheck
npm run example:ios
# Or: npm run example:android
```

Run **Run all checks** on each platform before a release. Refresh the example with `example:setup` after library changes; the command updates the local archive's lockfile integrity while keeping registry dependencies locked. Platform scripts apply the Expo config plugin before native builds, including when native directories already exist. Keep generated native projects and packed archives local, and keep all `example/` files out of the published package. CI installs and typechecks the app before linting its TypeScript.

### Platform validators

Android validation requires JDK 17, the profile's SDK/build tools and NDK, CMake 3.22.1, and the specified Gradle executable. The `rn88` profile is a reproducible host override fixture, not the library defaults or exact versions imposed on consumers:

| Profile | RN     | AGP / Gradle  | Minimum / compile / target SDK | NDK           | Kotlin |
| ------- | ------ | ------------- | ------------------------------ | ------------- | ------ |
| `rn88`  | 0.88.0 | 9.3.1 / 9.6.0 | 26 / 37 / 37                   | 30.0.16248370 | 2.2.0  |

The runner infers the profile from the installed RN dependency or accepts `--profile rn88`. To use a separate host's installed dependencies:

```sh
ANDROID_HOME=/path/to/android-sdk GRADLE_BIN=/path/to/gradle-9.6.0/bin/gradle \
  npm run validate:android -- --profile rn88 \
  --dependencies-root /path/to/rn88-host --output /path/to/validation-results
```

The host directory must contain matching RN, React and Nitro packages in `node_modules`. The runner copies native sources into an isolated fixture and checks Java/codegen, all Android ABIs, AAR contents, effective host settings and project/prebuilt consumer merges with matching Hermes. It skips JS bundling. `--output` retains artifacts and source manifests; `--keep-fixture` also preserves successful fixtures. Failed fixtures remain available for diagnosis.

Add `--config-only` to the command above to check effective host/Nitro toolchain settings and source isolation without compiling or producing an AAR. This mode still configures Gradle and resolves its required dependencies; it does not verify project/prebuilt consumer merges.

For iOS, install Xcode and CocoaPods, then run:

```sh
npm run validate:ios-sources
npm run validate:nitro-ios-compat
```

Both default to deployment target 15.1; `IOS_DEPLOYMENT_TARGET` selects a higher target. The source check evaluates the podspec and compiles C++/Objective-C++ for arm64 device and Simulator. The strict exception-import regression requires Xcode 27 and compiles Nitro's actual Swift/C++ paths before and after the repair. These checks do not replace full application linking or runtime tests.

Use `tests/runtime.ts` in a separate React Native host to check the public API. Install the packed package, apply its compatibility helper, and exercise cold import, first use, repeated calls, invalid input, native reload and failure recovery. Follow the [application lifecycle requirements](docs/compatibility.md#ios-app-lifecycle-with-xcode-27) when configuring an iOS host.

Keep Nitro, React Native and their imported native libraries out of this package's AAR; the consuming host supplies them. Verify project and prebuilt-AAR consumption whenever native linking or packaging changes.

## Hermes integration and benchmarks

The macOS integration checks require a matching Hermes `destroot` with framework and headers:

```sh
HERMES_ROOT=/absolute/path/to/hermes-engine/destroot npm run test:hermes
HERMES_ROOT=/absolute/path/to/hermes-engine/destroot npm run test:nitro-registry
```

The [CI workflow](.github/workflows/ci.yml) pins the Release SDK archive and checksum. Update them alongside the RN dependency; the test commands do not fetch an engine. JSI headers must match the installed React Native version.

The optional string benchmark requires that Release SDK and an unmodified checkout of `pioner92/react-native-xxhash` at the revision pinned in [the runner](tests/native/strings/run.cjs):

```sh
HERMES_ROOT=/absolute/path/to/hermes-engine/destroot \
XXHASH_COMPETITOR_ROOT=/absolute/path/to/react-native-xxhash \
  npm run bench:strings -- /path/to/results.json
```

`BENCHMARK_PROFILE` selects `latency`, `bulk`, `cold`, `large` or `ablation`. Keep generated reports outside the source tree.

## Maintenance rules

Preserve exact byte-view offsets, lengths and backing allocations in ordinary hash functions and `HashStream.update()`. Do not normalize views by copying or converting their elements. Keep imports and Android library loading lazy; iOS constructor registration through generated `+load` remains separate from first-use HybridObject creation.

Maintain `compat/` against exact Nitro source contents. Preserve version/source guards and regression checks when updating the peer, and rebuild Nitro with all native consumers of its headers. Keep an active file operation's admission slot until native settlement, and keep its dedicated workers independent of Nitro's shared pool.

CI checks formatting, lint, generated bindings, API/core tests and package contents. It also runs the Android host fixture and iOS source/type checks against RN 0.88, and repeats JS/GC, compatibility-helper and Expo plugin tests on the minimum Node version. The strict exception-import check runs when Xcode 27 or newer is selected; older toolchains still run source checks. Full app builds and device tests remain separate contributor checks.

## Documentation website

The Docusaurus site is in `website/`, with authored content in `docs/`. Install its dependencies separately from the native package:

```sh
npm ci
npm ci --prefix website
npm run build
npm run docs:check
npm run docs:build
npm run docs:serve -- --port 4173
```

For live editing, use `npm run docs:start`. Preview the project path `/react-native-nitro-xxhash/`, including direct navigation to nested pages. Check desktop/mobile layouts, code blocks, sidebar navigation, search and both color themes.

Ordinary `ts` and `typescript` fenced examples are checked against emitted public declarations with strict optional properties and React Native globals, without DOM or Node ambient types. Optional Expo integration examples use the declarations bundled with the development Expo installation. Expo fetch examples additionally use standard stream declarations from the website's development dependencies, isolated from bare React Native examples; no polyfill runs at runtime. These checks do not add runtime dependencies to the hashing package. Keep each example self-contained. Use `ts api-signature` only for declaration/reference blocks that are intentionally not executable consumer examples.

The site generates `docs/api/exports.md` from public TypeScript exports and JSDoc, and `docs/contributing.md` from this file. Edit the source or canonical API pages rather than generated outputs. The generator rejects exports without a reference mapping. Site dependencies, generated pages, caches and build output are excluded from the npm package.

The [documentation workflow](.github/workflows/docs.yml) validates pull requests and deploys main-branch builds through GitHub Pages. In the public repository, select **Settings → Pages → Build and deployment → GitHub Actions**. The configured address is `https://NikitaDudin.github.io/react-native-nitro-xxhash/`; no custom domain or paid hosting is required. GitHub repository access is needed for the initial push and enabling Pages.

## Manual release

Record notable user-facing changes in [CHANGELOG.md](CHANGELOG.md) under `Unreleased`. Keep unpublished work there without a release date. When publishing, move those entries into a `## <version> - YYYY-MM-DD` section using the publication date, remove any outdated development-status note and retain an empty `Unreleased` section for future changes. Describe API, behavior and compatibility changes rather than listing commits.

The configured repository is `NikitaDudin/react-native-nitro-xxhash`. Before publishing, create the repository, confirm ownership of the npm name and complete relevant native host checks. Set the release version in `package.json` and refresh `package-lock.json` with `npm install --package-lock-only`.

Run the local checks, then `npm pack`. Its `prepack` script regenerates bindings, builds JavaScript/declarations and verifies package contents. Inspect that exact tarball and install it in native hosts, applying `nitro-xxhash-compat` before native builds. CI produces an artifact and does not publish it.

Authenticate with npm and publish the reviewed tarball explicitly:

```sh
npm login
npm publish ./react-native-nitro-xxhash-0.1.0.tgz --access public
```

Use the actual version's filename. Tag the reviewed release as `v<version>` and create the matching GitHub release; the podspec uses that tag. See the [npm publish documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
