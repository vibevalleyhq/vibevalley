// What the farm's chat window and the desk's chat share: the faces (yours, the manager's, a helper's), a pixel glyph
// at its own size, the thinking dots, and typing with @ (web/src/farm/Chat.tsx typedName, useNameables and the
// composer's keys).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import '../../village/village_view.dart' show agentsProvider;
import '../../village/world.dart' show lookOf;
import 'chat_rules.dart';

/// The person's own face: their portrait on a wheat square, framed as the manager's (MessageList.tsx OwnerFace); 主 on
/// the wheat until the drawings are in.
class OwnerFace extends ConsumerWidget {
  const OwnerFace({super.key, this.size = 36});
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    if (atlas != null && atlas.has('owner-face')) return ManagerFace(atlas: atlas, size: size, look: 'owner-face', fill: Palette.wheat);
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: Palette.wheat,
        border: Border.all(color: Palette.bark900, width: 2),
      ),
      child: const Text('主', style: KitText.sm),
    );
  }
}

/// The manager's face, once the drawings are in.
class ManagerHead extends ConsumerWidget {
  const ManagerHead({super.key, required this.size});
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    if (atlas == null) return SizedBox.square(dimension: size);
    return ManagerFace(atlas: atlas, size: size);
  }
}

/// A helper's face by its agent (castOf), once the drawings are in.
class AgentHead extends ConsumerWidget {
  const AgentHead({super.key, required this.agent, required this.size});

  /// The agent id (or, for a message without one, the sender's id).
  final String agent;
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    if (atlas == null) return SizedBox.square(dimension: size);
    final profile = ref.watch(agentsProvider).value?[agent];
    return AnimalFace(atlas: atlas, look: lookOf(profile, agent, atlas.has), size: size);
  }
}

/// Who said a message, as a face.
Widget senderFace(ChatMessage m, double size) => switch (m.fromKind) {
  SenderKind.user => OwnerFace(size: size),
  SenderKind.foreman => ManagerHead(size: size),
  SenderKind.helper || SenderKind.system => AgentHead(agent: m.agent ?? m.from, size: size),
};

/// A pixel drawing at its own size (Chat.tsx Glyph).
class Glyph extends ConsumerWidget {
  const Glyph(this.name, {super.key});
  final String name;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    if (atlas == null || !atlas.has(name)) return const SizedBox.square(dimension: 16);
    final sp = atlas[name];
    return Image.asset(sp.asset, width: sp.w, height: sp.h, filterQuality: FilterQuality.none, fit: BoxFit.fill, excludeFromSemantics: true);
  }
}

/// A square dot in a colour, with a bark outline (a helper's state on its face).
class StateDot extends StatelessWidget {
  const StateDot({super.key, required this.color, this.size = 8, this.border = 1});
  final Color color;
  final double size;
  final double border;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: color,
      border: Border.all(color: Palette.bark900, width: border),
    ),
  );
}

/// The blinking bar under words still coming (a message or a line being said), in the words' colour.
class StreamingCaret extends StatefulWidget {
  const StreamingCaret({super.key});

  @override
  State<StreamingCaret> createState() => _StreamingCaretState();
}

class _StreamingCaretState extends State<StreamingCaret> with SingleTickerProviderStateMixin {
  late final _blink = AnimationController(vsync: this, duration: const Duration(seconds: 2));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (kitMoves(context)) {
      if (!_blink.isAnimating) _blink.repeat(reverse: true);
    } else {
      _blink.value = 0;
    }
  }

  @override
  void dispose() {
    _blink.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
    opacity: Tween<double>(begin: 1, end: .5).animate(_blink),
    child: Container(width: 6, height: 14, margin: const EdgeInsets.only(left: 2), color: DefaultTextStyle.of(context).style.color),
  );
}

/// Three dots that bob in turn: someone is thinking.
class ThinkingDots extends StatefulWidget {
  const ThinkingDots({super.key});

