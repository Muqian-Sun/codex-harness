import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import coverageLibrary from "istanbul-lib-coverage";

const COVERAGE_CHANGED_ARGUMENT = "--coverage.changed";
const COVERAGE_CHANGED_PREFIX = `${COVERAGE_CHANGED_ARGUMENT}=`;
const COVERAGE_THRESHOLD_PERCENT = 90;
const MAX_COVERAGE_REPORT_BYTES = 256 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const require = createRequire(import.meta.url);
const VITEST_CLI_PATH = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

export class CoverageGateError extends Error {
  constructor(message) {
    super(message);
    this.name = "CoverageGateError";
  }
}

export function parseBaselineArgument(arguments_) {
  if (arguments_.includes(COVERAGE_CHANGED_ARGUMENT)) {
    throw new CoverageGateError(
      `覆盖率基准必须使用 ${COVERAGE_CHANGED_PREFIX}<commit-or-branch> 形式显式传入。`,
    );
  }

  const unknownArguments = arguments_.filter(
    (argument) => !argument.startsWith(COVERAGE_CHANGED_PREFIX),
  );
  if (unknownArguments.length > 0) {
    throw new CoverageGateError(`覆盖率命令不接受未知参数：${unknownArguments.join(", ")}`);
  }

  const baselineArguments = arguments_.filter((argument) =>
    argument.startsWith(COVERAGE_CHANGED_PREFIX),
  );
  if (baselineArguments.length === 0) {
    throw new CoverageGateError("覆盖率命令必须显式传入 coverage.changed 基准。");
  }
  if (baselineArguments.length !== 1) {
    throw new CoverageGateError("覆盖率命令只能传入一个 coverage.changed 基准。");
  }

  const baseline = baselineArguments[0].slice(COVERAGE_CHANGED_PREFIX.length);
  if (baseline.length === 0) {
    throw new CoverageGateError("coverage.changed 基准不能为空。");
  }
  return baseline;
}

export function parseNullSeparatedList(value) {
  return value.split("\0").filter((item) => item.length > 0);
}

export function normalizeRepositoryPath(repositoryRoot, candidate) {
  const normalizedRoot = resolve(repositoryRoot);
  const absoluteCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(normalizedRoot, candidate);
  const repositoryPath = relative(normalizedRoot, absoluteCandidate);
  const normalized = repositoryPath.split(sep).join("/");
  if (
    normalized.length === 0 ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    isAbsolute(repositoryPath)
  ) {
    throw new CoverageGateError(`路径不在仓库内：${candidate}`);
  }
  return normalized;
}

export function isCoveredSourceFile(repositoryPath) {
  const normalized = repositoryPath.replaceAll("\\", "/");
  if (
    /(?:^|\/)[^/]+\.(?:test|spec)\.(?:ts|tsx|cts|mjs)$/.test(normalized) ||
    normalized.endsWith(".d.ts") ||
    normalized.startsWith("packages/app-server-adapter/src/generated/")
  ) {
    return false;
  }

  return (
    /^(?:apps|packages)\/.+\/src\/.+\.(?:ts|tsx|cts)$/.test(normalized) ||
    /^scripts\/.+\.mjs$/.test(normalized)
  );
}

export function parseAddedLineNumbers(patch) {
  const lines = new Set();
  const headerPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const patchLine of patch.split(/\r?\n/)) {
    if (!patchLine.startsWith("@@")) {
      continue;
    }
    const match = headerPattern.exec(patchLine);
    if (match === null) {
      throw new CoverageGateError(`无法解析 Git diff hunk：${patchLine}`);
    }
    const start = Number.parseInt(match[1], 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    for (let offset = 0; offset < count; offset += 1) {
      lines.add(start + offset);
    }
  }
  return lines;
}

export function allSourceLineNumbers(source) {
  if (source.length === 0) {
    return new Set();
  }
  const lineCount = source.split(/\r\n|\r|\n/).length - (/\r\n$|[\r\n]$/.test(source) ? 1 : 0);
  return new Set(Array.from({ length: lineCount }, (_, index) => index + 1));
}

