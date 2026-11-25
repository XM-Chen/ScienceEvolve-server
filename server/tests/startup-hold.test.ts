import { expect, it } from "vitest";
import { CollaborationRuntimeCoordinator } from "../src/collaboration-runtime.js";
import { EventHub } from "../src/event-hub.js";
import { ProjectStorage } from "../src/storage.js";
import type { ProjectState } from "../src/types.js";

it("prevents held projects from scheduling while leaving completed projects reusable", () => {
  const coordinator = new CollaborationRuntimeCoordinator({
    storage: new ProjectStorage("unused-startup-hold-test", new EventHub())
  });
  const held = {
    id: "prj_11111111111111111111111111111111",
    status: "retrying",
    phase: "user-intervention-required",
    orchestration: { schemaVersion: 3 }
  } as ProjectState;
  coordinator.holdProjectOnStartup(held);
  const internal = coordinator as unknown as {
    scheduleProject(state: ProjectState): boolean;
    conversationRunning(state: ProjectState): boolean;
  };
  expect(internal.scheduleProject(held)).toBe(false);
  expect(internal.conversationRunning(held)).toBe(false);

  const completed = { ...held, id: "prj_22222222222222222222222222222222", status: "completed" } as ProjectState;
  coordinator.holdProjectOnStartup(completed);
  completed.status = "queued";
  expect(internal.conversationRunning(completed)).toBe(true);
});
