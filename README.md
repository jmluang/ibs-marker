# 肠记 · 个人 PWA

三类记录（如厕、饮食、不适）、草稿与计时、检索统计和导出。浏览器 IndexedDB 支持离线保存；云模式通过本站 Node BFF 调用同一个 Supabase Auth/Postgres，保留 RLS/版本 RPC。

**当前状态：统一后端 BFF 已在 15001 和 HTTPS 正式域名上线。** 登录、会话刷新、退出以及记录/设置同步全部走本站 API；前端无 Supabase SDK、项目地址、API key 或供应商原始 token。已在真实域名验证注册自动登录、手动登录、读写及两账号隔离，浏览器外域请求为零；测试账号和四表归属数据均已读回确认清理。所有用户仍共用原站点项目/数据库，原账号密码与健康数据未修改；关闭旧页面后重新打开正式域名登录一次，无须重新注册。

**刷新与登录恢复修复已上线：** 首页根地址及带参数刷新不再误返回跨站/路由 JSON，静态壳不再受供应商 readiness 抖动影响。已有有效 Cookie 会在受保护握手内原值升级为剩余会话期限的持久 Cookie；临时连接故障提供恢复/重试，不误报密码错误。主动退出或明确失效的旧身份不会自动解锁。已在真实 HTTPS 域名及真实 Chromium profile 关闭/重开、SW/query 离线验证；无须清除站点数据或重新注册。

**当前为用户明确允许的过渡模式：** 私有 `.env` 设置 `ALLOW_PROVIDER_PUBLIC_SIGNUP=true`，仅暂时绕过 provider 原生注册开关的启动门槛；应用服务端邀请码、Origin/请求体/限流校验、登录门禁及 RLS 不变。Supabase 原生公开注册仍未关闭，因此不能保证邀请码是创建账号的唯一入口。后续关闭原生入口后可移除此过渡配置。数据库密码、服务端 key 和管理权限不作为前端变量发布；无付费、无提交推送。

## 本轮验收

本机功能、自动化验证和审查状态见 `docs/verification.md`；尚未完成的真实云端/手机验收及已知限制见 `docs/known-limits.md`。本机可用不代表已经上线或接通跨设备。

## 本地运行

```sh
npm ci
npm run build
npm start
# 仅前端本机开发，不接云账号
VITE_APP_MODE=local npm run dev
# one-shot checks
npm test
npm run typecheck
npm run build
```

依赖/lock 已提供。`npm run dev` 是开发服务器，正式构建为 `dist/`。只有明确无云配置的开发模式保留本机辅助流程；生产构建、邀请模式及存在云配置时必须登录，缺失或不完整配置不能退回访客/本机绕过。清理站点数据、浏览器存储被回收或换设备会导致未同步的本机数据不可用，先导出备份。

## 仅 10.21.1.0/24 的内网预览

构建后运行 `npm run preview:lan`，访问 `http://10.21.1.227:5217`。精确 LAN IP 绑定并按 socket 来源限制网段，不开放公网、不改其它服务。普通 LAN HTTP 不是安全上下文；记录/计时 UUID 已做密码学随机兼容，但 PWA/SW/系统通知仍需可信 HTTPS。账号与健康资料隐私、验证及停止回滚见 `docs/lan-preview.md`。

## 共享数据库与站点初始化

- **普通用户**只填写用户名、密码和邀请码。注册、登录、会话刷新/退出及记录/设置同步全部请求本站 `/api/*`；供应商请求和原始 token 只留在后端。所有业务数据写入原有同一组表，以用户 JWT 和 `owner_id` / `auth.uid()` RLS 隔离，不为每位用户新建项目或数据库。
- **站点维护者**只需配置这一套连接：项目 URL、public key、server key 和会话加密密钥均为 `.env` 的无前缀服务端字段；`.env.local` 不再保存供应商配置。文件 Git 忽略且 `0600`，`.private/` 为忽略的 `0700` 会话目录。此次会话加密密钥已自动生成，不需普通用户提供配置。不要重新覆盖已有值或重放初始化 SQL。
- `SUPABASE_ACCESS_TOKEN` 仅供受控初始化工具使用：关闭原生公开注册和匿名注册、精确读回并取得已有服务端 key。它不是用户登录密码，也不是运行时必需项。所需项目范围、权限及授权命令见 **`docs/invite-setup.md`**；缺授权不操作云，不新建或轮换项目 key。
- 运行时只在服务器使用 `SUPABASE_SECRET_KEY` 和 `INVITE_CODE`。预期邀请码不得进入页面或构建。**绝不将 service_role、sb_secret_*、数据库密码或管理令牌放入 `VITE_`、源码或公开静态资源。** 数据库密码不用于应用登录，旧 `APP_USERNAME` / `APP_PASSWORD` 不再用于注册。
- `npm start` 使用 Node 26 启动 15001 的静态/完整 BFF 服务；`PUBLIC_ORIGIN` 指定实际站点 Origin，`SESSION_ENCRYPTION_KEY` 为 64 位 hex 服务端密钥，`SESSION_STORE_PATH` 默认 `.private/bff-sessions.enc`。缺失/不安全会话配置会拒绝启动；不要删除密钥或加密会话文件来处理普通登录错误。`/healthz` / `/readyz` 不代替真实账号和数据隔离验收。
- 接口以 **`docs/plans/backend-only-cloud.md`**、`src/domain/backendApi.ts` 为准。原有账号 UUID、密码、IndexedDB 分区及队列保留；旧前端登录态不导入，需要重新登录一次。不自动上传或合并旧数据。真实供应商与离线证据在 `../ibs-marker-verification/backend-only-cloud/`，不得把夹具当真实供应商验收。

