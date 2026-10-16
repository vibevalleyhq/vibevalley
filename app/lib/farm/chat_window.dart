// The group chat (田头) in the farm's lower-right corner (web/src/farm/Chat.tsx): the square where you, the manager and
// the helpers talk, the channels, and the thread under each job. Messages are bubbles (markdown inside, @names
// highlighted); typing @ offers whom to name. Folded, it is just its input row; open, it is a window of a fixed size
// (or a larger one) drawn up over the picture from that row, so the farm never rescales. What it shows is the chat's
// shown conversation, the desk's chat page's too (lib/desk/chat).

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart' hide Icon;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../desk/chat/channel_menu.dart';
import '../desk/chat/chat_rules.dart';
import '../desk/chat/chat_state.dart';
import '../desk/chat/chat_widgets.dart';
import '../desktop/desktop.dart';
import '../gen/vibevalley.dart';
import '../shell/prefs.dart';
import '../shell/sfx.dart';
import '../sprites/atlas.dart';
import '../ui/kit/kit.dart';
import '../village/village_view.dart' show agentsProvider;
import '../village/world.dart' show lookOf;
import '../voice/voice.dart';
import '../rules/chat.dart';
import '../rules/farm.dart';
import '../rules/index.dart';

/// Quick lines to send while the manager is waiting for one.
const _suggestions = ['让前端阿郑把字幕面板做了', '让测试小吴跑一遍测试', '现在进度怎么样？', '大家收工'];

const _greeting = '这里是田头，你、管家和帮工都在这儿说话。跟我说一句要做的活，比如「让测试小吴跑一遍测试」。\n\n帮工来了以后，写 @w1 这样的名字就是直接叫它；每个活下面挂着它的工单串。按右下角的麦克风，可以直接跟我说话。';

const _small = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 4 / 3, color: Palette.bark500);
const _body = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 1.625, color: Palette.bark900);

/// The input grows to this many pixels (about four lines), then scrolls.
const _composerMax = 96.0;

// ── How the manager is doing ─────────────────────────────────────────────────

/// The call and the manager, in one word (Chat.tsx usePhase): the voice call first, then the day's own call.
enum ChatPhase { off, connecting, arriving, listening, thinking, speaking, leaving, error }

ChatPhase chatPhaseOf(VoiceCall v, FarmState s) {
  switch (v.phase) {
    case CallPhase.connecting:
      return ChatPhase.connecting;
    case CallPhase.ending:
      return ChatPhase.leaving;
    case CallPhase.live:
      if (!v.agentHere) return ChatPhase.arriving;
      return switch (v.agentState) {
        'speaking' => ChatPhase.speaking,
        'thinking' => ChatPhase.thinking,
        _ => ChatPhase.listening,
      };
    case CallPhase.idle:
      break;
  }
  if (s.call == CallState.connecting) return ChatPhase.connecting;
  if (s.call == CallState.error || v.problem != null) return ChatPhase.error;
  if (s.call != CallState.live) return ChatPhase.off;
  return switch (s.foreman) {
    ForemanState.speaking => ChatPhase.speaking,
    ForemanState.thinking => ChatPhase.thinking,
    _ => ChatPhase.listening,
  };
}

const chatPhaseText = {
  ChatPhase.off: '打字或者按麦克风，就开工',
  ChatPhase.connecting: '正在接通管家…',
  ChatPhase.arriving: '管家在赶来的路上…',
  ChatPhase.listening: '管家在听',
  ChatPhase.thinking: '管家在想…',
  ChatPhase.speaking: '管家在说',
  ChatPhase.leaving: '挂断中…',
  ChatPhase.error: '没接通，再试一次',
};

/// The ring around his face: green while listening, wheat while talking, berry when the call failed.
const _phaseRing = {
  ChatPhase.off: Palette.cream300,
  ChatPhase.connecting: Palette.cream300,
  ChatPhase.arriving: Palette.cream300,
  ChatPhase.listening: Palette.leaf500,
  ChatPhase.thinking: Palette.cream300,
  ChatPhase.speaking: Palette.wheat,
  ChatPhase.leaving: Palette.cream300,
  ChatPhase.error: Palette.berry,
};

// ── The window ───────────────────────────────────────────────────────────────

class ChatWindow extends ConsumerStatefulWidget {
  const ChatWindow({super.key, required this.state, required this.atlas, required this.agents, required this.onSay, required this.call});
  final FarmState state;
  final SpriteAtlas atlas;
  final Map<String, AgentProfile> agents;

  /// Says typed words on the square (the host's POST /api/say).
  final Future<void> Function(String text) onSay;
  final VoiceCall call;

