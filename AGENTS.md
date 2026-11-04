# @nestos/vfsdriver-local

Node.js 本地文件系统存储后端 — 实现 path-based `IStorageBackend`。

**构建**: tsup → CJS + ESM + `.d.ts`

## 架构

```
IStorageBackend  ← LocalFSBackend
    ├── fs/                   原生文件系统操作(IFsOps → NodeFsOps):文件内容
    └── db/                   SQLite sidecar(<sidecarDir>/index.db):元数据/标签/SeqFile 记录
```

## 目录结构

```
src/
├── index.ts                 公共 API 导出
├── localfs-backend.ts       LocalFSBackend (IStorageBackend 实现)
├── db/
│   ├── schema.ts            DDL + SCHEMA_VERSION (meta_ext, meta_tags, records)
│   ├── sidecar-interface.ts ISidecarDb 接口 + MetaExtRow
│   ├── sidecar.ts           BetterSqliteSidecarDb (better-sqlite3 实现)
│   ├── sidecar-stats.ts     SIDECAR_OPERATIONS + countSidecarOperations（IPC 计量代理）
│   └── path-data.ts         子树搬迁 SQL (Node / Tauri sidecar 共用)
├── fs/
│   ├── fs-ops.ts            IFsOps 接口 (readFile/writeFile/stat/readDir/...)
│   └── node-fs-ops.ts       NodeFsOps (基于 fs/promises, writeFile 临时文件+rename 原子写)
└── utils/
    └── fs-utils.ts          路径工具函数 (ensureDir, unlinkSafe, joinPath 等)
```

## 关键 API

```ts
// 创建/打开
import { openLocalFSBackend } from '@nestos/vfsdriver-local';
const backend = await openLocalFSBackend({ rootDir: '/path/to/vfs', sidecarDir: '/path/to/vfs/.meta' });

// 健康检查
const result = await backend.verify();   // { healthy, dirsExist, dbHealthy, orphanMetaExt, orphanMetaTags, ... }
await backend.repair(result);            // 清理孤儿 meta 行,返回 { fixedMetaExt, fixedMetaTags }

// Sidecar 逻辑调用计量:`ioStats` 不包含此通道；一次方法可能发出多条 SQL IPC，不能直接当作 IPC 总数
backend.sidecarStats;      // Readonly<Record<SidecarOperation, number>>（全量键,冻结快照）
backend.resetSidecarStats();
// SIDECAR_OPERATIONS / countSidecarOperations 由包入口导出;transaction 回调内的语句也被计数
```

## 与其他后端的区别

| 后端 | 平台 | 元数据存储 | 内容存储 |
|---|---|---|---|
| `vfsdriver-indexeddb` | 浏览器 | IndexedDB | IndexedDB |
| `vfsdriver-local` | Node | SQLite sidecar | 原生文件系统 |
| `vfs-core MemoryBackend` | Node/Browser | 内存 | 内存 |

## 编码约定

