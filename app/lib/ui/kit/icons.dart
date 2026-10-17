// No line icons and no characters standing in for icons: the pixel font has no ✓, ✗ or ›.

import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../gen/vibevalley.dart';
import 'base.dart';

class SpriteIcon extends StatelessWidget {
  const SpriteIcon(this.name, {super.key, required this.size, this.semanticLabel});
  final String name;
  final double size;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) => Image.asset(
    'assets/pixel/$name.png',
    width: size,
    height: size,
    fit: BoxFit.contain,
    filterQuality: FilterQuality.none,
    isAntiAlias: false,
    semanticLabel: semanticLabel,
    excludeFromSemantics: semanticLabel == null,
  );
}

class ActionGlyph extends StatelessWidget {
  const ActionGlyph(this.action, {super.key, this.size = 16});
  final SessionAction action;
  final double size;

  @override
  Widget build(BuildContext context) => action == SessionAction.none ? const SizedBox.shrink() : SpriteIcon('act-${action.wire}', size: size);
}

const outcomeIcon = <Outcome, String>{Outcome.completed: 'icon-harvest', Outcome.failed: 'icon-bug', Outcome.interrupted: 'icon-shovel'};

class PhaseGlyph extends StatelessWidget {
  const PhaseGlyph(this.phase, {super.key, this.size = 16});
  final Phase phase;
  final double size;

  @override
  Widget build(BuildContext context) => switch (phase) {
    PhaseArriving() => SpriteIcon('icon-seeds', size: size),
    PhaseWorking(doing: Doing(action: SessionAction.none)) => SizedBox.square(dimension: size),
    PhaseWorking(:final doing) => _Bob(child: SpriteIcon('act-${doing.action.wire}', size: size)),
    PhaseRipe() => SpriteIcon('icon-harvest', size: size),
    PhaseFailed() => SpriteIcon('icon-bug', size: size),
    PhaseResting() => SpriteIcon('act-wait', size: size),
  };
}

/// Two frames, no tween, so the pixels stay whole; still when the system asks for less motion.
class _Bob extends StatefulWidget {
  const _Bob({required this.child});
  final Widget child;

  @override
  State<_Bob> createState() => _BobState();
}

class _BobState extends State<_Bob> {
  Timer? _beat;
  bool _up = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (kitMoves(context)) {
      _beat ??= Timer.periodic(const Duration(milliseconds: 450), (_) => setState(() => _up = !_up));
    } else {
      _beat?.cancel();
      _beat = null;
      _up = false;
    }
  }

  @override
  void dispose() {
    _beat?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Transform.translate(offset: Offset(0, _up ? -1 : 0), child: widget.child);
}

class Marked extends StatelessWidget {
  const Marked(this.mark, {super.key, required this.child, this.size = 12, this.top = 2});
  final String mark;
  final Widget child;
  final double size;
  final double top;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: EdgeInsets.only(top: top),
        child: SpriteIcon(mark, size: size),
      ),
      const SizedBox(width: 6),
      Flexible(child: child),
    ],
  );
}
