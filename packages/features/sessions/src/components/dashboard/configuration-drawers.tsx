import { type Effort, type Session } from "@omp-remote/protocol";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button.js";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  getResponsiveDrawerProps,
} from "../ui/drawer.js";
import { Input } from "../ui/input.js";
import { cn } from "../ui/utils.js";
import { DashboardIcon } from "./icon.js";
import { formatEffortLabel } from "./session-metadata.js";

type ModelOption = NonNullable<Session["availableModels"]>[number];

const EMPTY_MODEL_OPTIONS: NonNullable<Session["availableModels"]> = [];

export interface ConfigurationError {
  drawer: "model" | "effort";
  message: string;
}

export function useConfigurationController({
  session,
  onSetModel,
  onSetEffort,
}: {
  session: Session | null;
  onSetModel(sessionId: string, model: string): Promise<void>;
  onSetEffort(sessionId: string, effort: Effort): Promise<void>;
}) {
  const [configurationDrawer, setConfigurationDrawer] = useState<"model" | "effort" | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [configurationPending, setConfigurationPending] = useState<string | null>(null);
  const [configurationError, setConfigurationError] = useState<ConfigurationError | null>(null);
  const configurationRequestRef = useRef<{ sessionId: string } | null>(null);
  const configurationSessionIdRef = useRef<string | null>(null);

  const availableModels = session?.availableModels ?? EMPTY_MODEL_OPTIONS;
  const currentModelOption = availableModels.find(
    (model) => `${model.provider}/${model.id}` === session?.model,
  );
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    const matchingModels = query
      ? availableModels.filter((model) =>
          [model.name, model.provider, model.id, ...(model.roles ?? [])].some((value) =>
            value.toLocaleLowerCase().includes(query),
          ),
        )
      : availableModels;
    return matchingModels
      .map((model, index) => ({ model, index }))
      .sort(
        (a, b) =>
          Number((b.model.roles?.length ?? 0) > 0) - Number((a.model.roles?.length ?? 0) > 0) ||
          a.index - b.index,
      )
      .map(({ model }) => model);
  }, [availableModels, modelQuery]);
  const availableEfforts = currentModelOption?.efforts ?? [];

  useLayoutEffect(() => {
    configurationSessionIdRef.current = session?.id ?? null;
    configurationRequestRef.current = null;
    setConfigurationDrawer(null);
    setModelQuery("");
    setConfigurationPending(null);
    setConfigurationError(null);
  }, [session?.id]);

  const selectModel = async (model: string) => {
    if (
      !session ||
      configurationPending ||
      !session.capabilities.includes("model") ||
      !availableModels.some((option) => `${option.provider}/${option.id}` === model)
    )
      return;
    const request = { sessionId: session.id };
    configurationRequestRef.current = request;
    setConfigurationPending(model);
    setConfigurationError(null);
    try {
      await onSetModel(session.id, model);
    } catch (configurationFailure) {
      if (
        configurationRequestRef.current !== request ||
        configurationSessionIdRef.current !== request.sessionId
      )
        return;
      setConfigurationError({
        drawer: "model",
        message:
          configurationFailure instanceof Error
            ? configurationFailure.message
            : "The model could not be changed",
      });
    } finally {
      if (
        configurationRequestRef.current === request &&
        configurationSessionIdRef.current === request.sessionId
      ) {
        configurationRequestRef.current = null;
        setConfigurationPending(null);
      }
    }
  };

  const selectEffort = async (effort: Effort) => {
    if (
      !session ||
      configurationPending ||
      !session.capabilities.includes("effort") ||
      !currentModelOption?.efforts.includes(effort)
    )
      return;
    const request = { sessionId: session.id };
    configurationRequestRef.current = request;
    setConfigurationPending(effort);
    setConfigurationError(null);
    try {
      await onSetEffort(session.id, effort);
    } catch (configurationFailure) {
      if (
        configurationRequestRef.current !== request ||
        configurationSessionIdRef.current !== request.sessionId
      )
        return;
      setConfigurationError({
        drawer: "effort",
        message:
          configurationFailure instanceof Error
            ? configurationFailure.message
            : "The effort could not be changed",
      });
    } finally {
      if (
        configurationRequestRef.current === request &&
        configurationSessionIdRef.current === request.sessionId
      ) {
        configurationRequestRef.current = null;
        setConfigurationPending(null);
      }
    }
  };

  const handleModelConfigurationOpenChange = (open: boolean) => {
    if (configurationPending) return;
    setConfigurationDrawer(open ? "model" : null);
    if (!open) {
      setModelQuery("");
      setConfigurationError(null);
    }
  };

  const handleEffortConfigurationOpenChange = (open: boolean) => {
    if (configurationPending) return;
    setConfigurationDrawer(open ? "effort" : null);
    if (!open) setConfigurationError(null);
  };

  return {
    availableModels,
    currentModelOption,
    filteredModels,
    availableEfforts,
    configurationDrawer,
    modelQuery,
    configurationPending,
    configurationError,
    openModelConfiguration: () => setConfigurationDrawer("model"),
    openEffortConfiguration: () => setConfigurationDrawer("effort"),
    handleModelConfigurationOpenChange,
    handleEffortConfigurationOpenChange,
    onModelQueryChange: setModelQuery,
    selectModel,
    selectEffort,
  };
}

export interface ModelConfigurationDrawerProps {
  open: boolean;
  mobile: boolean;
  session: Session | null;
  availableModels: readonly ModelOption[];
  filteredModels: readonly ModelOption[];
  modelQuery: string;
  pending: string | null;
  error: ConfigurationError | null;
  onOpenChange(open: boolean): void;
  onModelQueryChange(query: string): void;
  onSelectModel(model: string): void;
}

