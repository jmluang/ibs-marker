# 如厕计时时长修正 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. 本计划必须先经父代理独立 plan review PASS；本轮仅调查和写计划，不实施。

**Goal:** 已保存的如厕记录及结束计时后尚未保存的表单，都能修正用时，且不污染原计时精度、发生时间或其他活动计时。

**Architecture:** 复用现有 `durationSource` 和 `estimatedDurationMinutes`：未实际修改保留原来源；实际修正为手动估时，保留原 clock metadata。以可选 Draft UI 意图明确区分手动修正和旧调用默认值，并为首次 finalize 增补资源 CAS；保留编辑 ID、identity fence、草稿和事务，不增加数据库字段。

**Tech Stack:** React 19 / TypeScript / IndexedDB / node-only Vitest / 已安装 Playwright Chromium；Vite 隔离 fixture 与 native Node synthetic-provider fixture。

---

## 0. 证据、根因与运行边界

调查基线：`/home/luang/ibs-marker`，HEAD `9b7ad8c6a49e8dd9489877267b96585a31ba2069`；调查前 `git status --short` 空。根 dist manifest buildId 实读为 `mvl8cz7a`；不将 checkout 源码等同于已运行进程的内存版本。

根因（该基线精确行号）：
- `src/components/EntryForm.tsx:417–422`：`timer || e.durationSource === "timer"` 时仅显示 `<p>`，不渲染分钟输入或修改入口；`423–459` 的估时输入只有非计时来源可达。因此已保存计时记录编辑与 timer-form 都无法修改用时。
- `src/state/TrackerStore.ts:289–305`：`finalizeTimer` 不仅用当前 timer 重绑 `startedAt/endedAt`，还在 `301–302` 无条件重写来源为 timer、估时值为 null。只改 UI 会导致首次计时保存丢失修正。
- `src/App.tsx:185–197`：timer-form 初始值使用 timer ID、start/end，`occurredAt=startedAt`，来源 timer；`EntryForm.tsx:157–165` 会优先恢复同 key 草稿，故必须保留该恢复优先级，不能由 App 每次 render 重置修正。
- `src/App.tsx:300–329`：忘关时可填实际结束时间，但只在尚未结束时显示；`TrackerStore.ts:264–274` 已结束后不再重写 endedAt。这不能解决结束后的修正需求。

读取链路：
- 类型：`src/domain/types.ts:24–33`，仅三种来源，无独立“修正”字段。
- 验证：`src/domain/helpers.ts:55–77`；`server/syncValidation.ts:88–115,143` 复用同一验证，允许 estimated/unknown 同时保留有效 start/end；只要求 endedAt 不早于 startedAt。
- 有效时长唯一入口：`helpers.ts:142–147`，estimated 优先估时值，timer 才取时间差，unknown 返回 null。统计 `158–160`、`src/pages/stats/statsPresentation.ts:124–134` 已调用它。
- Timeline `src/components/ui.tsx:150–151` 目前直接拼估时字段，timer 只写“计时时长已记录”；应统一通过 duration helper 获取值，不另算时间差。
- JSON `helpers.ts:233–234`、CSV `245–279` 导出原字段，不包含独立有效 duration 列。保留导出格式；修正后必须导出 estimated+修正值及原 start/end，重新按 helper 解释只能得到修正值，不能把原巨大时间差当有效时长。
- 普通编辑 `EntryForm.tsx:213–215` 用 `saveEntry`，timer-form 才 finalize。普通编辑 `TrackerStore.ts:195–201` 有资源级 revision CAS，`120–142` 有 identity/事务 fence；草稿 `233–241` 只增加 namespace revision，不改变 editRevision。

运行安全实查：PID `956818`，cwd 为本 checkout，entrypoint `scripts/start-server.mjs`，未见 Node --watch/loader/import 标志；该进程 mountinfo 无 checkout 子挂载，运行 Docker 的相关 bind mount 查询为空。`scripts/start-server.mjs:65` 指向根 dist，`server/app.ts:160–201,285` 在启动时读取静态快照。当前未发现源码热更新/bind-mounted checkout；禁止重启、覆盖根 dist。实施前重复安全 cmd/cwd/mount 检查；如新发现 watch/热更新/bind，先向父代理报告并规划隔离 worktree，不操作正式进程。

未读取 AGENTS/.env/.private/真实用户记录/凭据，未调用正式健康或云接口；本轮不运行测试、不生成 build。

## 1. 冻结语义与最小 UI

