import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BootstrapScreen } from "./bootstrap-screen.js";

describe("desktop bootstrap screen", () => {
  it.each([
    ["starting", "正在建立受控运行时"],
    ["ready", "Harness 已就绪"],
    ["stopping", "正在关闭受控进程"],
  ] as const)("renders the %s state without claiming execution is available", (phase, title) => {
    const markup = renderToStaticMarkup(<BootstrapScreen state={{ phase }} />);

    expect(markup).toContain(`data-bootstrap-phase="${phase}"`);
    expect(markup).toContain(title);
    expect(markup).toContain("Execution");
    expect(markup).toContain("Locked");
  });

  it("renders only the stable failure code", () => {
    const markup = renderToStaticMarkup(
      <BootstrapScreen state={{ phase: "failed", code: "daemon_startup_failed" }} />,
    );

    expect(markup).toContain('data-bootstrap-code="daemon_startup_failed"');
    expect(markup).toContain("启动已安全停止");
  });
});
