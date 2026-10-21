// 连接到本机: lets the phones and computers on this network use this farm once paired, the owner
// saying yes to each here. Only this machine manages it: a paired device is refused the status and shown why.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { LanPairing, LanStatus } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { momentText } from "../../rules/time";
import { Button } from "../../ui/Button";
import { Qr } from "../../ui/Qr";
import { useToast } from "../../ui/Toast";
import { Card, Quiet } from "../kit";

const notes = [
  "帮工能在这台电脑上跑命令，所以只让配对过的设备连进来；配对要你在这里点头。",
  "配对过的设备和你一样用这个农场。开关和设备只能在这台电脑上管。",
  "连接走的是不加密的 HTTP：同一个网络里的人可能看到传的内容。只在信得过的网络里开，比如家里的 Wi-Fi、自己的热点。",
  "电脑换了地址（换了网络）以后，设备连不上了，在这里添加设备再扫一次就好，不用重新点头。",
];

export function LanPage() {
  const client = useQueryClient();
  const toast = useToast();
  // Polled: a device asking to pair shows up without a reload.
  const status = useQuery({ queryKey: ["lan"], queryFn: () => api.lan.status(), refetchInterval: 1500 });
  const act = async (call: () => Promise<LanStatus>) => {
    try {
      client.setQueryData(["lan"], await call());
    } catch (e) {
      toast(reasonOf(e));
    }
  };
  const s = status.data;
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <Card title="连接到本机" action={s && <span className="text-sm text-muted">{s.open ? "开着" : "关着"}</span>}>
        {!s ? (
          <Quiet>{status.error ? reasonOf(status.error) : "在问服务端……"}</Quiet>
        ) : (
          <>
            {!s.open ? (
              <>
                <p className="text-sm">打开以后，同一个局域网里的手机或另一台电脑扫码配对以后，就能用这台电脑上的农场：看帮工、派活、在田头说话。</p>
                <div>
                  <Button tone="primary" onClick={() => act(() => api.lan.update({ body: { open: true } }))}>
                    允许连接
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex gap-3">
                  <span className="w-18 shrink-0 text-sm text-muted">地址</span>
                  <span className="font-mono text-sm select-all">{s.url ?? "—"}</span>
                </div>
                {s.pairing ? (
                  <Pairing pairing={s.pairing} act={act} />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button tone="primary" disabled={!s.url} onClick={() => act(() => api.lan.startPairing())}>
                      添加设备
                    </Button>
                    <Button onClick={() => act(() => api.lan.update({ body: { open: false } }))}>关掉连接</Button>
                  </div>
                )}
              </>
            )}
            {s.problem && <p className="text-sm text-berry">{s.problem}</p>}
            <ul className="flex flex-col gap-1.5 border-t border-line pt-3">
              {notes.map((n) => (
                <li key={n} className="flex gap-2.5 text-sm text-muted">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" aria-hidden />
                  {n}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      {s && s.devices.length > 0 && (
        <Card title="配对过的设备" action={<span className="text-sm text-muted">{s.devices.length} 台</span>}>
          {s.devices.map((d) => (
            <div key={d.id} className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{d.name}</span>
                <span className="truncate text-xs text-muted">
                  配对于 {momentText(d.pairedAt)} · {d.lastSeen ? `上次来 ${momentText(d.lastSeen)}` : "还没来过"}
                </span>
              </span>
              <Button tone="danger" aria-label={`移除 ${d.name}`} onClick={() => act(() => api.lan.deleteDevice({ id: d.id }))}>
                移除
              </Button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function useNow(everyMs: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function Pairing({ pairing, act }: { pairing: LanPairing; act: (call: () => Promise<LanStatus>) => Promise<void> }) {
  const now = useNow(1000);
  const toast = useToast();
  if (pairing.asking)
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">「{pairing.asking}」想连接到这台电脑。让它进来以后，它能和你一样用这个农场。</p>
        <div className="flex gap-2">
          <Button tone="primary" onClick={() => act(() => api.lan.answerPairing({ body: { allow: true } }))}>
            让它进来
          </Button>
          <Button tone="danger" onClick={() => act(() => api.lan.answerPairing({ body: { allow: false } }))}>
            不让
          </Button>
        </div>
      </div>
    );
  const left = Math.min(999, Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)));
  return (
    <div className="flex flex-wrap gap-5">
      <div className="rounded-md border border-line bg-white p-2">
        <Qr text={pairing.link} label="配对二维码" />
      </div>
      <div className="flex max-w-md min-w-50 flex-col gap-2">
        <p className="text-sm">手机用相机扫这个码；另一台电脑在浏览器里打开这个链接：</p>
        <p className="font-mono text-[11.5px] break-all select-all">{pairing.link}</p>
        <p className="text-xs text-muted">还有 {left} 秒有效，只能用一次。</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            icon="button-copy"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(pairing.link);
                toast("复制好了：在另一台电脑的浏览器里打开它。");
              } catch {
                toast("复制不了：选中链接自己复制吧。");
              }
            }}
          >
            复制链接
          </Button>
          <Button onClick={() => act(() => api.lan.startPairing())}>换一个码</Button>
          <Button onClick={() => act(() => api.lan.stopPairing())}>不加了</Button>
        </div>
      </div>
    </div>
  );
}
