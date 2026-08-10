import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import coverageLibrary from "istanbul-lib-coverage";

import {
  CoverageGateError,
  allSourceLineNumbers,
  captureWorkspaceFingerprint,
  collectChangedSources,
  createGitRunner,
  evaluateChangedLineCoverage,
  formatCoverageResult,
  indexCoverageFiles,
  isCoveredSourceFile,
  main,
  normalizeRepositoryPath,
  parseAddedLineNumbers,
  parseBaselineArgument,
  parseNullSeparatedList,
  readCoverageReportText,
  readSourceText,
  readWorkspaceEntry,
  runChangedLineCoverage,
} from "./changed-line-coverage.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("变更行解析", () => {
  test("只接受唯一的显式基准", () => {
    expect(parseBaselineArgument(["--coverage.changed=main"])).toBe("main");
    expect(() => parseBaselineArgument([])).toThrow("必须显式传入");
    expect(() => parseBaselineArgument(["--coverage.changed"])).toThrow("必须使用");
    expect(() => parseBaselineArgument(["--coverage.changed="])).toThrow("不能为空");
    expect(() =>
      parseBaselineArgument(["--coverage.changed=main", "--coverage.changed=other"]),
    ).toThrow("只能传入一个");
    expect(() => parseBaselineArgument(["--watch"])).toThrow("不接受未知参数");
  });

  test("解析 NUL 列表与 diff 新行区间", () => {
    expect(parseNullSeparatedList("a\0b c\0")).toEqual(["a", "b c"]);
    expect([
      ...parseAddedLineNumbers("@@ -1,2 +4,3 @@\n+x\n@@ -9 +15 @@ context\n+y\n@@ -20 +21,0 @@"),
    ]).toEqual([4, 5, 6, 15]);
    expect(() => parseAddedLineNumbers("@@ malformed @@")).toThrow("无法解析 Git diff hunk");
  });

  test("为未跟踪源码生成全部真实行号", () => {
    expect([...allSourceLineNumbers("")]).toEqual([]);
    expect([...allSourceLineNumbers("a\n")]).toEqual([1]);
    expect([...allSourceLineNumbers("a\r\nb\r\n")]).toEqual([1, 2]);
    expect([...allSourceLineNumbers("a\rb")]).toEqual([1, 2]);
  });

  test("只选择 Vitest coverage.include 对应的源码", () => {
    expect(isCoveredSourceFile("apps/desktop/src/main.ts")).toBe(true);
    expect(isCoveredSourceFile("apps\\desktop\\src\\main.ts")).toBe(true);
    expect(isCoveredSourceFile("packages/protocol/src/index.cts")).toBe(true);
    expect(isCoveredSourceFile("scripts/smoke.mjs")).toBe(true);
    expect(isCoveredSourceFile("apps/desktop/src/main.test.ts")).toBe(false);
    expect(isCoveredSourceFile("apps/desktop/src/types.d.ts")).toBe(false);
    expect(isCoveredSourceFile("packages/app-server-adapter/src/generated/schema.ts")).toBe(false);
    expect(isCoveredSourceFile("README.md")).toBe(false);
  });

  test("拒绝仓库外路径", () => {
    expect(normalizeRepositoryPath("/repo", "apps/a/src/a.ts")).toBe("apps/a/src/a.ts");
    expect(normalizeRepositoryPath("/repo", "/repo/scripts/a.mjs")).toBe("scripts/a.mjs");
    expect(() => normalizeRepositoryPath("/repo", "/other/a.ts")).toThrow("不在仓库内");
    expect(() => normalizeRepositoryPath("/repo", "../a.ts")).toThrow("不在仓库内");
    expect(() => normalizeRepositoryPath("/repo", "apps/../../a.ts")).toThrow("不在仓库内");
    expect(() => normalizeRepositoryPath("/repo", "")).toThrow("不在仓库内");
  });
});

