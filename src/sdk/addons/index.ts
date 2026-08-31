// Re-export shim \u2014 public SDK surface lives at packages/addon-sdk/.
// This shim keeps existing internal imports working during the soft cutover.
// See ADR-055 \u00a712.1 C12 row "Public SDK External Boundary" and ADR-056 \u00a73.
//
// Source of truth: packages/addon-sdk/src/index.ts

export * from "../../../packages/addon-sdk/src/index";
