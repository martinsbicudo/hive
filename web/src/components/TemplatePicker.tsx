import { useEffect, useState } from "react";
import { api, ApiError, previewAvatarUrl, type AgentTemplate } from "../api.ts";
import { connectorNames } from "../connectors.ts";
import { describeSchedule } from "../wake.ts";

interface Props {
  onPick: (template: AgentTemplate) => void;
}

export function TemplatePicker({ onPick }: Props) {
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.templates().then(setTemplates, (caught: unknown) => setError(caught instanceof ApiError ? caught.message : "Hive didn't answer."));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!templates) return <p className="muted">Loading templates…</p>;
  return (
    <ul className="templates" aria-label="Templates">
      {templates.map((template) => (
        <li key={template.name}>
          <button type="button" className="template" onClick={() => onPick(template)}>
            <img className="avatar lg" src={previewAvatarUrl(template.avatar.style, template.avatar.seed)} alt="" />
            <span>
              <strong>{template.name}</strong>
              <span className="hint">
                {template.computer === "virtual" ? "Virtual computer" : "Your Mac"}
                {template.connectors.length > 0 && ` · Connectors: ${connectorNames(template.connectors)}`}
                {template.schedules.map((schedule) => ` · ${describeSchedule(schedule.kind, schedule.at, schedule.everyMinutes)}`).join("")}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
