const DEFAULT_CONSENT_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_ONE_TIME_CONSENT_TTL_MS = 1000 * 60 * 60;

export function taskClassForGoal(goal = "") {
  const text = String(goal ?? "").toLowerCase();
  if (/\b(book|booking|appointment|slot|calendar|reservation)\b/.test(text)) return "booking";
  if (/\b(amazon|cart|shop|shopping|product|price|buy)\b/.test(text)) return "shopping";
  if (/\b(news|research|find|search|look up|web)\b/.test(text)) return "research";
  if (/\b(form|field|fill|write|draft|edit)\b/.test(text)) return "form-edit";
  if (/\b(open|go to|navigate|visit)\b/.test(text)) return "navigation";
  return "general";
}

export function taskConsentKey({ siteKey, taskClass }) {
  return [siteKey, taskClass].filter(Boolean).join("::");
}

export function normalizeTaskConsent(consent, { now = Date.now } = {}) {
  const grantedAt = Number(consent?.grantedAt ?? now());
  const expiresAt = Number(consent?.expiresAt ?? grantedAt + DEFAULT_CONSENT_TTL_MS);
  const mode = consent?.mode === "deny"
    ? "deny"
    : consent?.mode === "allow-once"
      ? "allow-once"
      : "allow-safe";
  return {
    siteKey: String(consent?.siteKey ?? ""),
    taskClass: String(consent?.taskClass ?? "general"),
    mode,
    grantedAt,
    expiresAt,
    reason: String(consent?.reason ?? "Trusted safe task class").slice(0, 240),
    source: String(consent?.source ?? "human").slice(0, 80),
    sessionOnly: Boolean(consent?.sessionOnly || mode === "allow-once"),
    usesRemaining: mode === "allow-once" ? Math.max(0, Number(consent?.usesRemaining ?? 1)) : null
  };
}

export function createTaskConsentStore({
  storage,
  taskConsentAuditStorageKey = "augmentorTaskConsentAudit",
  taskConsentStorageKey,
  now = Date.now,
  ttlMs = DEFAULT_CONSENT_TTL_MS
}) {
  const oneTimeConsents = new Map();

  const activeOneTimeConsents = () => {
    const current = now();
    for (const [key, consent] of oneTimeConsents.entries()) {
      if (consent.expiresAt <= current || consent.usesRemaining <= 0) {
        oneTimeConsents.delete(key);
      }
    }
    return Object.fromEntries(oneTimeConsents.entries());
  };

  const persistedTaskConsents = async () => {
    const result = await storage?.get?.(taskConsentStorageKey).catch(() => ({}));
    const raw = result?.[taskConsentStorageKey] ?? {};
    return Object.fromEntries(
      Object.entries(raw)
        .map(([key, consent]) => [key, normalizeTaskConsent(consent, { now })])
        .filter(([, consent]) => consent.siteKey && consent.expiresAt > now())
    );
  };

  const taskConsents = async () => ({
    ...(await persistedTaskConsents()),
    ...activeOneTimeConsents()
  });

  const taskConsentAudit = async () => {
    const result = await storage?.get?.(taskConsentAuditStorageKey).catch(() => ({}));
    return result?.[taskConsentAuditStorageKey] ?? {};
  };

  const appendAudit = async ({ siteKey, taskClass, action, mode = "", reason = "", source = "human" }) => {
    if (!siteKey || !taskClass) return null;
    const key = taskConsentKey({ siteKey, taskClass });
    const audit = await taskConsentAudit();
    const entry = {
      action,
      at: now(),
      key,
      mode,
      reason: String(reason || action).slice(0, 240),
      siteKey,
      source: String(source || "human").slice(0, 80),
      taskClass
    };
    audit[key] = [entry, ...(audit[key] ?? [])].slice(0, 20);
    await storage?.set?.({ [taskConsentAuditStorageKey]: audit });
    return entry;
  };

  const consentFor = async ({ siteKey, goal, taskClass = taskClassForGoal(goal) }) => {
    if (!siteKey) return null;
    const key = taskConsentKey({ siteKey, taskClass });
    const oneTime = activeOneTimeConsents()[key] ?? null;
    if (oneTime) return oneTime;
    const consents = await persistedTaskConsents();
    return consents[key] ?? null;
  };

  const setTaskConsent = async ({ siteKey, goal, taskClass = taskClassForGoal(goal), mode = "allow-safe", reason = "Trusted safe task class", source = "human" }) => {
    if (!siteKey) throw new Error("No site is active.");
    const grantedAt = now();
    if (mode === "allow-once") {
      const expiresAt = grantedAt + Math.min(ttlMs, DEFAULT_ONE_TIME_CONSENT_TTL_MS);
      const consent = normalizeTaskConsent({
        siteKey,
        taskClass,
        mode,
        reason,
        source,
        grantedAt,
        expiresAt,
        sessionOnly: true,
        usesRemaining: 1
      }, { now });
      oneTimeConsents.set(taskConsentKey(consent), consent);
      await appendAudit({ siteKey, taskClass, action: "set-once", mode: consent.mode, reason, source });
      return consent;
    }
    const consents = await persistedTaskConsents();
    const consent = normalizeTaskConsent({
      siteKey,
      taskClass,
      mode,
      reason,
      source,
      grantedAt,
      expiresAt: grantedAt + ttlMs
    }, { now });
    consents[taskConsentKey(consent)] = consent;
    await storage?.set?.({ [taskConsentStorageKey]: consents });
    await appendAudit({ siteKey, taskClass, action: "set", mode: consent.mode, reason, source });
    return consent;
  };

  const revokeTaskConsent = async ({ siteKey, goal, taskClass = taskClassForGoal(goal), reason = "Task consent revoked", source = "human" }) => {
    if (!siteKey) return false;
    const consents = await persistedTaskConsents();
    const key = taskConsentKey({ siteKey, taskClass });
    const existed = Boolean(consents[key] || oneTimeConsents.has(key));
    delete consents[key];
    oneTimeConsents.delete(key);
    await storage?.set?.({ [taskConsentStorageKey]: consents });
    if (existed) {
      await appendAudit({ siteKey, taskClass, action: "revoke", mode: "revoked", reason, source });
    }
    return existed;
  };

  const consumeTaskConsent = async ({ siteKey, goal, taskClass = taskClassForGoal(goal), reason = "One-time task consent used", source = "agent-control" }) => {
    if (!siteKey) return null;
    const key = taskConsentKey({ siteKey, taskClass });
    const consent = activeOneTimeConsents()[key] ?? null;
    if (!consent) return null;
    const consumed = {
      ...consent,
      usesRemaining: Math.max(0, Number(consent.usesRemaining ?? 1) - 1)
    };
    if (consumed.usesRemaining <= 0) {
      oneTimeConsents.delete(key);
    } else {
      oneTimeConsents.set(key, consumed);
    }
    await appendAudit({ siteKey, taskClass, action: "consume-once", mode: "allow-once", reason, source });
    return consumed;
  };

  return {
    consumeTaskConsent,
    consentFor,
    revokeTaskConsent,
    setTaskConsent,
    taskClassForGoal,
    taskConsentAudit,
    taskConsents
  };
}
