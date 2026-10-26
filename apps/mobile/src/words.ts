// What the phone's shell says itself, before and around the farm's page: pairing, the call's line, and why a saved farm
// could not be read. It speaks the phone's language (App.tsx sets it from the device); the page inside speaks the farm's.

import { localized, setLocale } from "@vibevalley/protocol/words";

/** Chinese when the phone's language is, else English. */
export const followDevice = () => setLocale(Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en");

const zh = {
  cannotRead: (why: string) => "读不出保存的农场：" + why,
  unreachable: "连不上那台电脑：两台设备要在同一个网络里，那台电脑要允许连接",
  answered: (status: number) => `那台电脑答了 ${status}`,
  cannotSave: (why: string) => "保存配对失败：" + why,
  cannotRestore: (why: string) => "恢复保存的农场失败：" + why,
  cannotForget: (why: string) => "忘不掉保存的农场：" + why,
  callEnded: "通话已结束",
  noNotify: "没有通知的权限：到系统设置里打开",
  noCamera: "没有相机的权限：到系统设置里打开，或者粘贴链接",
  stopScan: "不扫了",
  title: "连进农场",
  intro: "在跑农场的电脑上打开「设置」的「连接到本机」，点「添加设备」，扫它的二维码。配对要那台电脑上的主人点头。",
  scan: "扫二维码",
  paste: "或者粘贴配对链接",
  name: "这台手机叫",
  waiting: "等那台电脑上的主人点头……",
  ask: "请主人放行",
  cancel: "取消配对",
  agora: (what: string, code: number) => `声网：${what}失败（${code}）`,
  agoraLost: (reason: number) => `声网：连接失败（${reason}）`,
  step: { mute: "静音", unmute: "取消静音", renew: "续期", initialize: "初始化", mic: "打开麦克风", volume: "读取音量", join: "加入频道" },
  noMic: "没有麦克风权限",
  android: "安卓手机",
  phone: "一台手机",
};

const en: typeof zh = {
  cannotRead: (why) => "The saved farm cannot be read: " + why,
  unreachable: "Cannot reach that computer: both devices must be on the same network, and that computer must allow connections",
  answered: (status) => `That computer answered ${status}`,
  cannotSave: (why) => "Saving the pairing failed: " + why,
  cannotRestore: (why) => "Restoring the saved farm failed: " + why,
  cannotForget: (why) => "The saved farm cannot be forgotten: " + why,
  callEnded: "The call has ended",
  noNotify: "No permission for notifications: turn it on in the system settings",
  noCamera: "No permission for the camera: turn it on in the system settings, or paste the link",
  stopScan: "Stop scanning",
  title: "Connect to the farm",
  intro:
    "On the computer running the farm, open Connect to this machine under Settings, press Add a device, and scan its QR code. Pairing needs the owner's approval on that computer.",
  scan: "Scan the QR code",
  paste: "Or paste the pairing link",
  name: "This phone is called",
  waiting: "Waiting for the owner on that computer to approve…",
  ask: "Ask the owner to let it in",
  cancel: "Cancel pairing",
  agora: (what, code) => `Agora: ${what} failed (${code})`,
  agoraLost: (reason) => `Agora: the connection failed (${reason})`,
  step: {
    mute: "muting",
    unmute: "unmuting",
    renew: "renewing",
    initialize: "starting",
    mic: "turning on the microphone",
    volume: "reading the volume",
    join: "joining the channel",
  },
  noMic: "No microphone permission",
  android: "Android phone",
  phone: "A phone",
};

export const mobileWording = localized({ zh, en });
