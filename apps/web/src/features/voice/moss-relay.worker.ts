import { mossRelay, type RelayCommand } from "./moss-relay.ts";

const relay = mossRelay((event, transfer) => self.postMessage(event, { transfer: transfer ?? [] }));
self.onmessage = (e: MessageEvent<RelayCommand>) => relay(e.data);
