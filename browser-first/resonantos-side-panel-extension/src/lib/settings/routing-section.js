import { noteCard, safeErrorMessage, setStatus, settingsHeader } from "./settings-common.js";

const costLabels = {
  "best-available-in-emergency": "Best available in emergency",
  "local-free": "Local/free",
  "low-cost-first": "Low cost first",
  "paid-per-call": "Paid per call",
  "quality-first": "Quality first",
  "responsive-subscription": "Responsive subscription",
  "subscription": "Subscription",
  "subscription-first": "Subscription first"
};

function label(value) {
  return costLabels[value] ?? String(value ?? "unknown").replace(/[-_]/g, " ");
}

function modelBadge(route) {
  const badge = document.createElement("span");
  badge.className = "settings-route-badge";
  badge.dataset.state = route?.state ?? "unavailable";
  badge.textContent = route
    ? `${route.label} · ${route.providerLabel} · ${label(route.costTier)} · ${route.state}`
    : "No route";
  return badge;
}

function option(value, text, selected) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = text;
  node.selected = selected;
  return node;
}

function routingCard({ strategy, models, bridgeRequest, getBridgeRequest, statusNode, reload }) {
  // `bridge` is a lazy getter so we always invoke the latest bridgeRequest
  // closure (handles rebind during the late-bound hydrate in main-workspace).
  // The caller (renderRoutingSection) may pass either bridgeRequest (older
  // call sites) or getBridgeRequest (newer ones); we honor both.
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const card = document.createElement("article");
  card.className = "settings-routing-card";
  card.dataset.state = strategy.routeState;

  const heading = document.createElement("div");
  heading.className = "settings-provider-heading";
  const title = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = strategy.label;
  const workload = document.createElement("p");
  workload.textContent = `${strategy.workload} · ${strategy.hardStop ? "hard-stop if unavailable" : "fallback allowed"}`;
  title.append(name, workload);
  const state = document.createElement("span");
  state.textContent = strategy.routeState === "routable" ? "Routable" : "Unavailable";
  heading.append(title, state);

  const chain = document.createElement("div");
  chain.className = "settings-route-chain";
  chain.append(modelBadge(strategy.primary));
  for (const fallback of strategy.fallbackChain ?? []) {
    chain.append(modelBadge(fallback));
  }

  const notes = document.createElement("p");
  notes.className = "settings-model-list";
  notes.textContent = strategy.notes;

  const form = document.createElement("form");
  form.className = "settings-routing-form";
  const primary = document.createElement("select");
  primary.name = "primaryModel";
  primary.setAttribute("aria-label", `${strategy.label} primary model`);
  for (const model of models) {
    primary.append(option(model.model, `${model.label} · ${model.providerLabel} · ${label(model.costTier)}`, model.model === strategy.primaryModel));
  }
  const fallback = document.createElement("input");
  fallback.name = "fallbackModels";
  fallback.placeholder = "Fallback models, comma separated";
  fallback.value = (strategy.fallbackModels ?? []).join(", ");
  fallback.setAttribute("aria-label", `${strategy.label} fallback models`);
  const cost = document.createElement("select");
  cost.name = "costPosture";
  cost.setAttribute("aria-label", `${strategy.label} cost posture`);
  for (const value of ["subscription-first", "responsive-subscription", "low-cost-first", "quality-first", "best-available-in-emergency"]) {
    cost.append(option(value, label(value), value === strategy.costPosture));
  }
  const hardStop = document.createElement("label");
  hardStop.className = "settings-routing-check";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.name = "hardStop";
  checkbox.checked = Boolean(strategy.hardStop);
  hardStop.append(checkbox, document.createTextNode(" Hard-stop"));
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save Strategy";
  form.append(primary, fallback, cost, hardStop, save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    setStatus(statusNode, `Saving ${strategy.label} routing strategy...`);
    try {
      await bridge()("/providers/routing-strategies", {
        method: "POST",
        capability: "provider-routing-write",
        body: {
          strategyId: strategy.id,
          primaryModel: primary.value,
          fallbackModels: fallback.value.split(",").map((item) => item.trim()).filter(Boolean),
          costPosture: cost.value,
          hardStop: checkbox.checked
        }
      });
      await reload();
      setStatus(statusNode, `${strategy.label} routing strategy saved.`, "success");
    } catch (error) {
      setStatus(statusNode, `Save failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      save.disabled = false;
    }
  });

  card.append(heading, chain, notes, form);
  return card;
}

export function renderRoutingSection(container, { bridgeRequest, getBridgeRequest }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const statusNode = document.createElement("p");
  statusNode.className = "settings-status";
  statusNode.textContent = "Loading routing strategies...";
  const grid = document.createElement("div");
  grid.className = "settings-routing-grid";

  container.replaceChildren(
    settingsHeader({
      eyebrow: "Cost and routing strategy",
      title: "Provider Fabric Routing",
      body: "Choose which model class handles each workload. ResonantOS keeps routing centralized, so add-ons declare needs while the system applies the user-approved cost and fallback strategy."
    }),
    statusNode,
    grid,
    noteCard({
      title: "Cost rule",
      body: "The best model is not always the right model. Strategies should prefer subscription or local capacity for routine work, reserve paid high-reasoning models for high-value tasks, and hard-stop when quality-sensitive memory work cannot meet policy."
    })
  );

  const load = async () => {
    const result = await bridge()("/providers/routing-strategies", { method: "GET" });
    const models = Array.isArray(result.models) ? result.models : [];
    const strategies = Array.isArray(result.strategies) ? result.strategies : [];
    grid.replaceChildren(...strategies.map((strategy) => routingCard({
      strategy,
      models,
      bridgeRequest,
      getBridgeRequest,
      statusNode,
      reload: load
    })));
    const routable = strategies.filter((strategy) => strategy.routeState === "routable").length;
    setStatus(statusNode, strategies.length
      ? `${routable}/${strategies.length} routing strategies currently have at least one available route.`
      : "No routing strategies are registered.",
      strategies.length && routable === strategies.length ? "success" : "warning");
  };

  void load().catch((error) => {
    setStatus(statusNode, `Routing strategies unavailable: ${safeErrorMessage(error)}`, "error");
  });
}
