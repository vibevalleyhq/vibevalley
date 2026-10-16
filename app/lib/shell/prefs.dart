// The player's preferences (packages/core session.ts Prefs, kept by save.ts): who the next job goes to, sound on or
// off, how the manager looks, the pet by his door (and beside him on the title screen). What survives a restart, in
// shared_preferences under the web page's key and shape ('vibevalley.save': {"prefs": {...}}), so the two read alike.

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The pets (core session.ts PETS).
const pets = ['dog', 'ragdoll', 'bluecat'];

class Prefs {
  const Prefs({this.autoplay = true, this.pick = 'auto', this.muted = false, this.managerLook, this.pet});

  /// The mock makes up requests on its own (the web page's mock only; kept so a save reads the same).
  final bool autoplay;

  /// Which agent the next job goes to: an agent id, or 'auto'.
  final String pick;
  final bool muted;

  /// How the manager looks; null is the young farmer.
  final String? managerLook;

  /// The pet; null is the dog.
  final String? pet;

  /// core petOf.
  String get petOrDog => pet ?? 'dog';

  Prefs copyWith({bool? autoplay, String? pick, bool? muted, String? managerLook, String? pet}) => Prefs(
    autoplay: autoplay ?? this.autoplay,
    pick: pick ?? this.pick,
    muted: muted ?? this.muted,
    managerLook: managerLook ?? this.managerLook,
    pet: pet ?? this.pet,
  );

  Map<String, Object?> toJson() => {'autoplay': autoplay, 'pick': pick, 'muted': muted, 'managerLook': ?managerLook, 'pet': ?pet};

  /// A save that does not read is ignored, as on the web page: the farm starts fresh.
  static Prefs? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final autoplay = raw['autoplay'], pick = raw['pick'], muted = raw['muted'], look = raw['managerLook'], pet = raw['pet'];
    if (autoplay is! bool || pick is! String || muted is! bool) return null;
    if (look != null && look is! String) return null;
    if (pet != null && !pets.contains(pet)) return null;
    return Prefs(autoplay: autoplay, pick: pick, muted: muted, managerLook: look as String?, pet: pet as String?);
  }
}

const _key = 'vibevalley.save';

final prefsProvider = NotifierProvider<PrefsNotifier, Prefs>(PrefsNotifier.new);

class PrefsNotifier extends Notifier<Prefs> {
  @override
  Prefs build() {
    unawaited(_load());
    return const Prefs();
  }

  Future<void> _load() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_key);
      if (raw == null) return;
      final saved = Prefs.fromJson((jsonDecode(raw) as Map)['prefs']);
      if (saved != null) state = saved;
    } on Object {
      // No storage (tests, a sandbox that refuses): preferences last only for this run.
    }
  }

  void _set(Prefs next) {
    state = next;
    unawaited(() async {
      try {
        await (await SharedPreferences.getInstance()).setString(_key, jsonEncode({'prefs': next.toJson()}));
      } on Object {
        // As above: kept for this run only.
      }
    }());
  }

  void setMuted(bool muted) => _set(state.copyWith(muted: muted));
  void setPick(String pick) => _set(state.copyWith(pick: pick));
  void setManagerLook(String look) => _set(state.copyWith(managerLook: look));
  void setPet(String pet) => _set(state.copyWith(pet: pet));
}
