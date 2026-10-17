import 'package:shared_preferences/shared_preferences.dart';

const namesSeenKey = 'vibevalley.pixel.names-seen';

/// True when this machine has seen the names before; storage that does not read counts as seen.
Future<bool> markNamesSeen() async {
  try {
    final store = await SharedPreferences.getInstance();
    final seen = store.containsKey(namesSeenKey);
    await store.setString(namesSeenKey, '1');
    return seen;
  } on Object {
    return true;
  }
}
