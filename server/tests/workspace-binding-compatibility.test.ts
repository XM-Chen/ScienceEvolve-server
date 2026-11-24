import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { SavedResearchTaskStore } from "../src/saved-research-tasks.js";
import { mergeAgentConfigs } from "../src/validation.js";
import { WorkspaceBindings } from "../src/workspace-bindings.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

describe("existing workspace compatibility", () => {
  it("persists a draft and directory registration across restart without changing research files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-binding-"));
    roots.push(root);
    const dataRoot = path.join(root, "private-data");
    const workspace = path.join(root, "研究项目 with spaces");
    await fs.mkdir(dataRoot);
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "research.md"), "existing research");
    const orchestration = cloneAgentOrchestrationTemplate();
    const store = new SavedResearchTaskStore(dataRoot);
    const task = await store.create({
      title: "Existing project", requirement: "Continue from the existing research after manual launch.",
      workspacePath: workspace, orchestration, agents: mergeAgentConfigs(undefined, orchestration),
      git: { enabled: false }
    });
    const canonical = await fs.realpath(workspace);
    expect((await new SavedResearchTaskStore(dataRoot).get(task.id))?.workspacePath).toBe(canonical);
    const projectId = `prj_${"a".repeat(32)}`;
    await new WorkspaceBindings(dataRoot).bind(projectId, workspace);
    const registrations = new WorkspaceBindings(dataRoot);
    expect(await registrations.resolve(projectId)).toBe(canonical);
    const child = path.join(workspace, "child");
    await fs.mkdir(child);
    await expect(registrations.bind(`prj_${"b".repeat(32)}`, child)).rejects.toThrow("已被其他项目绑定");
    await registrations.release(projectId);
    expect(await registrations.resolve(projectId)).toBeUndefined();
    expect(await fs.readFile(path.join(workspace, "research.md"), "utf8")).toBe("existing research");
    expect((await fs.readdir(workspace)).sort()).toEqual(["child", "research.md"]);
  });
});
