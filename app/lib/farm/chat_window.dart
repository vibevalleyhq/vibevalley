// Open, it is a window of a fixed size drawn up over the picture from its input row, so the farm never rescales.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart' hide Icon;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../chat/channel_menu.dart';
import '../shared/chat_rules.dart';
import '../chat/chat_state.dart';
import '../data/messages.dart';
import '../chat/turn_steps.dart';
import '../shared/chat_widgets.dart';
import '../gen/vibevalley.dart';
import '../audio/sfx.dart';
import '../sprites/atlas.dart';
import '../ui/kit/kit.dart';
import '../voice/voice.dart';
import '../rules/chat.dart';
import '../rules/sessions.dart';
import '../shared/composer.dart';
import '../shared/manager_stop_button.dart';
import '../shared/swatches.dart';
import 'chat_messages.dart';
import 'chat_voice.dart';

const _suggestions = ['让阿郑做字幕面板', '让小吴跑测试', '进度怎么样？', '大家收工'];

const _greeting = '这里是田头，你、管家和帮工都在这儿说话。跟我说一句要做的活，比如「让测试小吴跑一遍测试」。\n\n帮工来了以后，写 @w1 这样的名字就是直接叫它；每个活下面挂着它的工单串。按右下角的麦克风，可以直接跟我说话。';

const chatSmall = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 4 / 3, color: Palette.bark500);

const _body = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 1.625, color: Palette.bark900);

/// About four lines.
// Below this the picked helper's chip is its head alone: with the name (about 150) the field would go under the width of its hint.
const _pickNamedFrom = 360.0;

enum ChatPhase { off, connecting, arriving, listening, thinking, speaking, leaving, error }

