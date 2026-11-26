import type { JSX } from "nsh";

import { createAppDesignHost, installModalOverlayReporter, installMotionReporter } from "../design/appHost";
import { DesignHostProvider, type DesignHost } from "../design/host";
import { act } from "../infra/bridge";
import { useRouter } from "../infra/router";

export function WorkbenchDesignHost(props: { children: JSX.Element }) {
  installMotionReporter();
  installModalOverlayReporter();
  const router = useRouter();
  const designHost = createAppDesignHost((path, options) => router.navigate(path, options));
  return <DesignHostProvider host={designHost}>{props.children}</DesignHostProvider>;
}

export function HostDesignProvider(props: { navigate?: DesignHost["navigate"]; children: JSX.Element }) {
  installMotionReporter();
  const designHost = createAppDesignHost((path, options) => {
    if (props.navigate) props.navigate(path, options);
    else act({ type: "open_route", path });
  });
  return <DesignHostProvider host={designHost}>{props.children}</DesignHostProvider>;
}
