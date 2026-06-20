import { execa } from 'execa'

export function sanitizeBranch(branch: string): string {
  return branch.replace(/\//g, '-')
}

export function worktreeDirName(project: string, branch: string): string {
  return `${project}.${sanitizeBranch(branch)}`
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await execa('git', ['-C', repoRoot, 'rev-parse', '--verify', branch])
    return true
  } catch {
    return false
  }
}

export async function addWorktree(repoRoot: string, branch: string, dir: string): Promise<void> {
  const args = ['-C', repoRoot, 'worktree', 'add']
  if (await branchExists(repoRoot, branch)) {
    args.push(dir, branch)
  } else {
    args.push('-b', branch, dir)
  }
  await execa('git', args)
}

export async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  await execa('git', ['-C', repoRoot, 'worktree', 'remove', '--force', dir])
}
