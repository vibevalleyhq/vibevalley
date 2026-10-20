// Open, it is a window of a fixed size drawn up over the picture from its input row, so the farm never rescales.

import 'package:flutter/material.dart' hide Icon;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../shared/chat_rules.dart';
import '../shared/chat_widgets.dart';
import '../chat/dispatch_note.dart';
import '../gen/vibevalley.dart';
import '../data/prefs.dart';
import '../ui/kit/kit.dart';
import '../data/remote.dart' show agentsProvider;
import '../rules/money.dart';
import 'chat_window.dart';

class ChatRow extends StatelessWidget {
  const ChatRow({super.key, required this.mine, required this.first, required this.child, this.face, this.name, this.title});
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
    // A Tooltip here would take the words offstage for finders and screen readers alike.
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
                      child: DefaultTextStyle.merge(style: chatSmall, child: name!),
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

class ChatBubble extends StatelessWidget {
  const ChatBubble({
    super.key,
    required this.mine,
    required this.first,
    required this.text,
    required this.final_,
    this.face,
    this.name,
    this.at,
    this.aloud = false,
    this.tag,
    this.folded = false,
    this.after,
  });
  final bool mine;
  final bool first;
  final Widget? face;
  final Widget? name;
  final String text;
  final bool final_;
  final double? at;

  final bool aloud;
  final String? tag;

  /// One clipped line until tapped, as a dispatch note is.
  final bool folded;

  final Widget? after;

  @override
  Widget build(BuildContext context) {
    final title = [if (at != null) farmClock(at!), if (aloud) '语音'].join(' · ');
    return ChatRow(
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
          if (folded)
            DispatchNote(text, style: const TextStyle(color: Palette.bark900))
          else
            ChatText(
              text,
              folds: final_,
              style: TextStyle(color: mine ? Palette.cream50 : Palette.bark900),
              link: mine ? Palette.cream50 : Palette.leaf700,
            ),
          if (!final_) const StreamingCaret(),
          ?after,
        ],
      ),
    );
  }
}

class ChatParentMessage extends StatelessWidget {
  const ChatParentMessage({super.key, required this.message, required this.face});
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
                    if (message.fromKind == SenderKind.agent)
                      TextSpan(
                        text: ' @${message.from}',
                        style: KitText.mono.copyWith(color: Palette.bark500),
                      ),
                    TextSpan(text: ' · ${farmClock(message.at)}'),
                  ],
                ),
                style: chatSmall,
              ),
              ChatText(
                message.text,
                folds: message.final_,
                style: const TextStyle(color: Palette.bark800),
              ),
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

class ChatReportMessage extends StatelessWidget {
  const ChatReportMessage({super.key, required this.message, required this.first, required this.face, this.steps});
  final ChatMessage message;
  final bool first;
  final Widget face;
  final Widget? steps;

  @override
  Widget build(BuildContext context) {
    final (label, fill, ink) = _outcomeTag[message.outcome ?? Outcome.completed]!;
    return ChatRow(
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
          ChatText(message.text, folds: message.final_),
          if (message.spent != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('这一轮花了 ${spentText(message.spent!)}', style: chatSmall),
            ),
          ?steps,
        ],
      ),
    );
  }
}

class ChatThreadChip extends StatelessWidget {
  const ChatThreadChip({super.key, required this.thread, required this.unread, required this.onTap});
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

/// Who the next line goes to. [named] shows the name beside the head; without it the name is a tooltip. The composer decides from
/// its own width, not the screen's: a narrow window on a wide screen must keep its field wide.
class ChatPickChip extends ConsumerWidget {
  const ChatPickChip({super.key, this.named = true});

  final bool named;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pick = ref.watch(prefsProvider).pick;
    final agent = ref.watch(agentsProvider).value?[pick];
    if (pick == 'auto' || agent == null || !agent.enabled) return const SizedBox.shrink();
    final chip = Container(
      height: 32,
      margin: const EdgeInsets.only(right: 4),
      padding: const EdgeInsets.only(left: 2, right: 4),
      color: Palette.cream200,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          AgentHead(agent: agent.id, size: 26),
          if (named) ...[
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
    return named ? chip : Tooltip(message: '派给${agent.name}', child: chip);
  }
}
