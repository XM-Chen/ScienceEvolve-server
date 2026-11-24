import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface WorkspaceBinding {
  path: string;
  dev: string;
  ino: string;
}

export class WorkspaceBindingError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) { super(message); }
}

interface WorkspaceBindingsFile {
  schemaVersion: 1;
  projects: Record<string, WorkspaceBinding>;
}

function overlaps(left: string, right: string): boolean {
  const within = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  };
  return within(left, right) || within(right, left);
}

/** Inspect an explicit user selection without creating or modifying its files. */
export async function inspectWorkspacePath(requested: string, dataRoot: string): Promise<WorkspaceBinding> {
  const selected = requested.trim();
  if (!selected || !path.isAbsolute(selected) || selected.includes("\0")) throw new WorkspaceBindingError("工作目录必须是服务所在电脑上的完整绝对路径");
  const normalized = path.resolve(selected);
  if (normalized === path.parse(normalized).root) throw new WorkspaceBindingError("不能把磁盘根目录设为项目工作目录");
  let info;
  let canonical: string;
  try {
    info = await fs.lstat(normalized, { bigint: true });
    canonical = await fs.realpath(normalized);
  } catch { throw new WorkspaceBindingError("工作目录不存在或服务无法访问，请选择已有文件夹"); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkspaceBindingError("工作目录必须是实际文件夹，不能是符号链接");
  const resolvedInfo = await fs.lstat(canonical, { bigint: true });
  if (resolvedInfo.dev !== info.dev || resolvedInfo.ino !== info.ino)
    throw new WorkspaceBindingError("检查期间目录发生变化，请重新选择目录");
  const privateRoot = await fs.realpath(dataRoot).catch(() => path.resolve(dataRoot));
  if (overlaps(canonical, privateRoot)) throw new WorkspaceBindingError("工作目录不能包含应用管理数据，也不能位于管理数据目录内");
  try { await fs.access(canonical, constants.R_OK | constants.W_OK); }
  catch { throw new WorkspaceBindingError("服务需要读取和写入所选工作目录的权限"); }
  return { path: canonical, dev: info.dev.toString(), ino: info.ino.toString() };
}

/** Server-owned registrations; task/Agent text never supplies directory identity. */
export class WorkspaceBindings {
  private mutationTail: Promise<void> = Promise.resolve();
  constructor(private readonly dataRoot: string) {}

  inspect(requested: string): Promise<WorkspaceBinding> {
    return inspectWorkspacePath(requested, this.dataRoot);
  }

  async resolve(projectId: string): Promise<string | undefined> {
    await this.mutationTail;
    const binding = (await this.read()).projects[projectId];
    if (!binding) return undefined;
    const actual = await this.inspect(binding.path);
    if (actual.path !== binding.path || actual.dev !== binding.dev || actual.ino !== binding.ino)
      throw new WorkspaceBindingError("绑定的工作目录已移动或被替换，请核对目录身份；不会回退到默认目录", 409);
    return actual.path;
  }

  async bind(projectId: string, requested: string): Promise<string> {
    if (!/^prj_[a-f0-9]{32}$/.test(projectId)) throw new Error("Invalid project workspace identity");
    return this.serialize(async () => {
      const binding = await this.inspect(requested);
      const document = await this.read();
      for (const [owner, existing] of Object.entries(document.projects)) {
        if (owner === projectId) {
          if (existing.path !== binding.path || existing.dev !== binding.dev || existing.ino !== binding.ino)
            throw new WorkspaceBindingError("项目已经绑定其他工作目录，不能在运行期间替换", 409);
        } else if (overlaps(existing.path, binding.path) ||
          existing.dev === binding.dev && existing.ino === binding.ino) {
          throw new WorkspaceBindingError("该目录或其父子目录已被其他项目绑定，不能由多个项目共同接管", 409);
        }
      }
      document.projects[projectId] = binding;
      await this.write(document);
      return binding.path;
    });
  }

  /** Removing a registration never deletes or changes the user's directory. */
  async release(projectId: string): Promise<void> {
    await this.serialize(async () => {
      const document = await this.read();
      if (!(projectId in document.projects)) return;
      delete document.projects[projectId];
      await this.write(document);
    });
  }

  private async read(): Promise<WorkspaceBindingsFile> {
    let document: WorkspaceBindingsFile;
    try { document = JSON.parse(await fs.readFile(path.join(this.dataRoot, "workspace-bindings.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, projects: {} };
      throw error;
    }
    if (document.schemaVersion !== 1 || !document.projects || typeof document.projects !== "object" || Array.isArray(document.projects))
      throw new Error("工作目录绑定登记文件无效");
    for (const [id, binding] of Object.entries(document.projects)) {
      if (!/^prj_[a-f0-9]{32}$/.test(id) || !binding || typeof binding.path !== "string" ||
          !path.isAbsolute(binding.path) || typeof binding.dev !== "string" || typeof binding.ino !== "string")
        throw new Error("工作目录绑定条目无效");
    }
    return document;
  }

  private async write(document: WorkspaceBindingsFile): Promise<void> {
    await fs.mkdir(this.dataRoot, { recursive: true });
    const destination = path.join(this.dataRoot, "workspace-bindings.json");
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, destination);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
