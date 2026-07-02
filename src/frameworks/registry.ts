import type { ServiceType, ServiceConfig } from '../core/types.js'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'
import { django } from './django.js'
import { fastapi } from './fastapi.js'
import { vite } from './vite.js'
import { arq } from './arq.js'
import { celery } from './celery.js'
import { springboot } from './springboot.js'

const ALL: FrameworkAdapter[] = [django, fastapi, vite, arq, celery, springboot]

export function adapterFor(type: ServiceType): FrameworkAdapter {
  const a = ALL.find(x => x.type === type)
  if (!a) throw new BkError(Codes.CONFIG_INVALID, '未知 service type: ' + type)
  return a
}

export function detectType(dir: string): ServiceType | null {
  return ALL.find(a => a.detect(dir))?.type ?? null
}

export function injectionModeFor(svc: ServiceConfig): 'dotEnv' | 'startupArgs' {
  return svc.injectionMode ?? adapterFor(svc.type).defaultInjectionMode
}
