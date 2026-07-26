import { describe, expect, it } from "vitest";
import { missingIntegrationContext, resolveIntegrationTaskContext } from "../../apps/desktop/src/renderer/integration-context";

describe("integration task context", () => {
  it("keeps missing selection explicit instead of manufacturing defaults", () => {
    const context = resolveIntegrationTaskContext({ activeThread: undefined, activeProject: undefined, activeProfile: undefined, latestTurnId: undefined, accessMode: "standard" });
    expect(context).toEqual({ accessMode: "standard" });
    expect(missingIntegrationContext(context, ["projectId", "threadId", "turnId", "profileId"])).toEqual(["Project", "Thread", "parent Turn", "Model Profile"]);
  });

  it("records the selected project thread, parent turn, profile, and output location", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const context = resolveIntegrationTaskContext({
      activeThread: { id: "thread-1", title: "Project thread", scope: "project", projectId, stateVersion: 1, createdAt: "2026-07-26T00:00:00.000Z" },
      activeProject: { id: projectId, displayName: "Project", path: "C:/project", identityStatus: "stable", createdAt: "2026-07-26T00:00:00.000Z", updatedAt: "2026-07-26T00:00:00.000Z" },
      activeProfile: { id: "profile-1", name: "Fixture", provider: "fixture", model: "fixture", credentialRef: "credential-1", thinkingLevel: "off", createdAt: "2026-07-26T00:00:00.000Z", updatedAt: "2026-07-26T00:00:00.000Z" },
      latestTurnId: "turn-1",
      accessMode: "full"
    });
    expect(context).toEqual({ projectId, threadId: "thread-1", turnId: "turn-1", profileId: "profile-1", accessMode: "full" });
  });
});
