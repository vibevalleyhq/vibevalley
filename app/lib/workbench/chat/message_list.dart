import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/pixel/pixel.dart';
import '../../data/remote.dart' show agentsProvider;
import '../../shared/chat_rules.dart';
import '../../chat/chat_state.dart';
import '../../chat/turn_steps.dart';
import '../../shared/chat_widgets.dart';
import '../../chat/dispatch_note.dart';
import '../../rules/chat.dart';
import '../../rules/sessions.dart';
import '../../rules/money.dart';

/// A sender's messages this close together share one header.
const _runMs = 5 * 60000;

const _grey = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 4 / 3, color: Palette.bark500);

class MessageList extends ConsumerStatefulWidget {
  const MessageList({super.key, required this.conversation, this.filter, this.emptyText});
  final Conversation? conversation;

  final String? filter;
  final String? emptyText;

  @override
  ConsumerState<MessageList> createState() => _MessageListState();
}

class _MessageListState extends ConsumerState<MessageList> {
  final _scroll = ScrollController();

  /// Null until the first rows are shown, so the first page (and a page of older ones loaded above) just appears.
  double? _shownUpTo;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(MessageList old) {
    super.didUpdateWidget(old);
    if (old.conversation?.id != widget.conversation?.id) {
      _shownUpTo = null;
      if (_scroll.hasClients) _scroll.jumpTo(0);
    }
  }

  @override
  Widget build(BuildContext context) {
    final farm = ref.watch(stateProvider);
    final conversation = widget.conversation;
    final feed = ref.watch(chatFeedProvider(conversation?.id));
    final all = feed.items;
    if (conversation != null) ref.watch(visibleConversationProvider(conversation.id));
    final filter = widget.filter?.trim() ?? '';
    final items = filter.isEmpty
        ? all
        : all
              .where(
                (i) => (switch (i) {
                  SpokenItem(:final line) => line.text,
                  MessageItem(:final message) => message.text,
                }).toLowerCase().contains(filter.toLowerCase()),
              )
              .toList();
    final parent = feed.parent;
    final waiting =
        farm?.manager == ManagerState.thinking && conversation?.kind != ConversationKind.thread && all.isNotEmpty && all.last.sender != managerAgent;

    final rows = <Widget>[];
    var day = '';
    final shownUpTo = _shownUpTo;
    for (final (i, item) in items.indexed) {
      final label = dayLabel(item.at);
      if (label != day) {
        day = label;
        rows.add(_DayLine(label, key: ValueKey('day $label')));
      }
      final before = i > 0 ? items[i - 1] : null;
      final continues = before != null && before.sender == item.sender && item.sender != '' && item.at - before.at < _runMs && dayLabel(before.at) == label;
      // Keyed, so a row keeps its place (and its arrival) when older ones load above it.
      rows.add(
        _Arrive(
          key: ValueKey(switch (item) {
            SpokenItem(:final line) => 'line ${line.id}',
            MessageItem(:final message) => 'message ${message.number}',
          }),
          fresh: shownUpTo != null && item.at > shownUpTo,
          child: _Row(item: item, continues: continues),
        ),
      );
    }
    if (all.isNotEmpty) _shownUpTo = all.map((i) => i.at).reduce((a, b) => a > b ? a : b);

    final hasFilter = (widget.filter ?? '').isNotEmpty;
    return Semantics(
      label: '消息',
      liveRegion: true,
      child: LayoutBuilder(
        builder: (context, box) => SingleChildScrollView(
          controller: _scroll,
          // Reversed: it stays at the newest while you are there; older pages load above without a jump.
          reverse: true,
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: (box.maxHeight - 28).clamp(0, double.infinity)),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.end,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (feed.hasOlder && !hasFilter)
                  Center(
                    child: Tappable(
                      onTap: () => unawaited(ref.read(chatActionsProvider).loadOlder(conversation!.id).catchError((Object _) {})),
                      builder: (context, s) => Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        child: Text('更早的消息', style: _grey.copyWith(color: s.hovered ? Palette.bark900 : Palette.bark500)),
                      ),
                    ),
                  )
                else
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Center(child: Text(hasFilter ? '含「${widget.filter}」的消息' : '消息的开头', style: _grey)),
                  ),
                if (parent != null)
                  Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    padding: const EdgeInsets.only(bottom: 8),
                    decoration: const BoxDecoration(
                      border: Border(bottom: BorderSide(color: Palette.cream300, width: 2)),
                    ),
                    child: _MessageRow(message: parent, continues: false),
                  ),
                if (items.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 32),
                    child: Text(
                      hasFilter ? '没有找到' : (widget.emptyText ?? ''),
                      textAlign: TextAlign.center,
                      style: PxText.sm.copyWith(color: Palette.bark500),
                    ),
                  ),
                ...rows,
                if (waiting)
                  const _Frame(
                    face: ManagerHead(size: 36),
                    name: '管家',
                    meta: '在想…',
                    child: SizedBox(
                      height: 20,
                      child: Align(alignment: Alignment.centerLeft, child: ThinkingDots()),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Every other row just appears, as everything does when the system asks for less motion.
class _Arrive extends StatefulWidget {
  const _Arrive({required super.key, required this.fresh, required this.child});
  final bool fresh;
  final Widget child;

  @override
  State<_Arrive> createState() => _ArriveState();
}

class _ArriveState extends State<_Arrive> with SingleTickerProviderStateMixin {
  AnimationController? _rise;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (widget.fresh && _rise == null && motionAllowed(context)) {
      _rise = AnimationController(vsync: this, duration: const Duration(milliseconds: 220))..forward();
    }
  }

  @override
  void dispose() {
    _rise?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final rise = _rise;
    if (rise == null) return widget.child;
    return AnimatedBuilder(
      animation: rise,
      builder: (context, child) {
        final t = Curves.easeOut.transform(rise.value);
        return Opacity(
          opacity: t,
          child: Transform.translate(offset: Offset(0, (8 * (1 - t)).roundToDouble()), child: child),
        );
      },
      child: widget.child,
    );
  }
}

class _DayLine extends StatelessWidget {
  const _DayLine(this.label, {super.key});
  final String label;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Row(
      children: [
        Expanded(child: Container(height: 2, color: Palette.cream300)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(label, style: _grey),
        ),
        Expanded(child: Container(height: 2, color: Palette.cream300)),
      ],
    ),
  );
}

