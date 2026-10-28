# A 阶段共享 TypeScript 契约（UI / Cloud 必读）

真源：`src/domain/types.ts`、`src/domain/helpers.ts`、`src/state/TrackerStore.ts`。不直接读 localStorage。无默认真实记录、无真实 Supabase 网络调用。

## 数据
- `Entry = ToiletEntry | MealEntry | SymptomEntry`，kind 为 `toilet/meal/symptom`。所有 id 用 `crypto.randomUUID()`；ISO UTC 时间序列，上海日期用 helpers。occurredAt 是实际发生时间（可补记），createdAt 是创建时间，estimatedTime 独立。
- toilet.result `passed/none/unsure`；stoolForms 有序 `(1..7|'unknown')[]`，passed 必须至少一项，其余必须空。
- discomfort `{status:'reported',symptoms:[{name:'pain'|'bloating'|'urgency'|'nausea'|'other',severity:'mild'|'moderate'|'severe'|'unknown'}]}` 或 `{status:'none'|'unknown',symptoms:[]}`。relief `yes/partial/no/unknown`。
- durationSource `timer/estimated/unknown`；timer 需合法 startedAt/endedAt；estimatedDurationMinutes 仅 estimated 可非空；未知不是0。startedAt/endedAt 都可 null。
- meal.status `eaten/skipped`，slot `breakfast/lunch/dinner/snack`；foods 为自由多食物文本；tags 为字符串数组；portion `small/medium/large/unknown`。skipped 时 foods/tags 为空，portion unknown。正餐同上海日期/slot 唯一（已有记录应编辑，不静默覆盖）。
- symptom.discomfort 使用相同模型，context 自由文本。
- Settings.meals 三餐 `{time:'HH:mm',enabled:boolean}`；foodTemplates `string[]`；snoozes key `YYYY-MM-DD:slot` value ISO 到期时间；remindersEnabled 默认 false。提醒仅由前台UI实现。

## UI 使用
```ts
import {trackerStore} from '../state/TrackerStore';
import {useTracker} from '../state/useTracker';
// 启动明确选择身份：await trackerStore.activate('local')
// 云有会话：await trackerStore.activate(`user:${uuid}`)
// 注销/失效：await trackerStore.activate(null)
const state = useTracker();
```
- `getSnapshot/subscribe` 用于非 React。snapshot 含 entries（按发生时间倒序且不含墓碑）、records（含墓碑）、settings、timer、drafts、outbox、revision、editRevisions、cursor、conflicts、namespace/generation/loading/error/syncStatus。revision 仅为 namespace 通知/快照排序，不是编辑锁。
- `saveEntry(entry,expectedRevision?)` / `deleteEntry(id,expectedRevision?)` / `saveSettings(settings,expectedRevision?)` Promise：expectedRevision 为资源编辑 revision，默认 `getEditRevision(entry.id / id / 'settings')`。打开编辑器时捕获 `getEditRevision(resourceId)` 并保存时传入，禁止用 namespace revision 或保存前重新取最新值绕过检查；`STALE_REVISION` 则提示重新载入，不覆盖。snapshot.editRevisions 同步提供映射，未存在资源为 0。本地业务保存/删除、真正改变内容的远端落地推进对应资源编辑 revision；draft/timer/cursor/纯 ACK 元数据不推进。ACK/pull 等远端落地按 JSON 结构判等：递归忽略对象键顺序，严格保留数组元素顺序（含便形、症状、设置数组）；仅对象键重排不使编辑器失效，数组顺序变化仍推进编辑 revision，不改写业务 payload。IDB schema 仍为 v1，旧数据缺 editRevisions 时读/事务归一为空映射，下次写入持久化，保留所有原数据。
- `saveDraft(key,unknown)` / `clearDraft(key)`。表单存取 snapshot.drafts。所有写入等待 Promise 成功才关闭；失败保留表单。
- `startTimer(startedAt?)` 返回当前/新活动计时；同 namespace 单活动，跨标签同事务检查。`finishTimer(endedAt?)` 持久化结束时间及基础草稿；`saveTimerDraft(partial)` 保存表单；`finalizeTimer(fullToiletEntry)` 同事务保存同ID记录/outbox/清timer，双击幂等。`cancelTimer()` 仅用户显式放弃时用。
- `reload()` 读最新；BroadcastChannel 自动刷新。`clearCurrentNamespace(confirmed)` 必须先展示 outbox 数量、导出建议并确认。`dispose()` 关闭本实例广播监听，不负责关闭共享 adapter。
- 默认 IndexedDbAdapter 遇 blocked 会拒绝 `IDB_BLOCKED`，store.loading=false 且 error 可观察；提示用户关闭阻塞标签后 `reload()` 重试。失败 open 不永久缓存，迟到成功连接自动 close；不自动删库。
- helpers：validateEntry/validateSettings 返回错误字段列表；shanghaiDate/shanghaiTime/fromShanghai；sortEntries/lastPassed；statistics；completeness；exportJson/exportCsv（CSV 防公式注入、未知留标记）。下载及健康数据警告由 UI 实现。
- 完整度：mealsConfirmed/mealsEnabled 取启用餐次；事件确认项 toilet(result 与 discomfort)、symptom(discomfort)，未知列 missing，不给总分。统计不适分母为全部如厕和独立不适事件的 reported+none；unknown 另列。

