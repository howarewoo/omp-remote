import type { ComposerCommand, RoleEffort } from "@omp-remote/protocol";
const MODEL_ROLE_ORDER = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "designer",
  "commit",
  "tiny",
  "task",
  "advisor",
];

type ConfiguredRole = { name: string; effort: RoleEffort };
type ModelRoleResolver = (role: string) => { provider: string; id: string; effort: RoleEffort } | undefined;

function getConfiguredRoles(resolveRole?: ModelRoleResolver): Map<string, ConfiguredRole[]> {
  const rolesByModel = new Map<string, ConfiguredRole[]>();
  if (!resolveRole) return rolesByModel;

  for (const role of MODEL_ROLE_ORDER) {
    const assignment = resolveRole(role);
    if (!assignment) continue;
    const key = `${assignment.provider}/${assignment.id}`;
    const roles = rolesByModel.get(key);
    const configuredRole = { name: role, effort: assignment.effort };
    if (roles) roles.push(configuredRole);
    else rolesByModel.set(key, [configuredRole]);
  }
  return rolesByModel;
}

type ModelSummary = {
  provider: string;
  id: string;
  name: string;
  thinking?: { efforts: readonly Exclude<EffortName, "off">[]; requiresEffort?: boolean };
};

type EffortName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function sortConfiguredRoleModels(
  models: readonly ModelSummary[],
  rolesByModel: ReadonlyMap<string, readonly ConfiguredRole[]>,
): ModelSummary[] {
  return models
    .map((model, index) => ({
      model,
      index,
      rank: rolesByModel.has(`${model.provider}/${model.id}`)
        ? MODEL_ROLE_ORDER.indexOf(rolesByModel.get(`${model.provider}/${model.id}`)?.[0]?.name ?? "")
        : MODEL_ROLE_ORDER.length,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ model }) => model);
}

const ROLE_EFFORT_PATTERN = /:(off|minimal|low|medium|high|xhigh|max|auto|inherit)$/;
const ROLE_ALIAS_PATTERN = /^(?:@|pi\/)([^:]+)$/;

export function getConfiguredRoleEffort(
  role: string,
  getRoleSelector: (role: string) => string | undefined,
): RoleEffort {
  const visited = new Set<string>();
  let selector = getRoleSelector(role)?.trim();
  while (selector && !visited.has(selector)) {
    visited.add(selector);
    const effort = ROLE_EFFORT_PATTERN.exec(selector)?.[1];
    if (effort) return effort as RoleEffort;

    const alias = ROLE_ALIAS_PATTERN.exec(selector)?.[1];
    if (!alias) break;
    selector = getRoleSelector(alias)?.trim();
  }
  return "inherit";
}

export function getSessionModelOptions(models: readonly ModelSummary[], resolveRole?: ModelRoleResolver) {
  const rolesByModel = getConfiguredRoles(resolveRole);
  return sortConfiguredRoleModels(models, rolesByModel).map((model) => {
    const roles = rolesByModel.get(`${model.provider}/${model.id}`);
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      efforts: model.thinking
        ? [...(model.thinking.requiresEffort ? [] : (["off"] as const)), ...model.thinking.efforts]
        : [],
      ...(roles?.length
        ? {
            roles: roles.map((role) => role.name),
            roleEfforts: Object.fromEntries(roles.map((role) => [role.name, role.effort])),
          }
        : {}),
    };
  });
}

type AvailableCommand = {
  name: unknown;
  description?: unknown;
  source: unknown;
};

export function getComposerCommands(commands: readonly AvailableCommand[]): ComposerCommand[] {
  const composerCommands: ComposerCommand[] = [];
  for (const command of commands) {
    const validName =
      (command.source === "skill" &&
        typeof command.name === "string" &&
        /^skill:[^\s]+$/.test(command.name)) ||
      (command.source === "builtin" && command.name === "btw");
    if (!validName) continue;

    if (command.description === undefined) {
      composerCommands.push({ name: command.name as string });
      continue;
    }
    if (typeof command.description !== "string") continue;
    const description = command.description.trim();
    if (!description) continue;
    composerCommands.push({ name: command.name as string, description });
  }
  return composerCommands;
}
