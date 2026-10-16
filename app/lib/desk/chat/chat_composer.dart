import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import 'chat_rules.dart';
import 'chat_state.dart';
import 'chat_widgets.dart';

class ChatComposer extends ConsumerStatefulWidget {
  const ChatComposer({super.key, required this.conversation, required this.placeholder});
  final Conversation? conversation;
  final String placeholder;

  @override
  ConsumerState<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends ConsumerState<ChatComposer> {
  final _naming = Naming();
  String? _problem;

  @override
  void initState() {
    super.initState();
    _naming.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _naming.dispose();
    super.dispose();
  }

  void _send() {
    final said = _naming.text.text.trim();
    if (said.isEmpty) return;
    final c = widget.conversation;
    final actions = ref.read(chatActionsProvider);
    final sent = c != null && c.kind != ConversationKind.square ? actions.sayIn(c.id, said) : actions.talk(said);
    _naming.clear();
    setState(() => _problem = null);
    unawaited(
      sent.catchError((Object e) {
        if (mounted) setState(() => _problem = problemOf(e));
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    _naming.all = nameables(ref.watch(farmProvider)?.helpers ?? const [], nowMs());
    final empty = _naming.text.text.trim().isEmpty;
    return Container(
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: Palette.bark900, width: 2)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_naming.menu)
            Container(
              margin: const EdgeInsets.only(bottom: 4),
              padding: const EdgeInsets.symmetric(vertical: 4),
              decoration: const BoxDecoration(
                color: Palette.cream50,
                border: Border.fromBorderSide(BorderSide(color: Palette.bark900, width: 2)),
                boxShadow: kitDrop,
              ),
              child: NamingMenu(naming: _naming, highlight: Palette.wheat, faceSize: 22, everyoneMark: false),
            ),
          if (_problem != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(_problem!, style: KitText.xs.copyWith(color: Palette.berry)),
            ),
          Container(
            decoration: const BoxDecoration(
              color: Palette.cream50,
              border: Border.fromBorderSide(BorderSide(color: Palette.bark900, width: 2)),
              boxShadow: kitDrop,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 56, maxHeight: 192),
                  child: Focus(
                    onKeyEvent: (_, e) => _naming.key(e, _send),
                    child: TextField(
                      controller: _naming.text,
                      focusNode: _naming.focus,
                      minLines: 2,
                      maxLines: null,
                      style: KitText.sm.copyWith(height: 2),
                      cursorColor: Palette.bark900,
                      decoration: InputDecoration(
                        hintText: widget.placeholder,
                        hintStyle: KitText.sm.copyWith(height: 2, color: Palette.bark400),
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        filled: false,
                        isDense: true,
                        contentPadding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                      ),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text('回车发送 · Shift+回车换行 · @ 叫人', style: KitText.xs.copyWith(color: Palette.bark400)),
                      ),
                      PxButton(
                        size: PxSize.custom,
                        tone: PxTone.primary,
                        semanticLabel: '发送',
                        onPressed: empty ? null : _send,
                        child: const SizedBox.square(dimension: 28, child: Center(child: Glyph('button-send'))),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
