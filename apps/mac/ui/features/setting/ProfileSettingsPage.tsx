import { computed, host, Image, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { SettingsStatus, UserProfile } from "@vibevalley/protocol";

import { ownerPortraitUrl, roleAvatarUrl, useAssetsDir } from "../../design/art";
import { Button } from "../../design/Button";
import { USER_AVATAR_PRESETS, UserAvatar } from "../../design/domain/Face";
import { SettingRow, SettingsGroup, SettingsPage } from "../../design/domain/settings";
import { TextInput } from "../../design/Field";
import { SaveBar } from "../../design/KeyField";
import { Banner, Quiet } from "../../design/layout";
import { toast } from "../../design/toasts";
import { createAct } from "../../infra/act";
import { reasonOf } from "../../infra/api";
import { importLocalAttachment } from "../../infra/attachmentFile";
import { Keyed } from "../../infra/base/dom";
import { hostApi } from "../../infra/bridge";
import { ready, useSettings } from "../../infra/query";
import { useSaveSettings } from "../../infra/settings";

function presetImageUrl(dir: string | undefined, preset: string): string | undefined {
  if (!dir) return undefined;
  if (preset === "user") return ownerPortraitUrl(dir);
  return roleAvatarUrl(dir, preset);
}

function ProfileForm(props: { status: SettingsStatus }) {
  const saveSettings = useSaveSettings();
  const assetsDir = useAssetsDir();
  const initial = untracked(() => props.status.profile);

  const savedName = initial?.displayName ?? "";
  const savedTagline = initial?.tagline ?? "";
  const savedAttachmentId = initial?.avatarAttachmentId ?? "";
  const savedPreset = initial?.avatarPreset ?? "user";

  const displayName = signal(savedName);
  const tagline = signal(savedTagline);
  const avatarAttachmentId = signal(savedAttachmentId);
  const avatarPreset = signal(savedPreset);
  const uploading = signal(false);
  const error = signal<string | undefined>(undefined);
  const act = createAct((reason) => error.set(reason));

  const previewProfile = computed<UserProfile>(() => {
    const out: UserProfile = {};
    const name = displayName().trim();
    const line = tagline().trim();
    const attachment = avatarAttachmentId().trim();
    const preset = avatarPreset().trim();
    if (name !== "") out.displayName = name;
    if (line !== "") out.tagline = line;
    if (attachment !== "") out.avatarAttachmentId = attachment;
    if (preset !== "") out.avatarPreset = preset;
    return out;
  });

  const dirty = computed(
    () =>
      displayName().trim() !== savedName || tagline().trim() !== savedTagline || avatarAttachmentId() !== savedAttachmentId || avatarPreset() !== savedPreset,
  );

  const undo = () => {
    displayName.set(savedName);
    tagline.set(savedTagline);
    avatarAttachmentId.set(savedAttachmentId);
    avatarPreset.set(savedPreset);
    error.set(undefined);
  };

  const uploadAvatar = async () => {
    if (!host.available() || uploading() || act.busy()) return;
    error.set(undefined);
    uploading.set(true);
    try {
      const picked = await hostApi.pickFile();
      if (picked.bizCode !== 0 || !picked.data) return;
      const uploaded = await importLocalAttachment(picked.data.path, {
        name: picked.data.name,
        mime: picked.data.type,
      });
      avatarAttachmentId.set(uploaded.id);
    } catch (err) {
      error.set(reasonOf(err));
    } finally {
      uploading.set(false);
    }
  };

  const save = () => {
    if (!dirty() || act.busy() || uploading()) return;
    error.set(undefined);
    void act.run(async () => {
      await saveSettings({
        profile: {
          displayName: displayName().trim(),
          tagline: tagline().trim(),
          avatarAttachmentId: avatarAttachmentId().trim(),
          avatarPreset: avatarPreset().trim(),
        },
      });
      toast(t("web.setting.profile.saved"));
    });
  };

  return (
    <View testID="profile-settings-page" class="gap-5">
      <If when={error()}>
        {(err) => (
          <Banner tone="bad" role="alert" testID="profile-error">
            {err()}
          </Banner>
        )}
      </If>

      <SettingsGroup title={t("web.setting.profile.preview")} testid="profile-preview">
        <View class="flex-row items-center gap-3.5 px-4 py-3.5">
          <UserAvatar size={44} profile={previewProfile()} />
          <View class="min-w-0 flex-1 gap-0.5">
            <Text testID="profile-preview-name" class="truncate text-base font-semibold text-ink">
              {displayName().trim() || t("web.base.dashboard.profile.defaultName")}
            </Text>
            <Text testID="profile-preview-tagline" class="truncate text-xs text-muted">
              {tagline().trim() || t("web.base.dashboard.profile.defaultTagline")}
            </Text>
          </View>
        </View>
      </SettingsGroup>

      <SettingsGroup title={t("web.setting.profile.identity")}>
        <SettingRow label={t("web.setting.profile.displayName")} hint={t("web.setting.profile.displayNameHint")}>
          <View class="w-64 max-w-full">
            <TextInput
              testID="profile-display-name"
              accessibilityLabel={t("web.setting.profile.displayName")}
              placeholder={t("web.setting.profile.displayNamePlaceholder")}
              value={displayName()}
              onInput={(v) => displayName.set(v)}
            />
          </View>
        </SettingRow>
        <SettingRow label={t("web.setting.profile.tagline")} hint={t("web.setting.profile.taglineHint")} last>
          <View class="w-72 max-w-full">
            <TextInput
              testID="profile-tagline"
              accessibilityLabel={t("web.setting.profile.tagline")}
              placeholder={t("web.setting.profile.taglinePlaceholder")}
              value={tagline()}
              onInput={(v) => tagline.set(v)}
            />
          </View>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("web.setting.profile.avatar")}>
        <SettingRow label={t("web.setting.profile.avatar")} hint={t("web.setting.profile.avatarHint")}>
          <View class="flex-row items-center gap-2">
            <If when={host.available()}>
              <Button
                tone="plain"
                size="compact"
                icon="upload"
                testID="profile-avatar-upload"
                disabled={uploading() || act.busy()}
                onPress={() => void uploadAvatar()}
              >
                {uploading() ? t("web.setting.profile.uploading") : t("web.setting.profile.upload")}
              </Button>
            </If>
            <If when={avatarAttachmentId() !== ""}>
              <Button tone="danger" size="compact" icon="delete" testID="profile-avatar-clear" disabled={act.busy()} onPress={() => avatarAttachmentId.set("")}>
                {t("web.setting.profile.clearCustom")}
              </Button>
            </If>
          </View>
        </SettingRow>
        <SettingRow label={t("web.setting.profile.presets")} wide last>
          <View class="min-w-0 w-full flex-row flex-wrap items-center gap-2">
            <View
              role="button"
              testID="profile-preset-monogram"
              accessibilityLabel={t("web.setting.profile.monogram")}
              onPress={() => {
                avatarAttachmentId.set("");
                avatarPreset.set("monogram");
              }}
              class={`h-10 flex-row items-center gap-2 rounded-md border px-2.5 ${
                avatarAttachmentId() === "" && avatarPreset() === "monogram" ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"
              }`}
            >
              <UserAvatar size={24} profile={{ displayName: displayName().trim(), avatarPreset: "monogram" }} />
              <Text class="text-xs font-medium text-ink">{t("web.setting.profile.monogram")}</Text>
            </View>
            <Each of={USER_AVATAR_PRESETS} key={(p) => p}>
              {(preset) => {
                const active = () => avatarAttachmentId() === "" && avatarPreset() === preset();
                const url = () => presetImageUrl(assetsDir(), preset());
                return (
                  <View
                    role="button"
                    testID={`profile-preset-${preset()}`}
                    accessibilityLabel={preset()}
                    onPress={() => {
                      avatarAttachmentId.set("");
                      avatarPreset.set(preset());
                    }}
                    class={`size-10 items-center justify-center overflow-hidden rounded-md border ${
                      active() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"
                    }`}
                  >
                    <If when={url()} else={<Text class="text-xs font-medium text-muted">{preset().slice(0, 2)}</Text>}>
                      {(src) => <Image src={src()} class="size-8 object-cover" />}
                    </If>
                  </View>
                );
              }}
            </Each>
          </View>
        </SettingRow>
      </SettingsGroup>

      <SaveBar dirty={dirty()} busy={act.busy() || uploading()} onSave={save} onUndo={undo} />
    </View>
  );
}

export function ProfileSettingsPage() {
  const settings = useSettings();
  return (
    <SettingsPage title={t("web.setting.nav.profile")} description={t("web.setting.profile.intro")}>
      <If
        when={ready(settings, undefined)}
        else={<Quiet>{settings.error() ? t("web.base.form.unreachable", { why: reasonOf(settings.error()) }) : t("web.base.form.asking")}</Quiet>}
      >
        {(s) => (
          <Keyed
            key={JSON.stringify({
              name: s().profile?.displayName ?? "",
              tagline: s().profile?.tagline ?? "",
              attachment: s().profile?.avatarAttachmentId ?? "",
              preset: s().profile?.avatarPreset ?? "",
            })}
          >
            {() => <ProfileForm status={untracked(s)} />}
          </Keyed>
        )}
      </If>
    </SettingsPage>
  );
}
