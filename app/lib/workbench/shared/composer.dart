import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../shared/chat_rules.dart';
import '../../shared/chat_widgets.dart' show Naming, NameableFace, nowMs;
import '../../shared/composer.dart' show ComposerDraft, ComposerSend;
import '../../shared/dictation_button.dart' show DictationControl;
import '../../shared/manager_stop_button.dart' show ManagerStopControl;
import '../../ui/pro/pro.dart';

/// The workbench's box for saying a sentence: the same draft, keys and sending as the farm's (ComposerDraft), drawn in the pro kit.
class WorkbenchComposer extends ConsumerStatefulWidget {
  const WorkbenchComposer({
    super.key,
    required this.placeholder,
    this.onSend,
    this.draft,
    this.semanticLabel,
    this.sendLabel = '发送',
    this.stop = false,
    this.mentions = true,
    this.enterSends = true,
    this.sendButton = true,
    this.enabled = true,
    this.autofocus = false,
    this.minLines = 2,
  });

  final String placeholder;

  /// Null: nothing to send, only the caller's buttons read the words.
  final ComposerSend? onSend;

  /// The caller's, when its own buttons read the words; the composer's own otherwise.
  final ComposerDraft? draft;
  final String? semanticLabel;
  final String sendLabel;

  /// The manager's stop button beside dictation, while it thinks or speaks.
  final bool stop;

  /// @ names the helpers on the farm and the manager.
  final bool mentions;

  /// Off where Enter starts a line the box needs (findings, one a line).
  final bool enterSends;
  final bool sendButton;
  final bool enabled;
  final bool autofocus;
  final int minLines;

  @override
  ConsumerState<WorkbenchComposer> createState() => _WorkbenchComposerState();
}

class _WorkbenchComposerState extends ConsumerState<WorkbenchComposer> {
  ComposerDraft? _own;
  ComposerDraft get _draft => widget.draft ?? (_own ??= ComposerDraft());

  @override
  void initState() {
    super.initState();
    _draft.addListener(_changed);
    _draft.naming.focus.addListener(_changed);
  }

  void _changed() => setState(() {});

  @override
  void didUpdateWidget(WorkbenchComposer old) {
    super.didUpdateWidget(old);
    final was = old.draft ?? _own;
    if (was != null && !identical(was, _draft)) {
      was.removeListener(_changed);
      was.naming.focus.removeListener(_changed);
      _draft.addListener(_changed);
      _draft.naming.focus.addListener(_changed);
    }
  }

  @override
  void dispose() {
    _draft.removeListener(_changed);
    _draft.naming.focus.removeListener(_changed);
    _own?.dispose();
    super.dispose();
  }

  void _send() {
    final to = widget.onSend;
    if (to == null || !widget.enabled) return;
    _draft.send(to);
  }

  @override
  Widget build(BuildContext context) {
    final d = _draft;
    d.naming.all = widget.mentions ? nameables(ref.watch(stateProvider)?.sessions ?? const [], nowMs()) : const [];
    final canSend = widget.onSend != null && widget.enabled && !d.empty;
    final focused = d.naming.focus.hasFocus;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (d.naming.menu)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: _NamingMenu(naming: d.naming),
          ),
        if (d.problem case final problem?)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(problem, style: ProText.meta.copyWith(color: Palette.berry)),
          ),
        Opacity(
          opacity: widget.enabled ? 1 : .5,
          child: Container(
            decoration: proBox(focused: focused, radius: const BorderRadius.all(Radius.circular(8))),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 200),
                  child: Semantics(
                    label: widget.semanticLabel,
                    textField: true,
                    child: Focus(
                      onKeyEvent: (_, e) => d.naming.key(e, widget.enterSends && widget.onSend != null ? _send : null),
                      child: TextField(
                        controller: d.text,
                        focusNode: d.naming.focus,
                        enabled: widget.enabled,
                        autofocus: widget.autofocus,
                        minLines: widget.minLines,
                        maxLines: null,
                        keyboardType: TextInputType.multiline,
                        style: ProText.base,
                        cursorColor: ProColor.ink,
                        cursorWidth: 1,
                        decoration: InputDecoration.collapsed(
                          hintText: widget.placeholder,
                          hintStyle: ProText.base.copyWith(color: ProColor.faint),
                        ).copyWith(contentPadding: const EdgeInsets.fromLTRB(12, 10, 12, 4), isDense: true, filled: false),
                      ),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                  child: Row(
                    children: [
                      if (widget.mentions) Text('@ 叫人', style: ProText.meta.copyWith(color: ProColor.faint)),
                      const Spacer(),
                      if (widget.stop)
                        ManagerStopControl(
                          builder: (context, stop) => Padding(
                            padding: const EdgeInsets.only(right: 4),
                            child: ProButton.icon('button-stop', tone: ProTone.danger, semanticLabel: '叫停管家', tooltip: '叫管家停下这一轮，派出去的帮工照常干活', onPressed: stop),
                          ),
                        ),
                      DictationControl(
                        controller: d.text,
                        builder: (context, look) => ProButton.icon(
                          look.glyph,
                          tone: look.recording ? ProTone.danger : ProTone.quiet,
                          semanticLabel: '听写',
                          tooltip: look.tip,
                          onPressed: look.onPressed,
                        ),
                      ),
                      if (widget.sendButton && widget.onSend != null) ...[
                        const SizedBox(width: 4),
                        ProButton.icon(
                          'button-send',
                          tone: canSend ? ProTone.primary : ProTone.quiet,
                          semanticLabel: widget.sendLabel,
                          tooltip: widget.enterSends ? '回车${widget.sendLabel} · Shift+回车换行' : widget.sendLabel,
                          onPressed: canSend ? _send : null,
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _NamingMenu extends StatelessWidget {
  const _NamingMenu({required this.naming});
  final Naming naming;

  @override
  Widget build(BuildContext context) {
    final shown = naming.offered;
    // Inside the input's tap region: picking a name keeps the focus in the input.
    return TextFieldTapRegion(
      child: Semantics(
        label: '叫谁',
        container: true,
        child: Container(
          padding: const EdgeInsets.all(4),
          decoration: const BoxDecoration(
            color: Palette.paper,
            border: Border.fromBorderSide(proLine),
            borderRadius: BorderRadius.all(Radius.circular(8)),
            boxShadow: proFloat,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final (i, n) in shown.indexed)
                MouseRegion(
                  onEnter: (_) => naming.hover(i),
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () {
                      naming.choose(n);
                      naming.focus.requestFocus();
                    },
                    child: Semantics(
                      selected: i == naming.active,
                      button: true,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                        decoration: BoxDecoration(color: i == naming.active ? ProColor.selected : null, borderRadius: proRadius),
                        child: Row(
                          children: [
                            NameableFace(n, size: 20, everyoneMark: false),
                            const SizedBox(width: 8),
                            Text(n.token, style: ProText.mono),
                            const SizedBox(width: 8),
                            if (n.session != null) ...[Text(n.name, style: ProText.sm), const SizedBox(width: 8)],
                            Expanded(
                              child: Text(n.note, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.meta),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
