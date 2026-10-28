# Cloud implementation contract

## BFF 启动与身份边界

`bootstrapCloud` / `CloudController` 保留主入口；以 `src/main.tsx` 的已接线方式传递 `privateMode`、`authenticated` 与 `CloudPanel`。测试注入同源 fetch、Web Locks 和非凭据身份缓存，不模拟生产后端。

- 默认是后端账号模式；仅开发/测试显式 `VITE_APP_MODE=local` 且非生产可进入 local。缺网络/会话不能静默降级为访客。
- 浏览器不导入供应商 SDK，不读取或持有供应商项目 URL、API key、access/refresh token。生产构建边界由 `build/backendBoundary.ts` 强制检查；Vite 不加载 env 文件且仅接受 `VITE_APP_`。
- 唯一 cookie-bootstrap 在完整跨标签 Web Lock 内执行。会话/prepare/login/logout/同步的冻结协议见 `docs/plans/backend-only-cloud.md` 和 `src/domain/backendApi.ts`；普通 session 不补发 cookie，认证变更使用 authRevision CAS，数据 transport 捕获固定 revision。
- 后端使用真实供应商 Auth；用户数据继续用该用户 JWT 和 RLS，管理员密钥仅服务端注册用途。浏览器只持 HttpOnly/Secure/Strict 不透明 SID，供应商 token 在服务端 AES-GCM 私有文件持久化。
- `getSnapshot()/subscribe()` 暴露 configuration/mode/displayName/error/busy；mode 为 checking/login/cloud/local。初始化和身份分区水合均有 epoch fence；不导入旧 provider token，不清除健康数据或自动合并其他用户队列。
- 退出/取消/已失效身份锁定先停同步并隐藏本地分区，持久锁绑定捕获的 revision；迟到操作不得撤销新身份。离线缓存只用于先前确认过的同用户壳，不是服务端授权；待同步记录保留。
- Online/visible/manual actions sync. New non-conflicted edits schedule a 600ms debounce; retries are not an infinite timer. Hidden/closed pages have no stable sync/push guarantee. `dispose` removes listeners/debounce/requests.

## Sync wire protocol

`tracker_changes`: SELECT `seq,resource,change_id`, filter `seq > cursor`, ascending `seq`, limit 100. Owner filtering is RLS, not a caller owner parameter. `seq` is bigint but must remain a JS safe integer; invalid/nonmonotonic values fail without cursor advancement. Each page is applied with `applyPull(token, resources, cursor)` atomically. Historic snapshots, estimatedTime and tombstones are preserved. The log carries committed changeId so lost RPC responses can be ACKed from the owned log without falsely declaring a conflict; the ACK itself is transactional, and replay after an interrupted cursor commit is safe.

RPC `tracker_apply_change` arguments:

```ts
{p_change_id: UUID, p_kind:'entry'|'settings', p_resource_id:UUID|'settings',
 p_base_version:number, p_snapshot:Entry|Settings, p_tombstone:boolean}
// Response, for both fresh and identical-idempotent requests:
{status:'applied'|'conflict', remote:{kind,resourceId,version,snapshot,tombstone}}
```

There is deliberately **no owner argument**. Identity comes only from `auth.uid()`. Same owner + changeId + structurally equal JSONB input returns the original result, including original conflicts; changing any input with an existing ID raises `22023`. Different JSON key order compares equal; array order remains meaningful. Conflict resolution creates a new changeId. `baseVersion=0` on a missing row inserts version 1; a per-owner transaction advisory lock serializes even missing-row races. Version mismatch returns a retained remote snapshot and never writes the resource/log. Writes, log and private result ledger commit in one transaction. SQLSTATE 23505 for a separate same-day meal resource preserves outbox and prompts explicit choice/snack editing; it is not silently reclassified as a successful write.

The engine registers sent operations with `pendingOperations(token)` (never sends raw snapshot.outbox), guards all awaits with identity token and abort signal, ACKs exact changeId/version/remote, retains later edits and skips resources with visible conflicts. Network failure retains the queue; auth/permission failure clears visible identity rather than changing to local. No background subscription service or third-party health-data diagnostic logging exists.

## Conflict UI

Both snapshots are opt-in expandable health-data views. `remote`, `copy-local` (fresh explicit UUID), and settings `retry-settings` invoke the existing store API. Settings retry reads current transactional settings; another conflict remains visible. Main-meal copies require explicitly choosing conversion to snack or adopting the remote version; never alter the meal silently. Stale conflict resolutions remain errors and preserve new queued edits.

## Database and validation boundary

Migration: `supabase/migrations/202610200001_tracker.sql`. Only authenticated SELECT on records/settings/log is granted; RLS limits every read to current owner. Anonymous gets no table/RPC access. Ordinary client writes, sequence access and private ledger reads are revoked. RPC has fixed search_path, explicitly scoped owner queries, payload/UUID/version/tombstone validation, and execute only for authenticated. Tombstones, ledger and full log are intentionally not pruned in v1.

Local actual SQL verification: `python3 supabase/tests/run-isolated.py`. It only runs its newly created `postgres:16` container, `--network none`, tmpfs PGDATA, no published ports, synthetic password, and destroys it in finally. `fixture.sql` simulates auth.users/auth.uid via GUC **only for role/RLS/RPC tests**, not real Supabase Auth/JWT verification. Real two-session races run as authenticated. Evidence is under `/home/luang/ibs-marker-verification/cloud`.

**验收状态：**原共享项目/迁移/RLS 已实际配置验证。BFF 候选版本已在隔离的真实生产 Node + 真实供应商上验证注册/登录、记录与设置读写、重启会话、两账号隔离、冷 SW 离线队列及退出；浏览器外域请求为零，合成账号与四表归属数据清理已读回。证据位于 `../ibs-marker-verification/backend-only-cloud/`。最终线上发布与用户设备/跨设备网络验收仍须分别确认，不得用夹具或 NAS 浏览器结果冒充用户设备结果。供应商原生公开注册仍按用户决定暂缓关闭，既有显式过渡模式不代表邀请码是供应商唯一入口。
