import { describe, expect, it } from "vitest";

import { ModelRoutingProfileRepository } from "../apps/harnessd/src/domain/model-routing-profile-repository.ts";
import { ProjectRegistryRepository } from "../apps/harnessd/src/domain/project-registry-repository.ts";
import { ProjectRoutingProfileBindingRepository } from "../apps/harnessd/src/domain/project-routing-profile-binding-repository.ts";
import { TaskPlanRepository } from "../apps/harnessd/src/domain/task-plan-store.ts";
import { DaemonStateStore } from "../apps/harnessd/src/runtime/daemon-state-store.ts";
import { DESKTOP_DEFAULT_ROUTING_PROFILE_ID } from "../apps/harnessd/src/runtime/desktop-default-routing-profile.ts";
import { ProjectTaskService } from "../apps/harnessd/src/runtime/project-task-service.ts";
import { smokeProjectTaskPlanConfirmation } from "./smoke-project-task-plan-confirmation.mjs";

describe("候选 Plan 确认构建 smoke", () => {
  it("使用与编译产物相同的公开模块契约持久化并恢复确认结果", async () => {
    await expect(
      smokeProjectTaskPlanConfirmation({
        DaemonStateStore,
        ProjectRegistryRepository,
        ModelRoutingProfileRepository,
        ProjectRoutingProfileBindingRepository,
        TaskPlanRepository,
        ProjectTaskService,
        DESKTOP_DEFAULT_ROUTING_PROFILE_ID,
      }),
    ).resolves.toBeUndefined();
  });
});
