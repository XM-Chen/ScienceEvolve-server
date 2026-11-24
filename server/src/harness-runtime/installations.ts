import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PublicHarnessDescriptor } from "./contracts.js";
import { BUILTIN_HARNESS_DESCRIPTORS, resolveHarnessExecutable } from "./registry.js";

export interface HarnessInstallation {
  id: string;
  label: string;
  installed: boolean;
  available: boolean;
  packageName?: string;
  version?: string;
  adapterVersion?: string;
  /** Discovery reads local files only; availability does not prove model compatibility. */
  verification: "not-run";
  message: string;
}

const HARNESS_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  pi: ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"],
  codex: ["@openai/codex", "@openai/codex-win32-x64", "@openai/codex-win32-arm64",
    "@openai/codex-linux-x64", "@openai/codex-linux-arm64", "@openai/codex-darwin-x64", "@openai/codex-darwin-arm64"],
  dsh: ["@deepseek-ai/dsh"],
  "claude-code": ["@anthropic-ai/claude-code"],
  opencode: ["opencode-ai"]
};

/** Inspect the resolved entry's owning package without running a CLI or exposing its path. */
export async function harnessPackageMetadata(id: string, executable: string): Promise<{ packageName?: string; version?: string }> {
  const packages = HARNESS_PACKAGES[id] ?? [];
  const resolved = await realpath(executable).catch(() => executable);
  const binDirectory = path.dirname(resolved);
  const directories = [binDirectory];
  // Global npm shims may be beside node_modules rather than inside the package.
  if (/\.(?:cmd|ps1)$/i.test(resolved)) {
    directories.unshift(...packages.map(name => path.join(binDirectory, "node_modules", ...name.split("/"))));
  }
  for (let directory = path.dirname(binDirectory); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    directories.push(directory);
  }
  for (const directory of directories) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (packages.includes(manifest.name)) {
        return {
          packageName: manifest.name,
          ...(typeof manifest.version === "string" ? { version: manifest.version } : {})
        };
      }
    } catch { /* Missing or unreadable metadata leaves the version explicitly unknown. */ }
    if (id === "codex") {
      try {
        const manifest = JSON.parse(await readFile(path.join(directory, "codex-package.json"), "utf8"));
        if (manifest.layoutVersion === 1 && manifest.variant === "codex" &&
          typeof manifest.version === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version) &&
          typeof manifest.entrypoint === "string" &&
          await realpath(path.resolve(directory, manifest.entrypoint)) === resolved) {
          return { version: manifest.version };
        }
      } catch { /* Standalone metadata is optional; never infer a version from a directory name. */ }
    }
  }
  return {};
}

async function isFile(file: string | undefined): Promise<boolean> {
  if (!file) return false;
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function installedCommand(command: string): Promise<string | undefined> {
  const directories = [...new Set([
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm")] : [])
  ])];
  for (const directory of directories) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ".com"] : [""]) {
      const candidate = path.join(directory, command + suffix);
      if (await isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function harnessInstallations(catalog: readonly PublicHarnessDescriptor[]): Promise<HarnessInstallation[]> {
  const installed: HarnessInstallation[] = await Promise.all(BUILTIN_HARNESS_DESCRIPTORS.map(async descriptor => {
    const current = catalog.find(entry => entry.id === descriptor.id);
    const executable = await resolveHarnessExecutable(descriptor);
    const metadata = executable ? await harnessPackageMetadata(descriptor.id, executable) : {};
    const desktop = descriptor.id === "dsh" && await isFile(process.env.SCIENCEEVOLVE_DSH_DESKTOP_BIN);
    return {
      id: descriptor.id,
      label: desktop && !executable ? "DSH Desktop" : descriptor.label,
      installed: Boolean(executable || desktop),
      available: current?.available === true,
      ...metadata,
      adapterVersion: descriptor.adapterVersion,
      verification: "not-run" as const,
      message: current?.available
        ? `${descriptor.default ? "默认使用；" : ""}已识别 CLI 及运行适配器；${metadata.version ? "此版本的模型调用尚未验证" : "版本未知，兼容性尚未验证"}${
          metadata.packageName === "@earendil-works/pi-coding-agent" ? "；使用显式环境变量凭据引用"
            : metadata.packageName === "@mariozechner/pi-coding-agent" ? "；使用旧版环境变量凭据引用" : ""}`
        : desktop ? "桌面版及附带 CLI 已安装；原版尚未适配桌面版启动与 SDK 模块"
          : current?.availabilityReason ?? "未找到 CLI"
    };
  }));
  for (const [id, label, command] of [
    ["claude-code", "Claude Code", "claude"],
    ["opencode", "OpenCode", "opencode"]
  ]) {
    const executable = await installedCommand(command!);
    installed.push({
      id: id!,
      label: label!,
      installed: Boolean(executable),
      available: false,
      ...(executable ? await harnessPackageMetadata(id!, executable) : {}),
      verification: "not-run",
      message: executable ? "命令已安装；ScienceEvolve 尚无对应运行适配器" : "未找到命令"
    });
  }
  return installed;
}
