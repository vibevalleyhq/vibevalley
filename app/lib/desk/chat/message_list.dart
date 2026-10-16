// A conversation as rows, Raft's way (web/src/desk/MessageList.tsx): a face, the name, who it is and when in grey,
// then the words; a run from the same sender within a few minutes goes on without its header. Under a message with a
// thread, a box with how many replies and the last one, which opens the thread. Days are marked; the top says where
// the conversation began, or offers the older messages. What is on screen is read. Rows come from itemsOf, as in the
// farm window.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import '../../village/village_view.dart' show agentsProvider;
import 'chat_rules.dart';
import 'chat_state.dart';
import 'chat_widgets.dart';
import '../../rules/chat.dart';
import '../../rules/farm.dart';
import '../../rules/index.dart';

/// A sender's messages this close together share one header.
const _runMs = 5 * 60000;

const _grey = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 4 / 3, color: Palette.bark500);

class MessageList extends ConsumerStatefulWidget {
  const MessageList({super.key, required this.conversation, this.filter, this.emptyText});
  final Conversation? conversation;

  /// Only messages with these words (the header's search).
  final String? filter;
  final String? emptyText;

  @override
  ConsumerState<MessageList> createState() => _MessageListState();
}

class _MessageListState extends ConsumerState<MessageList> {
  final _scroll = ScrollController();

  /// The read position asked for last, so one unread run is marked once.
  String? _marked;

  /// The newest moment shown so far in this conversation: rows after it arrived while it was open. Null until the
  /// first rows are shown, so the first page (and a page of older ones loaded above) just appears.
  double? _shownUpTo;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(MessageList old) {
    super.didUpdateWidget(old);
    // A new conversation opens at its newest message, its rows already there.
    if (old.conversation?.id != widget.conversation?.id) {
      _shownUpTo = null;
      if (_scroll.hasClients) _scroll.jumpTo(0);
    }
  }

