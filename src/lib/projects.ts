import { bridge, isTauri, type ProjectRow } from "./bridge.js";
import type { Project } from "../core/types.js";

/**
 * Project repository. Uses the Rust/SQLite store in the desktop app and
 * `localStorage` in the browser fallback, so the UI works either way while all
 * real user data stays on the machine.
 */

const STORAGE_KEY = "motion-studio:projects";
const SCHEMA_VERSION = 1;

interface StorageShape {
  version: number;
  projects: Project[];
}

function readLocal(): Project[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StorageShape;
    if (parsed.version !== SCHEMA_VERSION) return [];
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
}

function writeLocal(projects: Project[]): void {
  if (typeof localStorage === "undefined") return;
  const shape: StorageShape = { version: SCHEMA_VERSION, projects };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
}

function parseRow(row: ProjectRow): Project | null {
  try {
    return JSON.parse(row.data) as Project;
  } catch {
    return null;
  }
}

export async function loadProjects(): Promise<Project[]> {
  if (isTauri()) {
    const rows = await bridge.listProjects();
    return rows.map(parseRow).filter((p): p is Project => p !== null);
  }
  return readLocal().sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function persistProject(project: Project): Promise<void> {
  if (isTauri()) {
    await bridge.saveProject(project);
    return;
  }
  const projects = readLocal().filter((p) => p.id !== project.id);
  projects.push(project);
  writeLocal(projects);
}

export async function removeProject(id: string): Promise<void> {
  if (isTauri()) {
    await bridge.deleteProject(id);
    return;
  }
  writeLocal(readLocal().filter((p) => p.id !== id));
}
