#!/usr/bin/env node
import { prepareEmbedGovernance } from "./scripts/prepare-embed-governance.mjs";
await prepareEmbedGovernance();
await import("./browser-first/host/run-bridge-minimal.mjs");
