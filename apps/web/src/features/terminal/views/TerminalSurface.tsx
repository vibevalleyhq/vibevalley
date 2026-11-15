import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import { createEffect, onSettled, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";

import type { TerminalTab } from "#/features/terminal/model/layout.ts";
import { attachTerminalOutput, reopenTerminalTab, resizeTerminal, sendTerminalInput } from "#/features/terminal/model/sessions.ts";
import { usePrefs } from "#/state/prefs.ts";
import { Button } from "#/ui/Button.tsx";

function readTerminalTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const theme: ITheme = {};
  const set = (key: Exclude<keyof ITheme, "extendedAnsi">, varName: string) => {
    const val = css.getPropertyValue(varName).trim();
    if (val) theme[key] = val;
  };
  set("background", "--wb-page");
  set("foreground", "--wb-ink");
  set("cursor", "--wb-ink");
  set("cursorAccent", "--wb-page");
  set("selectionBackground", "--wb-selected");
  set("black", "--wb-faint");
  set("brightBlack", "--wb-faint");
  set("red", "--wb-berry");
  set("brightRed", "--wb-berry");
  set("green", "--wb-leaf");
  set("brightGreen", "--wb-leaf");
  set("yellow", "--wb-wheat");
  set("brightYellow", "--wb-wheat");
  set("blue", "--wb-water");
  set("brightBlue", "--wb-water");
  set("magenta", "--shiki-token-keyword");
  set("brightMagenta", "--shiki-token-keyword");
  set("cyan", "--wb-water");
  set("brightCyan", "--wb-water");
  set("white", "--wb-ink");
  set("brightWhite", "--wb-ink");
  return theme;
}

export function TerminalSurface(props: { tab: TerminalTab; onFocus: () => void }) {
  const scale = usePrefs((p) => p.scale);
  const theme = usePrefs((p) => p.theme);
  const tabId = untrack(() => props.tab.id);
  let mountEl: HTMLDivElement | undefined;
  let terminalInstance: Terminal | undefined;
  let fitInstance: FitAddon | undefined;
  let detachOutput: (() => void) | undefined;

  const syncDimensions = () => {
    if (!terminalInstance || !fitInstance || !mountEl) return;
    if (mountEl.clientWidth < 16 || mountEl.clientHeight < 16) return;
    const dims = fitInstance.proposeDimensions();
    if (!dims || dims.cols < 2 || dims.rows < 1) return;
    terminalInstance.resize(dims.cols, dims.rows);
    resizeTerminal(tabId, dims.cols, dims.rows);
  };

  const ensureAttached = () => {
    if (!terminalInstance || detachOutput || props.tab.exitedCode !== null) return;
    detachOutput = attachTerminalOutput(props.tab, terminalInstance.cols, terminalInstance.rows, (chunk) => {
      terminalInstance?.write(chunk);
    });
  };

  onSettled(() => {
    const el = mountEl;
    if (!el) return;
    const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace";
    const term = new Terminal({
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 5000,
      fontSize: Math.round(13 * (scale() / 100)),
      fontFamily,
      lineHeight: 1.25,
      theme: readTerminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    terminalInstance = term;
    fitInstance = fit;

    syncDimensions();
    ensureAttached();
    const inputSub = term.onData((data) => {
      sendTerminalInput(tabId, data);
    });
    const observer = new ResizeObserver(() => {
      syncDimensions();
    });
    observer.observe(el);
    term.focus();

    return () => {
      observer.disconnect();
      inputSub.dispose();
      detachOutput?.();
      detachOutput = undefined;
      terminalInstance = undefined;
      fitInstance = undefined;
      term.dispose();
    };
  });

  createEffect(
    () => [scale(), theme(), props.tab.exitedCode] as const,
    ([nextScale, , exitedCode]) => {
      if (!terminalInstance) return;
      terminalInstance.options.fontSize = Math.round(13 * (nextScale / 100));
      terminalInstance.options.theme = readTerminalTheme();
      syncDimensions();
      if (exitedCode !== null) {
        detachOutput?.();
        detachOutput = undefined;
      } else {
        ensureAttached();
      }
    },
  );

  return (
    <div
      data-testid="terminal-surface"
      data-tab={tabId}
      class="relative flex h-full w-full min-h-0 min-w-0 flex-col bg-page"
      onMouseDown={() => props.onFocus()}
    >
      {/* Keep zoom at 1 on the xterm viewport so cell measurements and mouse selection coordinates remain exact. */}
      <div
        ref={(el) => {
          mountEl = el;
        }}
        class="min-h-0 flex-1 overflow-hidden px-2 py-1.5 [zoom:1]"
      />
      <Show when={props.tab.exitedCode !== null}>
        <div data-testid="terminal-exited" class="flex shrink-0 items-center justify-between gap-2 border-t border-line bg-side px-3 py-1.5 text-xs text-muted">
          <span>{t("web.terminal.exited", { code: props.tab.exitedCode ?? 0 })}</span>
          <Button icon="retry" onClick={() => reopenTerminalTab(tabId)}>
            {t("web.terminal.restart")}
          </Button>
        </div>
      </Show>
    </div>
  );
}
