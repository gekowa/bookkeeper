export type ServiceType = 'django' | 'fastapi' | 'vite' | 'arq' | 'celery' | 'springboot'
export type RedisIsolation = 'key_prefix' | 'db_number'

export interface ServiceConfig {
  name: string
  type: ServiceType
  port_base?: number
  command?: string
  startCommand?: string[]
  injectionMode?: 'dotEnv' | 'startupArgs'
  app?: string
  dir?: string
  envs?: Record<string, string>
  post_allocate?: string
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
  run?: RunRecord
}
export interface RunService {
  name: string
  itermSessionId?: string   // strategy === 'iterm'：iTerm session 的 unique id
  tmuxPaneId?: string       // strategy === 'tmux'：tmux pane id（如 %3），支持单服务停
  pid?: number              // strategy === 'wt' | 'win'：宿主进程 PID，stop 用 taskkill 杀树
  port?: number             // strategy === 'wt' | 'win'：该服务端口，pid 缺失时按端口兜底找进程
}
export interface RunHandle {
  strategy: 'tmux' | 'iterm' | 'wt' | 'win'   // 'print' 不记录（bk 无句柄）
  tmuxSession?: string         // strategy === 'tmux'：tmux session 名
  services: RunService[]
}
export interface RunRecord extends RunHandle {
  startedAt: string
}
