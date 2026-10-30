import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { Meter, Progress, Radio, RadioGroup, Separator, Slider } from "../src/index";
import { snap } from "../src/slider";
import { $, expectAccessible, mount, settle } from "./render";

test("a radio group is one tab stop; arrows move and check, wrapping, past disabled radios", async () => {
  const said: string[] = [];
  mount(() => (
    <form data-testid="form">
      <button data-testid="before">before</button>
      <RadioGroup aria-label="look" name="look" onValueChange={(v) => said.push(v)}>
        <Radio.Root value="a">
          <Radio.Indicator data-testid="dot-a" />a
        </Radio.Root>
        <Radio.Root value="b" disabled>
          b
        </Radio.Root>
        <Radio.Root value="c">c</Radio.Root>
      </RadioGroup>
    </form>
  ));
  await settle();
  $("[data-testid=before]").focus();
  await userEvent.tab();
  expect((document.activeElement as HTMLElement).dataset.value).toBe("a");
  await userEvent.keyboard("{ArrowDown}");
  await settle();
  expect([(document.activeElement as HTMLElement).dataset.value, $("[data-value=c]").getAttribute("aria-checked")]).toEqual(["c", "true"]);
  await userEvent.keyboard("{ArrowDown}");
  await settle();
  expect([(document.activeElement as HTMLElement).dataset.value, document.querySelector("[data-testid=dot-a]") !== null]).toEqual(["a", true]);
  expect([said, new FormData($("[data-testid=form]", HTMLFormElement)).get("look")]).toEqual([["c", "a"], "a"]);
  await expectAccessible();
});

test("a separator says its orientation", () => {
  mount(() => <Separator orientation="vertical" />);
  expect([$("[role=separator]").getAttribute("aria-orientation"), $("[role=separator]").dataset.orientation]).toEqual(["vertical", "vertical"]);
});

test("progress and meter say their value and fill their indicator; progress without a value is indeterminate", async () => {
  mount(() => (
    <>
      <Progress.Root value={30} data-testid="p">
        <Progress.Label>Upload</Progress.Label>
        <Progress.Track style={{ width: "200px" }}>
          <Progress.Indicator data-testid="p-fill" />
        </Progress.Track>
        <Progress.Value data-testid="p-value" />
      </Progress.Root>
      <Progress.Root value={null} aria-label="waiting" data-testid="busy" />
      <Meter.Root value={7} max={10} aria-label="quota" getValueText={(v) => `${v} of 10`} data-testid="m">
        <Meter.Track>
          <Meter.Indicator data-testid="m-fill" />
        </Meter.Track>
      </Meter.Root>
    </>
  ));
  await settle();
  const p = $("[data-testid=p]");
  expect([p.getAttribute("role"), p.getAttribute("aria-valuenow"), p.getAttribute("aria-valuetext"), p.hasAttribute("data-progressing")]).toEqual([
    "progressbar",
    "30",
    "30%",
    true,
  ]);
  expect([$(`#${p.getAttribute("aria-labelledby")}`).textContent, $("[data-testid=p-fill]").style.width, $("[data-testid=p-value]").textContent]).toEqual([
    "Upload",
    "30%",
    "30%",
  ]);
  const busy = $("[data-testid=busy]");
  expect([busy.hasAttribute("data-indeterminate"), busy.hasAttribute("aria-valuenow")]).toEqual([true, false]);
  const m = $("[data-testid=m]");
  expect([m.getAttribute("role"), m.getAttribute("aria-valuetext"), $("[data-testid=m-fill]").style.width]).toEqual(["meter", "7 of 10", "70%"]);
  await expectAccessible();
});

test("snap keeps a value on the step grid, inside the range, without float dust", () => {
  expect([snap(0.30000000000000004, { min: 0, max: 1, step: 0.1 }), snap(13, { min: 0, max: 100, step: 5 }), snap(140, { min: 0, max: 100, step: 1 })]).toEqual(
    [0.3, 15, 100],
  );
});

test("a slider moves by keys and by a press on its control, and commits where it ends", async () => {
  const moved: number[] = [];
  const committed: number[] = [];
  mount(() => (
    <Slider.Root defaultValue={50} step={5} onValueChange={(v) => moved.push(v)} onValueCommitted={(v) => committed.push(v)}>
      <Slider.Control data-testid="control" style={{ position: "relative", width: "200px", height: "20px" }}>
        <Slider.Track style={{ position: "relative", height: "4px" }}>
          <Slider.Indicator data-testid="fill" />
          <Slider.Thumb aria-label="volume" style={{ width: "10px", height: "10px" }} />
        </Slider.Track>
      </Slider.Control>
      <Slider.Value data-testid="value" />
    </Slider.Root>
  ));
  const thumb = $("[role=slider]");
  thumb.focus();
  await userEvent.keyboard("{ArrowRight}{PageDown}");
  await settle();
  expect([thumb.getAttribute("aria-valuenow"), $("[data-testid=value]").textContent, $("[data-testid=fill]").style.width]).toEqual(["5", "5", "5%"]);
  await userEvent.keyboard("{End}");
  await settle();
  expect(thumb.getAttribute("aria-valuenow")).toBe("100");
  await userEvent.click($("[data-testid=control]"), { position: { x: 50, y: 10 } });
  await settle();
  expect([thumb.getAttribute("aria-valuenow"), document.activeElement]).toEqual(["25", thumb]);
  expect([moved, committed]).toEqual([
    [55, 5, 100, 25],
    [55, 5, 100, 25],
  ]);
  await expectAccessible();
});
