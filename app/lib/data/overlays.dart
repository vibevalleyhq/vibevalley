import 'package:flutter_riverpod/flutter_riverpod.dart';

enum FarmPanel { shop, warehouse, graphs, log, manager, taskBoard }

sealed class FarmOverlay {
  const FarmOverlay();
  int get order;
}

final class InspectOverlay extends FarmOverlay {
  const InspectOverlay(this.id);
  final String id;
  @override
  int get order => 0;
}

final class ReviewOverlay extends FarmOverlay {
  const ReviewOverlay(this.id);
  final String id;
  @override
  int get order => 1;
}

final class SowOverlay extends FarmOverlay {
  const SowOverlay(this.station);
  final int station;
  @override
  int get order => 2;
}

final class WaterOverlay extends FarmOverlay {
  const WaterOverlay(this.id);
  final String id;
  @override
  int get order => 3;
}

final class PanelOverlay extends FarmOverlay {
  const PanelOverlay(this.panel);
  final FarmPanel panel;
  @override
  int get order => 4;
}

final class MenuOverlay extends FarmOverlay {
  const MenuOverlay();
  @override
  int get order => 5;
}

class FarmOverlayState {
  const FarmOverlayState([this.layers = const []]);
  final List<FarmOverlay> layers;
  bool get any => layers.isNotEmpty;
  String? get selected => layers.whereType<InspectOverlay>().firstOrNull?.id;
  String? get reviewing => layers.whereType<ReviewOverlay>().firstOrNull?.id;
  int? get sowing => layers.whereType<SowOverlay>().firstOrNull?.station;
  String? get watering => layers.whereType<WaterOverlay>().firstOrNull?.id;
  FarmPanel? get panel => layers.whereType<PanelOverlay>().firstOrNull?.panel;
  bool get menu => layers.any((layer) => layer is MenuOverlay);
  Map<String, bool> get soundFlags => {'panel': panel != null, 'selected': selected != null, 'sowing': sowing != null, 'watering': watering != null};
}

final farmOverlaysProvider = NotifierProvider<FarmOverlays, FarmOverlayState>(FarmOverlays.new);

class FarmOverlays extends Notifier<FarmOverlayState> {
  @override
  FarmOverlayState build() => const FarmOverlayState();
  void _replace<T extends FarmOverlay>(T? next) {
    final layers = [
      for (final layer in state.layers)
        if (layer is! T) layer,
      ?next,
    ]..sort((a, b) => a.order.compareTo(b.order));
    state = FarmOverlayState(List.unmodifiable(layers));
  }

  void select(String? id) => _replace<InspectOverlay>(id == null ? null : InspectOverlay(id));
  void review(String? id) => _replace<ReviewOverlay>(id == null ? null : ReviewOverlay(id));
  void sow(int? station) => _replace<SowOverlay>(station == null ? null : SowOverlay(station));
  void water(String? id) => _replace<WaterOverlay>(id == null ? null : WaterOverlay(id));
  void panel(FarmPanel? panel) => _replace<PanelOverlay>(panel == null ? null : PanelOverlay(panel));
  void menu(bool open) => _replace<MenuOverlay>(open ? const MenuOverlay() : null);
}

final selectedProvider = Provider<String?>((ref) => ref.watch(farmOverlaysProvider.select((s) => s.selected)));
final panelProvider = Provider<FarmPanel?>((ref) => ref.watch(farmOverlaysProvider.select((s) => s.panel)));
final sowingProvider = Provider<int?>((ref) => ref.watch(farmOverlaysProvider.select((s) => s.sowing)));
final wateringProvider = Provider<String?>((ref) => ref.watch(farmOverlaysProvider.select((s) => s.watering)));
final reviewingProvider = Provider<String?>((ref) => ref.watch(farmOverlaysProvider.select((s) => s.reviewing)));
final menuOpenProvider = Provider<bool>((ref) => ref.watch(farmOverlaysProvider.select((s) => s.menu)));
