# BookKeeper

Bookkeeper是一个CLI工具，用于管理并行运行多个工作树所需的资源和基础设施。

### 心智模型
回想没有AI的时候。你雇佣了一个新的开发人员，你给他分配了一台电脑，他在电脑上安装了开发环境（即开发工具包、数据库、Redis、MinIO等），这些基础设施在某种程度上变得稳定，只要开发人员仍在这个项目上工作，它们就会被安装并停留一段时间；即使他被分配到另一个项目，只要数据库选型相同，他不必安装新的数据库软件，他只需要设置一个新的数据库并创建数据表即可开始工作。
### 要解决的问题
傳統上，開發B/S架構專案（即FastAPI + Vue 3），需要先搭建基础设施（如数据库、Redis等），并啟動至少 2-3 項服務才可以進行手動E2E測試，对于微服务项目可能更多。您需要設定基礎設施，如資料庫、記憶體儲存、塊儲存等。我们之前在本机开发项目时，通常会认为，为了E2E测试所启动的服务都是临时性的，而不受重视，因为只会启动一套且并不会处理资源冲突问题。
当使用人工智能编程时，事情会变得复杂，因为你总是需要人工智能在同一台计算机上同时处理多个任务。对于代码隔离，我们已经有一个完美的解决方案：git worktree，但对于本地资源和基础设施分配问题，还需要再做更多的努力才能运行。
### 应对具体问题
#### 端口
一个典型的B/S系统至少需要2个端口才能启动，一个用于后端，一个用于前端。BookKeeper可以帮你记住哪个worktree对应的是哪套端口，并无感的正确注入到项目的配置文件中。
#### 数据库
数据库用名称前缀+数字或哈希
（假设有创建数据库的权限，以本地Docker运行的数据库。）
#### Redis
方法1：# of DB
方法2：Key前缀
#### MinIO
桶名称

### 注入配置
TBD


### 如何使用
#### 安装
`$ npm -g install bookkeepper`

```
$ bk

Outputs help message
```

#### 准备与配置
通过 bk_config.yml  定义项目配置
```YAML
---
project_name: foo
port_allocation_method: inc1  # also support random mode
services:
  - backend:
	  type: django # also support fastapi, springboot
      port_base: 10000
  - frontend
      type: Vite
      port_base: 10100
infra:
  - postgres:
      host:
      port:
      username:
      password:

  - redis:
      host:
      port:
      username:
      password:

  - minio:
      host:
      port:
      username:
      password:
        
  
```

用`bk init` 可以自动侦测当前项目情况，来自动生成`bk_config.yml`

#### 使用
在main分支目录下创建worktree，并为创建完的worktree注入配置（默认worktree会与main分支代码同级目录）
```
bk worktree create <worktree_dir> <worktree_branch>
```

用启动项目
```
$ bk start
```

观测，列出符合当前项目的所有resource和infra，以及已经分配的worktree和未分配的resource
```
$ bk list

Project Name: foo
Worktree: [DIR]
  - backend 10001
  - frontend 10101
  - PostgreSQL database: foo_1
  - MinIO bucket: foo_1
  - Redis key prefix: foo_1_
Worktree: [DIR]
  No resource allocated.

Unallocated resources:
Set 3:
  - backend 10003
  - frontend 10103
  - PostgreSQL database: foo_1
  - MinIO bucket: foo_1
  - Redis key prefix: foo_1_
```

为worktree分配基础设施，在worktree目录下执行
```
$ bk allocate 2

Project Name: foo
Worktree: ~/Workspace/baz_dir/worktree_bar
  - backend 10001
  - frontend 10101
  - PostgreSQL database: foo_1
  - MinIO bucket: foo_1
  - Redis key prefix: foo_1_
```

```
$ bk deallocate
```


删除worktree
```
$ bk worktree delete
```

销毁resource
```
$ bk destroy 3
```


