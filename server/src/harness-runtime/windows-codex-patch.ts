import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "windows-apply-patch.cs");
const SOURCE_SHA256 = "e6d7f7669bb9b5af3858d93282f01af4bc4868b427a82b47cd0616fe8d995c5c";

/** Install only in the native CLI's own generated arg0 directory. Business
 * files remain authored by the model and patched by the official engine. */
export async function installWindowsCodexPatch(home: string, codexExecutable: string,
  runtimePath: string): Promise<void> {
  if (process.platform !== "win32" || !codexExecutable.toLowerCase().endsWith(".exe")) return;
  const bytes = await fs.readFile(sourcePath);
  if (createHash("sha256").update(bytes).digest("hex") !== SOURCE_SHA256) {
    throw new Error("Windows patch launcher does not match its pinned build");
  }
  const aliasRoots = ["arg0-windows", "arg0"].map(name => path.join(home, "tmp", name));
  const expectedExecutable = path.win32.normalize(codexExecutable).toLowerCase();
  const deadline = Date.now() + 3000;
  let targets: string[] = [];
  while (Date.now() < deadline) {
    targets = [];
    for (const root of aliasRoots) {
      const directories = await fs.readdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const directory of directories) {
        const target = path.join(root, directory);
        const info = await fs.lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Codex arg0 directory is not a real directory");
        const batch = await fs.readFile(path.join(target, "apply_patch.bat"), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        const executable = /^"([^"\r\n]+)"[ \t]+--codex-run-as-apply-patch[ \t]+%\*[ \t]*\r?$/m.exec(batch)?.[1];
        if (!executable) continue;
        // Newer Codex aliases use the batch directory on the same volume.
        const resolved = executable.toLowerCase().startsWith("%~dp0")
          ? path.win32.resolve(target, executable.slice(5))
          : path.win32.normalize(executable);
        if (resolved.toLowerCase() === expectedExecutable) targets.push(target);
      }
    }
    if (targets.length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!targets.length) throw new Error("Native Codex did not create its Windows patch launcher");
  const compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const compiled = path.join(runtimePath, "openfars-apply-patch.exe");
  await fs.mkdir(runtimePath, { recursive: true });
  await execFileAsync(compiler, ["/nologo", "/target:exe", `/out:${compiled}`, sourcePath], { windowsHide: true, timeout: 15000 });
  for (const target of targets) {
    const locator = path.join(target, "openfars-codex-path.txt");
    await fs.writeFile(locator, codexExecutable, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      const info = await fs.lstat(locator);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        await fs.readFile(locator, "utf8") !== codexExecutable) throw new Error("Windows patch launcher executable binding changed");
    });
    await fs.copyFile(compiled, path.join(target, "apply_patch.exe"));
  }
}
