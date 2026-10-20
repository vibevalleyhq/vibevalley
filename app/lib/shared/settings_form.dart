import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../audio/sfx.dart';
import '../data/ui_state.dart' show settingsProvider;
import '../gen/vibevalley.dart';
import '../ui/pixel/pixel.dart';

const _from = {KeySource.settings: '存在设置里', KeySource.config: '来自配置（vibevalley.yaml 或环境变量）'};

String _keyLine(KeyStatus k) => k.source != null ? '在用 ${k.hint ?? ''}（${_from[k.source]}）' : '还没有';

enum _Key { deepseekApiKey, agoraAppId, agoraAppCertificate }

/// The keys and the memory sources, saved to the server (setting.save); the workbench's 设置 shows it a part at a time.
/// The parts a page can show one at a time; the title screen shows them all.
enum SettingsPart { deepseek, agora, memory }

class SettingsForm extends ConsumerStatefulWidget {
  const SettingsForm({super.key, this.part});

  /// Null: every part.
  final SettingsPart? part;

  @override
  ConsumerState<SettingsForm> createState() => _SettingsFormState();
}

class _SettingsFormState extends ConsumerState<SettingsForm> {
  final _deepseek = TextEditingController();
  final _certificate = TextEditingController();
  TextEditingController? _appId;
  final _cleared = <_Key>{};
  final _sources = <MemorySourceKind, _SourceDraft>{};
  String? _error;
  bool _saved = false;
  bool _busy = false;

  @override
  void dispose() {
    _deepseek.dispose();
    _certificate.dispose();
    _appId?.dispose();
    for (final d in _sources.values) {
      d.dispose();
    }
    super.dispose();
  }

  bool _shows(SettingsPart part) => widget.part == null || widget.part == part;

  void _clear(_Key key) => setState(() {
    _cleared.add(key);
    _saved = false;
  });