### 云同步行为

- 先从 seq 游标拉取，再发送已登记 outbox；每资源 baseVersion 校验、递增版本与 changeId 账本原子提交。传输失败保留待同步数据；响应丢失可由同 changeId 重试或顺序日志恢复。
- 记录冲突展示本地/远端，用户选择采用远端或复制为新 UUID；正餐冲突先选择版本或明确转加餐。设置可以按当前远端版本重试本地设置，重复冲突不隐藏。
- 退出本设备先锁当前可见身份并持久记录相应 revision，再由后端 CAS 撤销会话；旧退出/旧同步不得影响新账号。账号 IndexedDB 分区和 outbox 保留，不在未登录时加载。
- 前台在线/恢复可见/手动/新编辑 debounce 可触发同步；**不承诺网页关闭后的推送、提醒或稳定后台同步**。此版本不回收墓碑/日志/账本，需监控项目真实用量。

## 浏览器回归验证

```sh
npm exec -- playwright install chromium
UI_E2E_PORT=15004 npm run e2e
UI_E2E_PORT=15004 UI_E2E_CLOUD_BOOTSTRAP=1 npm run e2e
npm exec -- playwright test --config=e2e/invite.fixture.config.ts
```

开发回归显式清空云变量，只操作合成的本机记录；门禁和邀请回归使用隔离配置/HTTP fixture，不连接真实项目。生产登录态离线回归仍需独立验收，不能用无云开发模式代替。不要拿自己的健康记录或真实账号当测试夹具。默认使用 Playwright 管理的 Chromium；如复用已有浏览器，可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。报告在 Git 忽略的 `test-results/`，或用 `IBS_EVIDENCE_DIR` 覆盖。不要占用已经运行的预览/正式服务端口。

## Free 与隐私限制

Free 并非永久在线或无限容量。Supabase 官方文档说明 Free 项目低活动约 7 天可能暂停，Free 不提供可下载的托管数据库备份；免费额度、保留期与可选区域需在实际控制台核对。这里没有配置保活请求、付费备份/PITR 或可用性保证。

官方核对入口（2026-10-20 查阅）：
- https://supabase.com/docs/guides/platform/free-project-pausing
- https://supabase.com/docs/guides/deployment/going-into-prod
- https://supabase.com/docs/guides/platform/backups

记录包含健康数据。**无应用锁、无应用层数据库加密/端到端加密**；账号分区不是共享设备隐私锁，浏览器登录凭据也存在本设备。只在信任设备使用；没有第三方分析、健康内容远程诊断日志。云托管、跨境网络与隐私要求由用户另行评估，应用不输出医疗诊断。

## 导出与备份

在设置中导出 JSON（适合独立保存完整记录/设置）或 CSV（适合查看；未知值保留标记并防公式注入）。下载含健康数据，请放入受保护的离线位置并定期验证文件可打开；清除本机副本前检查未同步数量并先导出。首版没有自动导入/恢复流程，下载成功不等于恢复已验收。

需要数据库级备份时，由项目所有者在受信终端使用官方 CLI `supabase db dump`/适当的 pg_dump 流程管理私有连接凭据；数据库密码不得放到前端，本文不自动执行真实项目命令。导出文件、云端数据和本机副本应视为不同备份层，不假定 Free 自动备份能替代用户备份。

## 隔离云代码验证

```sh
npm test -- src/test/cloud-engine.test.ts src/test/cloud-sdk-auth.test.ts
python3 supabase/tests/run-isolated.py
```

SQL 验证仅使用新建临时 `postgres:16`：无网络、无映射公网端口、tmpfs、合成测试密码，结束销毁；从不 exec 现有生产容器。权限断言用 `SET ROLE authenticated/anon`，覆盖两用户与真实并发会话；`auth.uid()` 是 GUC 夹具，不是供应商 Auth 验收。

证据：`/home/luang/ibs-marker-verification/cloud/`（RED/GREEN、typecheck、Postgres 角色断言与容器清理记录）。真实云、iPhone 安装、实际跨设备和网络仍按验证清单待办。照片、AI 分析、云定时任务、推送、应用锁、加密、自动导入均未启用。
