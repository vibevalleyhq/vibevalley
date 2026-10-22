// Pairing: the camera reads the QR code the farm's 连接到本机 shows (or the link is pasted, or arrives as a
// vibevalley:// link); the phone names itself and waits for the owner to nod on that computer.

import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { FarmConnection, Pairing } from "./farm";
import { parsePairLink } from "./rules";
import { colors } from "./style";

export function PairScreen({ connection, choice }: { connection: FarmConnection; choice: Pairing }) {
  const [typed, setTyped] = useState("");
  const [scanning, setScanning] = useState(false);
  const [cameraProblem, setCameraProblem] = useState("");
  const [permission, requestPermission] = useCameraPermissions();
  const problem = choice.problem || cameraProblem;
  useEffect(() => {
    if (choice.link) setScanning(false);
  }, [choice.link]);

  const scan = async () => {
    if (!permission?.granted && !(await requestPermission()).granted) return setCameraProblem("没有相机的权限：到系统设置里打开，或者粘贴链接");
    setScanning(true);
  };

  if (scanning)
    return (
      <View style={s.fill}>
        <CameraView
          style={s.fill}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            const found = parsePairLink(data);
            if (!found) return;
            setScanning(false);
            connection.select(found);
          }}
        />
        <Pressable style={s.cancel} onPress={() => setScanning(false)}>
          <Text style={s.cancelText}>不扫了</Text>
        </Pressable>
      </View>
    );

  return (
    <View style={s.page}>
      <View style={s.card}>
        <Text style={s.title}>连进农场</Text>
        <Text style={s.muted}>在跑农场的电脑上打开「设置」的「连接到本机」，点「添加设备」，扫它的二维码。配对要那台电脑上的主人点头。</Text>
        {choice.link ? (
          <Text style={s.mono}>{choice.link.url}</Text>
        ) : (
          <>
            <Pressable style={s.button} onPress={scan}>
              <Text style={s.buttonText}>扫二维码</Text>
            </Pressable>
            <TextInput
              style={s.input}
              placeholder="或者粘贴配对链接"
              autoCapitalize="none"
              autoCorrect={false}
              value={typed}
              onChangeText={(t) => {
                setTyped(t);
                const found = parsePairLink(t);
                if (found) connection.select(found);
              }}
            />
          </>
        )}
        <Text style={s.label}>这台手机叫</Text>
        <TextInput style={s.input} value={choice.name} onChangeText={(name) => connection.setName(name)} editable={!choice.asking} maxLength={40} />
        {choice.asking ? (
          <View style={s.row} accessibilityRole="progressbar">
            <ActivityIndicator color={colors.accent} />
            <Text style={s.muted}>等那台电脑上的主人点头……</Text>
          </View>
        ) : (
          <Pressable style={[s.button, !choice.link && s.off]} disabled={!choice.link} onPress={() => void connection.pair()}>
            <Text style={s.buttonText}>请主人放行</Text>
          </Pressable>
        )}
        {choice.link ? (
          <Pressable onPress={() => void connection.cancel()}>
            <Text style={s.cancelText}>取消配对</Text>
          </Pressable>
        ) : null}
        {problem ? (
          <Text style={s.problem} accessibilityRole="alert">
            {problem}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  page: { flex: 1, backgroundColor: colors.side, justifyContent: "center", padding: 16 },
  card: { backgroundColor: colors.page, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: 20, gap: 12 },
  title: { fontSize: 18, fontWeight: "600", color: colors.ink },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 20, flexShrink: 1 },
  label: { fontSize: 12, fontWeight: "500", color: colors.muted },
  mono: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 13, color: colors.ink },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.page,
  },
  button: { backgroundColor: colors.accent, borderRadius: 6, paddingVertical: 10, alignItems: "center" },
  buttonText: { color: colors.page, fontSize: 15, fontWeight: "600" },
  off: { opacity: 0.5 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  problem: { color: colors.berry, fontSize: 14 },
  cancel: { position: "absolute", bottom: 48, alignSelf: "center", backgroundColor: colors.page, borderRadius: 20, paddingHorizontal: 20, paddingVertical: 10 },
  cancelText: { color: colors.ink, fontSize: 15 },
});