  Future<void> _submit(SettingsStatus status) async {
    // A key cleared and not typed again goes as '' (the server forgets it).
    String? value(_Key k, String typed) => typed.trim().isNotEmpty ? typed.trim() : (_cleared.contains(k) ? '' : null);
    final appId = _appId?.text.trim();
    final update = SettingsUpdate(
      deepseekApiKey: value(_Key.deepseekApiKey, _deepseek.text),
      agoraAppId: appId != null && appId != (status.agoraAppId.value ?? '') ? appId : (_cleared.contains(_Key.agoraAppId) ? '' : null),
      agoraAppCertificate: value(_Key.agoraAppCertificate, _certificate.text),
      memorySources: !_sources.values.any((d) => d.changed)
          ? null
          : [
              for (final d in _sources.values)
                if (d.url.text.trim().isNotEmpty || d.enabled)
                  MemorySourceUpdate(
                    kind: d.kind,
                    url: d.url.text.trim(),
                    enabled: d.enabled,
                    read: d.read,
                    write: d.write,
                    everything: d.everything ? true : null,
                    user: d.user.text.trim().isEmpty ? null : d.user.text.trim(),
                    key: d.key.text.trim().isNotEmpty ? d.key.text.trim() : (d.keyCleared ? '' : null),
                  ),
            ],
    );
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(settingsProvider.notifier).save(update);
    } on Object catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = '$e';
        });
      }
      return;
    }
    if (!mounted) return;
    Sfx.play('open');
    setState(() {
      _busy = false;
      _deepseek.clear();
      _certificate.clear();
      _appId?.dispose();
      _appId = null;
      _cleared.clear();
      for (final d in _sources.values) {
        d.dispose();
      }
      _sources.clear();
      _saved = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(settingsProvider);
    if (status == null) {
      return const Text(
        '在问服务端……',
        style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark800),
      );
    }
    final appId = _appId ??= TextEditingController(text: status.agoraAppId.value ?? '');
    void changed(String _) => setState(() => _saved = false);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_shows(SettingsPart.deepseek)) ...[
          _KeyField(
            label: 'DeepSeek API Key',
            help: _Link('platform.deepseek.com', Uri.parse('https://platform.deepseek.com/api_keys')),
            line: _cleared.contains(_Key.deepseekApiKey) ? '存的时候清掉' : _keyLine(status.deepseekApiKey),
            canClear: status.deepseekApiKey.source == KeySource.settings && !_cleared.contains(_Key.deepseekApiKey),
            onClear: () => _clear(_Key.deepseekApiKey),
            child: _SecretInput(controller: _deepseek, placeholder: 'sk-…（不改就空着）', label: 'DeepSeek API Key', onChanged: changed),
          ),
          const SizedBox(height: 16),
        ],
        if (_shows(SettingsPart.agora)) ...[
          _KeyField(
            label: 'Agora App ID',
            help: _Link('console.agora.io', Uri.parse('https://console.agora.io/')),
            line: _cleared.contains(_Key.agoraAppId)
                ? '存的时候清掉'
                : status.agoraAppId.source != null
                ? '（${_from[status.agoraAppId.source]}）'
                : '还没有',
            canClear: status.agoraAppId.source == KeySource.settings && !_cleared.contains(_Key.agoraAppId),
            onClear: () => _clear(_Key.agoraAppId),
            child: _Input(controller: appId, placeholder: '32 位，比如 0123…cdef', label: 'Agora App ID', onChanged: changed),
          ),
          const SizedBox(height: 16),
          _KeyField(
            label: 'Agora App Certificate',
            help: const Text(
              '和 App ID 在同一个项目里',
              style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark500),
            ),
            line: _cleared.contains(_Key.agoraAppCertificate) ? '存的时候清掉' : _keyLine(status.agoraAppCertificate),
            canClear: status.agoraAppCertificate.source == KeySource.settings && !_cleared.contains(_Key.agoraAppCertificate),
            onClear: () => _clear(_Key.agoraAppCertificate),
            child: _SecretInput(controller: _certificate, placeholder: '不改就空着', label: 'Agora App Certificate', onChanged: changed),
          ),
          const SizedBox(height: 16),
        ],
        if (_shows(SettingsPart.memory))
          for (final kind in MemorySourceKind.values) ...[
            _MemorySourceField(
              draft: _sources[kind] ??= _SourceDraft(kind, status.memorySources.where((m) => m.kind == kind).firstOrNull),
              onChanged: () => setState(() => _saved = false),
            ),
            const SizedBox(height: 16),
          ],
        if (_error != null) ...[
          const SizedBox(height: 16),
          Text(
            _error!,
            style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.berry),
          ),
        ],
        if (_saved) ...[
          const SizedBox(height: 16),
          const Text(
            '存好了，马上就用上。',
            style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.leaf700),
          ),
        ],
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: Tooltip(
                message: status.file,
                child: Text(
                  status.file,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: PxText.mono.copyWith(color: Palette.bark500),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Tappable(
              onTap: _busy ? null : () => unawaited(_submit(status)),
              semanticLabel: '保存',
              builder: (context, state) => Opacity(
                opacity: _busy ? 0.5 : 1,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                  decoration: BoxDecoration(
                    color: state.hovered ? Palette.leaf600 : Palette.leaf500,
                    border: Border.all(color: Palette.bark900, width: 2),
                  ),
                  foregroundDecoration: state.focused ? BoxDecoration(border: Border.all(color: Palette.leaf700, width: 2)) : null,
                  child: const Text(
                    '保存',
                    style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.cream50),
                  ),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

const _sourceLabels = {MemorySourceKind.nowledge: 'Nowledge Mem', MemorySourceKind.everos: 'EverOS'};
const _sourceAddress = {MemorySourceKind.nowledge: 'http://127.0.0.1:14242/mcp/', MemorySourceKind.everos: 'http://127.0.0.1:18791'};

/// One memory source as the panel edits it, from what is saved until it is saved again.
class _SourceDraft {
  _SourceDraft(this.kind, MemorySource? saved)
    : url = TextEditingController(text: saved?.url ?? ''),
      user = TextEditingController(text: saved?.user ?? ''),
      saved = saved,
      enabled = saved?.enabled ?? false,
      read = saved?.read ?? true,
      write = saved?.write ?? true,
      everything = saved?.everything ?? false;
  final MemorySourceKind kind;
  final MemorySource? saved;
  final TextEditingController url;
  final TextEditingController user;
  final key = TextEditingController();
  bool enabled;
  bool read;
  bool write;
  bool everything;
  bool keyCleared = false;
  // Only a source touched is sent: the list goes whole, and an untouched one must not undo a change made elsewhere.
  bool changed = false;
  bool open = false;

  void dispose() {
    url.dispose();
    user.dispose();
    key.dispose();
  }
}

class _MemorySourceField extends StatelessWidget {
  const _MemorySourceField({required this.draft, required this.onChanged});
  final _SourceDraft draft;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final d = draft;
    final label = _sourceLabels[d.kind] ?? d.kind.wire;
    void set(void Function() change) {
      change();
      d.changed = true;
      onChanged();
    }

    void typed(String _) => set(() {});

    final savedKey = d.saved?.key;
    if (!d.open) {
      final saved = d.saved;
      return Row(
        children: [
          Expanded(
            child: Text(
              '记性的来源：$label（${saved == null
                  ? '没接'
                  : saved.enabled
                  ? '接上了'
                  : '关着'}）',
              style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark900),
            ),
          ),
          Tappable(
            onTap: () {
              d.open = true;
              onChanged();
            },
            semanticLabel: '改 $label',
            builder: (context, _) => const Text(
              '改',
              style: TextStyle(
                fontFamily: pixelFont,
                fontSize: 12,
                color: Palette.bark500,
                decoration: TextDecoration.underline,
                decorationColor: Palette.bark500,
              ),
            ),
          ),
        ],
      );
    }
    return _KeyField(
      label: '记性的来源：$label',
      help: PxSwitchField(label: '接上', checked: d.enabled, onChanged: (on) => set(() => d.enabled = on)),
      line: d.keyCleared ? 'key 存的时候清掉' : (savedKey?.source != null ? 'key ${_keyLine(savedKey!)}' : '本机的不用 key'),
      canClear: savedKey?.source == KeySource.settings && !d.keyCleared,
      onClear: () => set(() => d.keyCleared = true),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Input(controller: d.url, placeholder: _sourceAddress[d.kind] ?? 'http://…', label: '$label 的地址', onChanged: typed),
          const SizedBox(height: 4),
          _SecretInput(controller: d.key, placeholder: 'key（不用或不改就空着）', label: '$label 的 key', onChanged: typed),
          if (d.kind == MemorySourceKind.everos) ...[
            const SizedBox(height: 4),
            _Input(controller: d.user, placeholder: '你在 EverOS 里的 user_id（空着就是 owner）', label: '$label 的 user_id', onChanged: typed),
          ],
          const SizedBox(height: 8),
          Wrap(
            spacing: 16,
            runSpacing: 8,
            children: [
              PxSwitchField(label: '读', hint: '开工想起、帮工翻记性时也问它', checked: d.read, onChanged: (on) => set(() => d.read = on)),
              PxSwitchField(label: '写', hint: '记下的也送一份过去', checked: d.write, onChanged: (on) => set(() => d.write = on)),
              if (d.kind == MemorySourceKind.nowledge)
                PxSwitchField(label: '读全部', hint: '不只读农场替帮工记的，主人在里面的记忆每个帮工都读得到', checked: d.everything, onChanged: (on) => set(() => d.everything = on)),
            ],
          ),
        ],
      ),
    );
  }
}

