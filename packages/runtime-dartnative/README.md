# Runtime Inspector — DartNative adapter (experimental)

An **opt-in, pure-Dart** RIP 0.3 runtime adapter for a DartNative app. This is
an isolated spike on `feat/dartnative-adapter`, **not** a published plugin or a
claim of working device integration yet.

It uses Runtime Inspector's existing WebSocket broker, web panel and MCP
client. There is no new UI and no alternative wire protocol. Parameters are
read again for the **next animation**; already running compositor/native
animations are not altered.

## Usage

After starting `npx runtime-inspector dev` in a project that has the existing
Runtime Inspector CLI, use its listening host and port (default `4577`):

```dart
import 'package:runtime_inspector_dartnative/runtime_inspector_dartnative.dart';

final inspector = RuntimeInspectorDartNative(
  brokerUrl: Uri.parse('ws://192.168.1.20:4577'), // your development machine
  schemaId: 'sheet',
  title: 'Sheet motion',
);

final spring = inspector.registerSpring(
  id: 'open.spring',
  label: 'Open spring',
  initial: const SpringParameters(damping: 18, stiffness: 240, mass: 1),
  onChange: (value) => print('Next gesture: ${value.damping}'),
);

inspector.registerAction(id: 'replay', label: 'Replay', onTrigger: replaySheet);
inspector.connect();

// When the gesture starts again, pass `spring.value` to the animation API.
// In the owning StatefulWidget.dispose(): unawaited(inspector.dispose());
```

The isolated, provisional DartNative screen is in
[`example/lib/main.dart`](example/lib/main.dart). It needs validation against
DN's current private framework and a real iOS/Android device before claiming
support for `AnimationController.fling` / `SpringDescription` or publishing.

### Important limits

- **No discovery:** controls must be registered explicitly. The framework's
  private internals are not accessed.
- **No write-back:** Dart source anchors and source editing are not implemented.
- **Debug only:** the runtime never connects from `dart.vm.product` builds,
  even if someone sets `enabled: true`. Additionally `enabled: false` can turn
  it off in development. Remove the package from shipped apps when possible.
- **LAN:** an explicit WebSocket URL is required; `localhost` on a phone is
  the phone, not the development machine. Connect only to a trusted developer
  broker. Authentication is dev-grade and broker tokens are for panel/workspace
  roles, not runtime roles.
- **Network permissions:** iOS ATS / Android cleartext development permissions
  may need configuration for `ws://` on a physical device.
- **Reconnect:** a dropped connection retries on the same URL; the broker's
  cached schema is refreshed after the new handshake. Call `dispose()` on
  unmount/hot-reload teardown to send `schema.dispose` when possible.
- **No platform spring parity claim** until testing `fling(spring:)` on both
  platforms.

## Checks

Self-contained wire smoke test (no dependencies other than the Dart SDK):

```bash
dart run tool/smoke_test.dart
```

It creates a local WebSocket server, exercises the RIP 0.3 handshake, schema
publish/dispose, patch, commit, batchPatch, trigger, invalid-value reporting,
and disabled mode. It does **not** run a DN app, and it is not a replacement for
device validation or protocol fixture conformance.

## Next validation gate

1. On Windows, install current DN/Zero SDK + Android SDK 36 and connect an
   Android phone over USB. See [the Windows / Android walkthrough](example/README.md).
   The official DartNative playground is free to run; custom examples may
   require a DN plan or an authorized trial.
2. Start the existing Runtime Inspector broker + web panel; use `adb reverse`
   to expose port 4577 to the Android app at `ws://127.0.0.1:4577`.
3. Compile this provisional example against the current private DN SDK,
   checking whether `SpringDescription` and `fling(spring:)` are exposed.
4. Tune a spring, replay the gesture, and observe the next fling on device.
5. Repeat on iOS/macOS later. Verify hot reload/restart and production network
   absence before publishing.

Technical design and maintainer questions: [`rfcs/0009-dartnative-runtime-adapter.md`](../../rfcs/0009-dartnative-runtime-adapter.md).
