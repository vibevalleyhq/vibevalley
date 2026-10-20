import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/messages.dart';
import '../../gen/vibevalley.dart';
import '../../shared/composer.dart';
import '../../shared/manager_stop_button.dart';
import '../../ui/pixel/pixel.dart';

class ChatComposer extends ConsumerWidget {
  const ChatComposer({super.key, required this.conversation, required this.placeholder});
  final Conversation? conversation;
  final String placeholder;

  @override
  Widget build(BuildContext context, WidgetRef ref) => Container(
    decoration: const BoxDecoration(border: Border(top: pxLine)),
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    child: Composer(
      look: ComposerLook.panel,
      placeholder: placeholder,
      tools: const [ManagerStopButton()],
      onSend: (text, key) => ref.read(messagesProvider).send(text, sendKey: key, conversation: conversation),
    ),
  );
}
