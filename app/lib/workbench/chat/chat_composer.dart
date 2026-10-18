import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import '../../chat/chat_rules.dart';
import '../../chat/chat_state.dart' show problemOf;
import '../../data/messages.dart';
import '../../chat/chat_widgets.dart';
import '../../chat/dictation_button.dart';
import '../../chat/manager_stop_button.dart';

class ChatComposer extends ConsumerStatefulWidget {
  const ChatComposer({super.key, required this.conversation, required this.placeholder});
  final Conversation? conversation;
  final String placeholder;

  @override
  ConsumerState<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends ConsumerState<ChatComposer> {
  final _naming = Naming();
  final _keys = SendKeys();
  String? _problem;
  bool _sending = false;

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

  Future<void> _send() async {
    final draft = _naming.text.text;
    final said = draft.trim();
    if (said.isEmpty || _sending) return;
    final c = widget.conversation;
    final messages = ref.read(messagesProvider);
    setState(() {
      _sending = true;
      _problem = null;
    });
    try {
      await messages.send(said, sendKey: _keys.of(said), conversation: c);
      _keys.sent();
      if (mounted && _naming.text.text == draft) _naming.clear();
    } on Object catch (e) {
      if (mounted) setState(() => _problem = problemOf(e));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    _naming.all = nameables(ref.watch(stateProvider)?.sessions ?? const [], nowMs());
    final empty = _naming.text.text.trim().isEmpty;
    return Container(
      decoration: const BoxDecoration(border: Border(top: pxLine)),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_naming.menu)
            Container(
              margin: const EdgeInsets.only(bottom: 4),
              padding: const EdgeInsets.symmetric(vertical: 4),
              decoration: const BoxDecoration(color: Palette.cream50, border: Border.fromBorderSide(pxLine), boxShadow: kitDrop),
              child: NamingMenu(naming: _naming, highlight: Palette.wheat, faceSize: 22, everyoneMark: false),
            ),
          if (_problem != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(_problem!, style: KitText.xs.copyWith(color: Palette.berry)),
            ),
          Container(
            decoration: const BoxDecoration(color: Palette.cream50, border: Border.fromBorderSide(pxLine), boxShadow: kitDrop),
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
                      const ManagerStopButton(),
                      DictationButton(controller: _naming.text),
                      const SizedBox(width: 6),
                      PxButton(
                        size: PxSize.custom,
                        tone: PxTone.primary,
                        semanticLabel: '发送',
                        onPressed: empty || _sending ? null : _send,
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
