export function createMemoryHostService(handlers = {}) {
  function required(name) {
    if (typeof handlers[name] !== "function") {
      throw new Error(`Memory host service missing handler: ${name}`);
    }
    return handlers[name];
  }

  return {
    memoryBridgeRoutes: [
      { method: "GET", path: "/memory/status", handler: required("executeMemoryStatus") },
      { method: "GET", path: "/memory/settings", handler: required("executeMemorySettings") },
      {
        method: "POST",
        path: "/memory/settings",
        requiredCapability: "memory-settings-write",
        handler: required("executeMemorySettingsSave"),
      },
      {
        method: "POST",
        path: "/memory/source/browse",
        requiredCapability: "memory-source-browse",
        handler: required("executeMemorySourceBrowse"),
      },
      {
        method: "POST",
        path: "/memory/source/scan",
        requiredCapability: "memory-source-scan",
        handler: required("executeMemorySourceScan"),
      },
      {
        method: "POST",
        path: "/memory/source/action",
        requiredCapability: "memory-source-manage",
        handler: required("executeMemorySourceAction"),
      },
      {
        method: "POST",
        path: "/memory/source/move-preflight",
        requiredCapability: "memory-source-move",
        handler: required("executeMemorySourceMovePreflight"),
      },
      {
        method: "POST",
        path: "/memory/source/move-execute",
        requiredCapability: "memory-source-move",
        handler: required("executeMemorySourceMoveExecute"),
      },
      {
        method: "POST",
        path: "/memory/source/move-rollback",
        requiredCapability: "memory-source-move",
        handler: required("executeMemorySourceMoveRollback"),
      },
      {
        method: "POST",
        path: "/memory/source/review",
        requiredCapability: "memory-source-review",
        handler: required("executeMemorySourceReview"),
      },
      {
        method: "POST",
        path: "/memory/source/intake",
        requiredCapability: "memory-source-intake",
        handler: required("executeMemorySourceIntake"),
      },
      {
        method: "POST",
        path: "/memory/source/file-intake",
        requiredCapability: "memory-source-file-intake",
        handler: required("executeMemorySourceFileIntake"),
      },
      {
        method: "POST",
        path: "/memory/source/sync",
        requiredCapability: "memory-source-file-intake",
        handler: required("executeMemorySourceSync"),
      },
      {
        method: "POST",
        path: "/memory/search",
        requiredCapability: "archive-read",
        handler: required("executeMemorySearch"),
      },
      { method: "GET", path: "/memory/wiki/health", handler: required("executeMemoryWikiHealth") },
      {
        method: "POST",
        path: "/memory/wiki/page/read",
        requiredCapability: "archive-read",
        handler: required("executeMemoryWikiPageRead"),
      },
      {
        method: "POST",
        path: "/memory/wiki/lint",
        requiredCapability: "memory-source-review",
        handler: required("executeMemoryWikiLint"),
      },
      {
        method: "POST",
        path: "/memory/source/versions",
        requiredCapability: "memory-source-review",
        handler: required("executeMemorySourceVersions"),
      },
      {
        method: "POST",
        path: "/memory/source/versions/repair",
        requiredCapability: "memory-source-manage",
        handler: required("executeMemorySourceVersionsRepair"),
      },
      {
        method: "POST",
        path: "/memory/source/diff",
        requiredCapability: "memory-source-review",
        handler: required("executeMemorySourceDiff"),
      },
      {
        method: "POST",
        path: "/archive/intake",
        requiredCapability: "archive-write",
        handler: required("executeArchiveIntake"),
      },
      {
        method: "POST",
        path: "/archive/intake/list",
        requiredCapability: "archive-read",
        handler: required("executeArchiveIntakeList"),
      },
      {
        method: "POST",
        path: "/archive/intake/read",
        requiredCapability: "archive-read",
        handler: required("executeArchiveIntakeRead"),
      },
      {
        method: "POST",
        path: "/archive/review/request",
        requiredCapability: "archive-write",
        handler: required("executeArchiveReviewRequest"),
      },
      {
        method: "POST",
        path: "/archive/review/list",
        requiredCapability: "archive-read",
        handler: required("executeArchiveReviewList"),
      },
      {
        method: "POST",
        path: "/archive/review/transition",
        requiredCapability: "archive-write",
        handler: required("executeArchiveReviewTransition"),
      },
      {
        method: "POST",
        path: "/archive/review/draft",
        requiredCapability: "archive-write",
        handler: required("executeArchiveReviewDraft"),
      },
      {
        method: "POST",
        path: "/archive/review/artifact/read",
        requiredCapability: "archive-read",
        handler: required("executeArchiveReviewArtifactRead"),
      },
      {
        method: "POST",
        path: "/archive/review/artifact/verify",
        requiredCapability: "archive-write",
        handler: required("executeArchiveReviewArtifactVerify"),
      },
      {
        method: "POST",
        path: "/archive/review/verification/read",
        requiredCapability: "archive-read",
        handler: required("executeArchiveVerificationRead"),
      },
      {
        method: "POST",
        path: "/archive/review/artifact/revise",
        requiredCapability: "archive-write",
        handler: required("executeArchiveReviewArtifactRevise"),
      },
      {
        method: "POST",
        path: "/archive/review/artifact/promote",
        requiredCapability: "archive-write",
        handler: required("executeArchiveReviewArtifactPromote"),
      },
      {
        method: "POST",
        path: "/archive/review/promotions/list",
        requiredCapability: "archive-read",
        handler: required("executeArchivePromotionList"),
      },
      {
        method: "POST",
        path: "/archive/review/promotions/restore",
        requiredCapability: "archive-write",
        handler: required("executeArchivePromotionRestore"),
      },
    ],
  };
}