export function collectChangedSources({ git, mergeBase, readSourceText, repositoryRoot }) {
  const trackedFiles = parseNullSeparatedList(
    git([
      "-c",
      "core.quotePath=false",
      "diff",
      "--name-only",
      "-z",
      "--find-renames",
      "--diff-filter=ACMR",
      mergeBase,
      "--",
    ]),
  );
  const untrackedFiles = parseNullSeparatedList(
    git(["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  const changedSources = new Map();

  for (const candidate of trackedFiles) {
    const repositoryPath = normalizeRepositoryPath(repositoryRoot, candidate);
    if (!isCoveredSourceFile(repositoryPath)) {
      continue;
    }
    const patch = git([
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-ext-diff",
      "--unified=0",
      "--no-color",
      "--find-renames",
      mergeBase,
      "--",
      repositoryPath,
    ]);
    changedSources.set(repositoryPath, parseAddedLineNumbers(patch));
  }

  for (const candidate of untrackedFiles) {
    const repositoryPath = normalizeRepositoryPath(repositoryRoot, candidate);
    if (!isCoveredSourceFile(repositoryPath)) {
      continue;
    }
    if (changedSources.has(repositoryPath)) {
      throw new CoverageGateError(`Git 同时把源码报告为已跟踪和未跟踪：${repositoryPath}`);
    }
    changedSources.set(
      repositoryPath,
      allSourceLineNumbers(readSourceText(resolve(repositoryRoot, repositoryPath))),
    );
  }

  return changedSources;
}

export function captureWorkspaceFingerprint({
  git,
  mergeBase,
  readWorkspaceEntry,
  repositoryRoot,
}) {
  const hash = createHash("sha256");
  const update = (label, value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    hash.update(`${label}\0${buffer.length}\0`);
    hash.update(buffer);
    hash.update("\0");
  };

  update("head", git(["rev-parse", "HEAD"]));
  update("status", git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  update(
    "diff",
    git(["diff", "--binary", "--no-ext-diff", "--no-color", "--find-renames", mergeBase, "--"]),
  );

  const untrackedFiles = parseNullSeparatedList(
    git(["ls-files", "--others", "--exclude-standard", "-z"]),
  ).sort();
  for (const candidate of untrackedFiles) {
    const repositoryPath = normalizeRepositoryPath(repositoryRoot, candidate);
    update(
      `untracked:${repositoryPath}`,
      readWorkspaceEntry(resolve(repositoryRoot, repositoryPath)),
    );
  }
  return hash.digest("hex");
}

export function indexCoverageFiles(coverageMap, repositoryRoot) {
  const indexed = new Map();
  for (const coveragePath of coverageMap.files()) {
    const repositoryPath = normalizeRepositoryPath(repositoryRoot, coveragePath);
    if (indexed.has(repositoryPath)) {
      throw new CoverageGateError(`覆盖报告包含重复源码路径：${repositoryPath}`);
    }
    indexed.set(repositoryPath, coverageMap.fileCoverageFor(coveragePath));
  }
  return indexed;
}

export function evaluateChangedLineCoverage({ changedSources, coverageMap, repositoryRoot }) {
  const coverageFiles = indexCoverageFiles(coverageMap, repositoryRoot);
  const files = [];
  let covered = 0;
  let total = 0;

  for (const [repositoryPath, changedLines] of [...changedSources].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const fileCoverage = coverageFiles.get(repositoryPath);
    if (fileCoverage === undefined) {
      throw new CoverageGateError(`变更源码未进入覆盖报告：${repositoryPath}`);
    }

    const lineCoverage = fileCoverage.getLineCoverage();
    let fileCovered = 0;
    let fileTotal = 0;
    const uncoveredLines = [];
    for (const line of [...changedLines].sort((left, right) => left - right)) {
      if (!Object.hasOwn(lineCoverage, line)) {
        continue;
      }
      fileTotal += 1;
      total += 1;
      if (lineCoverage[line] > 0) {
        fileCovered += 1;
        covered += 1;
      } else {
        uncoveredLines.push(line);
      }
    }
    if (fileTotal > 0) {
      files.push({
        covered: fileCovered,
        path: repositoryPath,
        total: fileTotal,
        uncoveredLines,
      });
    }
  }

  const percent = total === 0 ? 100 : (covered / total) * 100;
  return {
    covered,
    files,
    passed: total === 0 || covered * 100 >= total * COVERAGE_THRESHOLD_PERCENT,
    percent,
    total,
  };
}

export function formatCoverageResult(result) {
  if (result.total === 0) {
    return ["变更可执行行覆盖率：不适用（没有新增或修改的可执行行）"];
  }
  const lines = result.files.map(({ covered, path, total, uncoveredLines }) => {
    const percent = ((covered / total) * 100).toFixed(2);
    const uncovered = uncoveredLines.length === 0 ? "" : `，未覆盖行：${uncoveredLines.join(", ")}`;
    return `  ${path}: ${percent}% (${covered}/${total})${uncovered}`;
  });
  lines.push(
    `变更可执行行覆盖率：${result.percent.toFixed(2)}% (${result.covered}/${result.total})`,
  );
  return lines;
}

export function createGitRunner(repositoryDirectory) {
  return (arguments_) =>
    execFileSync("git", arguments_, {
      cwd: repositoryDirectory,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
}

export function readWorkspaceEntry(filePath) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    return Buffer.from(`symbolic-link\0${readlinkSync(filePath)}`);
  }
  if (!stat.isFile()) {
    throw new CoverageGateError(`无法为非常规文件建立工作区快照：${filePath}`);
  }
  return readFileSync(filePath);
}

export function readSourceText(filePath) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CoverageGateError(`未跟踪源码必须是常规文件：${filePath}`);
  }
  return readFileSync(filePath, "utf8");
}

export function readCoverageReportText(filePath, maxBytes = MAX_COVERAGE_REPORT_BYTES) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CoverageGateError(`覆盖报告必须是常规文件：${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new CoverageGateError(`覆盖报告超过 ${String(maxBytes)} 字节上限：${filePath}`);
  }
  return readFileSync(filePath, "utf8");
}

export function runVitest(repositoryRoot, reportDirectory) {
  return spawnSync(
    process.execPath,
    [
      VITEST_CLI_PATH,
      "run",
      "--coverage",
      "--coverage.reporter=json",
      `--coverage.reportsDirectory=${reportDirectory}`,
      "--coverage.thresholds.lines=0",
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: "inherit",
    },
  );
}

export function runChangedLineCoverage(options = {}) {
  const arguments_ = options.arguments ?? process.argv.slice(2);
  const initialDirectory = options.cwd ?? process.cwd();
  const initialGit = options.git ?? createGitRunner(initialDirectory);
  const baseline = parseBaselineArgument(arguments_);

  let baselineCommit;
  try {
    baselineCommit = initialGit([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${baseline}^{commit}`,
    ]).trim();
  } catch {
    throw new CoverageGateError(`coverage.changed 基准不可解析为 Git commit：${baseline}`);
  }

  const repositoryRoot = initialGit(["rev-parse", "--show-toplevel"]).trim();
  const git = options.git ?? createGitRunner(repositoryRoot);
  const mergeBase = git(["merge-base", baselineCommit, "HEAD"]).trim();
  if (mergeBase.length === 0) {
    throw new CoverageGateError(`无法计算 coverage.changed 基准与 HEAD 的 merge-base：${baseline}`);
  }

  const workspaceEntryReader = options.readWorkspaceEntry ?? readWorkspaceEntry;
  const sourceReader = options.readSourceText ?? readSourceText;
  const fingerprintOptions = {
    git,
    mergeBase,
    readWorkspaceEntry: workspaceEntryReader,
    repositoryRoot,
  };
  const beforeFingerprint = captureWorkspaceFingerprint(fingerprintOptions);
  const changedSources = collectChangedSources({
    git,
    mergeBase,
    readSourceText: sourceReader,
    repositoryRoot,
  });

  const makeReportDirectory =
    options.makeReportDirectory ??
    (() => {
      const directory = mkdtempSync(join(tmpdir(), "codex-harness-coverage-"));
      chmodSync(directory, 0o700);
      return directory;
    });
  const removeReportDirectory =
    options.removeReportDirectory ??
    ((directory) => {
      rmSync(directory, { force: true, recursive: true });
    });
  const reportDirectory = makeReportDirectory();

  try {
    const testResult = (options.runTests ?? runVitest)(repositoryRoot, reportDirectory);
    if (testResult.error !== undefined) {
      throw new CoverageGateError(`无法启动完整 Vitest：${testResult.error.message}`);
    }
    if (testResult.status !== 0) {
      const reason =
        testResult.signal === null
          ? `退出码 ${String(testResult.status)}`
          : `信号 ${testResult.signal}`;
      throw new CoverageGateError(`完整 Vitest 未通过：${reason}`);
    }

    const afterFingerprint = captureWorkspaceFingerprint(fingerprintOptions);
    if (afterFingerprint !== beforeFingerprint) {
      throw new CoverageGateError(
        "Vitest 运行期间 HEAD 或工作区内容发生变化，拒绝使用过期覆盖证据。",
      );
    }

    const reportPath = join(reportDirectory, "coverage-final.json");
    let report;
    try {
      report = JSON.parse((options.readReportText ?? readCoverageReportText)(reportPath));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CoverageGateError(`覆盖报告缺失或损坏：${detail}`);
    }

    let coverageMap;
    try {
      coverageMap = (options.createCoverageMap ?? coverageLibrary.createCoverageMap)(report);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CoverageGateError(`无法解析 Istanbul 覆盖报告：${detail}`);
    }
    const result = evaluateChangedLineCoverage({ changedSources, coverageMap, repositoryRoot });
    for (const line of formatCoverageResult(result)) {
      (options.writeOutput ?? console.log)(line);
    }
    if (!result.passed) {
      throw new CoverageGateError(`变更可执行行覆盖率低于 ${COVERAGE_THRESHOLD_PERCENT}% 门槛。`);
    }
    return result;
  } finally {
    removeReportDirectory(reportDirectory);
  }
}

export function main(arguments_ = process.argv.slice(2), options = {}) {
  try {
    runChangedLineCoverage({ ...options, arguments_ });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (options.writeError ?? console.error)(`变更可执行行覆盖率检查失败：${message}`);
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = main();
}
