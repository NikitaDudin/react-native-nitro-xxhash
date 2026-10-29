# xxHash example

A single-screen Expo SDK 58 / React Native 0.88 application that exercises the published library API through its real native module.

## Run

From the repository root:

**npm**

```sh
npm ci
npm run example:setup
npm run example:ios
# Or: npm run example:android
```

**Yarn Classic 1.x**

```sh
npm ci
yarn example:setup
yarn example:ios
# Or: yarn example:android
```

The repository and example retain their npm lockfiles. Use `npm ci` for the root dependencies; Yarn Classic can launch the scripts, while setup uses npm to pack and install the example's local library archive. For installation into your own Yarn application, follow the [installation guide](../docs/installation.md).

Use the [supported Node.js and native toolchains](../docs/compatibility.md). Expo SDK 58 requires iOS 16.4 or newer. Android uses the SDK/NDK choices supplied by its Expo template. Expo Go cannot run this module.

The setup command runs the library's publication checks, packs it into an ignored `.artifacts/` directory and installs that archive into the app. The app and library share one app-owned Nitro installation. Registry dependencies retain the versions in `package-lock.json`; refreshing the archive updates its lockfile integrity.

The platform scripts run prebuild before the native build, so the bundled config plugin prepares Nitro after a dependency reinstall. Generated `ios/` and `android/` directories remain local. Metro uses IPv4 localhost on port **8083**, which also works with Android's port forwarding; an existing project on 8081 can keep running.

To start Metro separately or check the application types:

**npm**

```sh
npm run example:start
npm run example:typecheck
```

**Yarn Classic**

```sh
yarn example:start
yarn example:typecheck
```

After changing library code, repeat `example:setup` and the platform command to refresh the installed archive and native build. Clean native build caches when changing C++/Swift/Kotlin sources or Nitro compatibility repairs. Changes to the example's own React code can use Fast Refresh.

## Reference checks

Tap **Run all checks**. The screen should report **4/4 checks passed** with the XXH3-64 digest `9555e8555c62dcfd` for `hello`:

- UTF-8 string hashing; the text field also accepts custom input.
- A `Uint8Array` at byte offset 2 and length 5, excluding sentinel bytes around the view.
- A local file created in an app-owned cache directory and removed after hashing.
- Incremental updates from a string and a byte view, with state disposed in `finally`.

The reference digest comes from upstream xxHash. A mismatch throws and appears as an error on the screen. Custom text displays its digest without claiming a reference check passed.

The app is excluded from the library's npm archive. Its UI is a native integration check; the library's existing tests cover the wider API and failure cases.