describe("变更源码收集", () => {
  test("合并已跟踪 diff 与未跟踪源码", () => {
    const git = vi.fn((arguments_) => {
      if (arguments_.includes("--name-only")) {
        return "apps/a/src/a.ts\0README.md\0";
      }
      if (arguments_[0] === "ls-files") {
        return "scripts/new.mjs\0notes.txt\0";
      }
      if (arguments_.includes("--unified=0")) {
        return "@@ -2 +3,2 @@\n+x\n+y\n";
      }
      throw new Error(`unexpected git arguments: ${arguments_.join(" ")}`);
    });
    const changed = collectChangedSources({
      git,
      mergeBase: "base",
      readSourceText: () => "one\ntwo\n",
      repositoryRoot: "/repo",
    });

    expect([...changed.get("apps/a/src/a.ts")]).toEqual([3, 4]);
    expect([...changed.get("scripts/new.mjs")]).toEqual([1, 2]);
    expect(changed.size).toBe(2);
    expect(git.mock.calls.some(([arguments_]) => arguments_.includes("--find-renames"))).toBe(true);
  });

  test("拒绝 Git 的冲突分类", () => {
    const git = (arguments_) => {
      if (arguments_.includes("--name-only")) return "scripts/a.mjs\0";
      if (arguments_[0] === "ls-files") return "scripts/a.mjs\0";
      return "@@ -0,0 +1 @@\n+x";
    };
    expect(() =>
      collectChangedSources({
        git,
        mergeBase: "base",
        readSourceText: () => "x",
        repositoryRoot: "/repo",
      }),
    ).toThrow("同时把源码报告为已跟踪和未跟踪");
  });
});

describe("工作区快照", () => {
  test("纳入 HEAD、状态、diff 和未跟踪文件内容", () => {
    let contents = Buffer.from("first");
    const git = (arguments_) => {
      if (arguments_[0] === "rev-parse") return "head\n";
      if (arguments_[0] === "status") return "?? scripts/new.mjs\0";
      if (arguments_[0] === "diff") return "patch";
      if (arguments_[0] === "ls-files") return "scripts/new.mjs\0";
      throw new Error("unexpected git call");
    };
    const input = {
      git,
      mergeBase: "base",
      readWorkspaceEntry: () => contents,
      repositoryRoot: "/repo",
    };
    const first = captureWorkspaceFingerprint(input);
    expect(captureWorkspaceFingerprint(input)).toBe(first);
    contents = Buffer.from("second");
    expect(captureWorkspaceFingerprint(input)).not.toBe(first);
  });

  test("读取常规文件并对符号链接只记录链接目标", () => {
    const directory = mkdtempSync(join(tmpdir(), "coverage-entry-test-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "target.mjs");
    const link = join(directory, "link.mjs");
    writeFileSync(target, "export const value = 1;\n");
    symlinkSync("target.mjs", link);

    expect(readWorkspaceEntry(target).toString()).toContain("value = 1");
    expect(readWorkspaceEntry(link).toString()).toContain("symbolic-link\0target.mjs");
    expect(readSourceText(target)).toContain("value = 1");
    expect(() => readSourceText(link)).toThrow("必须是常规文件");
    expect(() => readWorkspaceEntry(directory)).toThrow("非常规文件");
  });

  test("覆盖报告必须是未超限的常规文件", () => {
    const directory = mkdtempSync(join(tmpdir(), "coverage-report-test-"));
    temporaryDirectories.push(directory);
    const report = join(directory, "coverage-final.json");
    const link = join(directory, "coverage-link.json");
    writeFileSync(report, "{}\n");
    symlinkSync("coverage-final.json", link);

    expect(readCoverageReportText(report)).toBe("{}\n");
    expect(() => readCoverageReportText(report, 2)).toThrow("超过 2 字节上限");
    expect(() => readCoverageReportText(link)).toThrow("必须是常规文件");
    expect(() => readCoverageReportText(directory)).toThrow("必须是常规文件");
  });

  test("真实 Git runner 不经 shell 读取仓库根目录", () => {
    expect(createGitRunner(process.cwd())(["rev-parse", "--show-toplevel"]).trim()).toBe(
      process.cwd(),
    );
  });
});

function fakeCoverageMap(files) {
  return {
    fileCoverageFor(file) {
      return { getLineCoverage: () => files[file] };
    },
    files: () => Object.keys(files),
  };
}

describe("覆盖率计算", () => {
  test("Istanbul 对同一行多个语句使用最大命中次数", () => {
    const fileCoverage = coverageLibrary.createFileCoverage({
      b: {},
      branchMap: {},
      f: {},
      fnMap: {},
      path: "/repo/scripts/a.mjs",
      s: { 0: 0, 1: 3 },
      statementMap: {
        0: { end: { column: 1, line: 1 }, start: { column: 0, line: 1 } },
        1: { end: { column: 3, line: 1 }, start: { column: 2, line: 1 } },
      },
    });
    expect(fileCoverage.getLineCoverage()).toEqual({ 1: 3 });
  });

  test("只聚合变更且可执行的行", () => {
    const result = evaluateChangedLineCoverage({
      changedSources: new Map([
        ["apps/a/src/a.ts", new Set([1, 2, 3, 10])],
        ["scripts/new.mjs", new Set([1])],
      ]),
      coverageMap: fakeCoverageMap({
        "/repo/apps/a/src/a.ts": { 1: 2, 2: 0, 10: 1 },
        "/repo/scripts/new.mjs": { 1: 1 },
      }),
      repositoryRoot: "/repo",
    });

    expect(result).toMatchObject({ covered: 3, passed: false, total: 4 });
    expect(result.percent).toBe(75);
    expect(formatCoverageResult(result)).toEqual([
      "  apps/a/src/a.ts: 66.67% (2/3)，未覆盖行：2",
      "  scripts/new.mjs: 100.00% (1/1)",
      "变更可执行行覆盖率：75.00% (3/4)",
    ]);
  });

  test("没有变更可执行行时返回不适用", () => {
    const result = evaluateChangedLineCoverage({
      changedSources: new Map([["apps/a/src/a.ts", new Set([2])]]),
      coverageMap: fakeCoverageMap({ "/repo/apps/a/src/a.ts": { 1: 0 } }),
      repositoryRoot: "/repo",
    });
    expect(result).toMatchObject({ covered: 0, passed: true, percent: 100, total: 0 });
    expect(formatCoverageResult(result)).toEqual([
      "变更可执行行覆盖率：不适用（没有新增或修改的可执行行）",
    ]);
  });

  test("缺失或重复的报告文件失败关闭", () => {
    expect(() =>
      evaluateChangedLineCoverage({
        changedSources: new Map([["apps/a/src/a.ts", new Set([1])]]),
        coverageMap: fakeCoverageMap({}),
        repositoryRoot: "/repo",
      }),
    ).toThrow("未进入覆盖报告");

    const duplicateMap = {
      fileCoverageFor: () => ({ getLineCoverage: () => ({ 1: 1 }) }),
      files: () => ["/repo/a.ts", "a.ts"],
    };
    expect(() => indexCoverageFiles(duplicateMap, "/repo")).toThrow("重复源码路径");
  });

  test("精确使用整数比较通过 90% 门槛", () => {
    const lineCoverage = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [index + 1, index === 9 ? 0 : 1]),
    );
    const result = evaluateChangedLineCoverage({
      changedSources: new Map([["scripts/a.mjs", new Set(Object.keys(lineCoverage).map(Number))]]),
      coverageMap: fakeCoverageMap({ "/repo/scripts/a.mjs": lineCoverage }),
      repositoryRoot: "/repo",
    });
    expect(result).toMatchObject({ covered: 9, passed: true, total: 10 });
  });
});

