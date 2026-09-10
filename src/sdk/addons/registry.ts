// Re-export shim — public SDK surface lives at packages/addon-sdk/.
// This shim keeps existing internal imports working during the soft cutover.
// See ADR-055 §12.1 C12 row "Public SDK External Boundary" and ADR-056 §3.
//
// Source of truth: packages/addon-sdk/src/registry.ts

export * from "../../../packages/addon-sdk/src/registry";
