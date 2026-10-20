// No external dependencies: run with `dart run tool/smoke_test.dart` after
// installing Dart, or `dartvm tool/smoke_test.dart` with the SDK VM directly.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../lib/src/runtime_inspector.dart';

Future<void> main() async {
  await _checksRegistrationAndDisabledMode();
  await _checksWireProtocolAndValidation();
  stdout.writeln('runtime-dartnative smoke checks passed');
}

void _expect(bool condition, String message) {
  if (!condition) throw StateError(message);
}

Future<void> _checksRegistrationAndDisabledMode() async {
  final disabled = RuntimeInspectorDartNative(
    brokerUrl: Uri.parse('ws://127.0.0.1:49998'),
    schemaId: 'disabled',
    title: 'Disabled test',
    enabled: false,
  );
  disabled.registerSpring(
    id: 'bounce',
    label: 'Bounce',
    initial: const SpringParameters(damping: 18, stiffness: 240),
    onChange: (_) {},
  );
  await disabled.connect();
  _expect(!disabled.isConnected, 'Disabled adapter must not connect.');
  var duplicateRejected = false;
  try {
    disabled.registerSpring(
      id: 'bounce',
      label: 'Duplicate',
      initial: const SpringParameters(damping: 18, stiffness: 240),
      onChange: (_) {},
    );
  } on StateError catch (error) {
    duplicateRejected = error.message.startsWith('Duplicate inspector');
  }
  _expect(duplicateRejected, 'Duplicate ID must throw.');
  await disabled.dispose();
}

Future<void> _checksWireProtocolAndValidation() async {
  final broker = await _FakeBroker.start();
  final errors = <String>[];
  final settingsSeen = <SpringParameters>[];
  var triggerCount = 0;

  final adapter = RuntimeInspectorDartNative(
    brokerUrl: broker.url,
    schemaId: 'dn-motion',
    title: 'DN Motion',
    reconnect: false,
    onDiagnostic: errors.add,
  );
  final spring = adapter.registerSpring(
    id: 'sheet.spring',
    label: 'Sheet spring',
    initial: const SpringParameters(damping: 18, stiffness: 240),
    onChange: settingsSeen.add,
  );
  adapter.registerAction(
    id: 'sheet.replay',
    label: 'Replay sheet',
    onTrigger: () => triggerCount++,
  );

  try {
    final published = broker.next('schema.publish');
    await adapter.connect();
    final schema = (await published)['schema'] as Map<String, dynamic>;
    _expect(schema['id'] == 'dn-motion', 'Expected scoped DN schema.');
    final groups = schema['groups'] as List;
    _expect(groups.length == 2, 'Expected spring and trigger groups.');
    _expect(adapter.isConnected, 'Handshake should mark runtime connected.');

    // The callback arrives asynchronously over the WebSocket connection.
    broker.send({
      'type': 'control.patch',
      'schemaId': 'dn-motion',
      'controlId': 'sheet.spring',
      'value': {'damping': 22, 'stiffness': 320, 'mass': 1},
    });
    await _until(() => settingsSeen.length == 1);
    _expect(spring.value.damping == 22, 'Patch must update live spring.');

    broker.send({
      'type': 'control.commit',
      'schemaId': 'dn-motion',
      'controlId': 'sheet.spring',
      'value': {'damping': 24, 'stiffness': 350},
    });
    await _until(() => settingsSeen.length == 2);
    _expect(spring.value.mass == 1, 'Missing mass defaults to 1.');

    broker.send({
      'type': 'control.batchPatch',
      'schemaId': 'dn-motion',
      'patches': [
        {
          'controlId': 'sheet.spring',
          'value': {'damping': 25, 'stiffness': 380},
        },
      ],
    });
    await _until(() => settingsSeen.length == 3);

    final rejected = broker.next('error');
    broker.send({
      'type': 'control.patch',
      'schemaId': 'dn-motion',
      'controlId': 'sheet.spring',
      'value': {'damping': -100, 'stiffness': 380},
    });
    final rejection = await rejected;
    _expect(
      rejection['code'] == 'INVALID_CONTROL_VALUE',
      'Invalid spring must report rejection to panel.',
    );
    _expect(
      settingsSeen.length == 3,
      'Invalid value must never invoke application callback.',
    );

    final nullMassRejected = broker.next('error');
    broker.send({
      'type': 'control.patch',
      'schemaId': 'dn-motion',
      'controlId': 'sheet.spring',
      'value': {'damping': 18, 'stiffness': 200, 'mass': null},
    });
    _expect(
      (await nullMassRejected)['code'] == 'INVALID_CONTROL_VALUE',
      'Explicit null mass is not an optional number.',
    );
    _expect(
      settingsSeen.length == 3,
      'Malformed mass must not invoke application callback.',
    );

    broker.send({
      'type': 'control.trigger',
      'schemaId': 'dn-motion',
      'controlId': 'sheet.replay',
    });
    await _until(() => triggerCount == 1);

    final disposal = broker.next('schema.dispose');
    await adapter.dispose();
    _expect(
      (await disposal)['schemaId'] == 'dn-motion',
      'Explicit disposal must drop broker cache.',
    );
    _expect(!adapter.isConnected, 'Disposed adapter must disconnect.');
    _expect(
      errors.any((e) => e.contains('INVALID_CONTROL_VALUE')),
      'Invalid patch should also have a local diagnostic.',
    );
  } finally {
    await adapter.dispose();
    await broker.close();
  }
}

Future<void> _until(bool Function() condition) async {
  for (var i = 0; i < 100; i++) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  throw TimeoutException('Expected runtime callback did not execute.');
}

class _FakeBroker {
  _FakeBroker._(this._server);

  final HttpServer _server;
  WebSocket? _client;
  final _messages = StreamController<Map<String, dynamic>>.broadcast();

  static Future<_FakeBroker> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final broker = _FakeBroker._(server);
    server.listen((request) async {
      final socket = await WebSocketTransformer.upgrade(request);
      broker._client = socket;
      socket.listen((raw) {
        final message = jsonDecode(raw as String) as Map<String, dynamic>;
        broker._messages.add(message);
        if (message['type'] == 'handshake.hello') {
          socket.add(
            jsonEncode({
              'type': 'handshake.accept',
              'protocolVersion': '0.3',
              'clientId': message['clientId'],
              'brokerId': 'fake-broker',
            }),
          );
        }
      });
    });
    return broker;
  }

  Uri get url => Uri.parse('ws://127.0.0.1:${_server.port}');

  Future<Map<String, dynamic>> next(String type) => _messages.stream
      .firstWhere((message) => message['type'] == type)
      .timeout(const Duration(seconds: 3));

  void send(Map<String, dynamic> message) {
    final socket = _client;
    if (socket == null) throw StateError('Fake broker has no client.');
    socket.add(jsonEncode(message));
  }

  Future<void> close() async {
    await _client?.close();
    await _server.close(force: true);
    await _messages.close();
  }
}
