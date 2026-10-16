// Each closes after its timeout (5 s by default), held while the pointer is over the stack; past three they hide.

import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../app/theme.dart';
import 'base.dart';
import 'icons.dart';

abstract final class ToastType {
  static const info = 'info';
  static const warn = 'warn';
  static const error = 'error';
  static const achievement = 'achievement';
}

const noticeTitle = {ToastType.info: '提示', ToastType.warn: '没派成', ToastType.error: '出错了'};

class ToastData {
  ToastData._(this.id, this.type, this.title, this.description, this.timeout, this.data);
  final int id;
  final String type;
  final String title;
  final String? description;
  final Duration timeout;

  final Object? data;
}

class ToastManager extends ChangeNotifier {
  ToastManager({this.limit = 3});

  /// The rest wait hidden behind.
  final int limit;

  final _list = <ToastData>[];
  final _timers = <int, Timer>{};
  final _left = <int, Duration>{};
  final _started = <int, DateTime>{};
  var _next = 0;
  var _paused = false;

  List<ToastData> get toasts => List.unmodifiable(_list);

  int add({String type = ToastType.info, required String title, String? description, Duration timeout = const Duration(milliseconds: 5000), Object? data}) {
    final t = ToastData._(++_next, type, title, description, timeout, data);
    _list.insert(0, t);
    _left[t.id] = timeout;
    if (!_paused) _start(t.id);
    notifyListeners();
    return t.id;
  }

  void close(int id) {
    _timers.remove(id)?.cancel();
    _left.remove(id);
    _started.remove(id);
    final before = _list.length;
    _list.removeWhere((t) => t.id == id);
    if (_list.length != before) notifyListeners();
  }

  void _start(int id) {
    final left = _left[id];
    if (left == null || left <= Duration.zero) return;
    _started[id] = DateTime.now();
    _timers[id] = Timer(left, () => close(id));
  }

  void pause() {
    if (_paused) return;
    _paused = true;
    final now = DateTime.now();
    for (final MapEntry(:key, :value) in _timers.entries) {
      value.cancel();
      final started = _started[key];
      if (started != null) _left[key] = _left[key]! - now.difference(started);
    }
    _timers.clear();
  }

  void resume() {
    if (!_paused) return;
    _paused = false;
    for (final t in _list) {
      _start(t.id);
    }
  }

  @override
  void dispose() {
    for (final t in _timers.values) {
      t.cancel();
    }
    super.dispose();
  }
}

final toasts = ToastManager();

Color _tone(String type) => switch (type) {
  ToastType.warn => const Color(0x4DF3B07A),
  ToastType.error => Palette.berry.withValues(alpha: .15),
  _ => Palette.cream200,
};

class ToastViewport extends StatefulWidget {
  ToastViewport({super.key, ToastManager? manager, this.leading, this.kicker, this.top = 12}) : manager = manager ?? toasts;
  final ToastManager manager;
  final Widget? Function(ToastData toast)? leading;
  final String? Function(ToastData toast)? kicker;
  final double top;

  @override
  State<ToastViewport> createState() => _ToastViewportState();
}

class _ToastViewportState extends State<ToastViewport> {
  @override
  Widget build(BuildContext context) {
    final width = (MediaQuery.sizeOf(context).width - 32).clamp(0, 320).toDouble();
    return Align(
      alignment: Alignment.topCenter,
      child: Padding(
        padding: EdgeInsets.only(top: widget.top),
        child: SizedBox(
          width: width,
          // Only the cards take the pointer: around them (and with none shown) clicks go through to the page below.
          child: MouseRegion(
            hitTestBehavior: HitTestBehavior.deferToChild,
            onEnter: (_) => widget.manager.pause(),
            onExit: (_) => widget.manager.resume(),
            child: ListenableBuilder(
              listenable: widget.manager,
              builder: (context, _) {
                final list = widget.manager.toasts;
                // An empty Stack takes all the room it is given: none at all.
                if (list.isEmpty) return const SizedBox.shrink();
                return Stack(
                  clipBehavior: Clip.none,
                  children: [
                    // Back to front: the newest is drawn last, on top.
                    for (var i = list.length - 1; i >= 0; i--)
                      _ToastCard(
                        key: ValueKey(list[i].id),
                        toast: list[i],
                        index: i,
                        hidden: i >= widget.manager.limit,
                        leading: widget.leading?.call(list[i]),
                        kicker: widget.kicker?.call(list[i]),
                        onClose: () => widget.manager.close(list[i].id),
                      ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

class _ToastCard extends StatefulWidget {
  const _ToastCard({
    super.key,
    required this.toast,
    required this.index,
    required this.hidden,
    required this.leading,
    required this.kicker,
    required this.onClose,
  });
  final ToastData toast;
  final int index;
  final bool hidden;
  final Widget? leading;
  final String? kicker;
  final VoidCallback onClose;

  @override
  State<_ToastCard> createState() => _ToastCardState();
}

class _ToastCardState extends State<_ToastCard> {
  var _shown = false;
  var _drag = Offset.zero;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _shown = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.toast;
    final bg = _tone(t.type);
    final card = Container(
      padding: const EdgeInsets.all(12),
      decoration: const BoxDecoration(color: Palette.cream50, boxShadow: kitDrop),
      child: Row(
        children: [
          widget.leading ?? Container(width: 40, height: 40, color: bg, alignment: Alignment.center, child: const SpriteIcon('icon-bell', size: 32)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (widget.kicker != null) Text(widget.kicker!, style: KitText.xs.copyWith(color: Palette.leaf700)),
                Text(t.title, style: KitText.sm),
                if (t.description != null && t.description!.isNotEmpty) Text(t.description!, style: KitText.xs.copyWith(color: Palette.bark600)),
              ],
            ),
          ),
        ],
      ),
    );
    final i = widget.index.toDouble();
    return AnimatedSlide(
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOut,
      offset: _shown ? Offset.zero : const Offset(0, -1.2),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
        transformAlignment: Alignment.center,
        transform: Matrix4.translationValues(_drag.dx, i * 9.6 + _drag.dy, 0)..scaleByDouble(1 - i * .05, 1 - i * .05, 1, 1),
        child: AnimatedOpacity(
          duration: const Duration(milliseconds: 300),
          opacity: widget.hidden ? 0 : 1,
          child: IgnorePointer(
            ignoring: widget.hidden || widget.index > 0,
            child: GestureDetector(
              onPanUpdate: (d) =>
                  setState(() => _drag = Offset(_drag.dx + d.delta.dx.clamp(0, double.infinity), _drag.dy + d.delta.dy.clamp(0, double.infinity))),
              onPanEnd: (_) {
                if (_drag.dx > 40 || _drag.dy > 40) {
                  widget.onClose();
                } else {
                  setState(() => _drag = Offset.zero);
                }
              },
              child: Semantics(liveRegion: true, child: card),
            ),
          ),
        ),
      ),
    );
  }
}
