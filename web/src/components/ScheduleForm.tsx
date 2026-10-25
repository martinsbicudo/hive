import { useState, type FormEvent } from "react";
import { ApiError, type Schedule, type ScheduleInput, type ScheduleKind } from "../api.ts";

const KINDS: { kind: ScheduleKind; label: string }[] = [
  { kind: "daily", label: "Every day" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "interval", label: "Every few minutes" },
];

const MIN_EVERY = 15;
const MAX_EVERY = 1440;

interface Props {
  schedule: Schedule | null;
  onSave: (input: ScheduleInput) => Promise<void>;
  onCancel: () => void;
}

export function ScheduleForm({ schedule, onSave, onCancel }: Props) {
  const [kind, setKind] = useState<ScheduleKind>(schedule?.kind ?? "daily");
  const [at, setAt] = useState(schedule?.at ?? "09:00");
  const [every, setEvery] = useState(String(schedule?.everyMinutes ?? 60));
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const minutes = Number(every);
    if (kind === "interval" && !(Number.isInteger(minutes) && minutes >= MIN_EVERY && minutes <= MAX_EVERY)) {
      setError(`Use a whole number of minutes, ${MIN_EVERY} to ${MAX_EVERY}.`);
      return;
    }
    if (kind !== "interval" && !at) {
      setError("Pick a time.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ kind, at: kind === "interval" ? null : at, everyMinutes: kind === "interval" ? minutes : null, prompt: prompt.trim() });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't save the schedule.");
      setSaving(false);
    }
  };

  return (
    <form className="schedule-form" onSubmit={submit} aria-label={schedule ? "Edit schedule" : "New schedule"}>
      <div className="grid two">
        <label>
          Repeat
          <select value={kind} onChange={(event) => setKind(KINDS.find((item) => item.kind === event.target.value)?.kind ?? "daily")}>
            {KINDS.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
          </select>
        </label>
        {kind === "interval" ? (
          <label>
            Minutes between wakes
            <input type="number" min={MIN_EVERY} max={MAX_EVERY} step={1} value={every} onChange={(event) => setEvery(event.target.value)} />
          </label>
        ) : (
          <label>
            At (your local time)
            <input type="time" value={at} onChange={(event) => setAt(event.target.value)} />
          </label>
        )}
      </div>
      <label>
        What should it do when it wakes?
        <textarea rows={2} maxLength={4000} required value={prompt} placeholder="Check the inbox and summarize anything urgent." onChange={(event) => setPrompt(event.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row end">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={saving || !prompt.trim()}>{saving ? "Saving…" : schedule ? "Save" : "Add schedule"}</button>
      </div>
    </form>
  );
}
