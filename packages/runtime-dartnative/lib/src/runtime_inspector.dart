import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// A set of *next-run* spring parameters. Running native animations are not
/// retroactively re-targeted when the inspector changes these values.
class SpringParameters {
  const SpringParameters({
    required this.damping,
    required this.stiffness,
    this.mass = 1,
  });

  final double damping;
  final double stiffness;
  final double mass;

  Map<String, double> toJson() => {
    'damping': damping,
    'stiffness': stiffness,
    'mass': mass,
  };

  static SpringParameters? fromWire(Object? value) {
    if (value is! Map) return null;
    final damping = value['damping'];
    final stiffness = value['stiffness'];
    final mass = value.containsKey('mass') ? value['mass'] : 1;
    if (damping is! num || stiffness is! num || mass is! num) return null;
    if (!damping.isFinite || !stiffness.isFinite || !mass.isFinite) return null;
    return SpringParameters(
      damping: damping.toDouble(),
      stiffness: stiffness.toDouble(),
      mass: mass.toDouble(),
    );
  }
}

class SpringRanges {
  const SpringRanges({
    this.dampingMin = 1,
    this.dampingMax = 50,
    this.stiffnessMin = 10,
    this.stiffnessMax = 500,
    this.massMin = 0.1,
    this.massMax = 5,
  });

  final double dampingMin;
  final double dampingMax;
  final double stiffnessMin;
  final double stiffnessMax;
  final double massMin;
  final double massMax;

  void validate() {
    for (final bounds in [
      [dampingMin, dampingMax],
      [stiffnessMin, stiffnessMax],
      [massMin, massMax],
    ]) {
      if (!bounds[0].isFinite ||
          !bounds[1].isFinite ||
          bounds[0] <= 0 ||
          bounds[0] >= bounds[1]) {
        throw ArgumentError('Spring ranges must have 0 < finite min < max.');
      }
    }
  }

  bool contains(SpringParameters value) =>
      value.damping.isFinite &&
      value.stiffness.isFinite &&
      value.mass.isFinite &&
      value.damping >= dampingMin &&
      value.damping <= dampingMax &&
      value.stiffness >= stiffnessMin &&
      value.stiffness <= stiffnessMax &&
      value.mass >= massMin &&
      value.mass <= massMax;

  Map<String, List<double>> toJson() => {
    'damping': [dampingMin, dampingMax],
    'stiffness': [stiffnessMin, stiffnessMax],
    'mass': [massMin, massMax],
  };
}

/// The app reads [value] when starting an animation, rather than holding a
/// constant `SpringDescription` captured before the inspector is connected.
class InspectorSpring {
  InspectorSpring._(
    this.id,
    this.label,
    this.description,
    this.ranges,
    SpringParameters initial,
    this._onChange,
  ) : _value = initial,
      _defaultValue = initial;

  final String id;
  final String label;
  final String? description;
  final SpringRanges ranges;
  SpringParameters _value;
  final SpringParameters _defaultValue;
  final void Function(SpringParameters) _onChange;

  SpringParameters get value => _value;

  Map<String, Object?> toControlJson() => {
    'id': id,
    'kind': 'spring',
    'label': label,
    if (description != null) 'description': description,
    'defaultValue': _defaultValue.toJson(),
    'value': value.toJson(),
    'ranges': ranges.toJson(),
  };

  void _setValue(SpringParameters next) {
    _onChange(next);
    _value = next;
  }
}

class _InspectorAction {
  const _InspectorAction(this.id, this.label, this.description, this.callback);

  final String id;
  final String label;
  final String? description;
  final void Function() callback;

  Map<String, Object?> toControlJson() => {
    'id': id,
    'kind': 'trigger',
    'label': label,
    if (description != null) 'description': description,
  };
}

/// Experimental pure-Dart transport for the existing RIP 0.3 broker/panels.
/// No DartNative framework internals, runtime discovery or source write-back.
///
/// Create/register in State.initState(), call [connect] after registration,
/// and [dispose] from State.dispose(). Use an explicit LAN broker WebSocket URL
/// on physical devices. The constructor never opens sockets.
class RuntimeInspectorDartNative {
  RuntimeInspectorDartNative({
    required this.brokerUrl,
    required this.schemaId,
    required this.title,
    this.description,
    String? clientId,
    this.clientName = 'DartNative Runtime',
    this.reconnect = true,
    this.reconnectDelay = const Duration(milliseconds: 1200),
    this.onDiagnostic,
    bool enabled = true,
  }) : clientId = clientId ?? 'runtime-$schemaId',
       _enabled = !const bool.fromEnvironment('dart.vm.product') && enabled {
    if (schemaId.isEmpty || title.isEmpty || this.clientId.isEmpty) {
      throw ArgumentError('schemaId, title, and clientId must be non-empty.');
    }
    if ((brokerUrl.scheme != 'ws' && brokerUrl.scheme != 'wss') ||
        brokerUrl.host.isEmpty) {
      throw ArgumentError.value(brokerUrl, 'brokerUrl', 'Expected ws(s) URL.');
    }
    if (reconnectDelay <= Duration.zero) {
      throw ArgumentError.value(reconnectDelay, 'reconnectDelay');
    }
  }