## Cloud 接口（C 负责真实 RPC/认证组件）
- `IdentityToken {namespace,generation}`：从 identityToken() 获取；所有异步回包先 isCurrent(token)，换号/退出立即清空可见状态，旧回包不得应用。云未配置不请求。
- `pendingOperations(token?)` 返回克隆队列并登记在途操作。必须从此函数取发送对象（不要直接把 snapshot.outbox 发出）。OutboxOperation `{kind:'entry'|'settings',resourceId,changeId,baseVersion,snapshot,tombstone}`；settings 的 resourceId 固定 `settings`。资源 version 在 namespace.versions 中。
- `acknowledge(token,changeId,version,remote?)`：仅当前身份且已通过 pendingOperations 登记的 changeId 可确认；未知/已确认 changeId 即使带 remote 也幂等无效果。remote 必须同 kind/resourceId、同 ACK version（entry.id 同资源）；version 必须为安全整数、超过发送操作 baseVersion 且不倒退当前已知 version/pending baseVersion，否则拒绝 `INVALID_ACK`。成功原子确认对应 changeId；可选 RemoteResource 同事务落地；若期间再次编辑，保留新快照/新changeId，更新其 baseVersion。不以 ACK 覆盖新编辑。提交成功才清理发送登记，activate 清空旧身份登记。
- `applyPull(token,RemoteResource[],cursor)`：同事务落地与推进单调 cursor；有本地待发且远端 version > baseVersion 则保留本地并创建 conflict。不清队列。返回 false 表示旧身份，不再继续同步。
- RemoteResource `{kind,resourceId,version,snapshot,tombstone}`；entry snapshot 必须携带 deletedAt 墓碑，不能物理删除。
- `registerConflict(token,localOp,remote)`；`resolveConflict(id,'remote'|'retry-settings'|'copy-local',copy?)`。copy-local 传显式全新未占用 UUID 完整记录（已有记录、墓碑、versions/outbox 占用均拒绝 `NEW_COPY_REQUIRED`，整事务回滚），正餐唯一校验仍生效；不自动改加餐。remote/copy-local 发现本地 outbox.changeId 已不同于冲突快照时拒绝 `STALE_CONFLICT`，保留新编辑和冲突。retry-settings 从事务中当前 settings 排队（不是过期 conflict.local.snapshot），以不倒退的 remote.version 为 base 重试，确保可见值和待发值相同；再次冲突仍展示。
- `setSyncStatus(token,{state:'idle'|'syncing'|'offline'|'auth'|'error'|'conflict',message?})` 不与本地写失败混淆。CloudPanel 自行接 UI，父最终集成。
- 服务端必须按 architecture.md 用 auth.uid/RPC/baseVersion/changeId账本和顺序游标；本层不冒充真实 Auth/网络验收。

## 工程命令
`npm test` / `npm run typecheck` / `npm run build` 为 one-shot；`npm run dev` / `npm run preview` / `npm run test:watch` 为长运行；`npm run e2e` one-shot（B补 Playwright 配置）。根依赖与 lock 已安装，后续需要增依赖请父串行执行。
