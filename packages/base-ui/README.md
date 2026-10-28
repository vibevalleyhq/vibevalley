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
| `data-checked`, `data-unchecked` | Switch, Checkbox |
| `data-pressed` | Toggle |
| `data-selected` | Tab, Tabs.Panel, Select.Item |
| `data-highlighted` | Menu.Item, Select.Item under the focus |
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

Triggers, closes and tabs take `render`: another tag (`"span"`, `"a"`) or a component given the part's props to spread
(`render={(p) => <Button {...p} tone="quiet" />}`). A portal goes into the modal dialog its trigger is in, else the body.
Positioners take `side`, `align`, `sideOffset` and `collisionPadding` ([@floating-ui/dom](https://floating-ui.com)).

Exit animations are not done: a popup unmounts when it closes; entering is CSS (`animate-pop-in`).

```bash
vp run test     # Vitest in Chromium (Playwright): keys, focus, ARIA, placement and axe for each component
```
