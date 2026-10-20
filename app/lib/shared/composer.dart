import 'package:flutter/material.dart';

import '../data/messages.dart';
import '../data/remote.dart' show reasonOf;
import 'chat_widgets.dart';

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
