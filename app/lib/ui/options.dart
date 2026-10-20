// The choices a segmented control or a pick offers; each kit draws them.

class SegmentOption<T> {
  const SegmentOption({required this.value, required this.label, this.disabled = false, this.title});
  final T value;
  final String label;
  final bool disabled;

  final String? title;
}

class PickOption {
  const PickOption({required this.value, required this.label, this.detail});
  final String value;
  final String label;
  final String? detail;
}