class _KeyField extends StatelessWidget {
  const _KeyField({required this.label, required this.help, required this.line, required this.canClear, required this.onClear, required this.child});
  final String label;
  final Widget help;
  final String line;
  final bool canClear;
  final VoidCallback onClear;
  final Widget child;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Text(
              label,
              style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark900),
            ),
          ),
          help,
        ],
      ),
      const SizedBox(height: 4),
      child,
      const SizedBox(height: 4),
      Row(
        children: [
          Expanded(
            child: Text(
              line,
              style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark600),
            ),
          ),
          if (canClear)
            Tappable(
              onTap: onClear,
              semanticLabel: '清掉',
              builder: (context, _) => const Text(
                '清掉',
                style: TextStyle(
                  fontFamily: pixelFont,
                  fontSize: 12,
                  color: Palette.berry,
                  decoration: TextDecoration.underline,
                  decorationColor: Palette.berry,
                ),
              ),
            ),
        ],
      ),
    ],
  );
}

class _Link extends StatelessWidget {
  const _Link(this.text, this.uri);
  final String text;
  final Uri uri;

  @override
  Widget build(BuildContext context) => Tappable(
    onTap: () => linkOpener?.call(uri),
    semanticLabel: text,
    builder: (context, _) => Text(
      text,
      style: const TextStyle(
        fontFamily: pixelFont,
        fontSize: 12,
        color: Palette.bark500,
        decoration: TextDecoration.underline,
        decorationColor: Palette.bark500,
      ),
    ),
  );
}

