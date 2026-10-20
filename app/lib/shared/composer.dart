import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/messages.dart';
import '../data/providers.dart';
import '../data/remote.dart' show reasonOf;
import '../ui/kit/kit.dart';
import 'chat_rules.dart';
import 'chat_widgets.dart';
import 'dictation_button.dart';

/// Says [text] to whoever the composer is for; [sendKey] names this one send, so a retry is the words already said.
typedef ComposerSend = Future<void> Function(String text, String sendKey);

/// What is being written: the words, who is being named, this draft's send key and why the last send failed.
class ComposerDraft extends ChangeNotifier {
  ComposerDraft() {
    naming.addListener(notifyListeners);
  }

  final naming = Naming();
  final _keys = SendKeys();
  String? problem;

  TextEditingController get text => naming.text;
  String get said => naming.text.text.trim();
  bool get empty => said.isEmpty;

  void clear() => naming.clear();

  void report(Object? e) {
    problem = e == null ? null : reasonOf(e);
    notifyListeners();
  }

  /// The field clears at once; when the send fails, the words come back with their key, so sending them again cannot say them twice.
  /// [blank] sends an empty draft too (再起草 with nothing to add).
  Future<bool> send(ComposerSend to, {bool blank = false}) async {
    final words = said;
    if (words.isEmpty && !blank) return false;
    final key = _keys.of(words);
    naming.clear();
    report(null);
    try {
      await to(words, key);
      _keys.sent();
      return true;
    } on Object catch (e) {
      if (naming.text.text.isEmpty) {
        naming.text.value = TextEditingValue(
          text: words,
          selection: TextSelection.collapsed(offset: words.length),
        );
      }
      report(e);
      return false;
    }
  }

  @override
  void dispose() {
    naming.dispose();
    super.dispose();
  }
}

/// `bar`: the farm's one line, which draws neither the names menu nor the problem: its window places them, from [Composer.draft].
/// `panel`: the workbench's foot. `inline`: inside a card.
enum ComposerLook { bar, panel, inline }

const _barMax = 96.0;

/// Every place the owner says a sentence to someone; form fields stay PxTextInput and PxTextArea.
class Composer extends ConsumerStatefulWidget {
  const Composer({
    super.key,
    required this.look,
    required this.placeholder,
    this.onSend,
    this.draft,
    this.semanticLabel,
    this.sendLabel = '发送',
    this.leading,
    this.tools = const [],
    this.mentions = true,
    this.enterSends = true,
    this.sendButton = true,
    this.enabled = true,
    this.autofocus = false,
    this.minLines = 2,
  });

  final ComposerLook look;
  final String placeholder;

  /// Null: nothing to send, only the caller's buttons read the words.
  final ComposerSend? onSend;

  /// The caller's, when its own buttons read the words or it places the menu and problem; the composer's own otherwise.
  final ComposerDraft? draft;
  final String? semanticLabel;
  final String sendLabel;
  final Widget? leading;

  /// Before dictation and send.
  final List<Widget> tools;

  /// @ names the helpers on the farm and the manager.
  final bool mentions;

  /// Off where Enter starts a line the box needs (findings, one a line).
  final bool enterSends;
  final bool sendButton;
  final bool enabled;
  final bool autofocus;

  /// Not for `bar`, which starts at one.
  final int minLines;

  @override
  ConsumerState<Composer> createState() => _ComposerState();
}