function createGateFixture(overrides = {}) {
  let fingerprintVersion = "stable";
  const output = [];
  const removed = [];
  const git = vi.fn((arguments_) => {
    if (arguments_[0] === "rev-parse" && arguments_.includes("--verify")) return "baseline-sha\n";
    if (arguments_[0] === "rev-parse" && arguments_[1] === "--show-toplevel") return "/repo\n";
    if (arguments_[0] === "rev-parse" && arguments_[1] === "HEAD") return "head\n";
    if (arguments_[0] === "merge-base") return "merge-base\n";
    if (arguments_[0] === "status") return `${fingerprintVersion}\0`;
    if (arguments_[0] === "diff" && arguments_.includes("--binary")) return "snapshot";
    if (arguments_.includes("--name-only")) return "apps/a/src/a.ts\0";
    if (arguments_[0] === "ls-files") return "";
    if (arguments_.includes("--unified=0")) return "@@ -1 +1,2 @@\n+x\n+y\n";
    throw new Error(`unexpected git arguments: ${arguments_.join(" ")}`);
  });
  const options = {
    arguments: ["--coverage.changed=main"],
    createCoverageMap: () =>
      fakeCoverageMap({ "/repo/apps/a/src/a.ts": overrides.lineCoverage ?? { 1: 1, 2: 1 } }),
    git,
    makeReportDirectory: () => "/tmp/private-report",
    readReportText: () => "{}",
    readWorkspaceEntry: () => Buffer.from("entry"),
    removeReportDirectory: (directory) => removed.push(directory),
    runTests: overrides.runTests ?? (() => ({ error: undefined, signal: null, status: 0 })),
    writeOutput: (line) => output.push(line),
    ...overrides.options,
  };
  return {
    changeFingerprint: () => {
      fingerprintVersion = "changed";
    },
    git,
    options,
    output,
    removed,
  };
}

