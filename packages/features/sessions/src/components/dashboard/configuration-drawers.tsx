import type { Effort, Session } from "@omp-remote/protocol";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
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
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
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
    if (!query) return availableModels;
    return availableModels.filter((model) =>
      [
        model.name,
        model.provider,
        model.id,
        ...(model.roles ?? []),
        ...Object.values(model.roleEfforts ?? {}),
      ].some((value) => value.toLocaleLowerCase().includes(query)),
    );
  }, [availableModels, modelQuery]);

  useLayoutEffect(() => {
    configurationSessionIdRef.current = session?.id ?? null;
    configurationRequestRef.current = null;
    setConfigurationOpen(false);
    setExpandedModel(null);
    setModelQuery("");
    setConfigurationPending(null);
    setConfigurationError(null);
  }, [session?.id]);

  const selectConfiguration = async ({
    model,
    effort,
    role,
  }: {
    model: string;
    effort?: Effort;
    role?: string;
  }) => {
    const option = availableModels.find((candidate) => `${candidate.provider}/${candidate.id}` === model);
    const canSetEffort = session?.capabilities.includes("effort") ?? false;
    const configuredRole = role !== undefined && option?.roles?.includes(role);
    if (
      !session ||
      !option ||
      configurationPending ||
      !session.capabilities.includes("model") ||
      (role !== undefined && !configuredRole) ||
      (effort !== undefined && (!canSetEffort || !option.efforts.includes(effort))) ||
      (!configuredRole && canSetEffort && option.efforts.length > 0 && effort === undefined)
    )
      return;

    const request = { sessionId: session.id };
    configurationRequestRef.current = request;
    setConfigurationPending(role ? `@${role}` : model);
    setConfigurationError(null);
    try {
      if (configuredRole) await onSetModel(session.id, `@${role}`);
      else if (session.model !== model) await onSetModel(session.id, model);
      if (effort !== undefined && session.effort !== effort) await onSetEffort(session.id, effort);
      setExpandedModel(null);
    } catch (configurationFailure) {
      if (
        configurationRequestRef.current !== request ||
        configurationSessionIdRef.current !== request.sessionId
      )
        return;
      setConfigurationError({
        message:
          configurationFailure instanceof Error
            ? configurationFailure.message
            : "The model and effort could not be changed",
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

  const handleConfigurationOpenChange = (open: boolean) => {
    if (configurationPending) return;
    setConfigurationOpen(open);
    if (!open) {
      setExpandedModel(null);
      setModelQuery("");
      setConfigurationError(null);
    }
  };

  return {
    availableModels,
    currentModelOption,
    filteredModels,
    configurationOpen,
    expandedModel,
    modelQuery,
    configurationPending,
    configurationError,
    openConfiguration: () => setConfigurationOpen(true),
    handleConfigurationOpenChange,
    onExpandedModelChange: setExpandedModel,
    onModelQueryChange: setModelQuery,
    selectConfiguration,
  };
}

interface EffortOptionsProps {
  model: ModelOption;
  session: Session;
  pending: string | null;
  onSelect(model: string, effort?: Effort): void;
}

function EffortOptions({ model, session, pending, onSelect }: EffortOptionsProps) {
  const value = `${model.provider}/${model.id}`;
  if (!session.capabilities.includes("effort") || model.efforts.length === 0) {
    return (
      <Button
        className="model-use-option"
        type="button"
        variant="outline"
        disabled={pending !== null}
        onClick={() => onSelect(value)}
      >
        Use model
      </Button>
    );
  }

  return (
    <fieldset className="effort-options" aria-label={`Effort for ${model.name}`}>
      {model.efforts.map((effort) => {
        const selected = value === session.model && effort === session.effort;
        return (
          <Button
            className={cn("effort-option", selected && "selected")}
            type="button"
            variant="outline"
            aria-pressed={selected}
            disabled={pending !== null}
            onClick={() => onSelect(value, effort)}
            key={effort}
          >
            {formatEffortLabel(effort)}
          </Button>
        );
      })}
    </fieldset>
  );
}

export interface ModelConfigurationDrawerProps {
  open: boolean;
  mobile: boolean;
  session: Session | null;
  availableModels: readonly ModelOption[];
  filteredModels: readonly ModelOption[];
  expandedModel: string | null;
  modelQuery: string;
  pending: string | null;
  error: ConfigurationError | null;
  onOpenChange(open: boolean): void;
  onExpandedModelChange(model: string | null): void;
  onModelQueryChange(query: string): void;
  onSelectRole(model: string, role: string): void;
  onSelectModel(model: string, effort?: Effort): void;
}

export function ModelConfigurationDrawer({
  open,
  mobile,
  session,
  availableModels,
  filteredModels,
  expandedModel,
  modelQuery,
  pending,
  error,
  onOpenChange,
  onExpandedModelChange,
  onModelQueryChange,
  onSelectRole,
  onSelectModel,
}: ModelConfigurationDrawerProps) {
  const roleModels = availableModels.filter((model) => (model.roles?.length ?? 0) > 0);
  const adHocModels = filteredModels.filter((model) => (model.roles?.length ?? 0) === 0);
  const roleCount = roleModels.reduce((count, model) => count + (model.roles?.length ?? 0), 0);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} {...getResponsiveDrawerProps(mobile)}>
      <DrawerContent className="model-settings-sheet">
        <DrawerHeader className="model-settings-header">
          <div>
            <DrawerTitle>Model and effort</DrawerTitle>
            <DrawerDescription>Choose a configured role or set a model and effort ad hoc.</DrawerDescription>
          </div>
          <DrawerClose
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close model and effort settings"
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
              {roleModels.length > 0 ? (
                <section className="model-settings-section" aria-labelledby="configured-role-heading">
                  <div className="model-settings-section-heading">
                    <h3 id="configured-role-heading">Configured roles</h3>
                    <span>{roleCount} configured</span>
                  </div>
                  <div className="role-option-list">
                    {roleModels.flatMap((model) =>
                      (model.roles ?? []).map((role) => (
                        <Button
                          className="role-option"
                          type="button"
                          variant="ghost"
                          disabled={pending !== null}
                          onClick={() => onSelectRole(`${model.provider}/${model.id}`, role)}
                          key={`${role}:${model.provider}/${model.id}`}
                        >
                          <span className="role-option-name">@{role}</span>
                          <span className="role-option-model">
                            <strong>{model.name}</strong>
                            <small>{`${model.provider}/${model.id}`}</small>
                          </span>
                          <span className="role-option-effort">
                            {model.roleEfforts?.[role]
                              ? formatEffortLabel(model.roleEfforts[role])
                              : "Restart session"}
                          </span>
                        </Button>
                      )),
                    )}
                  </div>
                </section>
              ) : null}
              <section className="model-settings-section" aria-labelledby="ad-hoc-model-heading">
                <div className="model-settings-section-heading">
                  <h3 id="ad-hoc-model-heading">Ad hoc model</h3>
                  <span>{availableModels.length - roleModels.length} available</span>
                </div>
                {availableModels.length > 8 ? (
                  <label className="model-search-field" htmlFor="model-settings-search">
                    <span className="sr-only">Search ad hoc models</span>
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
                <div className="model-option-list">
                  {adHocModels.map((model) => {
                    const value = `${model.provider}/${model.id}`;
                    const expandable = session.capabilities.includes("effort") && model.efforts.length > 0;
                    const selected = value === session.model;
                    if (!expandable) {
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
                            <small>{value}</small>
                          </span>
                          <span className="selection-indicator" aria-hidden="true" />
                        </Button>
                      );
                    }
                    return (
                      <Collapsible
                        className="model-option-disclosure"
                        open={expandedModel === value}
                        onOpenChange={(expanded) => onExpandedModelChange(expanded ? value : null)}
                        key={value}
                      >
                        <CollapsibleTrigger
                          render={
                            <Button
                              className={cn("model-option", selected && "selected")}
                              type="button"
                              variant="ghost"
                              disabled={pending !== null}
                            />
                          }
                        >
                          <span>
                            <strong>{model.name}</strong>
                            <small>{value}</small>
                          </span>
                          <DashboardIcon name={expandedModel === value ? "down" : "up"} />
                        </CollapsibleTrigger>
                        <CollapsibleContent className="model-effort-dropdown">
                          <span>Choose effort</span>
                          {EffortOptions({
                            model,
                            session,
                            pending,
                            onSelect: onSelectModel,
                          })}
                        </CollapsibleContent>
                      </Collapsible>
                    );
                  })}
                  {adHocModels.length === 0 ? (
                    <p className="model-settings-empty">
                      {modelQuery.trim()
                        ? `No ad hoc models match “${modelQuery.trim()}”.`
                        : "No ad hoc models available."}
                    </p>
                  ) : null}
                </div>
              </section>
            </>
          ) : (
            <p className="model-settings-empty model-settings-unavailable">
              {session?.source !== "history"
                ? "Restart this session with the latest extension to change its model and effort."
                : "Resume this session to load its available models and effort levels."}
            </p>
          )}
          {error ? (
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