- 实现 `IStorageBackend` 全部方法(path-based)。
- `write` 使用临时文件 + rename 保证原子性;临时名必须**每次写唯一**（Node 使用 UUID 并以 wx 独占创建；Rust 使用序号候选并以 create_new 独占创建）——否则同一路径的并发写会共用临时文件、第二个 rename 报 `ENOENT`(桌面 Rust `fs_write_file` 同样要唯一,且不能改真实扩展名)。回归:`25-journal-probe.test.ts`「survives concurrent writes to the same path」。
- 元数据(metadata, tags, icon)写入 SQLite sidecar,不与文件内容耦合。
- `init()` 仅在完整性检查明确报告损坏，或原生 SQLite 返回 SQLITE_CORRUPT/SQLITE_NOTADB 时重建；探针不可用、未知/空结果和普通关闭错误不能授权删除数据库，须保留原文件并抛出原初始化错误。
- **重命名恢复与只读快照**：写事务仍在操作前核对并恢复 rename journal。普通读通过必需的 `ISidecarDb.readTransaction` 使用 `BEGIN` 快照，不预留 SQLite 写锁；快照内读取 `intent` 与 `next-rename`，提交后重新核对。出现 intent 时进入写事务恢复；版本变化（包括读取失败期间发生的重命名）重新读取，最多四次，持续变化报 `EBUSY/NAMESPACE_CHANGED`。不得以进程内“曾经干净”跳过跨进程核对。
- **连接归属**：同一 SQLite 连接的读写事务继续通过同一个队列排他使用，防止读取混入未提交写入；跨连接 WAL 读快照可与写事务并行。记录事务内的 scoped 句柄复用已有事务，不嵌套 BEGIN。所有内置宿主实现同一只读契约，不保留读转写事务的回退。
- **sidecar 批量读取**：完整目录每批 64 项调用 `getMetaExtMany`；已知字段集合调用 `getRecordFields`；跨文件批量调用 `getRecordFieldsMany`（最多 200 条/批）。普通读在一次只读快照内完成，前后各一次原子 namespace 核对；写事务中复用原事务。宿主及路径映射必须转发这些端口，不以跨进程读缓存替代。成本回归见 `29-record-walk-cost.test.ts`，并发写锁、重命名及恢复见 `30-read-snapshot.test.ts`。
- **`statType` 供能力检查用**:VFS 的 `noLinks` 会对每个路径前缀做类型检查,`LocalFSBackend.statType` 复用同一个 `fsOps.stat` 但**不读 sidecar 元数据**——否则每个前缀都是一次 `getMetaExt` IPC。实测单次发送的 VFS stat 由 653 降到 114。语义与 `stat` 的类型同源,不要在其中加元数据。`25-journal-probe.test.ts` 守「深路径只对目标取一次元数据」。详见 [验收记录 §14](https://github.com/mushuanli/itookit/blob/v5.3/doc/minimal-system-acceptance.md)。
- **`statType` 微批处理**:`noLinks` 并发发起各前缀检查,`LocalFSBackend` 把同一事件循环 tick 的 `statType` 合并为一次 `IFsOps.statMany`(桌面 = 一次 `fs_stat_many` IPC)。**不要改成逐个 await 或逐个 `fsOps.stat`**,那会把一次发送的前缀走查从批量打回 ~900 次 IPC。回归:`25-journal-probe.test.ts`「coalesces a path-prefix walk into one batched stat call」。详见 [验收记录 §16](https://github.com/mushuanli/itookit/blob/v5.3/doc/minimal-system-acceptance.md)。
- 此包仅用于 Node/Electron 环境,依赖 `better-sqlite3` (原生模块)。

## 测试

```bash
pnpm --filter @nestos/vfsdriver-local test   # vitest run
```

目录列表按最多 64 个条目分批使用 `IFsOps.statMany`，没有批量端口时有界并发 stat；完整节点的 sidecar 元数据同批调用 `getMetaExtMany`，轻量 `fields: 'entry'` 不读元数据。Tauri Session 的 ScopedFsOps 也必须实现 statMany（按 grant 分组，经 directory_stat_many 检查每条路径），不能仅在全局 TauriFsOps 上实现。性能回归见 `25-journal-probe.test.ts` 的宽目录列表测试。

`IFsOps.readFileRange?` 提供有界宿主读取，`LocalFSBackend.read({offset,length})` 优先调用它；NodeFsOps 与 Tauri 的 ScopedFsOps 实现该端口，禁止先整块读取再截断。未实现端口的第三方驱动保留内存截断兼容路径。

## 独立仓库边界

开发 core 由 `vendor/vfs-core` 固定；独立 `pnpm test` 仅包含驱动测试。内核 IPC 集成测试归属 `libraries/durable-kernel/tests`，Node SQLite 宿主适配集成测试归属 itookit 的 `apps/cli/tests`，不反向增加驱动依赖。

## 通用宿主事务端口

`storageAccess()` 提供 rootDir、sidecarDir、身份、实际 durability 和连接绑定 transaction，复用现有 rename 恢复与串行边界。它不包含同步策略，不反向依赖 vfs-sync。Node 默认仍是 WAL/NORMAL；显式 `durability: 'full'` 使用 WAL/FULL，BEGIN IMMEDIATE 的 SQLITE_BUSY 通过有界异步重试，避免另一个连接同步等待时阻塞当前连接的文件 I/O 和提交。注入式 sidecar 可报告 durability，未报告时为 unknown。

已移除无人使用的 `ISidecarDbSync` / beginSync 旧契约；宿主统一实现 `ISidecarDb` 的只读快照与写事务。
