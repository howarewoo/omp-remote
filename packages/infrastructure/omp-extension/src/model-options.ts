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

type ModelRoleResolver = (role: string) => { provider: string; id: string } | undefined;

function getConfiguredRoles(resolveRole?: ModelRoleResolver): Map<string, string[]> {
  const rolesByModel = new Map<string, string[]>();
  if (!resolveRole) return rolesByModel;

  for (const role of MODEL_ROLE_ORDER) {
    const model = resolveRole(role);
    if (!model) continue;
    const key = `${model.provider}/${model.id}`;
    const roles = rolesByModel.get(key);
    if (roles) roles.push(role);
    else rolesByModel.set(key, [role]);
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
  rolesByModel: ReadonlyMap<string, readonly string[]>,
): ModelSummary[] {
  return models
    .map((model, index) => ({
      model,
      index,
      rank: rolesByModel.has(`${model.provider}/${model.id}`)
        ? MODEL_ROLE_ORDER.indexOf(rolesByModel.get(`${model.provider}/${model.id}`)?.[0] ?? "")
        : MODEL_ROLE_ORDER.length,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ model }) => model);
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
      ...(roles?.length ? { roles } : {}),
    };
  });
}

type AvailableCommand = {
  name: string;
  description?: string;
  source: string;
};

type ExtensionSkillCommand = {
  name: string;
  description?: string;
};

export function getSkillCommands(commands: readonly AvailableCommand[]): ExtensionSkillCommand[] {
  return commands
    .filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
    .map((command) => ({
      name: command.name,
      ...(command.description?.trim() ? { description: command.description.trim() } : {}),
    }));
}
