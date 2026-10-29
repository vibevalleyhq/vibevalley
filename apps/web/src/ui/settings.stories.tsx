import { stories, story } from "@vibevalley/stories";
import { Select } from "./Field";
import { KeyRow, SettingRow, SettingsGroup, SettingsPage, SettingsSearch } from "./settings";
import { Toggle } from "./layout";

export default stories({
  title: "ui/settings",
  stories: {
    Page: story({
      fill: true,
      note: "设置的每一节都是这个样子；搜索时命中的行染上麦色。",
      args: { search: "", key: "", removing: false },
      render: (a, set) => (
        <SettingsSearch value={() => a.search.toLowerCase()}>
          <SettingsPage title="通用" hint="这台电脑上的农场">
            <SettingsGroup title="启动">
              <SettingRow label="开机时启动" hint="登录后自己起来">
                <Toggle label="开机时启动" ariaLabel="开机时启动" checked onChange={() => undefined} />
              </SettingRow>
              <SettingRow label="语言" hint="界面和管家说话用的">
                <Select
                  label="语言"
                  value="zh"
                  onChange={() => undefined}
                  options={[
                    { value: "zh", label: "中文" },
                    { value: "en", label: "English" },
                  ]}
                />
              </SettingRow>
            </SettingsGroup>
            <SettingsGroup title="模型" note="存在本机的 vibevalley.yaml">
              <KeyRow
                label="DeepSeek"
                hint="管家和记性用它"
                status={{ source: "settings", hint: "a1b2" }}
                value={a.key}
                onInput={(key) => set({ key })}
                removing={a.removing}
                onRemove={(removing) => set({ removing })}
                link={{ href: "https://platform.deepseek.com", label: "拿钥匙" }}
                placeholder="sk-…"
              />
            </SettingsGroup>
          </SettingsPage>
        </SettingsSearch>
      ),
    }),
  },
});