  @override
  ConsumerState<ChatWindow> createState() => _ChatWindowState();
}

class _ChatWindowState extends ConsumerState<ChatWindow> {
  final _naming = Naming();
  final _scroll = ScrollController();
  String? _problem;
  String? _marked;
  double? _shownId;
  bool _skipHeaderTap = false;
  (Duration, Offset)? _lastHeaderUp;

  @override
  void initState() {
    super.initState();
    _naming
      ..addListener(() => setState(() {}))
      ..onNaming = () {
        // The menu is drawn inside the window: typing @ opens it.
        if (!ref.read(chatOpenProvider)) _setOpen(true);
      };
    widget.call.addListener(_syncLines);
  }

  @override
  void didUpdateWidget(ChatWindow old) {
    super.didUpdateWidget(old);
    if (old.call != widget.call) {
      old.call.removeListener(_syncLines);
      widget.call.addListener(_syncLines);
    }
  }

  @override
  void dispose() {
    widget.call.removeListener(_syncLines);
    _naming.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _syncLines() => ref.read(spokenProvider.notifier).sync(widget.call.captions.turns);

  void _setOpen(bool open) {
    Sfx.play(open ? 'open' : 'close');
    ref.read(chatOpenProvider.notifier).set(open);
  }

  void _toggleLarge() => ref.read(chatLargeProvider.notifier).set(!ref.read(chatLargeProvider));

  void _show(double? id) => unawaited(ref.read(chatActionsProvider).showChat(id).catchError((Object _) {}));

  /// A channel or a thread: said there. The square: through the host, once the day is on.
  void _send(Conversation? conversation, [String? line]) {
    final said = (line ?? _naming.text.text).trim();
    if (said.isEmpty) return;
    final actions = ref.read(chatActionsProvider);
    final Future<void> sent;
    if (conversation != null && conversation.kind != ConversationKind.square) {
      sent = actions.sayIn(conversation.id, said);
    } else if (actions.pickedAgent() != null) {
      sent = actions.talk(said);
    } else {
      sent = () async {
        if (await actions.whenLive()) await widget.onSay(said);
      }();
    }
    if (line == null) _naming.clear();
    setState(() => _problem = null);
    unawaited(
      sent.catchError((Object e) {
        if (mounted) setState(() => _problem = problemOf(e));
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.state;
    final chat = s.chat;
    final open = ref.watch(chatOpenProvider);
    final large = ref.watch(chatLargeProvider);
    final shownId = ref.watch(chatShownProvider);
    final shown = (shownId == null ? null : conversationOf(chat, shownId)) ?? squareOf(chat);
    final thread = shown?.kind == ConversationKind.thread ? shown : null;
    final phase = chatPhaseOf(widget.call, s);
    final unread = unreadTotal(chat);
    _naming.all = nameables(s.helpers, nowMs());
    if (shown?.id != _shownId) {
      _shownId = shown?.id;
      if (_scroll.hasClients) _scroll.jumpTo(0);
    }

    final screen = MediaQuery.sizeOf(context);
    final narrow = screen.width < 640;
    final Size size = !open
        ? Size(narrow ? screen.width - 24 : 360, 60)
        : large
        ? Size(narrow ? screen.width - 16 : math.min(640, screen.width - 192), math.min(760, screen.height - 120))
        : Size(narrow ? screen.width - 24 : 360, math.min(460, screen.height - 144));

    return Semantics(
      label: '田头',
      container: true,
      child: Focus(
        onKeyEvent: (_, e) {
          if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.escape && open) {
            _setOpen(false);
            return KeyEventResult.handled;
          }
          return KeyEventResult.ignored;
        },
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
          width: math.max(288, size.width),
          height: math.max(60, size.height),
          child: PxWindow(
            clip: true,
            child: Material(
              type: MaterialType.transparency,
              child: DefaultTextStyle(
                style: _body,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (open) ...[
                      if (thread != null) _threadHeader(chat, thread, large) else _squareHeader(chat, shown, phase, large),
                      Expanded(
                        child: Stack(
                          children: [
                            Positioned.fill(child: _messages(chat, shown, phase)),
                            if (_naming.menu)
                              Positioned(
                                left: 8,
                                right: 8,
                                bottom: 4,
                                child: Container(
                                  padding: const EdgeInsets.symmetric(vertical: 4),
                                  decoration: BoxDecoration(
                                    color: Palette.cream50,
                                    border: Border.all(color: Palette.cream300, width: 2),
                                    boxShadow: kitDrop,
                                  ),
                                  child: NamingMenu(naming: _naming, highlight: Palette.leaf300.withValues(alpha: .4)),
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (_problem != null)
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
                          child: Text(_problem!, style: _small.copyWith(color: Palette.berry)),
                        ),
                      if (thread == null) _suggestionRow(s, shown),
                    ],
                    _composer(shown, thread, phase, open: open, unread: !open && unread > 0),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ── Headers: where you are, and how the manager or the helper is ──────────

  /// Double-click the header to enlarge or restore, as with a window. Read from raw pointer events: a double-tap
  /// recognizer here would hold every tap on the header's buttons until it gave up.
  void _headerUp(PointerUpEvent e) {
    if (_skipHeaderTap) {
      _skipHeaderTap = false;
      _lastHeaderUp = null;
      return;
    }
    final last = _lastHeaderUp;
    if (last != null && e.timeStamp - last.$1 < kDoubleTapTimeout && (e.position - last.$2).distance < kDoubleTapSlop) {
      _lastHeaderUp = null;
      _toggleLarge();
    } else {
      _lastHeaderUp = (e.timeStamp, e.position);
    }
  }

  /// A press on a button in the header is not half of a double-click.
  Widget _inHeader(Widget child) => Listener(onPointerDown: (_) => _skipHeaderTap = true, child: child);

  Widget _headerFrame({required bool large, required Widget child, VoidCallback? back, String backLabel = '回到田头'}) => Listener(
    onPointerUp: _headerUp,
    child: Container(
      padding: EdgeInsets.fromLTRB(back != null ? 4 : 12, 8, 8, 8),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Palette.cream200)),
      ),
      child: Row(
        children: [
          if (back != null) _inHeader(_HeaderButton(label: backLabel, sprite: 'button-back', onTap: back)),
          const SizedBox(width: 4),
          Expanded(child: child),
          _inHeader(_HeaderButton(label: large ? '还原对话窗口' : '放大对话窗口', sprite: large ? 'button-shrink' : 'button-enlarge', onTap: _toggleLarge)),
          _inHeader(_HeaderButton(label: '收起对话', sprite: 'button-collapse', onTap: () => _setOpen(false))),
        ],
      ),
    ),
  );

  Widget _squareHeader(Chat? chat, Conversation? shown, ChatPhase phase, bool large) {
    final voiceOn = widget.call.phase == CallPhase.live;
    return _headerFrame(
      large: large,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const SpriteIcon('icon-board', size: 20),
              const SizedBox(width: 8),
              Flexible(child: _inHeader(ChannelMenu(current: shown))),
              if (voiceOn) ...[const SizedBox(width: 8), const _Pill('语音中')],
              _inHeader(_NewElsewhere(chat: chat, except: shown?.id, onShow: _show)),
            ],
          ),
          Semantics(
            liveRegion: true,
            child: SizedBox(
              height: 16,
              child: Row(
                children: [
                  Flexible(
                    child: Text(chatPhaseText[phase]!, maxLines: 1, overflow: TextOverflow.ellipsis, style: _small),
                  ),
                  if (voiceOn && phase == ChatPhase.listening) ...[
                    const SizedBox(width: 6),
                    _LevelBars(level: widget.call.micLevel / 255, tone: Palette.leaf500),
                  ],
                  if (voiceOn && phase == ChatPhase.speaking) ...[
                    const SizedBox(width: 6),
                    _LevelBars(level: widget.call.managerLevel / 255, tone: Palette.wheat),
                  ],
                  if (phase == ChatPhase.thinking || phase == ChatPhase.connecting || phase == ChatPhase.arriving) ...[
                    const SizedBox(width: 6),
                    const ThinkingDots(),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _threadHeader(Chat? chat, Conversation thread, bool large) {
    final channel = channelOf(chat, thread);
    final backTo = channel?.kind == ConversationKind.channel ? channel!.id : null;
    final helper = thread.subjectKind == SubjectKind.job ? widget.state.helpers.where((h) => h.id == thread.subjectId).firstOrNull : null;
    // A helper that left is named as it was in its own thread.
    final said = messagesIn(chat, thread.id).where((m) => m.from == thread.subjectId).firstOrNull?.name;
    final title = thread.subjectKind == SubjectKind.job ? '${helper?.name ?? said ?? thread.subjectId ?? ''}的工单串' : '串';
    final status = helper != null
        ? phaseText(helper, nowMs())
        : thread.subjectKind == SubjectKind.job
        ? '它已经离开农场，串还留着'
        : '${idText(thread.replies)} 条回复';
    return _headerFrame(
      large: large,
      back: () => _show(backTo),
      backLabel: '回到${channelLabel(channel)}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Flexible(
                child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.sm),
              ),
              if (helper != null) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  color: Palette.cream200,
                  child: Text('@${helper.id}', style: KitText.mono.copyWith(color: Palette.bark600)),
                ),
              ],
              _inHeader(_NewElsewhere(chat: chat, except: thread.id, onShow: _show)),
            ],
          ),
          SizedBox(
            height: 16,
            child: Text(status, maxLines: 1, overflow: TextOverflow.ellipsis, style: _small),
          ),
        ],
      ),
    );
  }

  // ── The conversation ─────────────────────────────────────────────────────

  Widget _messages(Chat? chat, Conversation? conversation, ChatPhase phase) {
    final lines = ref.watch(spokenProvider);
    final more = conversation == null ? null : ref.watch(chatLoadedProvider)[conversation.id];
    final items = itemsOf(chat, conversation, lines, more);
    final parent = conversation?.kind == ConversationKind.thread ? parentOf(chat, conversation!, more) : null;
    // The manager is thinking about an answer on the square, and has not begun it.
    final thinking = phase == ChatPhase.thinking && conversation?.kind != ConversationKind.thread && (items.lastOrNull?.sender ?? '') != 'foreman';
    final unread = conversation == null ? 0 : unreadIn(chat, conversation);
    // What is on screen is read.
    if (conversation != null && unread > 0) {
      final mark = '${conversation.id}:${newestUnread(chat, conversation)}';
      if (mark != _marked) {
        _marked = mark;
        WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(ref.read(chatActionsProvider).markRead(conversation.id).catchError((Object _) {})));
      }
    }
    final children = <Widget>[
      if (conversation != null && items.isNotEmpty && !(more?.complete ?? false))
        Center(
          child: KitTappable(
            onTap: () => unawaited(ref.read(chatActionsProvider).loadOlder(conversation.id).catchError((Object _) {})),
            builder: (context, s) => Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
              color: s.hovered ? Palette.cream200 : null,
              child: Text('更早的消息', style: _small.copyWith(color: s.hovered ? Palette.bark800 : Palette.bark500)),
            ),
          ),
        ),
      if (parent != null) _ParentMessage(message: parent, face: _face(parent, 30)),
      if (items.isEmpty && conversation?.kind != ConversationKind.thread)
        _Bubble(
          mine: false,
          face: ManagerFace(atlas: widget.atlas, size: 30),
          name: const Text('管家'),
          first: true,
          text: _greeting,
          final_: true,
        ),
      if (items.isEmpty && conversation?.kind == ConversationKind.thread)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 16),
          child: Center(child: Text('串里还没人说话。在这里说的话，它的帮工会看到。', style: _small)),
        ),
      for (final (i, item) in items.indexed) _item(item, i == 0 || items[i - 1].sender != item.sender),
      if (thinking)
        _Row(
          mine: false,
          face: ManagerFace(atlas: widget.atlas, size: 30),
          first: true,
          child: const SizedBox(
            height: 20,
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 4),
              child: Align(alignment: Alignment.centerLeft, child: ThinkingDots()),
            ),
          ),
        ),
    ];
    return Semantics(
      label: conversation?.kind == ConversationKind.thread ? '工单串' : channelLabel(conversation),
      child: LayoutBuilder(
        builder: (context, box) => SingleChildScrollView(
          controller: _scroll,
          // Reversed: it follows new messages at the bottom; older ones load above without a jump.
          reverse: true,
          padding: const EdgeInsets.all(12),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: math.max(0, box.maxHeight - 24)),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.start,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [for (final w in children) Padding(padding: const EdgeInsets.only(bottom: 8), child: w)],
            ),
          ),
        ),
      ),
    );
  }

  Widget _face(ChatMessage m, double size) => switch (m.fromKind) {
    SenderKind.user => OwnerFace(size: size),
    SenderKind.foreman => ManagerFace(atlas: widget.atlas, size: size),
    SenderKind.helper ||
    SenderKind.system => AnimalFace(atlas: widget.atlas, look: lookOf(widget.agents[m.agent], m.agent ?? m.from, widget.atlas.has), size: size),
  };

  Widget _item(ChatItem item, bool first) {
    switch (item) {
      case SpokenItem(:final line):
        return line.role == LineRole.user
            ? _Bubble(mine: true, first: first, text: line.text, final_: line.final_, at: line.at, aloud: true)
            : _Bubble(
                mine: false,
                face: ManagerFace(atlas: widget.atlas, size: 30),
                name: const Text('管家'),
                first: first,
                text: line.text,
                final_: line.final_,
                at: line.at,
                aloud: true,
              );
      case MessageItem(:final message, :final thread):
        final m = message;
        if (m.kind == MessageKind.notice || m.fromKind == SenderKind.system) {
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(m.text, textAlign: TextAlign.center, style: _small.copyWith(height: 1.625)),
          );
        }
        final steps = chatTurnSteps;
        if (m.kind == MessageKind.report) {
          return _ReportMessage(
            message: m,
            first: first,
            face: _face(m, 30),
            steps: steps != null && m.final_ && m.fromKind == SenderKind.helper ? steps(context, m.from, m.at, manager: false) : null,
          );
        }
        final chip = thread == null ? null : _ThreadChip(thread: thread, unread: unreadIn(widget.state.chat, thread), onTap: () => _show(thread.id));
        if (m.fromKind == SenderKind.user) return _Bubble(mine: true, first: first, text: m.text, final_: m.final_, at: m.at, after: chip);
        // The dispatch note is the farm's, under the manager's name: its words say the same turn.
        final turn = steps != null && m.final_ && m.fromKind == SenderKind.foreman && m.kind != MessageKind.dispatch
            ? steps(context, managerAgent, m.at, manager: true)
            : null;
        return _Bubble(
          mine: false,
          face: _face(m, 30),
          name: _senderName(m),
          first: first,
          text: m.text,
          final_: m.final_,
          at: m.at,
          tag: m.kind == MessageKind.dispatch ? '派活' : null,
          after: turn == null && chip == null ? null : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [?turn, ?chip]),
        );
    }
  }

  // ── Quick lines ────────────────────────────────────────────────────────────

  Widget _suggestionRow(FarmState s, Conversation? shown) {
    final empty = (s.chat?.messages ?? const []).isEmpty;
    final live = s.call == CallState.live;
    final speaking = widget.call.phase == CallPhase.live;
    if (speaking || !(live || empty)) return const SizedBox.shrink();
    return SizedBox(
      height: 32,
      child: ShaderMask(
        shaderCallback: (r) => const LinearGradient(colors: [Colors.black, Colors.black, Colors.transparent], stops: [0, .85, 1]).createShader(r),
        blendMode: BlendMode.dstIn,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
          children: [
            for (final line in _suggestions)
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: KitTappable(
                  onTap: () => _send(shown == null || shown.kind == ConversationKind.square ? null : shown, line),
                  builder: (context, st) => Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                    color: st.hovered ? Palette.leaf300 : Palette.cream200,
                    child: Text(line, style: KitText.xs.copyWith(color: st.hovered ? Palette.bark900 : Palette.bark800)),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  // ── Typing ─────────────────────────────────────────────────────────────────

  Widget _composer(Conversation? conversation, Conversation? thread, ChatPhase phase, {required bool open, required bool unread}) {
    final voiceOn = widget.call.phase == CallPhase.live;
    final owner = thread?.subjectKind == SubjectKind.job ? widget.state.helpers.where((h) => h.id == thread!.subjectId).firstOrNull : null;
    final placeholder = thread != null
        ? (owner != null ? '在串里说，${owner.name}会看到…' : '在串里说…')
        : voiceOn
        ? '直接说话，或者打字…'
        : '对管家说，@ 叫帮工…';
    final empty = _naming.text.text.trim().isEmpty;
    return Container(
      padding: const EdgeInsets.all(6),
      decoration: open
          ? const BoxDecoration(
              border: Border(top: BorderSide(color: Palette.cream200)),
            )
          : null,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          KitTappable(
            onTap: () => _setOpen(!open),
            tooltip: open ? '收起对话' : (unread ? '田头有新话，点开看看' : '展开对话'),
            semanticLabel: open ? '收起对话' : '展开对话',
            builder: (context, _) => Stack(
              clipBehavior: Clip.none,
              children: [
                // The button's focus-visible:ring-2 is the skin's inner line, over the phase's 2 px ring.
                Container(
                  padding: const EdgeInsets.all(2),
                  color: _phaseRing[phase],
                  foregroundDecoration: pxRing,
                  child: ManagerFace(atlas: widget.atlas, size: 40),
                ),
                if (unread)
                  Positioned(
                    top: -2,
                    right: -2,
                    child: Container(width: 12, height: 12, color: Palette.berry, foregroundDecoration: pxRing),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Container(
              constraints: const BoxConstraints(minHeight: 44),
              padding: const EdgeInsets.all(4),
              color: Palette.cream100,
              // focus-within:ring-2, the skin's inner line, shown always.
              foregroundDecoration: pxRing,
              child: Row(
                children: [
                  if (thread == null) const _PickChip(),
                  Expanded(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: _composerMax),
                      child: Focus(
                        onKeyEvent: (_, e) => _naming.key(e, () => _send(conversation)),
                        child: TextField(
                          controller: _naming.text,
                          focusNode: _naming.focus,
                          minLines: 1,
                          maxLines: null,
                          style: KitText.sm.copyWith(height: 2),
                          cursorColor: Palette.bark900,
                          decoration: InputDecoration(
                            hintText: placeholder,
                            hintStyle: KitText.sm.copyWith(color: Palette.bark400, height: 2),
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            filled: false,
                            isDense: true,
                            contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            semanticCounterText: '',
                          ),
                        ),
                      ),
                    ),
                  ),
                  KitTappable(
                    onTap: empty ? null : () => _send(conversation),
                    semanticLabel: '发送',
                    builder: (context, st) => Container(
                      width: 36,
                      height: 36,
                      alignment: Alignment.center,
                      color: st.hovered ? Palette.cream200 : null,
                      foregroundDecoration: pxRing,
                      child: Opacity(opacity: empty ? .35 : 1, child: const Glyph('button-send')),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(width: 6),
          _VoiceToggle(call: widget.call),
        ],
      ),
    );
  }

  Widget _senderName(ChatMessage m) => m.fromKind != SenderKind.helper
      ? Text(m.name)
      : Text.rich(
          TextSpan(
            children: [
              TextSpan(text: '${m.name} '),
              TextSpan(
                text: '@${m.from}',
                style: KitText.mono.copyWith(color: Palette.bark500),
              ),
            ],
          ),
        );
}

// ── Small parts ──────────────────────────────────────────────────────────────

class _Pill extends StatelessWidget {
  const _Pill(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    color: Palette.berry.withValues(alpha: .15),
    child: Text(text, style: KitText.xs.copyWith(color: Palette.berry)),
  );
}

class _HeaderButton extends StatelessWidget {
  const _HeaderButton({required this.label, required this.sprite, required this.onTap});
  final String label;
  final String sprite;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    tooltip: label,
    semanticLabel: label,
    // focus-visible:ring-2: the skin's inner cream-300 line.
    builder: (context, s) => Container(
      width: 32,
      height: 32,
      alignment: Alignment.center,
      color: s.hovered ? Palette.cream200 : null,
      foregroundDecoration: pxRing,
      child: Glyph(sprite),
    ),
  );
}

/// New words in other conversations: a pill that takes you to the newest of them.
class _NewElsewhere extends StatelessWidget {
  const _NewElsewhere({required this.chat, required this.except, required this.onShow});
  final Chat? chat;
  final double? except;
  final void Function(double? id) onShow;

  @override
  Widget build(BuildContext context) {
    final waiting = [...?chat?.conversations.where((c) => c.id != except && unreadIn(chat, c) > 0)];
    if (waiting.isEmpty) return const SizedBox.shrink();
    final newest = waiting.reduce((a, b) => (b.lastSeq ?? 0) > (a.lastSeq ?? 0) ? b : a);
    final text = waiting.length > 1
        ? '${waiting.length} 处有新话'
        : newest.kind == ConversationKind.thread
        ? '串里有新话'
        : '${channelLabel(newest)}有新话';
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: KitTappable(
        onTap: () => onShow(newest.kind == ConversationKind.square ? null : newest.id),
        builder: (context, s) => Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
          color: Palette.berry.withValues(alpha: s.hovered ? .25 : .15),
          child: Text(text, style: KitText.xs.copyWith(color: Palette.berry)),
        ),
      ),
    );
  }
}

/// One message: others' on the left beside their face (named above the first of a run), yours on the right in green.
class _Row extends StatelessWidget {
  const _Row({required this.mine, required this.first, required this.child, this.face, this.name, this.title});
  final bool mine;
  final bool first;
  final Widget? face;
  final Widget? name;
  final String? title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    Widget bubble = Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: mine
          ? const BoxDecoration(
              color: Palette.leaf500,
              boxShadow: [BoxShadow(color: Palette.leaf700, offset: Offset(0, 2))],
            )
          : BoxDecoration(
              color: Palette.cream100,
              border: Border.all(color: Palette.cream300, width: 1.5),
              boxShadow: const [BoxShadow(color: Color(0x297A5F40), offset: Offset(0, 2))],
            ),
      child: DefaultTextStyle.merge(
        style: TextStyle(color: mine ? Palette.cream50 : Palette.bark900),
        child: child,
      ),
    );
    // The page's title (the time, 语音) as the bubble's semantics: a Tooltip here would take the words offstage for finders
    // and screen readers alike.
    if (title != null) bubble = Semantics(hint: title, child: bubble);
    return Padding(
      padding: EdgeInsets.only(top: first ? 4 : 0),
      child: LayoutBuilder(
        builder: (context, box) => Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: mine ? MainAxisAlignment.end : MainAxisAlignment.start,
          children: [
            if (!mine) ...[SizedBox(width: 30, child: first ? face : null), const SizedBox(width: 8)],
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: box.maxWidth * .84),
              child: Column(
                crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                children: [
                  if (!mine && first && name != null)
                    Padding(
                      padding: const EdgeInsets.only(left: 4, right: 4, bottom: 2),
                      child: DefaultTextStyle.merge(style: _small, child: name!),
                    ),
                  bubble,
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({
    required this.mine,
    required this.first,
    required this.text,
    required this.final_,
    this.face,
    this.name,
    this.at,
    this.aloud = false,
    this.tag,
    this.after,
  });
  final bool mine;
  final bool first;
  final Widget? face;
  final Widget? name;
  final String text;
  final bool final_;
  final double? at;

  /// Said aloud in a voice call.
  final bool aloud;
  final String? tag;

  /// Under the words: the turn's steps, the thread chip.
  final Widget? after;

  @override
  Widget build(BuildContext context) {
    final title = [if (at != null) farmClock(at!), if (aloud) '语音'].join(' · ');
    return _Row(
      mine: mine,
      face: face,
      name: name,
      first: first,
      title: title.isEmpty ? null : title,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (tag != null)
            Container(
              margin: const EdgeInsets.only(bottom: 4),
              padding: const EdgeInsets.symmetric(horizontal: 6),
              color: Palette.wheat.withValues(alpha: .4),
              child: Text(tag!, style: KitText.xs.copyWith(color: Palette.bark800)),
            ),
          PxMarkdown(text, mentions: true, style: TextStyle(color: mine ? Palette.cream50 : Palette.bark900)),
          if (!final_) const StreamingCaret(),
          ?after,
        ],
      ),
    );
  }
}

/// The message a thread hangs under, at its top.
class _ParentMessage extends StatelessWidget {
  const _ParentMessage({required this.message, required this.face});
  final ChatMessage message;
  final Widget face;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 4),
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    color: Palette.cream100,
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        face,
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text.rich(
                TextSpan(
                  children: [
                    TextSpan(text: message.name),
                    if (message.fromKind == SenderKind.helper)
                      TextSpan(
                        text: ' @${message.from}',
                        style: KitText.mono.copyWith(color: Palette.bark500),
                      ),
                    TextSpan(text: ' · ${farmClock(message.at)}'),
                  ],
                ),
                style: _small,
              ),
              PxMarkdown(message.text, mentions: true, style: const TextStyle(color: Palette.bark800)),
            ],
          ),
        ),
      ],
    ),
  );
}

