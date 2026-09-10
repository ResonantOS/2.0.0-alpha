import { readFileSync } from "node:fs";
import { validateAddOnManifest } from "../src/sdk/addons/validation.ts";

const manifest = JSON.parse(
  readFileSync("./examples/addons/addon.deepseek-harness.json", "utf8")
);
const result = validateAddOnManifest(manifest);
console.log("valid:", result.valid);
if (!result.valid) {
  console.log("issues:", JSON.stringify(result.issues, null, 2));
}
