import { stat } from "node:fs/promises";
import path from "node:path";
import type { PublicHarnessDescriptor } from "./contracts.js";
import { BUILTIN_HARNESS_DESCRIPTORS, resolveHarnessExecutable } from "./registry.js";

export interface HarnessInstallation {
  id: string;
  label: string;
  installed: boolean;
  available: boolean;
  message: string;
}

async function isFile(file: string | undefined): Promise<boolean> {
  if (!file) return false;
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function commandInstalled(command: string): Promise<boolean> {
  const directories = [...new Set([
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm")] : [])
  ])];
  for (const directory of directories) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ".com"] : [""]) {
      if (await isFile(path.join(directory, command + suffix))) return true;
    }
  }
  return false;
}

export async function harnessInstallations(catalog: readonly PublicHarnessDescriptor[]): Promise<HarnessInstallation[]> {
  const installed = await Promise.all(BUILTIN_HARNESS_DESCRIPTORS.map(async descriptor => {
    const current = catalog.find(entry => entry.id === descriptor.id);
    const executable = await resolveHarnessExecutable(descriptor);
    const desktop = descriptor.id === "dsh" && await isFile(process.env.SCIENCEEVOLVE_DSH_DESKTOP_BIN);
    return {
      id: descriptor.id,
      label: desktop && !executable ? "DSH Desktop" : descriptor.label,
      installed: Boolean(executable || desktop),
      available: current?.available === true,
      message: current?.available
        ? descriptor.default ? "已就绪，默认使用" : "已识别原生 CLI，尚未执行模型验证"
        : desktop ? "桌面版及附带 CLI 已安装；原版尚未适配桌面版启动与 SDK 模块"
          : current?.availabilityReason ?? "未找到 CLI"
    };
  }));
  for (const [id, label, command] of [
    ["claude-code", "Claude Code", "claude"],
    ["opencode", "OpenCode", "opencode"]
  ]) {
    const present = await commandInstalled(command!);
    installed.push({
      id: id!,
      label: label!,
      installed: present,
      available: false,
      message: present ? "命令已安装；ScienceEvolve 原版尚无对应运行适配器" : "未找到命令"
    });
  }
  return installed;
}
