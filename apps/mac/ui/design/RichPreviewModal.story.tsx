import "../infra/polyfill";
import { mount, signal, Text, View } from "nsh";

import "@vibevalley/i18n/catalogs";

import { Markdown } from "./Markdown";

const SAMPLE_MERMAID = "flowchart LR\n  A[Request] --> B{Valid?}\n  B -->|Yes| C[Done]";
const SAMPLE_MARKDOWN = `Here is a diagram:\n\n\`\`\`mermaid\n${SAMPLE_MERMAID}\n\`\`\`\n`;

function RichPreviewBench() {
  const customPressed = signal("");
  return (
    <View testID="rich-preview-bench" class="flex-1 gap-4 bg-page p-4">
      <View testID="md-default">
        <Markdown text={SAMPLE_MARKDOWN} />
      </View>
      <View testID="md-custom">
        <Markdown text={SAMPLE_MARKDOWN} onDiagramPress={(ev) => customPressed.set(ev.source)} />
      </View>
      <Text testID="custom-diagram-pressed">{customPressed()}</Text>
    </View>
  );
}

mount(() => <RichPreviewBench />);
