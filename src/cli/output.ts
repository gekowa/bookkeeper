// src/cli/output.ts
import { confirm as inquirerConfirm } from '@inquirer/prompts'
export const info = (m: string) => console.error(`  ${m}`)
export const warn = (m: string) => console.error(`⚠ ${m}`)
export const error = (m: string) => console.error(`✖ ${m}`)
export const success = (m: string) => console.log(`✓ ${m}`)
export const plain = (m: string) => console.log(m)
export async function confirm(message: string): Promise<boolean> {
  return inquirerConfirm({ message, default: false })
}