  @override
  State<ThinkingDots> createState() => _ThinkingDotsState();
}

class _ThinkingDotsState extends State<ThinkingDots> with SingleTickerProviderStateMixin {
  late final _bob = AnimationController(vsync: this, duration: const Duration(milliseconds: 900));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (kitMoves(context)) {
      if (!_bob.isAnimating) _bob.repeat();
    } else {
      _bob.value = 0;
    }
  }

  @override
  void dispose() {
    _bob.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: AnimatedBuilder(
      animation: _bob,
      builder: (context, _) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < 3; i++)
            Padding(
              padding: EdgeInsets.only(left: i == 0 ? 0 : 4),
              child: Transform.translate(
                offset: Offset(0, _lift((_bob.value - i * 150 / 900) % 1)),
                child: Container(width: 6, height: 6, color: Palette.bark400),
              ),
            ),
        ],
      ),
    ),
  );

  /// eng-bob: up 2 px half way through, back down, a whole pixel at a time.
  static double _lift(double t) => (t < .5 ? -4 * t : -4 * (1 - t)).roundToDouble();
}

/// The number badge on a channel or a helper: a bark chip with the count.
class CountChip extends StatelessWidget {
  const CountChip(this.count, {super.key, this.fill = Palette.bark900, this.ink = Palette.cream50});
  final int count;
  final Color fill;
  final Color ink;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6),
    color: fill,
    child: Text('$count', style: KitText.xs.copyWith(color: ink)),
  );
}

// ── Typing, and naming someone with @ ────────────────────────────────────────

/// The input's text and the @ menu that follows the caret. Enter sends, Shift+Enter starts a line; with names
/// offered, the arrows move, Enter or Tab names and Esc closes them; Enter that picks a word in an input method does
/// neither.
class Naming extends ChangeNotifier {
  Naming() {
    text.addListener(_follow);
    focus.addListener(() {
      if (!focus.hasFocus && typing != null) {
        typing = null;
        notifyListeners();
      }
    });
  }

  final text = TextEditingController();
  final focus = FocusNode();

  /// Whom the person can name now; the owner keeps it current.
  List<Nameable> all = const [];

  /// The @word being typed, when there is one.
  ({int start, String query})? typing;
  int active = 0;

  /// Called when an @ is typed (the farm window opens itself to show the menu).
  VoidCallback? onNaming;

  String _last = '';
  int _caret = -1;

  List<Nameable> get offered => typing == null ? const [] : offeredFor(all, typing!.query);
  bool get menu => offered.isNotEmpty;

  void _follow() {
    final value = text.text;
    final sel = text.selection;
    final caret = sel.isCollapsed ? sel.baseOffset : -1;
    if (value == _last && caret == _caret) return;
    _last = value;
    _caret = caret;
    if (caret < 0) return;
    final found = typedName(value, caret);
    typing = found;
    active = 0;
    if (found != null) onNaming?.call();
    notifyListeners();
  }