1. 计时来源仍显示原有效时长（显示可格式化，数据不得 toFixed/四舍五入写回），旁边一个清晰的“修改用时”按钮。展开共用“用时（分钟）”输入；不增加层级标题、不要求手机用户寻找隐藏菜单。打开、聚焦、返回或仅改备注都不修改来源/值。
2. 输入有效非负数且与当前有效分钟数不同，写 `durationSource=estimated`、对应精确数值；保留 start/end 作为原计时 metadata。有效相同数值不触发 timer→estimated。实际修正后即使再输入原数值也仍为手动来源，不伪装成新的真实计时。
3. 清空并明确提交为未知：`durationSource=unknown`、`estimatedDurationMinutes=null`；0 为已知 estimated 0，纳入已知统计分母。提示/placeholder 简短表明“留空为未知”。打开修改入口不自动清空或填 5；非计时补记既有未知/估计选择和默认值行为保持兼容。
4. 验证遵循实读契约：非负、有限数，可为任意小数（例如 7.125），无业务分钟上限。现有 `step=0.5` 只是 HTML UI 限制，不是 domain/BFF 契约；共享输入必须允许契约内小数，不能把计时秒精度变成 stepMismatch。负值、NaN/Infinity/溢出如 1e309 拒绝；不存在“超既有分钟上限”测试值，禁止臆造 24h/1440 等上限。大但有限的值不得因新增限制失败。
5. 保留 raw 编辑状态，避免把中间输入（如 `-`、未完成小数或非法字符）误当空值/0；非法状态就地提示且阻止提交。可用文本输入配 `inputMode=decimal` 保留 raw，再严格解析十进制；不要依赖 `Number("")`。raw/展开状态仅为可选的 Draft UI 字段，不进入 Entry/outbox/导出；老草稿缺失这些字段时按 entry 原值恢复。已有效的修正应直接反映在草稿 entry，以便刷新恢复。
6. 不改变 `occurredAt`、`estimatedTime`、createdAt、ID；`updatedAt` 仅按现有保存更新。发生时间估计标记与时长来源完全独立：勾选“时间为估计”不能影响 duration；修正 duration 不能代勾该框。不要用重算 endedAt 伪造实际结束时间。
7. **显式修正意图**：新增可选、可持久化的 Draft UI 标记，仅真实有效改值或明确清空设置；打开/聚焦/相同值输入不设置。标记与 raw/展开状态同属 Draft UI，不进入 Entry/outbox/导出。EntryForm 显式把意图传给 finalize；不通过 estimated/unknown 本身猜测意图。旧调用省略新参数、旧 timer-form 草稿缺少标记时，继续原强制 timer/null 行为；包括 `newEntry("toilet")` 默认 unknown/null 的旧调用。timer-form 无意图时按原 clock 显示，不误把旧默认 unknown 呈现为已选择未知；普通记录 edit 仍按其真实来源保存，不被该兼容规则重写。
8. `finalizeTimer` 以向后兼容的可选 options 接收显式意图和打开表单时捕获的 `draft.baseRevision`。仍核对 timer 存在/ID/endedAt，绑定真实 start/end；仅有显式修正意图时接受合法 estimated/unknown，否则强制 timer/null。**资源 CAS 在同一事务内、无 timer 且同 ID 已完成的原幂等返回之后检查**，不能把 CAS 简单置于通用 mutate 前置条件而破坏重复 finalize。timer 仍存在时，以捕获 revision 比较该资源 editRevision；旧调用未传 revision 按未创建基线0保护，避免覆盖另一事务已写入的同 ID。冲突抛 STALE_REVISION，记录/outbox/timer 原样；不得保存时读取最新 revision。只在成功事务后清除匹配 timer；原 identity fence、NO_TIMER/TIMER_MISMATCH 与幂等行为保留。普通 edit 永远只 saveEntry，不调用 start/finish/reset/cancel/finalize。
9. “返回”保留草稿；未确认丢弃不丢输入，确认“丢弃草稿”继续现有明确删除语义。保存失败保留修正/草稿，刷新后可恢复；只有成功保存后清草稿。过期 revision 不覆写，身份切换不写新身份；不为本需求修复/放宽无关 auth 或未来补记规则。

## 2. 文件所有权（一个 writer，先 RED 后 GREEN）

