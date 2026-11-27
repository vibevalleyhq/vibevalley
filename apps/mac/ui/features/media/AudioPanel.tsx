import { computed, signal, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { IconButton } from "../../design/IconButton";
import { Empty } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { createAct } from "../../infra/act";
import { reasonOf } from "../../infra/api";
import { useOpsSlice } from "../../infra/frame";
import { providerQuery, ready, useQuery } from "../../infra/query";
import { type AudioMode, audioModeIcon, audioModes, audioModeTitle, DesignForm, isAudioJob, SpeakersForm, UploadForm } from "./audio/AudioForms";
import { AudioJobCard } from "./audio/AudioJobCard";
import { NoticeBanner, Refusal, SectionHeading } from "./JobFacts";

export function AudioPanel() {
  const ops = useOpsSlice();
  const query = useQuery(providerQuery);
  const status = () => ready(query, undefined);
  const mode = signal<AudioMode>("speakers");
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const jobs = computed(() => ops()?.media?.filter(isAudioJob) ?? []);
  const modeOptions = computed(() => audioModes.map((kind) => ({ value: kind, label: audioModeTitle(kind), icon: audioModeIcon(kind) })));

  return (
    <View testID="audio-panel" accessibilityLabel={t("web.audio.title")} class="max-w-3xl min-w-0 gap-4">
      <NoticeBanner tone="info">{t("web.audio.notice")}</NoticeBanner>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <Segmented testid="audio-mode" label={t("web.audio.title")} value={mode()} onChange={(kind) => mode.set(kind)} options={modeOptions()} />
        <IconButton
          icon="refresh"
          label={t("web.audio.refresh")}
          testid="audio-refresh"
          disabled={act.busy() || query.fetching()}
          onClick={() => void act.run(() => query.refetch())}
        />
      </View>
      <Refusal error={error() ?? (query.error() ? reasonOf(query.error()) : undefined)} testid="audio-error" />
      <If when={mode() === "speakers"}>
        <SpeakersForm status={status()} />
      </If>
      <If when={mode() === "voiceDesign"}>
        <DesignForm status={status()} />
      </If>
      <If when={mode() === "clone"}>
        <UploadForm kind="clone" status={status()} />
      </If>
      <If when={mode() === "transcription"}>
        <UploadForm kind="transcription" status={status()} />
      </If>
      <SectionHeading title={t("web.audio.history")} count={jobs().length} />
      <If
        when={jobs().length > 0}
        else={
          <Empty icon="audio" compact>
            {t("web.audio.empty")}
          </Empty>
        }
      >
        <Each of={jobs()} key={(job) => job.id}>
          {(job) => <AudioJobCard job={job()} />}
        </Each>
      </If>
    </View>
  );
}
