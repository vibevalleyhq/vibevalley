# @vibevalley/base-ui

Unstyled components for Solid 2, after [Base UI](https://base-ui.com): the keyboard, focus, ARIA, open and checked
state, and placement against a trigger; no styles, words or icons. The workbench's `apps/web/src/ui` gives them the
field-workbench look (docs/style/design.md).

Each component is parts (`Menu.Root`, `Menu.Trigger`, …); each part makes one element, and what else it is given
(`class`, `data-testid`, handlers, `ref`) lands on that element. State is written as Base UI's data attributes, so styles
(`data-checked:bg-accent`) and page tests read the same thing:

| Attribute | On |
|---|---|
| `data-open`, `data-closed` | Collapsible, Dialog, Popover, Tooltip, Menu, Select popups and positioners |
| `data-popup-open` | the trigger of an open popup |
| `data-checked`, `data-unchecked` | Switch, Checkbox, Radio |
| `data-pressed` | Toggle |
| `data-selected` | Tab, Tabs.Panel, Select.Item |
| `data-highlighted` | Menu.Item, Select.Item under the focus; Combobox.Item the input points at |
| `data-indeterminate`, `data-progressing`, `data-complete` | Progress parts |
| `data-dragging` | Slider parts while the pointer drags |
| `data-disabled`, `data-orientation` | where they apply |
| `data-side`, `data-align` | a positioner: where it ended up after turning away from the window's edge |

Values are the owner's or the component's: `value` / `defaultValue` / `onValueChange`, `open` / `defaultOpen` /
`onOpenChange(open, reason)`, `checked` / `defaultChecked` / `onCheckedChange`.

| Component | Parts | Notes |
|---|---|---|
| `Collapsible` | Root, Trigger, Panel | Panel unmounts when closed, or stays hidden with `keepMounted` |
| `Switch` | Root, Thumb | `role="switch"`; `readOnly` |
| `Checkbox` | Root, Indicator | `indeterminate` reads as mixed |
| `Toggle`, `ToggleGroup` | — | a group is one tab stop, arrows move; `multiple`, `orientation`, `loop` |
| `Tabs` | Root, List, Tab, Panel | first tab selected by default; `activateOnFocus`; a tab claims a panel only when one is mounted |
| `Dialog`, `AlertDialog` | Root, Trigger, Popup, Title, Description, Close | the native `<dialog>` with `showModal`; reasons `trigger`, `escape`, `outside`, `close`; an alert dialog ignores the backdrop |
| `Popover` | Root, Trigger, Portal, Positioner, Popup, Title, Description, Close | not modal; focus goes in, and back to the trigger on Escape or Close |
| `Tooltip` | Root, Trigger, Portal, Positioner, Popup | `delay` (600 ms), `closeDelay`; the keyboard's focus shows it at once; the next one shows without waiting |
| `Menu` | Root, Trigger, Portal, Positioner, Popup, Item, Separator, Group, GroupLabel | arrows, Home, End, letters; an item closes the menu unless `closeOnClick={false}` |
| `Select` | Root, Trigger, Value, Portal, Positioner, Popup, Item, ItemIndicator | `items` gives Value its labels; `name` sends it with a form |
| `Combobox` | Root, Input, Portal, Positioner, Popup, Item, Empty | the focus stays in the input, `aria-activedescendant` follows the highlight; the caller renders the options matching `inputValue`; `inline` keeps the list open in place (a command palette), `autoHighlight` keeps the first highlighted |
| `ContextMenu` | Root, Trigger, Portal, Positioner, Popup, Item, Separator, Group, GroupLabel | a Menu opened at the pointer by a right click, the context menu key or Shift+F10; name the popup with `aria-label` |
| `PreviewCard` | Root, Trigger, Portal, Positioner, Popup | shadcn's HoverCard: `delay` (600 ms), `closeDelay` (300 ms); moving onto the card keeps it open |
| `RadioGroup`, `Radio` | Radio: Root, Indicator | one tab stop; arrows move and check |
| `Accordion` | Root, Item, Header, Trigger, Panel | one item open unless `multiple`; arrows move among triggers |
| `Toolbar` | Root, Button, Link, Input, Group, Separator | one tab stop that stays on the item focused last |
| `Slider` | Root, Control, Track, Indicator, Thumb, Value | one value; arrows by `step`, Page Up and Down by ten; `onValueCommitted` where a drag or key ends |
| `Progress`, `Meter` | Root, Track, Indicator, Value, Label | a null progress value is indeterminate; the indicator's width is its share |
| `Separator` | — | `orientation` |

Triggers, closes and tabs take `render`: another tag (`"span"`, `"a"`) or a component given the part's props to spread
(`render={(p) => <Button {...p} tone="quiet" />}`). A portal goes into the modal dialog its trigger is in, else the body.
Positioners take `side`, `align`, `sideOffset` and `collisionPadding` ([@floating-ui/dom](https://floating-ui.com)).

Styling-only pieces that shadcn also ships (Badge, Card, Alert, Skeleton, Kbd, Spinner, Table, Breadcrumb) have no
behaviour to share and live in `apps/web/src/ui`. Parts never spread a computed object next to their props
(`{...attrs()}`): Solid would re-read `children` with it and rebuild them, taking the focus; `test/source.test.ts` checks.

Exit animations are not done: a popup unmounts when it closes; entering is CSS (`animate-pop-in`).

```bash
vp run test     # Vitest in Chromium (Playwright): keys, focus, ARIA, placement and axe for each component
```