| Owner | 确切文件 | 允许范围 |
| --- | --- | --- |
| 单一实施 writer | `src/components/EntryForm.tsx` | 替换只读死分支、可选 Draft UI 状态、字段级错误与保存 guard；保持恢复、排队、revision、identity 和 timer prop 语义 |
| 同一 writer | `src/domain/helpers.ts` | 最小纯输入解析/时长转换 helper，供 UI 与专用 unit 共用；不改变既有 validateEntry/durationMinutes/导出模型 |
| 同一 writer | `src/state/TrackerStore.ts` | 仅 finalizeTimer 向后兼容的可选意图/revision参数、来源/估时覆盖与事务内资源 CAS，保留 timer 绑定、identity 及原幂等/错误语义 |
| 同一 writer | `src/components/ui.tsx` | Timeline 用 durationMinutes 读取有效值，来源文案不冒称真实计时 |
| 同一 writer | 新建 `src/test/toilet-duration-edit.test.ts` | 纯解析转换、store/helper/导出/canonicalOperation 的合成回归；使用独立随机 IndexedDB 名 |
| 同一 writer | 新建 `e2e/duration-edit.spec.ts`、`e2e/duration-edit.fixture.config.ts` | 真实 App/EntryForm/store 的开发隔离验证，独立 testMatch；复用现有 invite.vite.config.ts 和 bff.fixture.ts 防火墙 |
| 同一 writer | 新建 `e2e/duration-edit-production.spec.ts`、`e2e/duration-edit-production.fixture.config.ts` | 复用现有 watercolor-production.server.mjs，仅通过 WATERCOLOR_DIST_DIR 指向本候选；真实 native Node/BFF 与 synthetic provider，禁止 API fulfill |
| 父代理集成 | 本计划、外部 `/home/luang/ibs-marker-verification/duration-edit/` | 审核与执行日志/报告/截图；唯一候选输出 `release/dist` |

不改 `App.tsx`、`types.ts`、storage schema、server/syncValidation、认证、数据库/迁移、依赖、根 playwright testMatch。若必须扩范围，先指出证据并重新 review。字体只在确有新增静态字符缺失时，由父代理独占授权最小 subset 更新，不盲重装。

## 3. RED → GREEN 必测矩阵（每行须有断言与日志）

| 用例 | RED/原缺陷 | GREEN 精确验收 |
| --- | --- | --- |
| 保存过的 timer 记录 | 当前无可编辑控件 | Today/History 同一 ID edit：巨大原时间差改 7.125，记录数不变，editRevision +1，outbox 同 resourceId，estimated 7.125，clock/发生时间/estimatedTime 不变；重开仍正确 |
| timer-form 首次保存 | UI 无入口；直接传 estimated 会被 finalize 覆盖 | start→finish→timer-form 改 6.5，返回/刷新恢复后保存；记录 ID=timer ID，clock 原样，estimated 6.5，仅成功后清匹配 timer；单独 unit 证明原覆盖导致 RED |
| timer 结束后未知/0 | 原不可修正 | 两入口分别清空保存 unknown/null，输入 0 保存 estimated/0；helper/statistics 区分 missing 与 known 0 |
| 未触碰保真 | 防回归 | 带秒/毫秒的 timer：打开关闭修改入口、相同值输入、只改备注均逐字段保留 source、start/end、估时 null 和完整精度；无新 UI 字段/意图的旧 timer 草稿刷新同样保真；直接 finalize(newEntry默认unknown/null) 不传新参数仍保存 timer/null；显式 unknown/0 与兼容路径有独立断言 |
| 已有 estimated/unknown | 防回归 | 补记/旧记录/旧 Draft（无 UI 新字段）能照常修改保存；7.125 不被 step=0.5 拒绝，blank 不变成 0；非如厕表单不出现用时字段 |
| 非法与边界 | 防回归 | `-1`、中间 `-`、NaN/Infinity 字符、1e309 不可保存、错误就地可见；有效大有限数可保存；原输入与其他字段不丢，不把非法状态悄悄写成 unknown；raw 草稿刷新保留 |
| 草稿/失败/取消 | 防回归 | 两入口：返回保留；丢弃确认取消保留；保存失败注入在记录事务而非草稿 autosave，原记录/outbox/timer 不变且输入/草稿在；刷新仍能重试成功；主动确认丢弃继续原语义 |
| revision / identity | 防回归 | 普通编辑 A 修正时 B 修改同记录，A 保存抛 STALE_REVISION；首次 timer-form 打开捕获revision后，另一事务写同 ID 且 timer 仍在，finalize 拒绝覆盖并完整保留 timer/远端记录/outbox和修正草稿；不传 revision 的旧调用同样不得覆盖已写同 ID；草稿 autosave不自造 stale；身份在排队/事务前切换，旧修正不落新 namespace |
| 其他全局 timer | 防回归 | 旧记录 edit × 全局 timer 活动/已结束：改用时、返回、取消丢弃、保存失败/成功/刷新前后 timer 结构深相等；监视 start/finish/cancel/finalize 调用均零 |
| finalize 防线 | 防回归 | 无 timer、错误 ID、未结束按原错误；timer 原样保存、并发重复 finalize 同 ID 仍仅一条；estimated/unknown 保存失败事务回滚；不改变已存在同 ID 幂等返回 |
| helper→显示→统计→导出→BFF | 防回归 | 原巨大时间差修正为 6.5 后 Timeline 显示估计 6.5，平均数/known 分母按 6.5；unknown 排除、0 包含；JSON/CSV 保留原字段且 source/value 精确，解析后 durationMinutes=修正值；canonicalOperation 保留合法 clock+estimated/unknown；native fixture push/pull 相同 ID/version 成功，远端读回值/clock正确 |
| 手机/桌面可用 | 原入口缺失 | 两入口各在 320/390/1280px：控件明确可见，键盘可达、label 对应输入、修改/保存触控高度≥44px，无横向溢出/重叠/遮挡，错误靠近输入；截图与 console/pageerror/网络报告齐全 |