  static const String ripVersion = '0.3';

  final Uri brokerUrl;
  final String schemaId;
  final String title;
  final String? description;
  final String clientId;
  final String clientName;
  final bool reconnect;
  final Duration reconnectDelay;
  final void Function(String message)? onDiagnostic;
  final bool _enabled;

  final Map<String, InspectorSpring> _springs = {};
  final Map<String, _InspectorAction> _actions = {};
  WebSocket? _socket;
  Future<void>? _connecting;
  StreamSubscription<dynamic>? _subscription;
  Timer? _reconnectTimer;
  Timer? _handshakeTimer;
  bool _accepted = false;
  bool _wantsConnection = false;
  bool _disposed = false;
  int _failureCount = 0;

  bool get enabled => _enabled;
  bool get isConnected => _accepted;

  InspectorSpring registerSpring({
    required String id,
    required String label,
    required SpringParameters initial,
    required void Function(SpringParameters) onChange,
    SpringRanges ranges = const SpringRanges(),
    String? description,
  }) {
    _checkRegister(id, label);
    ranges.validate();
    if (!ranges.contains(initial)) {
      throw ArgumentError.value(initial, 'initial', 'Outside spring ranges.');
    }
    final control = InspectorSpring._(
      id,
      label,
      description,
      ranges,
      initial,
      onChange,
    );
    _springs[id] = control;
    _publishIfConnected();
    return control;
  }

  void registerAction({
    required String id,
    required String label,
    required void Function() onTrigger,
    String? description,
  }) {
    _checkRegister(id, label);
    _actions[id] = _InspectorAction(id, label, description, onTrigger);
    _publishIfConnected();
  }

  /// Attempts the initial connection. The handshake completes asynchronously;
  /// [isConnected] is true only after the broker replies with handshake.accept.
  /// Errors are reported to [onDiagnostic] and retried if [reconnect] is true.
  Future<void> connect() {
    if (_disposed) throw StateError('Inspector has been disposed.');
    if (!_enabled) return Future.value();
    _wantsConnection = true;
    if (_accepted || _socket != null) return Future.value();
    return _connecting ??= _open().whenComplete(() => _connecting = null);
  }

  Future<void> _open() async {
    try {
      final socket = await WebSocket.connect(brokerUrl.toString())
          .timeout(const Duration(seconds: 5));
      if (!_wantsConnection || _disposed) {
        await socket.close();
        return;
      }
      _socket = socket;
      _accepted = false;
      _subscription = socket.listen(
        (data) => _receive(data),
        onError: (Object error) {
          _warn('WebSocket receive failed: $error');
          _handleDisconnect(socket);
          socket.close();
        },
        onDone: () => _handleDisconnect(socket),
        cancelOnError: true,
      );
      _send({
        'type': 'handshake.hello',
        'protocolVersion': ripVersion,
        'role': 'runtime',
        'clientId': clientId,
        'clientName': clientName,
      });
      _handshakeTimer = Timer(const Duration(seconds: 5), () {
        if (!identical(_socket, socket) || _accepted) return;
        _warn('Timed out waiting for RIP handshake.accept.');
        socket.close();
      });
    } catch (error) {
      _reportConnectionFailure('$error');
      _scheduleReconnect();
    }
  }

  void _receive(dynamic raw) {
    Object? decoded;
    try {
      decoded = jsonDecode(raw is String ? raw : utf8.decode(raw as List<int>));
    } catch (error) {
      _warn('Ignoring malformed JSON: $error');
      return;
    }
    if (decoded is! Map<String, dynamic>) {
      _warn('Ignoring non-object RIP message.');
      return;
    }

    final type = decoded['type'];
    if (type == 'handshake.accept') {
      if (decoded['protocolVersion'] != ripVersion ||
          decoded['clientId'] != clientId ||
          decoded['brokerId'] is! String) {
        _warn('Rejected incompatible handshake.accept.');
        _socket?.close();
        return;
      }
      _failureCount = 0;
      _accepted = true;
      _handshakeTimer?.cancel();
      _handshakeTimer = null;
      _publishIfConnected();
      return;
    }
    if (type == 'error') {
      _warn('Broker error ${decoded['code']}: ${decoded['message']}');
      return;
    }
    if (!_accepted) {
      _warn('Ignoring $type before handshake.');
      return;
    }
    if (type == 'control.patch' || type == 'control.commit') {
      _applyPatch(decoded);
    } else if (type == 'control.batchPatch') {
      if (decoded['schemaId'] != schemaId) return;
      final patches = decoded['patches'];
      if (patches is! List) {
        _reject('INVALID_MESSAGE', 'control.batchPatch expects patches array.');
        return;
      }
      for (final patch in patches) {
        if (patch is! Map) {
          _reject('INVALID_MESSAGE', 'Batch entry is not an object.');
          continue;
        }
        _applyPatch(<String, dynamic>{...patch, 'schemaId': schemaId});
      }
    } else if (type == 'control.trigger') {
      _applyTrigger(decoded);
    }
    // Unknown/newer protocol messages are intentionally ignored.
  }

