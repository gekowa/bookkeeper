export type ServiceType = 'django' | 'fastapi' | 'vite' | 'arq' | 'celery'
export type RedisIsolation = 'key_prefix' | 'db_number'

export interface ServiceConfig {
  name: string
  type: ServiceType
  port_base?: number
  command?: string
  app?: string
  dir?: string
  envs?: Record<string, string>
}
export interface InfraConfig {
  postgres?: { host: string; port: number; username: string; password: string }
  redis?: { host: string; port: number; isolation?: RedisIsolation }
  minio?: { endpoint: string; access_key: string; secret_key: string }
}
export interface ProjectConfig {
  project_name: string
  services: ServiceConfig[]
  infra: InfraConfig
  allocation?: { max_probe_attempts?: number }
}
export interface Ctx {
  config: ProjectConfig
  projectRoot: string   // main 仓库根（含 bk_config.yml）
}
export interface ResourceNames {
  ports: Record<string, number>      // serviceName -> port
  database?: string
  redisPrefix?: string
  redisDb?: number
  bucket?: string
}
export interface SetRecord {
  status: 'allocated' | 'free'
  owner: { worktree: string; branch: string } | null
  resources: {
    [service: string]: { port: number } | undefined
  } & {
    postgres?: { database: string }
    redis?: { prefix?: string; db?: number }
    minio?: { bucket: string }
  }
  created_at: string
}