const _outcomeTag = {
  Outcome.completed: ('做完了', Color(0x66E5A93C), Palette.bark900),
  Outcome.failed: ('没做成', Color(0x26C84A3A), Palette.berry),
  Outcome.interrupted: ('叫停了', Palette.cream200, Palette.bark600),
};

/// A helper's report at the end of a turn, in its job thread.
class _ReportMessage extends StatelessWidget {
  const _ReportMessage({required this.message, required this.first, required this.face, this.steps});
  final ChatMessage message;
  final bool first;
  final Widget face;
  final Widget? steps;

  @override
  Widget build(BuildContext context) {
    final (label, fill, ink) = _outcomeTag[message.outcome ?? Outcome.completed]!;
    return _Row(
      mine: false,
      face: face,
      first: first,
      title: farmClock(message.at),
      name: Text.rich(
        TextSpan(
          children: [
            TextSpan(text: '${message.name} '),
            TextSpan(
              text: '@${message.from}',
              style: KitText.mono.copyWith(color: Palette.bark500),
            ),
          ],
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            margin: const EdgeInsets.only(bottom: 4),
            padding: const EdgeInsets.symmetric(horizontal: 6),
            color: fill,
            child: Text(label, style: KitText.xs.copyWith(color: ink)),
          ),
          PxMarkdown(message.text, mentions: true),
          if (message.spent != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('这一轮花了 ${spentText(message.spent!)}', style: _small),
            ),
          ?steps,
        ],
      ),
    );
  }
}

