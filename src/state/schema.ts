// src/state/schema.ts
import type { SetRecord } from '../core/types.js'
export interface StateFile {
  project_name: string
  config_fingerprint: string
  sets: Record<string, SetRecord>
}
export function emptyState(project: string): StateFile {
  return { project_name: project, config_fingerprint: '', sets: {} }
}
