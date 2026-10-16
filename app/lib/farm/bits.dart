// Small pieces the farm's panels share: the empty-panel note, a coloured tag, a tinted box, a line of what the server
// answered, and a clock that ticks every second (web/src/farm/Panels.tsx Empty, Plans.tsx Tag and Said, useNow).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../desk/shared/faces.dart' as desk show AgentFace;
import '../gen/vibevalley.dart';
import '../sprites/atlas.dart';
import '../ui/kit/kit.dart';
import '../village/village_view.dart' show agentsProvider;
import '../rules/playbook.dart';

/// A panel with nothing in it yet.
class FarmEmpty extends StatelessWidget {
  const FarmEmpty(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    color: Palette.cream100,
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 32),
    alignment: Alignment.center,
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: KitText.sm.copyWith(color: Palette.bark600),
    ),
  );
}

/// A small coloured tag: a state in a word.
class FarmTag extends StatelessWidget {
  const FarmTag(this.text, {super.key, this.fill = Palette.cream200, this.ink = Palette.bark800, this.icon, this.goes = false});
  final String text;
  final Color fill;
  final Color ink;

  /// A sprite before the words.
  final String? icon;

  /// It leads somewhere: the way-in chevron after the words (the page's ›).
  final bool goes;

  @override
  Widget build(BuildContext context) => Container(
    color: fill,
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (icon != null) ...[SpriteIcon(icon!, size: 12), const SizedBox(width: 4)],
        Text(text, maxLines: 1, style: KitText.xs.copyWith(color: ink)),
        if (goes) ...[const SizedBox(width: 4), const SpriteIcon('button-next', size: 10)],
      ],
    ),
  );
}

/// A tinted box around some lines.
class Tinted extends StatelessWidget {
  const Tinted({super.key, required this.child, this.color = Palette.cream100, this.padding = const EdgeInsets.symmetric(horizontal: 12, vertical: 8)});
  final Widget child;
  final Color color;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Container(color: color, padding: padding, child: child);
}

/// What the server answered, in green or red (Plans.tsx Said).
class Said extends StatelessWidget {
  const Said(this.answer, {super.key});
  final Answer? answer;

  @override
  Widget build(BuildContext context) {
    final a = answer;
    if (a == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Text(a.text, style: KitText.xs.copyWith(color: a.ok ? Palette.leaf700 : Palette.berry)),
    );
  }
}

/// Rebuilds every second with the time in epoch milliseconds (Panels.tsx useNow).
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

/// A helper's (an agent's) face, from its agent's looks (the desk's AgentFace, found by the agent's id).
class AgentFace extends ConsumerWidget {
  const AgentFace(this.agentId, {super.key, required this.size, this.muted = false});
  final String agentId;
  final double size;
  final bool muted;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agent = (ref.watch(agentsProvider).value ?? const <String, AgentProfile>{})[agentId];
    return desk.AgentFace(look: agent?.look, id: agentId, size: size, muted: muted);
  }
}

/// The manager's face in its current look.
class ManagerFaceOf extends ConsumerWidget {
  const ManagerFaceOf({super.key, required this.size, required this.look});
  final double size;
  final String look;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final SpriteAtlas? atlas = ref.watch(atlasProvider).value;
    if (atlas == null) return SizedBox.square(dimension: size);
    final name = look != 'farmer' && atlas.has('manager-$look-face') ? 'manager-$look-face' : 'manager-face';
    return ManagerFace(atlas: atlas, size: size, look: name);
  }
}

/// A clock time, 24 hours: 09:05.
String clockOf(double at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// Tones of the farm's tags: a colour at a share of its strength over cream (Tailwind's bg-x/NN).
Color tint(Color c, double alpha) => Color.alphaBlend(c.withValues(alpha: alpha), Palette.cream50);