/// The thread under a message: how many replies, how many new, and the way in.
class _ThreadChip extends StatelessWidget {
  const _ThreadChip({required this.thread, required this.unread, required this.onTap});
  final Conversation thread;
  final int unread;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 6),
    child: KitTappable(
      onTap: onTap,
      builder: (context, s) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          color: s.hovered ? Palette.cream50 : Palette.cream50.withValues(alpha: .8),
          border: Border.all(color: Palette.cream300),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Glyph('button-thread'),
            const SizedBox(width: 6),
            Text(thread.replies > 0 ? '${idText(thread.replies)} 条回复' : '工单串', style: KitText.xs.copyWith(color: Palette.leaf700)),
            if (unread > 0) ...[
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6),
                color: Palette.berry,
                child: Text('$unread 新', style: KitText.xs.copyWith(color: Palette.cream50)),
              ),
            ],
            const SizedBox(width: 6),
            const SpriteIcon('button-next', size: 12),
          ],
        ),
      ),
    ),
  );
}

/// Who the next job goes to, when one was picked from the friends bar.
class _PickChip extends ConsumerWidget {
  const _PickChip();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pick = ref.watch(prefsProvider).pick;
    final agent = ref.watch(agentsProvider).value?[pick];
    if (pick == 'auto' || agent == null || !agent.enabled) return const SizedBox.shrink();
    final wide = MediaQuery.sizeOf(context).width >= 640;
    return Container(
      height: 32,
      margin: const EdgeInsets.only(right: 4),
      padding: const EdgeInsets.only(left: 2, right: 4),
      color: Palette.cream200,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          AgentHead(agent: agent.id, size: 26),
          if (wide) ...[
            const SizedBox(width: 4),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 80),
              child: Text(
                '派给${agent.name}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: KitText.xs.copyWith(color: Palette.bark800),
              ),
            ),
          ],
          KitTappable(
            onTap: () => ref.read(prefsProvider.notifier).setPick('auto'),
            semanticLabel: '不指定帮工',
            builder: (context, s) => Container(
              width: 24,
              height: 24,
              alignment: Alignment.center,
              color: s.hovered ? Palette.cream300 : null,
              child: const SpriteIcon('button-close', size: 12),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Voice ────────────────────────────────────────────────────────────────────

const _mood = {'speaking': '在说话', 'listening': '在听', 'thinking': '在想', 'idle': '在听', 'silent': '在听'};

/// The microphone: talk to the manager by voice (Agora). Press again to hang up.
class _VoiceToggle extends ConsumerWidget {
  const _VoiceToggle({required this.call});
  final VoiceCall call;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final desktop = ref.watch(desktopProvider);
    final live = call.phase == CallPhase.live;
    final joining = call.phase == CallPhase.connecting;
    final leaving = call.phase == CallPhase.ending;
    final error = call.phase == CallPhase.idle && call.problem != null;
    final tip = live
        ? '挂断语音。管家${call.agentHere ? (_mood[call.agentState] ?? '在听') : '还在路上'}'
        : joining
        ? '正在接通管家…'
        : leaving
        ? '挂断中…'
        : error
        ? '上次没接通：${call.problem}。再按一下重试'
        : '按一下，和管家语音说话${desktop.isDesktop && desktop.voiceShortcut.isNotEmpty ? '（别的程序在前面时按 ${shortcutText(desktop.voiceShortcut)}）' : ''}';
    final fill = leaving
        ? Palette.cream300
        : live
        ? Palette.berry
        : error
        ? const Color(0xFFC9813A)
        : Palette.leaf500;
    return KitTappable(
      onTap: leaving ? null : () => unawaited(live || joining ? call.end() : call.start()),
      tooltip: tip,
      semanticLabel: live || joining ? '挂断语音' : '语音说话',
      selected: live,
      builder: (context, s) => Transform.translate(
        offset: Offset(0, s.pressed ? 1 : 0),
        child: Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: !live && !error && !leaving && s.hovered ? Palette.leaf600 : fill,
            boxShadow: const [BoxShadow(color: Color(0x2E000000), offset: Offset(0, 3))],
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              // A soft square around the microphone that grows with your voice.
              if (live)
                Positioned.fill(
                  child: Transform.scale(
                    scale: 1 + math.min(1, call.micLevel / 255 * 1.6) * .45,
                    child: Container(color: Palette.berry.withValues(alpha: .35)),
                  ),
                ),
              if (joining || leaving)
                const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Palette.cream50, backgroundColor: Color(0x80F7E8C4)),
                )
              else
                Glyph(live ? 'button-hangup' : 'button-mic'),
            ],
          ),
        ),
      ),
    );
  }
}

/// Five bars that follow one side's loudness (0 to 1).
class _LevelBars extends StatelessWidget {
  const _LevelBars({required this.level, required this.tone});
  final double level;
  final Color tone;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: SizedBox(
      height: 14,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (i, weight) in const [.55, .85, 1.0, .75, .5].indexed)
            AnimatedContainer(
              duration: const Duration(milliseconds: 100),
              curve: Curves.easeOut,
              margin: EdgeInsets.only(left: i == 0 ? 0 : 3),
              width: 3,
              height: 14 * (math.max(18, math.min(100, 18 + level * weight * 150)) / 100),
              color: tone,
            ),
        ],
      ),
    ),
  );
}
