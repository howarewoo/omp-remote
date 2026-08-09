export type TodoTaskState = "pending" | "in-progress" | "completed" | "blocked" | "dropped";

export type TodoTask = {
  label: string;
  state: TodoTaskState;
  reason?: string;
};

export type TodoPhase = {
  name: string;
  state: TodoTaskState;
  tasks: TodoTask[];
};

export type TodoOverallProgress = {
  done: number;
  total: number;
  open?: number;
  blocked?: number;
};

export type TodoActivePhase = {
  index: number;
  total: number;
  name: string;
  done: number;
  taskTotal: number;
};

export type TodoResult = {
  overall: TodoOverallProgress;
  activePhase?: TodoActivePhase;
  phases: TodoPhase[];
};

function getTodoPhaseState(tasks: TodoTask[]): TodoTaskState {
  if (tasks.every((task) => task.state === "dropped")) return "dropped";
  if (tasks.every((task) => task.state === "completed" || task.state === "dropped")) return "completed";
  if (tasks.some((task) => task.state === "in-progress")) return "in-progress";
  if (tasks.some((task) => task.state === "blocked")) return "blocked";
  return "pending";
}

export function parseTodoResult(text: string): TodoResult | null {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0);
  const overallPattern = /^Overall: (\d+)\/(\d+) done(?:, (\d+) open)?(?:, (\d+) blocked)?\.$/;
  const overallIndex = lines.findIndex((line) => overallPattern.test(line));
  if (overallIndex === -1) return null;
  for (let preambleIndex = 0; preambleIndex < overallIndex; preambleIndex += 1) {
    if (lines[preambleIndex]?.startsWith("Errors:")) return null;
  }
  const overallLine = lines[overallIndex];
  if (overallLine === undefined) return null;
  const overallMatch = overallPattern.exec(overallLine);
  if (!overallMatch) return null;
  const doneText = overallMatch?.[1];
  const totalText = overallMatch?.[2];
  if (doneText === undefined || totalText === undefined) return null;

  const done = Number(doneText);
  const total = Number(totalText);
  const open = overallMatch[3] === undefined ? undefined : Number(overallMatch[3]);
  const blocked = overallMatch[4] === undefined ? undefined : Number(overallMatch[4]);
  if (
    !Number.isSafeInteger(done) ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    (open !== undefined && !Number.isSafeInteger(open)) ||
    (blocked !== undefined && !Number.isSafeInteger(blocked)) ||
    done > total ||
    ((open !== undefined || blocked !== undefined) && done + (open ?? 0) + (blocked ?? 0) !== total)
  ) {
    return null;
  }

  let lineIndex = overallIndex + 1;
  let activePhase: TodoResult["activePhase"];
  const activeMatch = /^Active phase (\d+)\/(\d+) "([^"\n]+)" \((\d+)\/(\d+)\)(?:\.| — .+)$/.exec(
    lines[lineIndex] ?? "",
  );
  if (activeMatch) {
    const indexText = activeMatch[1];
    const totalText = activeMatch[2];
    const name = activeMatch[3];
    const doneText = activeMatch[4];
    const taskTotalText = activeMatch[5];
    if (
      indexText === undefined ||
      totalText === undefined ||
      name === undefined ||
      doneText === undefined ||
      taskTotalText === undefined
    ) {
      return null;
    }
    const parsedActivePhase: TodoActivePhase = {
      index: Number(indexText),
      total: Number(totalText),
      name,
      done: Number(doneText),
      taskTotal: Number(taskTotalText),
    };
    if (
      !Number.isSafeInteger(parsedActivePhase.index) ||
      !Number.isSafeInteger(parsedActivePhase.total) ||
      !Number.isSafeInteger(parsedActivePhase.done) ||
      !Number.isSafeInteger(parsedActivePhase.taskTotal) ||
      parsedActivePhase.index < 1 ||
      parsedActivePhase.index > parsedActivePhase.total ||
      parsedActivePhase.taskTotal < 1 ||
      parsedActivePhase.done > parsedActivePhase.taskTotal ||
      parsedActivePhase.name.trim() !== parsedActivePhase.name
    ) {
      return null;
    }
    activePhase = parsedActivePhase;
    lineIndex += 1;
  }

  const phases: TodoPhase[] = [];
  let currentPhase: TodoPhase | undefined;
  for (; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined) return null;
    const phaseMatch = /^ {2}([^:\n]+):$/.exec(line);
    const phaseName = phaseMatch?.[1];
    if (phaseName !== undefined) {
      if (phaseName.trim() !== phaseName) return null;
      currentPhase = { name: phaseName, state: "pending", tasks: [] };
      phases.push(currentPhase);
      continue;
    }

    const taskMatch =
      /^ {4}- \[([ xX])\] (.+?)(?: \((pending|in progress|completed|blocked|dropped)(?:: ([^)]+))?\))?$/.exec(
        line,
      );
    const checkbox = taskMatch?.[1];
    const label = taskMatch?.[2];
    const stateText = taskMatch?.[3];
    const reason = taskMatch?.[4];
    if (
      !taskMatch ||
      !currentPhase ||
      checkbox === undefined ||
      label === undefined ||
      label.trim() !== label ||
      (reason !== undefined && (stateText !== "blocked" || reason.trim() !== reason))
    ) {
      return null;
    }

    const checked = checkbox.toLowerCase() === "x";
    const explicitState: TodoTaskState | undefined =
      stateText === "in progress"
        ? "in-progress"
        : stateText === "pending" ||
            stateText === "completed" ||
            stateText === "blocked" ||
            stateText === "dropped"
          ? stateText
          : undefined;
    if (
      (checked && explicitState !== undefined && explicitState !== "completed") ||
      (!checked && explicitState === "completed")
    ) {
      return null;
    }
    currentPhase.tasks.push({
      label,
      state: explicitState ?? (checked ? "completed" : "pending"),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  if (phases.length === 0 || phases.some((phase) => phase.tasks.length === 0)) return null;
  let parsedTaskCount = 0;
  let parsedDoneCount = 0;
  let parsedOpenCount = 0;
  let parsedBlockedCount = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      parsedTaskCount += 1;
      if (task.state === "completed" || task.state === "dropped") parsedDoneCount += 1;
      else if (task.state === "blocked") parsedBlockedCount += 1;
      else parsedOpenCount += 1;
    }
  }
  if (
    parsedTaskCount !== total ||
    parsedDoneCount !== done ||
    parsedOpenCount !== (open ?? 0) ||
    parsedBlockedCount !== (blocked ?? 0)
  ) {
    return null;
  }

  for (const phase of phases) phase.state = getTodoPhaseState(phase.tasks);
  if (activePhase) {
    const phase = phases[activePhase.index - 1];
    if (phase === undefined) return null;
    let activeDoneCount = 0;
    for (const task of phase.tasks) {
      if (task.state === "completed" || task.state === "dropped") activeDoneCount += 1;
    }
    if (
      activePhase.total !== phases.length ||
      phase.name !== activePhase.name ||
      phase.tasks.length !== activePhase.taskTotal ||
      activeDoneCount !== activePhase.done
    ) {
      return null;
    }
  } else if (done !== total) {
    return null;
  }

  return {
    overall: {
      done,
      total,
      ...(open === undefined ? {} : { open }),
      ...(blocked === undefined ? {} : { blocked }),
    },
    ...(activePhase ? { activePhase } : {}),
    phases,
  };
}