ChatPhase chatPhaseOf(VoiceCall v, CoreState s) {
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
  return switch (s.manager) {
    ManagerState.speaking => ChatPhase.speaking,
    ManagerState.thinking => ChatPhase.thinking,
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

class ChatWindow extends ConsumerStatefulWidget {
  const ChatWindow({super.key, required this.state, required this.atlas, required this.agents, required this.call});
  final CoreState state;
  final SpriteAtlas atlas;
  final Map<String, Agent> agents;

  final VoiceCall call;

  @override
  ConsumerState<ChatWindow> createState() => _ChatWindowState();
}

class _ChatWindowState extends ConsumerState<ChatWindow> {
  final _draft = ComposerDraft();
  final _scroll = ScrollController();
  String? _shownId;
  bool _skipHeaderTap = false;
  (Duration, Offset)? _lastHeaderUp;

  @override
  void initState() {
    super.initState();
    _draft.addListener(() => setState(() {}));
    _draft.naming.onNaming = () {
      if (!ref.read(chatOpenProvider)) _setOpen(true);
    };
  }

  @override
  void dispose() {
    _draft.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _setOpen(bool open) {
    Sfx.play(open ? 'open' : 'close');
    ref.read(chatOpenProvider.notifier).set(open);
  }

  void _toggleLarge() => ref.read(chatLargeProvider.notifier).set(!ref.read(chatLargeProvider));

  void _show(String? id) => unawaited(ref.read(chatActionsProvider).showChat(id).catchError((Object _) {}));

  Future<void> _say(Conversation? conversation, String text, String key) => ref.read(messagesProvider).send(text, sendKey: key, conversation: conversation);

  /// A suggested line goes out on its own key and leaves the draft alone.
  void _sendLine(Conversation? conversation, String line) {
    _draft.report(null);
    unawaited(
      _say(conversation, line, newSendKey()).catchError((Object e) {
        if (mounted) _draft.report(e);
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
    final shown = (shownId == null ? null : conversationOf(chat, shownId)) ?? generalOf(chat);
    final thread = shown?.kind == ConversationKind.thread ? shown : null;
    final phase = chatPhaseOf(widget.call, s);
    final unread = unreadTotal(chat);
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
                      if (thread != null) _threadHeader(chat, thread, large) else _generalHeader(chat, shown, phase, large),
                      Expanded(
                        child: Stack(
                          children: [
                            Positioned.fill(child: _messages(chat, shown, phase)),
                            if (_draft.naming.menu)
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
                                  child: NamingMenu(naming: _draft.naming, highlight: Palette.leaf300.withValues(alpha: .4)),
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (_draft.problem case final problem?)
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
                          child: Text(problem, style: chatSmall.copyWith(color: Palette.berry)),
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

  /// Read from raw pointer events: a double-tap recognizer here would hold every tap on the header's buttons until it gave up.
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

  Widget _generalHeader(Chat? chat, Conversation? shown, ChatPhase phase, bool large) {
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
                    child: Text(chatPhaseText[phase]!, maxLines: 1, overflow: TextOverflow.ellipsis, style: chatSmall),
                  ),
                  if (voiceOn && phase == ChatPhase.listening) ...[
                    const SizedBox(width: 6),
                    ChatLevelBars(level: widget.call.micLevel / 255, tone: Palette.leaf500),
                  ],
                  if (voiceOn && phase == ChatPhase.speaking) ...[
                    const SizedBox(width: 6),
                    ChatLevelBars(level: widget.call.managerLevel / 255, tone: Palette.wheat),
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
    final session = threadOwnerOf(thread, widget.state.sessions);
    final title = threadTitle(chat, thread, issues: widget.state.issues ?? const [], sessions: widget.state.sessions);
    final status = session != null
        ? phaseText(session, nowMs())
        : thread.subjectKind == SubjectKind.issue
        ? '现在没有帮工在干，串还留着'
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
              if (session != null) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  color: Palette.cream200,
                  child: Text('@${session.id}', style: KitText.mono.copyWith(color: Palette.bark600)),
                ),
              ],
              _inHeader(_NewElsewhere(chat: chat, except: thread.id, onShow: _show)),
            ],
          ),
          SizedBox(
            height: 16,
            child: Text(status, maxLines: 1, overflow: TextOverflow.ellipsis, style: chatSmall),
          ),
        ],
      ),
    );
  }

  Widget _messages(Chat? chat, Conversation? conversation, ChatPhase phase) {
    final feed = ref.watch(chatFeedProvider(conversation?.id));
    final items = feed.items;
    final parent = feed.parent;
    final thinking = phase == ChatPhase.thinking && conversation?.kind != ConversationKind.thread && (items.lastOrNull?.sender ?? '') != managerAgent;
    if (conversation != null) ref.watch(visibleConversationProvider(conversation.id));
    final children = <Widget>[
      if (feed.hasOlder)
        Center(
          child: KitTappable(
            onTap: () => unawaited(ref.read(chatActionsProvider).loadOlder(conversation!.id).catchError((Object _) {})),
            builder: (context, s) => Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
              color: s.hovered ? Palette.cream200 : null,
              child: Text('更早的消息', style: chatSmall.copyWith(color: s.hovered ? Palette.bark800 : Palette.bark500)),
            ),
          ),
        ),
      if (parent != null) ChatParentMessage(message: parent, face: _face(parent, 30)),
      if (items.isEmpty && conversation?.kind != ConversationKind.thread)
        ChatBubble(
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
          child: Center(child: Text('串里还没人说话。在这里说的话，它的帮工会看到。', style: chatSmall)),
        ),
      for (final (i, item) in items.indexed) _item(item, i == 0 || items[i - 1].sender != item.sender),
      if (thinking)
        ChatRow(
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
    SenderKind.manager => ManagerFace(atlas: widget.atlas, size: size),
    SenderKind.agent ||
    SenderKind.system => AnimalFace(atlas: widget.atlas, look: lookOf(widget.agents[m.agent], m.agent ?? m.from, widget.atlas.has), size: size),
  };

  Widget _item(ChatItem item, bool first) {
    switch (item) {
      case SpokenItem(:final line):
        return line.role == LineRole.user
            ? ChatBubble(mine: true, first: first, text: line.text, final_: line.final_, at: line.at, aloud: true)
            : ChatBubble(
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
            child: Text(m.text, textAlign: TextAlign.center, style: chatSmall.copyWith(height: 1.625)),
          );
        }
        if (m.kind == MessageKind.report) {
          return ChatReportMessage(
            message: m,
            first: first,
            face: _face(m, 30),
            steps: m.final_ && m.fromKind == SenderKind.agent ? TurnSteps(id: m.from, run: m.run) : null,
          );
        }
        final chip = thread == null ? null : ChatThreadChip(thread: thread, unread: unreadIn(widget.state.chat, thread), onTap: () => _show(thread.id));
        if (m.fromKind == SenderKind.user) return ChatBubble(mine: true, first: first, text: m.text, final_: m.final_, at: m.at, after: chip);
        // The dispatch note is the farm's, under the manager's name: its words say the same turn.
        final turn = m.final_ && m.fromKind == SenderKind.manager && m.kind != MessageKind.dispatch
            ? TurnSteps(id: managerAgent, run: m.run, manager: true)
            : null;
        return ChatBubble(
          mine: false,
          face: _face(m, 30),
          name: _senderName(m),
          first: first,
          text: m.text,
          final_: m.final_,
          at: m.at,
          tag: m.kind == MessageKind.dispatch ? '派活' : null,
          folded: m.kind == MessageKind.dispatch,
          after: turn == null && chip == null ? null : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [?turn, ?chip]),
        );
    }
  }

  Widget _suggestionRow(CoreState s, Conversation? shown) {
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
                  onTap: () => _sendLine(shown == null || shown.kind == ConversationKind.general ? null : shown, line),
                  builder: (context, st) => Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                    color: st.hovered ? Palette.leaf300 : Palette.cream200,
                    constraints: const BoxConstraints(maxWidth: 160),
                    child: Text(
                      line,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: KitText.xs.copyWith(color: st.hovered ? Palette.bark900 : Palette.bark800),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _composer(Conversation? conversation, Conversation? thread, ChatPhase phase, {required bool open, required bool unread}) {
    final voiceOn = widget.call.phase == CallPhase.live;
    final owner = thread == null ? null : threadOwnerOf(thread, widget.state.sessions);
    final placeholder = thread != null
        ? (owner != null ? '在串里说，${owner.name}会看到…' : '在串里说…')
        : voiceOn
        ? '直接说话，或者打字…'
        : '对管家说，@ 叫帮工…';
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
            // The bar's own padding and ring take 8 of this width.
            child: LayoutBuilder(
              builder: (context, box) => Composer(
                look: ComposerLook.bar,
                draft: _draft,
                placeholder: placeholder,
                leading: thread == null ? ChatPickChip(named: box.maxWidth - 8 >= _pickNamedFrom) : null,
                tools: const [ManagerStopButton(size: 24)],
                onSend: (text, key) => _say(conversation, text, key),
              ),
            ),
          ),
          const SizedBox(width: 6),
          ChatVoiceToggle(call: widget.call),
        ],
      ),
    );
  }

  Widget _senderName(ChatMessage m) => m.fromKind != SenderKind.agent
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
    builder: (context, s) => Container(
      width: 32,
      height: 32,
      alignment: Alignment.center,
      color: s.pressed ? Palette.cream300 : (s.hovered ? Palette.cream200 : null),
      child: Glyph(sprite),
    ),
  );
}

class _NewElsewhere extends StatelessWidget {
  const _NewElsewhere({required this.chat, required this.except, required this.onShow});
  final Chat? chat;
  final String? except;
  final void Function(String? id) onShow;

  @override
  Widget build(BuildContext context) {
    final waiting = [...?chat?.conversations.where((c) => c.id != except && unreadIn(chat, c) > 0)];
    if (waiting.isEmpty) return const SizedBox.shrink();
    final newest = waiting.reduce((a, b) => (b.lastNumber ?? 0) > (a.lastNumber ?? 0) ? b : a);
    final text = waiting.length > 1
        ? '${waiting.length} 处有新话'
        : newest.kind == ConversationKind.thread
        ? '串里有新话'
        : '${channelLabel(newest)}有新话';
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: KitTappable(
        onTap: () => onShow(newest.kind == ConversationKind.general ? null : newest.id),
        builder: (context, s) => Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
          color: Palette.berry.withValues(alpha: s.hovered ? .25 : .15),
          child: Text(text, style: KitText.xs.copyWith(color: Palette.berry)),
        ),
      ),
    );
  }
}
