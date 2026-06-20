import { execaSync } from 'execa'
export function hasDocker(): boolean {
  try { execaSync('docker', ['info']); return true } catch { return false }
}