  @override
  Widget build(BuildContext context) {
    final farm = ref.watch(farmProvider);
    final chat = farm?.chat;
    final conversation = widget.conversation;
    final lines = ref.watch(spokenProvider);
    final more = conversation == null ? null : ref.watch(chatLoadedProvider)[conversation.id];
    final all = itemsOf(chat, conversation, lines, more);
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
    final parent = conversation?.kind == ConversationKind.thread ? parentOf(chat, conversation!, more) : null;
    final unread = conversation == null ? 0 : unreadIn(chat, conversation);
    final waiting = farm?.foreman == ForemanState.thinking && conversation?.kind != ConversationKind.thread && all.isNotEmpty && all.last.sender != 'foreman';

    // What is on screen is read.
    if (conversation != null && unread > 0) {
      final mark = '${conversation.id}:${newestUnread(chat, conversation)}';
      if (mark != _marked) {
        _marked = mark;
        WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(ref.read(chatActionsProvider).markRead(conversation.id).catchError((Object _) {})));
      }
    }

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
            MessageItem(:final message) => 'message ${message.seq}',
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
                if (conversation != null && all.isNotEmpty && !(more?.complete ?? false) && !hasFilter)
                  Center(
                    child: KitTappable(
                      onTap: () => unawaited(ref.read(chatActionsProvider).loadOlder(conversation.id).catchError((Object _) {})),
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
                      style: KitText.sm.copyWith(color: Palette.bark500),
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

/// A row that arrived while the conversation was open rises 8 px into place and fades in, once, when it is first built
/// (a whole pixel at a time); every other row just appears, as everything does when the system asks for less motion.
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
    if (widget.fresh && _rise == null && kitMoves(context)) {
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
      meta: '语音 ${deskClock(line.at)}',
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

/// A report's outcome, as a tag over its words.
const _outcome = {Outcome.completed: ('做完了', Color(0xFFB4CB7C)), Outcome.failed: ('没做成', Color(0xFFE9A092)), Outcome.interrupted: ('叫停了', Color(0xFFE2C995))};

/// A tag's words with its sprite before them.
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
        Text(label, style: KitText.xs),
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
    final helper = m.fromKind == SenderKind.helper ? ref.watch(farmProvider)?.helpers.where((h) => h.id == m.from).firstOrNull : null;
    final dot = helper == null ? null : Color(phaseDot(helper.phase));
    final who = switch (m.fromKind) {
      SenderKind.helper => [
        '@${m.from}',
        if (helper != null) runtimeLabel[helper.runtime] ?? helper.runtime,
        if (agent != null && agent.role.isNotEmpty) _roleShort(agent.role),
      ].where((s) => s.isNotEmpty).join(' '),
      // The manager's name already says who it is.
      _ => '',
    };
    final outcome = m.outcome ?? Outcome.completed;
    final tag = switch (m.kind) {
      // Sowing: a dispatched job is planted in a plot.
      MessageKind.dispatch => const _Tag(icon: 'icon-seeds', label: '派活', fill: Color(0xFFF3D38A)),
      MessageKind.report => _Tag(icon: outcomeIcon[outcome]!, label: _outcome[outcome]!.$1, fill: _outcome[outcome]!.$2),
      _ => null,
    };
    final steps = chatTurnSteps;
    final turn = steps == null || !m.final_
        ? null
        : m.fromKind == SenderKind.foreman && m.kind != MessageKind.dispatch
        ? steps(context, managerAgent, m.at, manager: true)
        : m.fromKind == SenderKind.helper && m.kind == MessageKind.report
        ? steps(context, m.from, m.at, manager: false)
        : null;
    return _Frame(
      face: senderFace(m, 36),
      dot: dot,
      name: m.fromKind == SenderKind.user ? '主人' : m.name,
      meta: '${who.isNotEmpty ? '$who  ' : ''}${deskClock(m.at)}',
      continues: continues,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ?tag,
          Opacity(
            opacity: m.final_ ? 1 : .7,
            child: PxMarkdown(m.text, mentions: true, style: const TextStyle(height: 1.625)),
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

  /// The first clause of an agent's role, at most 18 characters.
  static String _roleShort(String role) {
    final first = role.split(RegExp('[，。,.]')).first;
    return first.length > 18 ? first.substring(0, 18) : first;
  }
}

/// A face, and beside it the header (unless it continues a run) and the body.
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
                      Text(widget.name, style: KitText.sm),
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

/// The thread under a message: how many replies, how many new, what its helper is doing, the last one; opens it.
class ThreadPreview extends ConsumerWidget {
  const ThreadPreview({super.key, required this.thread});
  final Conversation thread;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final farm = ref.watch(farmProvider);
    final chat = farm?.chat;
    final unread = unreadIn(chat, thread);
    final last = messagesIn(chat, thread.id).lastOrNull;
    final helper = thread.subjectKind == SubjectKind.job ? farm?.helpers.where((h) => h.id == thread.subjectId).firstOrNull : null;
    return KitTappable(
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
            // The farm window's thread chip, across the box: the bubble, the count, what is new, its helper, the way in.
            Row(
              children: [
                const Glyph('button-thread'),
                const SizedBox(width: 6),
                Text(thread.replies > 0 ? '${idText(thread.replies)} 条回复' : '工单串', style: KitText.sm),
                if (unread > 0) ...[
                  const SizedBox(width: 8),
                  Container(
                    color: Palette.leaf300,
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    child: Text('$unread 条新', style: KitText.xs),
                  ),
                ],
                const SizedBox(width: 8),
                if (helper != null) ...[PhaseGlyph(helper.phase, size: 14), const SizedBox(width: 4)],
                Expanded(
                  child: helper == null ? const SizedBox() : Text(phaseText(helper, nowMs()), maxLines: 1, overflow: TextOverflow.ellipsis, style: _grey),
                ),
                Opacity(opacity: s.hovered || s.focused ? 1 : .6, child: const SpriteIcon('button-next', size: 12)),
              ],
            ),
            if (last != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Row(
                  children: [
                    Text(last.fromKind == SenderKind.user ? '主人' : last.name, style: KitText.sm),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        last.text.replaceAll(RegExp(r'\s+'), ' '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: KitText.sm.copyWith(color: Palette.bark500),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(deskClock(last.at), style: _grey),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
