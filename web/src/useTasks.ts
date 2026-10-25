import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Task, type TaskEvent, type TaskStatus } from "./api.ts";
import { withStatus } from "./tasks.ts";

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

export function useTasks(tick: number) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.tasks().then(
      (loaded) => current && setTasks(loaded),
      (caught: unknown) => current && setError(messageOf(caught, "Couldn't load tasks.")),
    );
    return () => {
      current = false;
    };
  }, [tick]);

  const move = useCallback(
    async (id: string, status: TaskStatus) => {
      const before = tasks;
      setTasks(withStatus(before, id, status));
      setError(null);
      try {
        await api.updateTask(id, { status });
      } catch (caught) {
        setTasks(before);
        setError(messageOf(caught, "Couldn't move the task."));
      }
    },
    [tasks],
  );

  return { tasks, error, move, setError };
}

export function useThread(taskId: string, tick: number) {
  const [data, setData] = useState<{ task: Task; events: TaskEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.task(taskId).then(
      (loaded) => current && setData(loaded),
      (caught: unknown) => current && setError(messageOf(caught, "Couldn't load the task.")),
    );
    return () => {
      current = false;
    };
  }, [taskId, tick]);

  return { data, error };
}

export { messageOf };
