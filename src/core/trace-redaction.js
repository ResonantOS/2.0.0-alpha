// Stable ESM entry point; classic content scripts use the same core directly.
import './trace-redaction-core.js';

const api = globalThis.__RESONANTOS_TRACE_REDACTION__;
if (!api || api.version !== 1 || !Object.isFrozen(api) ||
    typeof api.redactTraceText !== 'function' || typeof api.redactTraceValue !== 'function') {
  throw new Error('Incompatible ResonantOS trace redaction API');
}

export const redactTraceText = api.redactTraceText;
export const redactTraceValue = api.redactTraceValue;