  void choose(Nameable n) {
    final t = typing;
    if (t == null) return;
    final value = text.text;
    final caret = text.selection.isValid ? text.selection.baseOffset : value.length;
    final next = '${value.substring(0, t.start)}${n.token} ${value.substring(caret.clamp(t.start, value.length))}';
    final at = t.start + n.token.length + 1;
    typing = null;
    text.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: at),
    );
    notifyListeners();
  }

  void hover(int i) {
    active = i;
    notifyListeners();
  }

  void clear() {
    text.clear();
    typing = null;
    notifyListeners();
  }

  /// The keys, for a Focus around the input.
  KeyEventResult key(KeyEvent e, VoidCallback send) {
    if (e is KeyUpEvent) return KeyEventResult.ignored;
    if (text.value.composing.isValid && !text.value.composing.isCollapsed) return KeyEventResult.ignored;
    final k = e.logicalKey;
    final shown = offered;
    if (shown.isNotEmpty) {
      if (k == LogicalKeyboardKey.arrowDown || k == LogicalKeyboardKey.arrowUp) {
        active = (active + (k == LogicalKeyboardKey.arrowDown ? 1 : shown.length - 1)) % shown.length;
        notifyListeners();
        return KeyEventResult.handled;
      }
      if (k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.numpadEnter || k == LogicalKeyboardKey.tab) {
        if (e is KeyDownEvent) choose(shown[active.clamp(0, shown.length - 1)]);
        return KeyEventResult.handled;
      }
      if (k == LogicalKeyboardKey.escape) {
        typing = null;
        notifyListeners();
        return KeyEventResult.handled;
      }
    }
    if ((k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.numpadEnter) && !HardwareKeyboard.instance.isShiftPressed) {
      if (e is KeyDownEvent) send();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  void dispose() {
    text.dispose();
    focus.dispose();
    super.dispose();
  }
}

/// The face beside a name in the @ menu: a helper's, the manager's, or 全 for everyone.
class NameableFace extends StatelessWidget {
  const NameableFace(this.n, {super.key, this.size = 24, this.everyoneMark = true});
  final Nameable n;
  final double size;

  /// The farm window marks everyone with 全; the desk leaves the place empty.
  final bool everyoneMark;

  @override
  Widget build(BuildContext context) {
    final h = n.helper;
    if (h != null) return AgentHead(agent: h.agent, size: size);
    if (n.name == '管家') return ManagerHead(size: size);
    if (!everyoneMark) return SizedBox.square(dimension: size);
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      color: Palette.cream200,
      child: Text('全', style: KitText.xs.copyWith(color: Palette.bark600)),
    );
  }
}

/// The @ menu's rows: face, token, name, what it is doing.
class NamingMenu extends StatelessWidget {
  const NamingMenu({super.key, required this.naming, required this.highlight, this.faceSize = 24, this.everyoneMark = true});
  final Naming naming;
  final Color highlight;
  final double faceSize;
  final bool everyoneMark;

  @override
  Widget build(BuildContext context) {
    final shown = naming.offered;
    // Inside the input's tap region: picking a name keeps the focus in the input.
    return TextFieldTapRegion(
      child: Semantics(
        label: '叫谁',
        container: true,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final (i, n) in shown.indexed)
              MouseRegion(
                onEnter: (_) => naming.hover(i),
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () {
                    naming.choose(n);
                    naming.focus.requestFocus();
                  },
                  child: Semantics(
                    selected: i == naming.active,
                    button: true,
                    child: Container(
                      color: i == naming.active ? highlight : null,
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                      child: Row(
                        children: [
                          NameableFace(n, size: faceSize, everyoneMark: everyoneMark),
                          const SizedBox(width: 8),
                          Text(n.token, style: KitText.mono),
                          const SizedBox(width: 8),
                          if (n.helper != null) ...[Text(n.name, style: KitText.sm.copyWith(color: Palette.bark800)), const SizedBox(width: 8)],
                          Expanded(
                            child: Text(
                              n.note,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: KitText.xs.copyWith(color: Palette.bark500),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// The time of day as the desk writes it: 上午09:05 (zh-CN, 12-hour, two digits).
String deskClock(double at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  final h12 = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '${d.hour < 12 ? '上午' : '下午'}${h12.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// The time of day as the farm window writes it: 09:05.
String farmClock(double at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// The day a message is on: 今天, 昨天, or 10月13日 (MessageList.tsx dayLabel).
String dayLabel(double at, [DateTime? now]) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  final today = now ?? DateTime.now();
  bool same(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;
  if (same(d, today)) return '今天';
  if (same(d, today.subtract(const Duration(days: 1)))) return '昨天';
  return '${d.month}月${d.day}日';
}

/// Now, in epoch milliseconds, as the protocol's functions take it.
double nowMs() => DateTime.now().millisecondsSinceEpoch.toDouble();