class _Row extends StatelessWidget {
  const _Row({required this.item, required this.continues});
  final ChatItem item;
  final bool continues;

  @override
  Widget build(BuildContext context) => switch (item) {
    SpokenItem(:final line) => _Frame(
      face: line.role == LineRole.user ? const OwnerFace() : const ManagerHead(size: 36),
      name: line.role == LineRole.user ? '主人' : '管家',
      meta: '语音 ${workbenchClock(line.at)}',
      continues: continues,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [PxMarkdown(line.text), if (!line.final_) const StreamingCaret()]),
    ),
    MessageItem(:final message, :final thread) =>
      message.kind == MessageKind.notice || message.fromKind == SenderKind.system
          ? Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
              child: Text(message.text, textAlign: TextAlign.center, style: _grey.copyWith(height: 1.625)),
            )
          : _MessageRow(message: message, continues: continues, thread: thread),
  };
}

const _outcome = {Outcome.completed: ('做完了', Color(0xFFB4CB7C)), Outcome.failed: ('没做成', Color(0xFFE9A092)), Outcome.interrupted: ('叫停了', Color(0xFFE2C995))};

class _Tag extends StatelessWidget {
  const _Tag({required this.icon, required this.label, required this.fill});
  final String icon;
  final String label;
  final Color fill;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 4),
    padding: const EdgeInsets.only(left: 4, right: 6),
    decoration: BoxDecoration(
      color: fill,
      border: Border.all(color: Palette.bark900, width: 2),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        SpriteIcon(icon, size: 14),
        const SizedBox(width: 4),
        Text(label, style: PxText.xs),
      ],
    ),
  );
}