InputDecoration _decoration(String placeholder) => InputDecoration(
  hintText: placeholder,
  hintStyle: PxText.mono.copyWith(color: Palette.bark400),
  isDense: true,
  filled: true,
  fillColor: Palette.cream50,
  contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
  border: const OutlineInputBorder(
    borderRadius: BorderRadius.zero,
    borderSide: BorderSide(color: Palette.bark800, width: 2),
  ),
  enabledBorder: const OutlineInputBorder(
    borderRadius: BorderRadius.zero,
    borderSide: BorderSide(color: Palette.bark800, width: 2),
  ),
  focusedBorder: const OutlineInputBorder(
    borderRadius: BorderRadius.zero,
    borderSide: BorderSide(color: Palette.leaf600, width: 2),
  ),
);

class _Input extends StatelessWidget {
  const _Input({required this.controller, required this.placeholder, required this.label, required this.onChanged, this.obscure = false});
  final TextEditingController controller;
  final String placeholder;
  final String label;
  final ValueChanged<String> onChanged;
  final bool obscure;

  @override
  Widget build(BuildContext context) => Semantics(
    label: label,
    textField: true,
    child: TextField(
      controller: controller,
      onChanged: onChanged,
      obscureText: obscure,
      autocorrect: false,
      enableSuggestions: false,
      style: PxText.mono,
      decoration: _decoration(placeholder),
    ),
  );
}

class _SecretInput extends StatefulWidget {
  const _SecretInput({required this.controller, required this.placeholder, required this.label, required this.onChanged});
  final TextEditingController controller;
  final String placeholder;
  final String label;
  final ValueChanged<String> onChanged;

  @override
  State<_SecretInput> createState() => _SecretInputState();
}

class _SecretInputState extends State<_SecretInput> {
  bool _shown = false;

  @override
  Widget build(BuildContext context) => IntrinsicHeight(
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: _Input(controller: widget.controller, placeholder: widget.placeholder, label: widget.label, onChanged: widget.onChanged, obscure: !_shown),
        ),
        Tappable(
          onTap: () => setState(() => _shown = !_shown),
          semanticLabel: _shown ? '藏起来' : '看一眼',
          builder: (context, _) => Container(
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            decoration: const BoxDecoration(
              color: Palette.cream200,
              border: Border(
                top: BorderSide(color: Palette.bark800, width: 2),
                right: BorderSide(color: Palette.bark800, width: 2),
                bottom: BorderSide(color: Palette.bark800, width: 2),
              ),
            ),
            child: Text(
              _shown ? '藏' : '看',
              style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark800),
            ),
          ),
        ),
      ],
    ),
  );
}
