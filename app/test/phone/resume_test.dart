import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/phone/calls.dart';

class Inbox extends Notifier<List<InboxItem>> {
  @override
  List<InboxItem> build() => const [];
  void show(List<InboxItem> next) => state = next;
}

final inbox = NotifierProvider<Inbox, List<InboxItem>>(Inbox.new);
const first = InboxItem(
  id: 'first',
  kind: InboxKind.mention,
  from: InboxFromManager(),
  text: 'hello',
  at: 1,
  target: InboxTargetChat(conversation: 'c'),
);
const second = InboxItem(
  id: 'second',
  kind: InboxKind.mention,
  from: InboxFromManager(),
  text: 'again',
  at: 2,
  target: InboxTargetChat(conversation: 'c'),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('resuming the phone primes missed calls without lifecycle state access or ringing', () async {
    final c = ProviderContainer(overrides: [inboxProvider.overrideWith((ref) => ref.watch(inbox))]);
    addTearDown(c.dispose);
    var view = c.listen(phoneProvider, (_, _) {});
    await c.pump();
    view.close();
    await c.pump();
    c.read(inbox.notifier).show([first]);
    view = c.listen(phoneProvider, (_, _) {});
    await c.pump();
    expect(c.read(phoneProvider).missed.map((x) => x.id), ['first']);
    expect(c.read(phoneProvider).ringing, isNull);
    c.read(inbox.notifier).show([first, second]);
    await c.pump();
    expect(c.read(phoneProvider).ringing?.id, 'second');
    view.close();
  });

  test('a resume immediately cancelled again does not reactivate the phone', () async {
    final c = ProviderContainer(overrides: [inboxProvider.overrideWith((ref) => ref.watch(inbox))]);
    addTearDown(c.dispose);
    var view = c.listen(phoneProvider, (_, _) {});
    await c.pump();
    view.close();
    await c.pump();
    view = c.listen(phoneProvider, (_, _) {});
    view.close();
    await c.pump();
    c.read(inbox.notifier).show([first]);
    await c.pump();
    view = c.listen(phoneProvider, (_, _) {});
    await c.pump();
    expect(c.read(phoneProvider).ringing, isNull);
    view.close();
  });
}