  void _applyPatch(Map<String, dynamic> message) {
    if (message['schemaId'] != schemaId) return;
    final id = message['controlId'];
    final control = _springs[id];
    if (control == null) {
      _reject('UNKNOWN_CONTROL', 'No spring control with id $id.');
      return;
    }
    final parsed = SpringParameters.fromWire(message['value']);
    if (parsed == null || !control.ranges.contains(parsed)) {
      _reject(
        'INVALID_CONTROL_VALUE',
        'Spring $id expects finite values inside configured ranges.',
      );
      return;
    }
    try {
      control._setValue(parsed);
    } catch (error) {
      _reject('CONTROL_CALLBACK_FAILED', 'Spring $id: $error');
    }
  }

  void _applyTrigger(Map<String, dynamic> message) {
    if (message['schemaId'] != schemaId) return;
    final id = message['controlId'];
    final action = _actions[id];
    if (action == null) {
      _reject('UNKNOWN_CONTROL', 'No trigger control with id $id.');
      return;
    }
    try {
      action.callback();
    } catch (error) {
      _reject('CONTROL_CALLBACK_FAILED', 'Trigger $id: $error');
    }
  }

  Map<String, Object?> _schema() => {
    'id': schemaId,
    'title': title,
    if (description != null) 'description': description,
    'groups': [
      if (_springs.isNotEmpty)
        {
          'id': 'motion',
          'label': 'Motion',
          'controls': [for (final s in _springs.values) s.toControlJson()],
        },
      if (_actions.isNotEmpty)
        {
          'id': 'actions',
          'label': 'Actions',
          'controls': [for (final a in _actions.values) a.toControlJson()],
        },
    ],
  };

  void _publishIfConnected() {
    if (_accepted) _send({'type': 'schema.publish', 'schema': _schema()});
  }

  void _reject(String code, String reason) {
    _warn('$code: $reason');
    _send({'type': 'error', 'code': code, 'message': reason});
  }

  void _send(Map<String, Object?> message) {
    final socket = _socket;
    if (socket == null || socket.readyState != WebSocket.open) return;
    try {
      socket.add(jsonEncode(message));
    } catch (error) {
      _warn('WebSocket send failed: $error');
    }
  }

  void _handleDisconnect(WebSocket former) {
    if (!identical(_socket, former)) return;
    _handshakeTimer?.cancel();
    _handshakeTimer = null;
    _socket = null;
    _subscription = null;
    _accepted = false;
    if (_wantsConnection && !_disposed) {
      _warn('Inspector disconnected; waiting to reconnect.');
      _scheduleReconnect();
    }
  }

  void _reportConnectionFailure(String message) {
    _failureCount++;
    if (_failureCount == 1 || _failureCount % 10 == 0) {
      _warn('Cannot connect to $brokerUrl: $message');
    }
  }

  void _scheduleReconnect() {
    if (!reconnect ||
        !_wantsConnection ||
        _disposed ||
        _reconnectTimer != null) {
      return;
    }
    _reconnectTimer = Timer(reconnectDelay, () {
      _reconnectTimer = null;
      connect();
    });
  }

  void _warn(String message) {
    if (!_enabled) return;
    final diagnostic = '[Runtime Inspector/DartNative] $message';
    if (onDiagnostic != null) {
      onDiagnostic!(diagnostic);
    } else {
      stderr.writeln(diagnostic);
    }
  }

  void _checkRegister(String id, String label) {
    if (_disposed) throw StateError('Inspector has been disposed.');
    if (id.isEmpty || label.isEmpty) {
      throw ArgumentError('Control id and label must be non-empty.');
    }
    if (_springs.containsKey(id) || _actions.containsKey(id)) {
      throw StateError('Duplicate inspector control id: $id');
    }
  }

  /// Disposes the owned schema explicitly, cancels reconnect and closes its
  /// socket. Old schema states are never deliberately left stale on unmount.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _wantsConnection = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _handshakeTimer?.cancel();
    _handshakeTimer = null;
    if (_accepted) {
      _send({
        'type': 'schema.dispose',
        'schemaId': schemaId,
        'source': 'runtime',
      });
    }
    final socket = _socket;
    _socket = null;
    _accepted = false;
    await _subscription?.cancel();
    _subscription = null;
    if (socket != null) await socket.close();
    _springs.clear();
    _actions.clear();
  }
}
