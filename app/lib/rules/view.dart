import '../gen/vibevalley.dart';

String callerName(InboxItem call) => switch (call.from) {
  InboxFromWorker(:final name) => name,
  InboxFromManager() => '管家',
};
