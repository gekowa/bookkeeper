import type { ServiceType } from '../core/types.js'
import type { FrameworkAdapter } from './types.js'
import { django } from './django.js'
import { fastapi } from './fastapi.js'
import { vite } from './vite.js'

const ALL: FrameworkAdapter[] = [django, fastapi, vite]

export function adapterFor(type: ServiceType): FrameworkAdapter {
  const a = ALL.find(x => x.type === type)
  if (!a) throw new Error(`未知 service type: ${type}`)
  return a
}

export function detectType(dir: string): ServiceType | null {
  return ALL.find(a => a.detect(dir))?.type ?? null
}
