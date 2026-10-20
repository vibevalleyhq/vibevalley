import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../audio/sfx.dart';
import '../../data/ui_state.dart' show settingsProvider;
import '../../gen/vibevalley.dart';
import '../../ui/pro/pro.dart';

const _from = {KeySource.settings: '存在设置里', KeySource.config: '来自配置（vibevalley.yaml 或环境变量）'};

String _keyLine(KeyStatus k) => k.source != null ? '在用 ${k.hint ?? ''}（${_from[k.source]}）' : '还没有';

enum _Key { deepseekApiKey, agoraAppId, agoraAppCertificate }

/// The keys and the memory sources, saved to the server (setting.save); the workbench's 设置 shows it a part at a time.
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
    if (status == null) return Text('在问服务端……', style: ProText.sm.copyWith(color: ProColor.muted));
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
          const SizedBox(height: 20),
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
          const SizedBox(height: 20),
          _KeyField(
            label: 'Agora App Certificate',
            help: const Text('和 App ID 在同一个项目里', style: ProText.meta),
            line: _cleared.contains(_Key.agoraAppCertificate) ? '存的时候清掉' : _keyLine(status.agoraAppCertificate),
            canClear: status.agoraAppCertificate.source == KeySource.settings && !_cleared.contains(_Key.agoraAppCertificate),
            onClear: () => _clear(_Key.agoraAppCertificate),
            child: _SecretInput(controller: _certificate, placeholder: '不改就空着', label: 'Agora App Certificate', onChanged: changed),
          ),
          const SizedBox(height: 20),
        ],
        if (_shows(SettingsPart.memory))
          for (final kind in MemorySourceKind.values) ...[
            _MemorySourceField(
              draft: _sources[kind] ??= _SourceDraft(kind, status.memorySources.where((m) => m.kind == kind).firstOrNull),
              onChanged: () => setState(() => _saved = false),
            ),
            const SizedBox(height: 12),
          ],
        if (_error != null) ...[const SizedBox(height: 8), Text(_error!, style: ProText.sm.copyWith(color: Palette.berry))],
        if (_saved) ...[const SizedBox(height: 8), Text('存好了，马上就用上。', style: ProText.sm.copyWith(color: Palette.leaf700))],
        const SizedBox(height: 12),
        const Divider(height: 1, thickness: 1, color: ProColor.line),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: Tooltip(
                message: status.file,
                child: Text(
                  status.file,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ProText.mono.copyWith(color: ProColor.muted, fontSize: 12),
                ),
              ),
            ),
            const SizedBox(width: 12),
            ProButton.text('保存', tone: ProTone.primary, semanticLabel: '保存', onPressed: _busy ? null : () => unawaited(_submit(status))),
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
      return ProPanel(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Row(
          children: [
            Expanded(
              child: Text(
                '记性的来源：$label（${saved == null
                    ? '没接'
                    : saved.enabled
                    ? '接上了'
                    : '关着'}）',
                style: ProText.sm.copyWith(fontWeight: FontWeight.w500),
              ),
            ),
            ProButton.text(
              '改',
              size: ProSize.sm,
              semanticLabel: '改 $label',
              onPressed: () {
                d.open = true;
                onChanged();
              },
            ),
          ],
        ),
      );
    }
    return ProPanel(
      padding: const EdgeInsets.all(12),
      child: _KeyField(
        label: '记性的来源：$label',
        help: ProSwitchField(label: '接上', checked: d.enabled, onChanged: (on) => set(() => d.enabled = on)),
        line: d.keyCleared ? 'key 存的时候清掉' : (savedKey?.source != null ? 'key ${_keyLine(savedKey!)}' : '本机的不用 key'),
        canClear: savedKey?.source == KeySource.settings && !d.keyCleared,
        onClear: () => set(() => d.keyCleared = true),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _Input(controller: d.url, placeholder: _sourceAddress[d.kind] ?? 'http://…', label: '$label 的地址', onChanged: typed),
            const SizedBox(height: 6),
            _SecretInput(controller: d.key, placeholder: 'key（不用或不改就空着）', label: '$label 的 key', onChanged: typed),
            if (d.kind == MemorySourceKind.everos) ...[
              const SizedBox(height: 6),
              _Input(controller: d.user, placeholder: '你在 EverOS 里的 user_id（空着就是 owner）', label: '$label 的 user_id', onChanged: typed),
            ],
            const SizedBox(height: 12),
            Wrap(
              spacing: 24,
              runSpacing: 10,
              children: [
                ProSwitchField(label: '读', hint: '开工想起、帮工翻记性时也问它', checked: d.read, onChanged: (on) => set(() => d.read = on)),
                ProSwitchField(label: '写', hint: '记下的也送一份过去', checked: d.write, onChanged: (on) => set(() => d.write = on)),
                if (d.kind == MemorySourceKind.nowledge)
                  ProSwitchField(label: '读全部', hint: '不只读农场替帮工记的，主人在里面的记忆每个帮工都读得到', checked: d.everything, onChanged: (on) => set(() => d.everything = on)),
              ],
            ),
          ],
        ),
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
        children: [
          Expanded(
            child: Text(label, style: ProText.sm.copyWith(fontWeight: FontWeight.w600)),
          ),
          const SizedBox(width: 8),
          help,
        ],
      ),
      const SizedBox(height: 6),
      child,
      const SizedBox(height: 6),
      Row(
        children: [
          Expanded(child: Text(line, style: ProText.meta)),
          if (canClear) _Link('清掉', null, onTap: onClear, color: Palette.berry),
        ],
      ),
    ],
  );
}

