import '../../data/remote.dart' show projectNamesProvider;
// A channel has no members to pick: helpers are in the channel their job was arranged in.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../audio/sfx.dart';
import '../../ui/pro/pro.dart';
import '../../chat/chat_state.dart';
import '../../rules/chat.dart';

Future<void> showNewChannelDialog(BuildContext context) => showProDialog<void>(context, title: const Text('创建频道'), builder: (_) => const NewChannelForm());

Future<void> showChannelSettingsDialog(BuildContext context, Conversation channel) => showProDialog<void>(
  context,
  title: Text('${channel.kind == ConversationKind.general ? '# $generalName' : '# ${channel.name ?? ''}'} 的设置'),
  builder: (_) => ChannelSettingsForm(channel: channel),
);

class _Actions extends StatelessWidget {
  const _Actions({required this.submit, required this.onSubmit});
  final String submit;
  final VoidCallback? onSubmit;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 24),
    child: Row(
      mainAxisAlignment: MainAxisAlignment.end,
      children: [
        ProButton.text(
          '取消',
          size: ProSize.custom,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 6),
          onPressed: () => Navigator.of(context).pop(),
        ),
        const SizedBox(width: 12),
        ProButton.text(
          submit,
          size: ProSize.custom,
          tone: ProTone.primary,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 6),
          onPressed: onSubmit,
        ),
      ],
    ),
  );
}

class _ProjectInput extends ConsumerWidget {
  const _ProjectInput({required this.value, required this.onChanged});
  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) => ProTextInput(
    value: value,
    onChanged: onChanged,
    placeholder: '比如 clock-in',
    semanticLabel: '默认项目',
    suggestions: ref.watch(projectNamesProvider).value ?? const [],
  );
}

class NewChannelForm extends ConsumerStatefulWidget {
  const NewChannelForm({super.key});

  @override
  ConsumerState<NewChannelForm> createState() => _NewChannelFormState();
}

class _NewChannelFormState extends ConsumerState<NewChannelForm> {
  String _name = '';
  String _description = '';
  String _project = '';
  String? _error;
  bool _busy = false;

  Future<void> _submit() async {
    setState(() => _busy = true);
    try {
      await ref
          .read(chatActionsProvider)
          .openChannel(
            ChannelRequest(name: _name, description: _description.trim().isEmpty ? null : _description, project: _project.trim().isEmpty ? null : _project),
          );
    } on Object catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = problemOf(e);
        });
      }
      return;
    }
    Sfx.play('open');
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      ProField(
        label: '名称',
        required: true,
        hint: const Text('字母、数字、汉字、- 和 _，不超过 24 个字'),
        child: ProTextInput(
          value: _name,
          autofocus: true,
          onChanged: (v) => setState(() {
            _name = v;
            _error = null;
          }),
          onSubmitted: (_) => _name.trim().isEmpty || _busy ? null : _submit(),
          placeholder: '例如 clock-in',
          semanticLabel: '名称',
        ),
      ),
      const SizedBox(height: 16),
      ProField(
        label: '描述',
        optional: true,
        child: ProTextArea(rows: 3, value: _description, onChanged: (v) => setState(() => _description = v), placeholder: '这个频道是做什么的？', semanticLabel: '描述'),
      ),
      const SizedBox(height: 16),
      ProField(
        label: '默认项目',
        optional: true,
        hint: const Text('在这个频道里派活、没说项目时，就在这个项目里干'),
        child: _ProjectInput(value: _project, onChanged: (v) => setState(() => _project = v)),
      ),
      if (_error != null)
        Padding(
          padding: const EdgeInsets.only(top: 16),
          child: Text(_error!, style: ProText.sm.copyWith(color: Palette.berry)),
        ),
      _Actions(submit: '创建频道', onSubmit: _busy || _name.trim().isEmpty ? null : _submit),
    ],
  );
}

class ChannelSettingsForm extends ConsumerStatefulWidget {
  const ChannelSettingsForm({super.key, required this.channel});
  final Conversation channel;

  @override
  ConsumerState<ChannelSettingsForm> createState() => _ChannelSettingsFormState();
}

class _ChannelSettingsFormState extends ConsumerState<ChannelSettingsForm> {
  late final Conversation _latest = conversationOf(ref.read(stateProvider)?.chat, widget.channel.id) ?? widget.channel;
  late String _description = _latest.description ?? '';
  late String _project = _latest.project ?? '';
  String? _error;
  bool _busy = false;

  Future<void> _submit() async {
    setState(() => _busy = true);
    try {
      await ref.read(chatActionsProvider).updateChannel(widget.channel.id, ChannelUpdate(description: _description, project: _project));
    } on Object catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = problemOf(e);
        });
      }
      return;
    }
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      ProField(
        label: '描述',
        optional: true,
        child: ProTextArea(rows: 3, value: _description, onChanged: (v) => setState(() => _description = v), placeholder: '这个频道是做什么的？', semanticLabel: '描述'),
      ),
      const SizedBox(height: 16),
      ProField(
        label: '默认项目',
        optional: true,
        hint: const Text('空着就没有：派活时管家要问在哪个项目'),
        child: _ProjectInput(value: _project, onChanged: (v) => setState(() => _project = v)),
      ),
      if (_error != null)
        Padding(
          padding: const EdgeInsets.only(top: 16),
          child: Text(_error!, style: ProText.sm.copyWith(color: Palette.berry)),
        ),
      _Actions(submit: '保存', onSubmit: _busy ? null : _submit),
    ],
  );
}