describe("覆盖率门禁编排", () => {
  test("解析 merge-base、运行完整测试、输出结果并清理报告", () => {
    const fixture = createGateFixture();
    const result = runChangedLineCoverage(fixture.options);

    expect(result).toMatchObject({ covered: 2, passed: true, total: 2 });
    expect(fixture.output.at(-1)).toBe("变更可执行行覆盖率：100.00% (2/2)");
    expect(fixture.removed).toEqual(["/tmp/private-report"]);
    expect(fixture.git).toHaveBeenCalledWith([
      "rev-parse",
      "--verify",
      "--end-of-options",
      "main^{commit}",
    ]);
    expect(fixture.git).toHaveBeenCalledWith(["merge-base", "baseline-sha", "HEAD"]);
  });

  test("无效基准、空 merge-base 和不足 90% 均失败关闭", () => {
    const invalid = createGateFixture();
    invalid.options.git = () => {
      throw new Error("bad revision");
    };
    expect(() => runChangedLineCoverage(invalid.options)).toThrow("不可解析为 Git commit");

    const noMergeBase = createGateFixture();
    noMergeBase.options.git = (arguments_) => {
      if (arguments_[0] === "merge-base") return "";
      if (arguments_[0] === "rev-parse" && arguments_.includes("--verify")) return "sha";
      if (arguments_[0] === "rev-parse") return "/repo";
      throw new Error("unexpected");
    };
    expect(() => runChangedLineCoverage(noMergeBase.options)).toThrow("无法计算");

    const insufficient = createGateFixture({ lineCoverage: { 1: 1, 2: 0 } });
    expect(() => runChangedLineCoverage(insufficient.options)).toThrow("低于 90%");
    expect(insufficient.removed).toEqual(["/tmp/private-report"]);
  });

  test("测试启动错误、失败退出和工作区变化均失败关闭", () => {
    const launchFailure = createGateFixture({
      runTests: () => ({ error: new Error("ENOENT"), signal: null, status: null }),
    });
    expect(() => runChangedLineCoverage(launchFailure.options)).toThrow("无法启动完整 Vitest");

    const testFailure = createGateFixture({
      runTests: () => ({ error: undefined, signal: null, status: 2 }),
    });
    expect(() => runChangedLineCoverage(testFailure.options)).toThrow("退出码 2");

    const signalFailure = createGateFixture({
      runTests: () => ({ error: undefined, signal: "SIGTERM", status: null }),
    });
    expect(() => runChangedLineCoverage(signalFailure.options)).toThrow("信号 SIGTERM");

    let calls = 0;
    const changed = createGateFixture({
      options: {
        readWorkspaceEntry: () => Buffer.from(String(calls++)),
      },
    });
    changed.options.git = ((originalGit) => (arguments_) => {
      if (arguments_[0] === "ls-files") return "scripts/untracked.mjs\0";
      return originalGit(arguments_);
    })(changed.options.git);
    changed.options.readSourceText = () => "export {};\n";
    expect(() => runChangedLineCoverage(changed.options)).toThrow("工作区内容发生变化");
  });

  test("报告缺失、JSON 损坏和 Istanbul 解析失败均清理临时目录", () => {
    for (const readReportText of [
      () => {
        throw new Error("missing");
      },
      () => "not-json",
    ]) {
      const fixture = createGateFixture({ options: { readReportText } });
      expect(() => runChangedLineCoverage(fixture.options)).toThrow("覆盖报告缺失或损坏");
      expect(fixture.removed).toEqual(["/tmp/private-report"]);
    }

    const invalidIstanbul = createGateFixture({
      options: {
        createCoverageMap: () => {
          throw new Error("invalid Istanbul");
        },
      },
    });
    expect(() => runChangedLineCoverage(invalidIstanbul.options)).toThrow("无法解析 Istanbul");
  });

  test("main 把成功与异常转换为退出码", () => {
    const success = createGateFixture();
    expect(main(success.options.arguments, success.options)).toBe(0);

    const errors = [];
    expect(main([], { writeError: (message) => errors.push(message) })).toBe(1);
    expect(errors[0]).toContain("必须显式传入");
    expect(new CoverageGateError("x")).toMatchObject({ name: "CoverageGateError" });
  });
});
