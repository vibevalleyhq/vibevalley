import "../infra/polyfill";
import { mount, signal, Text, View } from "nsh";

import { Button } from "./Button";
import { Empty } from "./layout";

function EmptyStory() {
  const pending = signal(true);
  const clicked = signal(0);
  return (
    <View class="gap-2 p-4">
      <View class="flex-row items-center gap-3">
        <Button testID="settle-pending" onPress={() => pending.set(false)}>
          Settle
        </Button>
        <Text testID="empty-clicks">{`clicks:${clicked()}`}</Text>
      </View>
      <View class="grid grid-cols-2 gap-3">
        <Empty
          variant="firstRun"
          compact
          testid="empty-first-run"
          icon="notes"
          title="Start your first note"
          description="Draft specs, tables, or diagrams in one place."
          shortcut="⌘N"
          action={
            <Button testID="empty-primary" tone="primary" onPress={() => clicked.set(clicked() + 1)}>
              New note
            </Button>
          }
          secondaryAction={
            <Button testID="empty-secondary" onPress={() => clicked.set(clicked() + 10)}>
              From template
            </Button>
          }
        />
        <Empty variant="filtered" compact testid="empty-filtered" icon="search" title="No matches" description="Adjust your search." />
        <Empty variant="unselected" compact testid="empty-unselected" icon="repos" description="Select a repository" shortcut="⌘K" />
        <Empty variant="zero" compact testid="empty-zero" icon="check" title="All caught up" description="Nothing needs attention." />
        <Empty variant="error" compact testid="empty-error" icon="warn" title="Failed to load" description="Check connection." />
        <Empty variant="firstRun" compact testid="empty-gated" icon="issues" title="No issues yet" pending={pending()} delayMs={200} />
      </View>
    </View>
  );
}

mount(EmptyStory);
