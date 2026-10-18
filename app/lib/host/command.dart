// The protocol's schema is not among the generated shapes, so its five cases are written here once, with its JSON form.

sealed class HostCommand {
  const HostCommand();

  /// null for anything else (a newer app's command).
  static HostCommand? fromJson(Object? j) {
    if (j is! Map) return null;
    return switch (j['type']) {
      'voice' => const HostVoice(),
      'session' when j['id'] is String => HostOpenSession(j['id'] as String),
      'chat' when j['conversation'] is String => HostOpenChat(j['conversation'] as String),
      'taskBoard' when j['task'] is String => HostOpenTaskBoard(j['task'] as String),
      'achievements' => const HostOpenAchievements(),
      _ => null,
    };
  }

  Map<String, Object> toJson();
}

final class HostVoice extends HostCommand {
  const HostVoice();
  @override
  Map<String, Object> toJson() => {'type': 'voice'};
}

final class HostOpenSession extends HostCommand {
  const HostOpenSession(this.id);
  final String id;
  @override
  Map<String, Object> toJson() => {'type': 'session', 'id': id};
  @override
  bool operator ==(Object other) => other is HostOpenSession && other.id == id;
  @override
  int get hashCode => id.hashCode;
}

final class HostOpenChat extends HostCommand {
  const HostOpenChat(this.conversation);
  final String conversation;
  @override
  Map<String, Object> toJson() => {'type': 'chat', 'conversation': conversation};
  @override
  bool operator ==(Object other) => other is HostOpenChat && other.conversation == conversation;
  @override
  int get hashCode => conversation.hashCode;
}

final class HostOpenTaskBoard extends HostCommand {
  const HostOpenTaskBoard(this.graph);
  final String graph;
  @override
  Map<String, Object> toJson() => {'type': 'taskBoard', 'task': graph};
  @override
  bool operator ==(Object other) => other is HostOpenTaskBoard && other.graph == graph;
  @override
  int get hashCode => graph.hashCode;
}

final class HostOpenAchievements extends HostCommand {
  const HostOpenAchievements();
  @override
  Map<String, Object> toJson() => {'type': 'achievements'};
}
