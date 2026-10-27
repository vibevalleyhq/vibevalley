// What a dropdown lists: both kits pick from these.

export interface PickOption {
  value: string;
  label: string;
  detail?: string;
}

/**
 * What a pick lists: with `clearable`, no value is a choice of its own, listed first as the placeholder ("所有项目",
 * "按规则挑"). Without it the list is only the options: a pick that always has a value must not offer a second entry
 * that means the same as one of them. '' is the placeholder's own value, so an option for it is dropped.
 */
export function pickItems(options: readonly PickOption[], placeholder: string, clearable: boolean): PickOption[] {
  return [...(clearable ? [{ value: "", label: placeholder }] : []), ...options.filter((o) => o.value !== "")];
}
