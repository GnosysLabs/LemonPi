import { Brain, CaretDown } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import type { PiModel, PiSessionState, PiSessionStats, ThinkingLevel } from "../lib/pi-types";

export function SessionControls({
  state,
  stats,
  connected,
  models,
  thinkingLevels,
  onSelectModel,
  onSelectThinking,
}: {
  state?: PiSessionState;
  stats?: PiSessionStats;
  connected: boolean;
  models: PiModel[];
  thinkingLevels: ThinkingLevel[];
  onSelectModel: (model: PiModel) => void;
  onSelectThinking: (level: ThinkingLevel) => void;
}) {
  const contextPercent = stats?.contextUsage?.percent;
  const modelValue = (model: PiModel) => JSON.stringify([model.provider, model.id]);
  const currentModelValue = state?.model ? modelValue(state.model) : "";
  const currentModelIsAvailable = models.some((model) => modelValue(model) === currentModelValue);
  const modelsByProvider = models.reduce<Record<string, PiModel[]>>((groups, model) => {
    (groups[model.provider] ??= []).push(model);
    return groups;
  }, {});

  return (
    <div className="session-controls" aria-label="Session controls">
      <label className="instrument instrument--select" title="Select model" aria-disabled={!connected || models.length === 0}>
        <span className="sr-only">Model</span>
        <span className="instrument--select__value">{state?.model?.name ?? state?.model?.id ?? "Model"}</span>
        <select
          aria-label="Model"
          value={currentModelValue}
          disabled={!connected || models.length === 0}
          onChange={(event) => {
            const selected = models.find((model) => modelValue(model) === event.target.value);
            if (selected) onSelectModel(selected);
          }}
        >
          {!currentModelIsAvailable && (
            <option value={currentModelValue}>{state?.model?.name ?? state?.model?.id ?? "Model"}</option>
          )}
          {Object.entries(modelsByProvider).map(([provider, providerModels]) => (
            <optgroup key={provider} label={provider}>
              {providerModels.map((model) => (
                <option key={`${model.provider}/${model.id}`} value={modelValue(model)}>
                  {model.name ?? model.id}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <CaretDown size={11} weight="bold" />
      </label>

      <label className="instrument instrument--select instrument--thinking" title="Select reasoning level" aria-disabled={!connected || thinkingLevels.length === 0}>
        <Brain size={13} weight="light" />
        <span className="sr-only">Reasoning level</span>
        <span className="instrument--select__value">{state?.thinkingLevel ?? "off"}</span>
        <select
          aria-label="Reasoning level"
          value={state?.thinkingLevel ?? "off"}
          disabled={!connected || thinkingLevels.length === 0}
          onChange={(event) => onSelectThinking(event.target.value as ThinkingLevel)}
        >
          {thinkingLevels.length === 0 && <option value={state?.thinkingLevel ?? "off"}>{state?.thinkingLevel ?? "off"}</option>}
          {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
        <CaretDown size={11} weight="bold" />
      </label>

      <span className="instrument instrument--static" title="Context window usage">
        <span className="context-ring" style={{ "--progress": `${contextPercent ?? 0}%` } as CSSProperties} />
        <span>{contextPercent == null ? "—" : `${Math.round(contextPercent)}%`}</span>
      </span>
    </div>
  );
}