/// A quiet underlined word: a page to open, or [onTap].
class _Link extends StatelessWidget {
  const _Link(this.text, this.uri, {this.onTap, this.color = ProColor.muted});
  final String text;
  final Uri? uri;
  final VoidCallback? onTap;
  final Color color;

  @override
  Widget build(BuildContext context) => Tappable(
    onTap: onTap ?? () => linkOpener?.call(uri!),
    semanticLabel: text,
    builder: (context, s) => ProFocusRing(
      on: s.focused,
      radius: 4,
      child: Text(
        text,
        style: ProText.xs.copyWith(color: s.hovered ? ProColor.ink : color, decoration: TextDecoration.underline, decorationColor: color.withValues(alpha: .5)),
      ),
    ),
  );
}

/// A key or an address: a mono line in a pro box, on a controller the form clears after saving; [trailing] sits inside the box.
class _Input extends StatefulWidget {
  const _Input({required this.controller, required this.placeholder, required this.label, required this.onChanged, this.obscure = false, this.trailing});
  final TextEditingController controller;
  final String placeholder;
  final String label;
  final ValueChanged<String> onChanged;
  final bool obscure;
  final Widget? trailing;

  @override
  State<_Input> createState() => _InputState();
}

class _InputState extends State<_Input> {
  final _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    _focus.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Container(
    height: 32,
    padding: EdgeInsets.only(left: 10, right: widget.trailing == null ? 10 : 2),
    decoration: proBox(focused: _focus.hasFocus),
    child: Row(
      children: [
        Expanded(
          child: Semantics(
            label: widget.label,
            textField: true,
            child: TextField(
              controller: widget.controller,
              focusNode: _focus,
              onChanged: widget.onChanged,
              obscureText: widget.obscure,
              autocorrect: false,
              enableSuggestions: false,
              style: ProText.mono,
              cursorColor: ProColor.ink,
              cursorWidth: 1,
              // The placeholders are mostly Chinese, which the mono face draws poorly.
              decoration: proBare(widget.placeholder, ProText.sm),
            ),
          ),
        ),
        ?widget.trailing,
      ],
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
  Widget build(BuildContext context) => _Input(
    controller: widget.controller,
    placeholder: widget.placeholder,
    label: widget.label,
    onChanged: widget.onChanged,
    obscure: !_shown,
    trailing: ProButton.text(
      _shown ? '藏' : '看',
      tone: ProTone.quiet,
      size: ProSize.sm,
      semanticLabel: _shown ? '藏起来' : '看一眼',
      onPressed: () => setState(() => _shown = !_shown),
    ),
  );
}
