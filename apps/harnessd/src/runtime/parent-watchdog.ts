import type { Readable } from "node:stream";

export type ParentLossReason = "parent_eof" | "parent_watchdog_error";

export function monitorParentWatchdog(
  input: Readable,
  onParentLost: (reason: ParentLossReason) => void,
): () => void {
  let active = true;

  const notify = (reason: ParentLossReason): void => {
    if (!active) {
      return;
    }
    active = false;
    removeListeners();
    absorbErrorsUntilClose();
    input.destroy();
    onParentLost(reason);
  };
  const onEnd = (): void => notify("parent_eof");
  const onError = (): void => notify("parent_watchdog_error");
  const onClose = (): void => notify("parent_watchdog_error");
  const removeListeners = (): void => {
    input.off("end", onEnd);
    input.off("error", onError);
    input.off("close", onClose);
  };
  const absorbErrorsUntilClose = (): void => {
    const ignoreError = (): void => undefined;
    input.on("error", ignoreError);
    input.once("close", () => input.off("error", ignoreError));
  };

  input.once("end", onEnd);
  input.once("error", onError);
  input.once("close", onClose);
  input.resume();

  return () => {
    if (!active) {
      return;
    }
    active = false;
    removeListeners();
    absorbErrorsUntilClose();
    input.destroy();
  };
}