class _ComposerState extends ConsumerState<Composer> {
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
  void didUpdateWidget(Composer old) {
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
    final field = Semantics(
      label: widget.semanticLabel,
      textField: true,
      child: Focus(
        onKeyEvent: (_, e) => d.naming.key(e, widget.enterSends && widget.onSend != null ? _send : null),
        child: TextField(
          controller: d.text,
          focusNode: d.naming.focus,
          enabled: widget.enabled,
          autofocus: widget.autofocus,
          minLines: widget.look == ComposerLook.bar ? 1 : widget.minLines,
          maxLines: null,
          keyboardType: TextInputType.multiline,
          style: _style,
          cursorColor: Palette.bark900,
          decoration: kitBare(
            InputDecoration(
              hintText: widget.placeholder,
              // A hint that wraps grows the bar; folded, the farm's window has no room for that.
              hintMaxLines: widget.look == ComposerLook.bar ? 1 : null,
              hintStyle: _style.copyWith(color: Palette.bark400),
              border: InputBorder.none,
              isDense: true,
              contentPadding: switch (widget.look) {
                ComposerLook.bar => const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                ComposerLook.panel => const EdgeInsets.fromLTRB(12, 8, 12, 0),
                ComposerLook.inline => const EdgeInsets.fromLTRB(12, 4, 12, 0),
              },
              semanticCounterText: '',
            ),
          ),
        ),
      ),
    );
    return switch (widget.look) {
      ComposerLook.bar => _bar(field, canSend),
      ComposerLook.panel || ComposerLook.inline => _box(field, canSend),
    };
  }

  TextStyle get _style => KitText.sm.copyWith(height: 2);

  Widget _bar(Widget field, bool canSend) => Container(
    constraints: const BoxConstraints(minHeight: 44),
    padding: const EdgeInsets.all(4),
    color: Palette.cream100,
    foregroundDecoration: pxRing,
    child: Row(
      children: [
        ?widget.leading,
        Expanded(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: _barMax),
            child: field,
          ),
        ),
        ...widget.tools,
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: DictationButton(size: 24, controller: _draft.text),
        ),
        if (widget.sendButton && widget.onSend != null)
          KitTappable(
            onTap: canSend ? _send : null,
            semanticLabel: widget.sendLabel,
            builder: (context, st) => Container(
              width: 36,
              height: 36,
              alignment: Alignment.center,
              color: st.pressed ? Palette.cream300 : (st.hovered ? Palette.cream200 : null),
              child: Opacity(opacity: canSend ? 1 : .35, child: const Glyph('button-send')),
            ),
          ),
      ],
    ),
  );

  Widget _box(Widget field, bool canSend) {
    final d = _draft;
    final inline = widget.look == ComposerLook.inline;
    final focused = d.naming.focus.hasFocus;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (d.naming.menu)
          Container(
            margin: const EdgeInsets.only(bottom: 4),
            padding: const EdgeInsets.symmetric(vertical: 4),
            decoration: const BoxDecoration(color: Palette.cream50, border: Border.fromBorderSide(pxLine), boxShadow: kitDrop),
            child: NamingMenu(naming: d.naming, highlight: Palette.wheat, faceSize: 22, everyoneMark: false),
          ),
        if (d.problem case final problem?)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text(problem, style: KitText.xs.copyWith(color: Palette.berry)),
          ),
        Opacity(
          opacity: widget.enabled ? 1 : .5,
          child: Container(
            decoration: inline
                ? BoxDecoration(
                    color: Palette.creamInput,
                    border: Border.all(color: focused ? Palette.leaf500 : pxEdge, width: 2),
                  )
                : const BoxDecoration(color: Palette.cream50, border: Border.fromBorderSide(pxLine), boxShadow: kitDrop),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ConstrainedBox(
                  constraints: BoxConstraints(minHeight: inline ? 0 : 56, maxHeight: 192),
                  child: field,
                ),
                Padding(
                  padding: inline ? const EdgeInsets.fromLTRB(6, 0, 6, 6) : const EdgeInsets.fromLTRB(8, 0, 8, 8),
                  child: Row(
                    children: [
                      ?widget.leading,
                      const Spacer(),
                      ...widget.tools,
                      DictationButton(size: inline ? 24 : 28, controller: d.text),
                      if (widget.sendButton && widget.onSend != null) ...[
                        const SizedBox(width: 6),
                        PxButton(
                          size: PxSize.custom,
                          tone: PxTone.primary,
                          semanticLabel: widget.sendLabel,
                          tooltip: [widget.enterSends ? '回车${widget.sendLabel} · Shift+回车换行' : widget.sendLabel, if (widget.mentions) '@ 叫人'].join(' · '),
                          onPressed: canSend ? _send : null,
                          child: SizedBox.square(
                            dimension: inline ? 24 : 28,
                            child: const Center(child: Glyph('button-send')),
                          ),
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
