import { useEffect, useState } from "react";

import {
  advanceDesktopBootstrapState,
  decodeDesktopBootstrapState,
  failedBootstrapState,
  initialBootstrapState,
  type DesktopBootstrapState,
} from "../shared/bootstrap-state.js";
import { BootstrapScreen } from "./bootstrap-screen.js";

export function App() {
  const [state, setState] = useState<DesktopBootstrapState>(initialBootstrapState);

  useEffect(() => {
    let active = true;
    const accept = (candidate: unknown): void => {
      const decoded = decodeDesktopBootstrapState(candidate);
      if (active) {
        setState((current) =>
          advanceDesktopBootstrapState(current, decoded ?? failedBootstrapState("internal_error")),
        );
      }
    };
    const unsubscribe = window.codexHarness.onBootstrapState(accept);
    void window.codexHarness
      .getBootstrapState()
      .then(accept)
      .catch(() => {
        if (active) {
          setState((current) =>
            current.phase === "starting" ? failedBootstrapState("internal_error") : current,
          );
        }
      });
    return (): void => {
      active = false;
      unsubscribe();
    };
  }, []);

  return <BootstrapScreen state={state} />;
}
