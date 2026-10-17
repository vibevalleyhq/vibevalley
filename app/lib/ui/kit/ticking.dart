import 'dart:async';

import 'package:flutter/widgets.dart';

/// In epoch milliseconds.
class Ticking extends StatefulWidget {
  const Ticking({super.key, required this.builder});
  final Widget Function(BuildContext context, double now) builder;

  @override
  State<Ticking> createState() => _TickingState();
}

class _TickingState extends State<Ticking> {
  late final Timer _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _timer.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, DateTime.now().millisecondsSinceEpoch.toDouble());
}
