import type { SessionCostAgent, SessionCostSummary } from "@omp-remote/protocol";

export type SessionCostRow = {
  agent: SessionCostAgent;
  depth: number;
};

/** Formats USD with cents for normal totals and enough sub-cent precision to preserve tiny costs. */
export function formatUsd(value: number): string {
  if (value === 0 || Object.is(value, -0)) return "$0.00";
  const absolute = Math.abs(value);
  let places = 2;
  if (absolute < 0.01) {
    places = 4;
    while (places < 15 && Math.round((absolute + Number.EPSILON) * 10 ** places) === 0) places += 1;
  }
  const factor = 10 ** places;
  const units = Math.round((absolute + Number.EPSILON) * factor);
  if (units === 0) return "$0.00";
  const rounded = units / factor;
  const sign = value < 0 ? "-" : "";
  return `${sign}$${rounded < 0.01 ? rounded.toFixed(places) : rounded.toFixed(2)}`;
}
export const formatSessionCost = formatUsd;

/** Flattens protocol cost agents into the selected root followed by its descendants. */
export function getSessionCostRows(
  summary: SessionCostSummary | undefined,
  mainSessionId: string,
): SessionCostRow[] {
  const agents = summary?.agents ?? [];
  if (agents.length === 0) return [];

  const byId = new Map(agents.map((agent) => [agent.sessionId, agent]));
  const root = byId.get(mainSessionId) ?? agents.find((agent) => agent.parentSessionId === null) ?? agents[0];
  if (!root) return [];

  const rows: SessionCostRow[] = [];
  const visited = new Set<string>();
  const append = (agent: SessionCostAgent, depth: number) => {
    if (visited.has(agent.sessionId)) return;
    visited.add(agent.sessionId);
    rows.push({ agent, depth });
    for (const child of agents) {
      if (child.parentSessionId === agent.sessionId) append(child, depth + 1);
    }
  };

  append(root, 0);
  for (const agent of agents) {
    if (!visited.has(agent.sessionId)) append(agent, agent.parentSessionId === null ? 0 : 1);
  }
  return rows;
}
