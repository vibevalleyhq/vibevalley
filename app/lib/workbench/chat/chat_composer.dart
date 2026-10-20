import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/messages.dart';
import '../../gen/vibevalley.dart';
import '../../ui/pro/pro.dart';
import '../shared/composer.dart';

class ChatComposer extends ConsumerWidget {
  const ChatComposer({super.key, required this.conversation, required this.placeholder});
  final Conversation? conversation;
  final String placeholder;

  @override
  Widget build(BuildContext context, WidgetRef ref) => Container(
    decoration: const BoxDecoration(border: Border(top: proLine)),
    padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
    child: WorkbenchComposer(
      placeholder: placeholder,
      stop: true,
      onSend: (text, key) => ref.read(messagesProvider).send(text, sendKey: key, conversation: conversation),
    ),
  );
}
