# Windows → Android device validation (experimental)

This is a proposed device-validation path, **not yet verified against an
installed DartNative SDK**. The pure-Dart adapter passes wire tests, but the
example's `SpringDescription` export and `AnimationController.fling(spring:)`
usage must be compiled and tested on a real device.

## 0. DartNative and Android prerequisites

Install the DartNative `dn` CLI using the
[official Windows instructions](https://dartnative.com/docs/getting-started/installation/).
Install Android Studio's Android SDK Platform **36**, Build-Tools **36.0.0**,
and Platform-Tools. Enable USB debugging and authorize the Windows PC on your
Android phone. Check in PowerShell:

```powershell
dn --version
dn doctor
adb devices
```

The phone should appear with status `device`, not `unauthorized`.

**License gate:** DartNative documents that its official playground/tutorials
are free without an account, whereas custom projects require a license or
valid trial. Do not assume the Runtime Inspector example qualifies as an
official demo; ask DN for evaluation access if you cannot build it.

To confirm the toolchain independently, clone
`https://github.com/DartNative/dartnative`, enter `playground`, then run
`dn pub get` and `dn run`. This tests DN itself, *not* Runtime Inspector.

## 1. Start the Runtime Inspector broker on Windows

From the `feat/dartnative-adapter` branch of the Runtime Inspector repo:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm -r build
corepack pnpm --filter @runtime-inspector/cli dev
```

Keep this terminal open and open the local panel URL printed by the CLI.
Do **not** run the root `pnpm dev` script in PowerShell: it contains POSIX
shell syntax. The filtered CLI command above is the Windows-compatible route.

Do not accidentally fetch the unrelated `runtime-inspector` npm package.
The CLI in this repository is `@runtime-inspector/cli`.

## 2. Reverse the WebSocket port over USB

In another PowerShell terminal:

```powershell
adb reverse tcp:4577 tcp:4577
adb reverse --list
```

The Android app can then reach the PC's local broker through
`ws://127.0.0.1:4577`. Re-apply the reverse after reconnecting USB.
This is preferable to exposing the developer broker over the LAN for a
single-device test.

## 3. Scaffold and run the provisional DN app

In the example folder:

```powershell
cd packages/runtime-dartnative/example
dn create .
dn pub get
dn run --dart-define=INSPECTOR_URL=ws://127.0.0.1:4577
```

`dn create .` is intended to generate missing native app scaffolding; inspect
its output and preserve the existing `pubspec.yaml` and `lib/main.dart`.
If it wants to overwrite either, stop and resolve that deliberately.

Verify the generated Android debug manifest permits the app's local
WebSocket connection. If needed, merge these declarations into
`android/app/src/debug/AndroidManifest.xml` (do not replace other entries):

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <application android:usesCleartextTraffic="true" />
</manifest>
```

The cleartext allowance is **for debug only**. Do not place it in the main
or release manifest; never ship a developer broker connection.

## 4. Acceptance checklist

1. The app starts and displays a tappable card.
2. The Runtime Inspector web panel lists `DN spring tuning`.
3. Change damping/stiffness. The `dn run` terminal prints the new values.
4. Tap the card again (or trigger `Replay card` from the panel). The *next*
   animation behaves differently; an already running native animation need
   not retarget.
5. Drop and restore the broker connection; controls appear again.
6. Check hot reload/restart, then verify a release build never connects.

### Expected integration unknowns

- `SpringDescription` may not be publicly exported from
  `package:dartnative/dartnative.dart`; the example has not been compiled
  against the private SDK. Save the **exact** compiler error if it fails.
- The custom example may require a DN license/trial even when the official
  playground runs for free.
- On some Android configurations, a debug-specific cleartext exception is
  required for `ws://`; do not relax release network policy.

Bring the `dn doctor` output, the first `dn run` error, and the app/broker
logs to the next iteration.
