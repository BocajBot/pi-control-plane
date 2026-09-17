/** Durable, workspace-scoped storage for the task list. */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type TodoState, validateTodoState } from "./todo.ts";

export interface TodoStoreRead {
  todo: TodoState | null;
  malformed: boolean;
}

export function todoStateDirectory(): string {
  const override = process.env.PI_CONTROL_PLANE_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  const agentDirectory = process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDirectory) return path.join(path.resolve(agentDirectory), "state", "control-plane");
  const piHome = process.env.PI_HARNESS_HOME?.trim() || path.join(os.homedir(), ".pi");
  return path.join(piHome, "agent", "state", "control-plane");
}

export function todoStatePath(workspace: string, stateDirectory = todoStateDirectory()): string {
  const key = createHash("sha256").update(path.resolve(workspace)).digest("hex");
  return path.join(stateDirectory, "todos", `${key}.json`);
}

export function readWorkspaceTodo(workspace: string): TodoStoreRead {
  const file = todoStatePath(workspace);
  try {
    const todo = validateTodoState(JSON.parse(fs.readFileSync(file, "utf8")));
    return { todo, malformed: todo === null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { todo: null, malformed: false };
    return { todo: null, malformed: true };
  }
}

/** Atomic replace prevents a crash from leaving partial JSON. */
export function writeWorkspaceTodo(workspace: string, todo: TodoState): string | null {
  const file = todoStatePath(workspace);
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify(todo)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
    return null;
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {}
    return String(error);
  }
}

export function newerTodo(first: TodoState | null, second: TodoState | null): TodoState | null {
  if (first === null) return second;
  if (second === null) return first;
  const firstTime = Date.parse(first.updatedAt);
  const secondTime = Date.parse(second.updatedAt);
  if (!Number.isFinite(firstTime)) return second;
  if (!Number.isFinite(secondTime)) return first;
  return secondTime > firstTime ? second : first;
}