class _MessageRow extends ConsumerWidget {
  const _MessageRow({required this.message, required this.continues, this.thread});
  final ChatMessage message;
  final bool continues;
  final Conversation? thread;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final m = message;
    final agent = ref.watch(agentsProvider).value?[m.agent];
    final session = m.fromKind == SenderKind.agent ? ref.watch(stateProvider)?.sessions.where((h) => h.id == m.from).firstOrNull : null;
    final dot = session == null ? null : Color(phaseDot(session.phase));
    final who = switch (m.fromKind) {
      SenderKind.agent => [
        '@${m.from}',
        if (session != null) runtimeLabel[session.runtime] ?? session.runtime,
        if (agent != null && agent.role.isNotEmpty) _roleShort(agent.role),
      ].where((s) => s.isNotEmpty).join(' '),
      _ => '',
    };
    final outcome = m.outcome ?? Outcome.completed;
    final tag = switch (m.kind) {
      MessageKind.dispatch => const _Tag(icon: 'icon-seeds', label: '派活', fill: Color(0xFFF3D38A)),
      MessageKind.report => _Tag(icon: outcomeIcon[outcome]!, label: _outcome[outcome]!.$1, fill: _outcome[outcome]!.$2),
      _ => null,
    };
    final turn = !m.final_
        ? null
        : m.fromKind == SenderKind.manager && m.kind != MessageKind.dispatch
        ? TurnSteps(id: managerAgent, run: m.run, manager: true)
        : m.fromKind == SenderKind.agent && m.kind == MessageKind.report
        ? TurnSteps(id: m.from, run: m.run)
        : null;
    return _Frame(
      face: senderFace(m, 36),
      dot: dot,
      name: m.fromKind == SenderKind.user ? '主人' : m.name,
      meta: '${who.isNotEmpty ? '$who  ' : ''}${workbenchClock(m.at)}',
      continues: continues,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ?tag,
          Opacity(
            opacity: m.final_ ? 1 : .7,
            child: m.kind == MessageKind.dispatch
                ? DispatchNote(m.text, style: const TextStyle(height: 1.625))
                : ChatText(m.text, folds: m.final_, style: const TextStyle(height: 1.625)),
          ),
          if (!m.final_) const StreamingCaret(),
          if (m.spent != null && m.kind == MessageKind.report)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                children: [
                  const SpriteIcon('icon-coin', size: 12),
                  const SizedBox(width: 4),
                  Flexible(child: Text('这一轮花了 ${spentText(m.spent!)}', style: _grey)),
                ],
              ),
            ),
          ?turn,
          if (thread != null) ThreadPreview(thread: thread!),
        ],
      ),
    );
  }

  static String _roleShort(String role) {
    final first = role.split(RegExp('[，。,.]')).first;
    return first.length > 18 ? first.substring(0, 18) : first;
  }
}

class _Frame extends StatefulWidget {
  const _Frame({required this.face, required this.name, required this.meta, required this.child, this.dot, this.continues = false});
  final Widget face;
  final Color? dot;
  final String name;
  final String meta;
  final bool continues;
  final Widget child;

  @override
  State<_Frame> createState() => _FrameState();
}

class _FrameState extends State<_Frame> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) => MouseRegion(
    onEnter: (_) => setState(() => _hover = true),
    onExit: (_) => setState(() => _hover = false),
    child: Container(
      color: _hover ? Palette.creamHover : null,
      margin: EdgeInsets.only(top: widget.continues ? 0 : 12),
      padding: EdgeInsets.only(left: 4, right: 4, top: widget.continues ? 2 : 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 40,
            child: widget.continues
                ? null
                : SizedBox.square(
                    dimension: 40,
                    child: Stack(
                      children: [
                        Positioned.fill(
                          child: Align(alignment: Alignment.topLeft, child: widget.face),
                        ),
                        if (widget.dot != null) Positioned(right: 0, bottom: 0, child: StateDot(color: widget.dot!, size: 12, border: 2)),
                      ],
                    ),
                  ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (!widget.continues)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Text(widget.name, style: PxText.sm),
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(widget.meta, maxLines: 1, overflow: TextOverflow.ellipsis, style: _grey),
                      ),
                    ],
                  ),
                widget.child,
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class ThreadPreview extends ConsumerWidget {
  const ThreadPreview({super.key, required this.thread});
  final Conversation thread;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final farm = ref.watch(stateProvider);
    final chat = farm?.chat;
    final unread = unreadIn(chat, thread);
    final last = messagesIn(chat, thread.id).lastOrNull;
    final session = threadOwnerOf(thread, farm?.sessions ?? const []);
    return Tappable(
      onTap: () => unawaited(ref.read(chatActionsProvider).showChat(thread.id).catchError((Object _) {})),
      builder: (context, s) => Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: Palette.cream100,
          border: Border.all(color: s.hovered || s.focused ? Palette.bark900 : Palette.cream300, width: 2),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Glyph('button-thread'),
                const SizedBox(width: 6),
                Text(thread.replies > 0 ? '${idText(thread.replies)} 条回复' : '工单串', style: PxText.sm),
                if (unread > 0) ...[
                  const SizedBox(width: 8),
                  Container(
                    color: Palette.leaf300,
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    child: Text('$unread 条新', style: PxText.xs),
                  ),
                ],
                const SizedBox(width: 8),
                if (session != null) ...[PhaseGlyph(session.phase, size: 14), const SizedBox(width: 4)],
                Expanded(
                  child: session == null ? const SizedBox() : Text(phaseText(session, nowMs()), maxLines: 1, overflow: TextOverflow.ellipsis, style: _grey),
                ),
                Opacity(opacity: s.hovered || s.focused ? 1 : .6, child: const SpriteIcon('button-next', size: 12)),
              ],
            ),
            if (last != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Row(
                  children: [
                    Text(last.fromKind == SenderKind.user ? '主人' : last.name, style: PxText.sm),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        last.text.replaceAll(RegExp(r'\s+'), ' '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: PxText.sm.copyWith(color: Palette.bark500),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(workbenchClock(last.at), style: _grey),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
