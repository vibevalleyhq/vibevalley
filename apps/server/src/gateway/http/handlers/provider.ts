import type { ProviderHandlers } from "@vibevalley/protocol/api";

import type { Provider } from "#/platform/provider/provider.ts";

export function providerHandlers(deps: { readonly provider: Provider }): ProviderHandlers {
  const { provider } = deps;
  return {
    "provider.get": async () => provider.status(),
    "provider.update": (body) => provider.update(body),
    "provider.voice.list": (body) => provider.voices(body),
    "provider.model.list": (body) => provider.models(body),
  };
}