export function ModelConfigurationDrawer({
  open,
  mobile,
  session,
  availableModels,
  filteredModels,
  modelQuery,
  pending,
  error,
  onOpenChange,
  onModelQueryChange,
  onSelectModel,
}: ModelConfigurationDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} {...getResponsiveDrawerProps(mobile)}>
      <DrawerContent className="model-settings-sheet">
        <DrawerHeader className="model-settings-header">
          <div>
            <DrawerTitle>Model</DrawerTitle>
            <DrawerDescription>Choose the model for this session.</DrawerDescription>
          </div>
          <DrawerClose
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close model settings"
                disabled={pending !== null}
              />
            }
          >
            <DashboardIcon name="close" />
          </DrawerClose>
        </DrawerHeader>
        <div className="model-settings-body" aria-busy={pending !== null}>
          {session?.capabilities.includes("model") && availableModels.length > 0 ? (
            <>
              {availableModels.length > 8 ? (
                <label className="model-search-field" htmlFor="model-settings-search">
                  <span className="sr-only">Search models</span>
                  <DashboardIcon name="search" />
                  <Input
                    id="model-settings-search"
                    value={modelQuery}
                    onChange={(event) => onModelQueryChange(event.target.value)}
                    placeholder="Search models"
                    autoComplete="off"
                  />
                </label>
              ) : null}
              <section className="model-settings-section" aria-labelledby="model-settings-model-heading">
                <div className="model-settings-section-heading">
                  <h3 id="model-settings-model-heading">Model</h3>
                  <span>{availableModels.length} available</span>
                </div>
                <div className="model-option-list">
                  {filteredModels.map((model) => {
                    const value = `${model.provider}/${model.id}`;
                    const roles = model.roles ?? [];
                    const selected = value === session.model;
                    return (
                      <Button
                        className={cn("model-option", selected && "selected")}
                        type="button"
                        variant="ghost"
                        aria-pressed={selected}
                        disabled={pending !== null}
                        onClick={() => onSelectModel(value)}
                        key={value}
                      >
                        <span>
                          <strong>{model.name}</strong>
                          {roles.length > 0 ? (
                            <small className="model-option-roles">
                              Configured roles: {roles.join(" · ")}
                            </small>
                          ) : null}
                          <small>{value}</small>
                        </span>
                        <span className="selection-indicator" aria-hidden="true" />
                      </Button>
                    );
                  })}
                  {filteredModels.length === 0 ? (
                    <p className="model-settings-empty">No models match “{modelQuery.trim()}”.</p>
                  ) : null}
                </div>
              </section>
            </>
          ) : (
            <p className="model-settings-empty model-settings-unavailable">
              {session?.source !== "history"
                ? "Restart this session with the latest extension to change its model."
                : "Resume this session to load its available models."}
            </p>
          )}
          {error?.drawer === "model" ? (
            <p className="inline-error model-settings-error" role="alert">
              {error.message}
            </p>
          ) : null}
        </div>
        <DrawerFooter className="model-settings-footer">
          <DrawerClose
            render={
              <Button type="button" disabled={pending !== null}>
                Done
              </Button>
            }
          />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

export interface EffortConfigurationDrawerProps {
  open: boolean;
  mobile: boolean;
  session: Session | null;
  model: ModelOption | undefined;
  availableEfforts: readonly Effort[];
  pending: string | null;
  error: ConfigurationError | null;
  onOpenChange(open: boolean): void;
  onSelectEffort(effort: Effort): void;
}

export function EffortConfigurationDrawer({
  open,
  mobile,
  session,
  model,
  availableEfforts,
  pending,
  error,
  onOpenChange,
  onSelectEffort,
}: EffortConfigurationDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} {...getResponsiveDrawerProps(mobile)}>
      <DrawerContent className="model-settings-sheet">
        <DrawerHeader className="model-settings-header">
          <div>
            <DrawerTitle>Effort</DrawerTitle>
            <DrawerDescription>
              Choose the reasoning effort for {model?.name ?? "this session"}.
            </DrawerDescription>
          </div>
          <DrawerClose
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close effort settings"
                disabled={pending !== null}
              />
            }
          >
            <DashboardIcon name="close" />
          </DrawerClose>
        </DrawerHeader>
        <div className="model-settings-body" aria-busy={pending !== null}>
          {session?.capabilities.includes("effort") && model && availableEfforts.length > 0 ? (
            <section className="model-settings-section" aria-labelledby="model-settings-effort-heading">
              <div className="model-settings-section-heading">
                <h3 id="model-settings-effort-heading">Effort</h3>
                <span>{model.name}</span>
              </div>
              <div className="effort-options">
                {availableEfforts.map((effort) => (
                  <Button
                    className={cn("effort-option", effort === session.effort && "selected")}
                    type="button"
                    variant="outline"
                    aria-pressed={effort === session.effort}
                    disabled={pending !== null}
                    onClick={() => onSelectEffort(effort)}
                    key={effort}
                  >
                    {formatEffortLabel(effort)}
                  </Button>
                ))}
              </div>
            </section>
          ) : (
            <p className="model-settings-empty model-settings-unavailable">
              {session?.capabilities.includes("effort") && model && availableEfforts.length === 0
                ? "This model does not expose adjustable effort."
                : session?.source !== "history"
                  ? "Restart this session with the latest extension to change its effort."
                  : "Resume this session to load its available effort choices."}
            </p>
          )}
          {error?.drawer === "effort" ? (
            <p className="inline-error model-settings-error" role="alert">
              {error.message}
            </p>
          ) : null}
        </div>
        <DrawerFooter className="model-settings-footer">
          <DrawerClose
            render={
              <Button type="button" disabled={pending !== null}>
                Done
              </Button>
            }
          />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