测试样本只在 fixture 新浏览器 context 与独立 DB；真实用户的浏览器状态不可复用。正常测试不等待真实计时，使用固定时钟/合成 start/end；多标签 revision 用共享同一 fixture context 的新 page。

## 4. 执行步骤与命令（仅审核通过后）

1. 父代理独立 plan review PASS，复核工作树、运行安全、浏览器可执行文件与端口空闲；单 writer 接管上述文件。记录 baseline，根 dist 仅做 manifest/hash 比较，不写入。
2. 写专用 unit 和真实 App E2E，串行运行取得预期 RED：控件缺失和 finalize 覆盖两类失败必须分别留证，不能把 fixture 启动失败算 RED。
3. 最小 GREEN：先解析/转换 helper 与 finalize，再 EntryForm 的共用字段/草稿，最后 Timeline；专用矩阵回归过后才跑全量。每一步只记录验证 diff，不自动 commit。
4. 在 repo 根运行以下命令，日志分别保存到外部 baseline/red/green 子目录。设置 `IBS_EVIDENCE_DIR` 为本任务独占子目录、`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 为发现的现有 Chromium；不安装 DOM/浏览器依赖。
   - `npm exec vitest run src/test/toilet-duration-edit.test.ts`
   - `npm exec -- playwright test --config e2e/duration-edit.fixture.config.ts`
   - `npm test -- --maxWorkers=1`（包括现有 stats 真浏览器测试，串行避免共享宿主资源争用）
   - `npm run typecheck`
   - `npm run build -- --outDir /home/luang/ibs-marker-verification/duration-edit/release/dist`（先确认该目录只属于本任务；绝不直接 npm run build 默认根 dist）
   - `WATERCOLOR_DIST_DIR=/home/luang/ibs-marker-verification/duration-edit/release/dist npm exec -- playwright test --config e2e/duration-edit-production.fixture.config.ts`
   - `git diff --check`、`git status --short`，父代理核对只改已授权文件和根 dist 原指纹。
5. 新 fixture config 固定独占 loopback 端口，`reuseExistingServer=false`、workers=1、输出外部。开发 config 用 `e2e/invite.vite.config.ts`（envDir:false），context 防火墙在导航前安装、SW block；生产 config 复用 native Node server 的 15009，先确认空闲，与其他相关套件串行，SW block 即可完成本功能验收，不伪称验证全套 PWA。生产上下文不 mock API、禁止外域 HTTP/WS，fixture upstream transport 为纯合成而非真云。
6. 生产浏览器以 fixture seed 合成计时记录，从真实历史入口修正，再从全新干净 context 登录 fixture Alice 读回同一远端记录，证明真实 push/pull，不以 UI snapshot 代替远端验证。首次 timer-form 也须通过真实原生服务器保存读回。候选 build 的两入口在 320/390/1280px 真实渲染，不只开发服截图。
7. 字体 gate：对最终新增静态文案与 `src/assets/xiaolai-ui-subset.woff2` 做 CMap 差集，检查项目已有工具/虚拟环境；当前默认 python 无 fontTools，不能报告已通过。优先复用已覆盖简短文案；确需补字则父代理确认可用本地完整字体后最小 resubset 并复建候选，不联网盲装或覆盖根 dist。报告缺字/工具缺失为真实阻塞。
8. 解析报告核对实际总数/failed/skipped，不手算或把未跑项说 PASS。保存 RED/GREEN、全量、tsc、候选 build、浏览器尺寸/截图、网络/console、远端读回证据；关闭且仅关闭自己创建的 fixture 进程与端口。

## 5. 完成定义与审核顺序

- **SPEC review 先行**：独立审查冻结语义、两入口、ID/revision/identity、草稿/失败、其他 timer 隔离、边界值、导出与原生 BFF 读回全部有实际证据；缺项不得 PASS。
- **QUALITY review 后行**：只在 SPEC PASS 后审查最小 diff、无重复 duration 算法、无默认 rounding、无未经验证的数值强转、可访问性、过期 async/草稿兼容、无无关认证/部署/依赖改动。发现问题回 writer 修复并重跑受影响测试，最终两级均 PASS。
- 交付仅本地代码 diff 与外部候选/验证证据；不 commit、push、部署、重启或覆盖根 dist。业务上无必须先问的阻塞问题：本方案将修正诚实标为手动估时，并保留原始计时 metadata；若另需“修改真实起止时刻且仍标 timer”或修正审计历史，属于新范围，必须另行确认。
