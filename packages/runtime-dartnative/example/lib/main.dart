// Provisional DN-facing example. The pure-Dart adapter is wire-tested, but
// this screen and SpringDescription export have NOT been compiled against a
// current licensed DartNative/Zero SDK or validated on physical devices.
import 'dart:async' show unawaited;

import 'package:dartnative/dartnative.dart';
import 'package:runtime_inspector_dartnative/runtime_inspector_dartnative.dart';

const _brokerUrl = String.fromEnvironment(
  'INSPECTOR_URL',
  defaultValue: 'ws://127.0.0.1:4577',
);

void main() {
  DartNativePluginRegistrant.registerAll();
  runApp(const InspectorDemo());
}

class InspectorDemo extends StatefulWidget {
  const InspectorDemo({super.key});

  @override
  State<InspectorDemo> createState() => _InspectorDemoState();
}

class _InspectorDemoState extends State<InspectorDemo>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final RuntimeInspectorDartNative _inspector;
  late final InspectorSpring _spring;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    );
    _inspector = RuntimeInspectorDartNative(
      brokerUrl: Uri.parse(_brokerUrl),
      schemaId: 'dn-motion-demo',
      title: 'DN spring tuning',
    );
    _spring = _inspector.registerSpring(
      id: 'card.spring',
      label: 'Card spring',
      initial: const SpringParameters(damping: 18, stiffness: 240),
      onChange: (value) => print(
        '[Runtime Inspector / DN] next fling: '
        'damping=${value.damping}, stiffness=${value.stiffness}, '
        'mass=${value.mass}',
      ),
    );
    _inspector.registerAction(
      id: 'card.replay',
      label: 'Replay card',
      onTrigger: _replay,
    );
    unawaited(_inspector.connect());
  }

  void _replay() {
    final parameters = _spring.value;
    print('[Runtime Inspector / DN] replay requested');
    _controller.value = 0;
    _controller.fling(
      velocity: 1,
      spring: SpringDescription(
        damping: parameters.damping,
        stiffness: parameters.stiffness,
        mass: parameters.mass,
      ),
    );
  }

  @override
  void dispose() {
    unawaited(_inspector.dispose());
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Runtime Inspector / DN')),
        body: Center(
          child: GestureDetector(
            onTap: _replay,
            child: AnimatedBuilder(
              animation: _controller,
              builder: (_, child) => Transform.translate(
                offset: Offset(0, -100 * _controller.value),
                child: child,
              ),
              child: Container(
                width: 180,
                height: 180,
                color: const Color(0xFF0D9488),
                child: const Center(child: Text('Tap to replay')),
              ),
            ),
          ),
        ),
      );
}
