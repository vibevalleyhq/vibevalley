// /pair: another device joins the farm (连接到本机). The owner's QR code opens it with the code; the device names
// itself and asks, the owner nods on the farm's computer, and the key the farm hands back is kept in a cookie.

import { useState } from "react";
import { api, reasonOf } from "../../data/api";
import { deviceGuess, keyCookie } from "../../rules/lan";
import { Button } from "../../ui/Button";
import { Field, TextInput } from "../../ui/Field";

export function PairPage() {
  const given = new URLSearchParams(location.search).get("c") ?? "";
  const [code, setCode] = useState(given);
  const [name, setName] = useState(() => deviceGuess(navigator.userAgent));
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState("");

  const ask = async () => {
    setAsking(true);
    setProblem("");
    try {
      const paired = await api.lan.pair({ body: { code: code.trim(), name: name.trim() } });
      document.cookie = keyCookie(paired.key);
      location.replace("/");
    } catch (e) {
      setProblem(reasonOf(e));
      setAsking(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-side px-4 text-ink">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-line bg-page p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!asking) void ask();
        }}
      >
        <h1 className="text-lg font-semibold">连进农场</h1>
        <p className="text-sm text-muted">这台设备连进那台电脑上的农场，和主人一样看帮工、派活、在田头说话。配对要那台电脑上的主人点头。</p>
        {!given && (
          <Field label="配对码" hint="在那台电脑的「连接到本机」里点「添加设备」">
            <TextInput value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="off" />
          </Field>
        )}
        <Field label="这台设备叫" hint="主人在设备列表里看到的名字">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </Field>
        {asking ? (
          <p role="status" className="text-sm">
            等那台电脑上的主人点头……
          </p>
        ) : (
          <Button tone="primary" type="submit" disabled={!code.trim()} className="self-start">
            请主人放行
          </Button>
        )}
        {problem && (
          <p role="alert" className="text-sm text-berry">
            {problem}
          </p>
        )}
      </form>
    </main>
  );
}
