# 肠记 v5 水彩四主页面 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 将已认可 v5 接入真实今天／历史／统计／设置，进一步收紧上下留白，完整保留记录、计时、离线与同步行为。

**Architecture:** 保持 App 的 store／身份门禁／hash routing／表单与计时生命周期；仅调整呈现与统计页局部交互。复用真实 TrackerStore、领域统计和原 cloudPanel，不迁移数据，不改变 BFF／数据库／账号架构。

**Tech Stack:** 已安装 React 19.3.1、Vite 8.3.4、TypeScript 7.0.2、Vitest 5.0.5、Playwright 1.64.1；不加库、不安装、不升级依赖。

---

## 0. 授权、事实与审查门

- 用户已明确批准 v5 实施，新增要求是“上下 padding 调下太高”；不重新讨论选型。设计依据：`/home/luang/ibs-marker-design/watercolor-main-pages-v5/{index.template.html,index.html,statistics.png,range-picker.png}`，首页采用 E3 动作分区；C 后备稿不删除。
- 本轮计划梳理仅写此文件；不改业务源码、不读取 AGENTS、健康记录、`.env`／`.private`／账号，不启动 listener、不安装、不 commit／push／部署，不覆盖根 `dist`，不修正式服务。
- 实施前由 parent 以 high／xhigh 做严格计划 review；问题修入计划后才分工。实现每组先规格审查 **PASS**，再质量审查 **APPROVED**；修复后重跑相应检查。此文不是已经通过独立审查或已经完成测试的声明。
- 已只读确认：`App.tsx` 管理真实身份、草稿 generation、提醒与 timer；首页／历史尚内联。`StatsPage.tsx` 导出被 App 与 `ui-dates.test.ts` 使用的日期函数，旧实现对超长范围只是循环截断，必须改为提交前拒绝。`SettingsPage.tsx` 已有草稿队列、revision、身份令牌、真实导出和清理，保留函数链。`Timeline` 为首页／历史共享。
- `domain/helpers.ts` 已支持 deleted 过滤、passed 多形态逐项、已知用时、不适已知／未知，优先复用；不要为换皮改领域模块。`build/offlineManifest.ts` 已枚举 bundle 非 map 资产，字体理论可纳入，但必须用最终产物证明。
- 原根 `playwright.config.ts` 只匹配既有指定 spec，且 production 分支使用 preview；**新增 spec 不会自动运行，preview 不等于真实 Node/SW 验收**。parent 负责新增专用 fixture config／候选 Node 运行入口，不修改根配置或正式服务。

## 1. 并行 ownership 与冻结接口

所有路径相对 `/home/luang/ibs-marker`。一文件一个 owner；非 owner 不编辑。需要共享改动先交 parent；不让三组各自改 App／全局 CSS／同一测试。

| Owner | 独占可修改／新建文件 | 责任与 targeted checks |
| --- | --- | --- |
| A：路由接线＋今天／历史 | `src/App.tsx`、`src/styles.css`、`src/components/ui.tsx`；必要时新建 `src/components/TodayPageView.tsx`、`src/components/HistoryPageView.tsx`；新 `src/test/watercolor-home-history.test.tsx` | 在 App 原生命周期内落地 E3 与历史；复用 Timeline，不大改 EntryForm／Choices／Back。`npm test -- src/test/watercolor-home-history.test.tsx src/test/ui-defaults.test.ts src/test/ui-dates.test.ts` |
| B：统计 | `src/pages/StatsPage.tsx`；新 `src/pages/stats/{RangeDialog.tsx,statsPresentation.ts,TimeChart.tsx,stats.css}`；新 `src/test/watercolor-stats.test.tsx` | 范围事务、真实时点与当日列表、领域统计展示和 memo。`npm test -- src/test/watercolor-stats.test.tsx src/test/ui-dates.test.ts src/test/core.test.ts src/test/core-fixes.test.ts` |
| C：设置 | `src/pages/SettingsPage.tsx`；新 `src/pages/settings.css`；新 `src/test/watercolor-settings.test.tsx` | 仅重排原业务 UI，保留 save／reload／download／clear 与 queue／revision。`npm test -- src/test/watercolor-settings.test.tsx src/test/blocked-fixes.test.ts src/test/edge.test.ts` |
| D：可选独立浏览器测试 | 仅新 `e2e/watercolor-ui.spec.ts`、`e2e/watercolor-production.spec.ts` | 合成隔离 fixture，页面流程／真实编译样式／生产离线验收；不改既有 spec、业务文件、根配置。parent 显式 testMatch 后执行 |
| E：隔离测试基础设施 | 仅新 `e2e/watercolor.fixture.config.ts`、`e2e/watercolor-production.fixture.config.ts`、`e2e/watercolor-production.server.mjs`、`e2e/watercolor-native-fixture-check.mjs` | dev 15008 显式 local fixture；production 15009 使用真实 createApplication＋仅 Node 端 synthetic provider transport。先做 native preflight，不读取真实 env 或云 |
| Parent：集成／资产／证据 | `src/assets/xiaolai-ui-subset.woff2`、对应 OFL、`src/assets/watercolor-font.css`；外部验证目录及必要旧 spec 选择器适配 | baseline／字体最终 resubset／集成审查／全量测试／候选 build／串行浏览器验收。E 编写 fixture，父仍负责实际运行与读回；原则上不改 dependency／根配置／build manifest，缺陷先协调独占归属 |

最小稳定 contract（先冻结再并行）：

1. `StatsPage` 仍 default export，props 保持 `entries: Entry[]`、`settings: Settings`；保留 `addDay`、`isValidDay`、`dateRangeError` 兼容导出。A 在 StatsPage 挂载处使用 `snapshot.generation` 作为 React key，身份代际切换必须卸载旧统计组件及其模态／详情。当天列表在统计页内部打开并复用 `Timeline(entries,onEdit)`；编辑只设既有 `edit/<id>` hash，不要求 A 增加 prop 或新路由。
2. `SettingsPage({ cloudPanel?: ReactNode })` 不变；App 仍用 generation key 挂载。cloudPanel 原节点直接保留，不另做假账号／假同步面板。
3. `Timeline({ entries: Entry[], onEdit: (entry: Entry) => void })` 不变，排序／时区／unknown 含义不变；`Choices`、`Back` 原语义与可访问名称保持。
4. A 若抽 Today／History，仅传现有计算结果和动作回调，不在呈现组件启动 timer、写 store、复制草稿状态。保留 App 的 run、formInitial、generation、private gates、提醒与 start／elapsed。
5. A 统一根 tokens `--paper/--ink/--muted/--lake/--line`；旧 `--blue` 可兼容映射，避免破坏未改表单。B/C 各自 import CSS，以 `.stats-page`／`.settings-page` 根类限定选择器，不覆盖 body／全局按钮／Timeline。parent 提供 font CSS，A 单点导入；其他组不改字体入口。
6. `selectedRange` 是已提交范围，`rangeDraft` 只归 B；设置草稿只归 C。二者不能共用 draft、持久化键或保存回调。
7. B 独占 RangeDialog／统计详情的 portal 与模态生命周期：portal 在 App 根之外的独立容器，隔离整个当前 App 根（含底导航），不得将 body 或 portal 祖先设为 inert；逐节点捕获及恢复 inert 原值。关闭、路由／generation 切换、unmount、StrictMode cleanup 均释放所拥有隔离及监听。显式关闭时只回焦当前同代页面内的有效 trigger；替换后寻找当前新 trigger，必要时用当前页安全 fallback；卸载不回焦旧身份节点、不覆盖认证锁或他人隔离。

## 2. 关键实施步骤（每组按 RED → GREEN → 小步整理）

### 2.1 Baseline 与 RED 证据先行

- Parent 先保存源码路径＋hash baseline、原根 dist hash 和全量 unit JSON。工程基本 untracked／无已知 HEAD，不能用空 `git diff` 当作无变更证据；不 stage、不 reset、不 clean。
- 每组先新增最小失败回归，运行本组 targeted command，保留独立 `red-<owner>` 日志／JSON，确认失败来自缺失的目标行为而非环境、导入或 fixture 错误；再改所属实现并保留 `green-<owner>`。
- JSX 交互测试沿用项目已有 React／Vitest 测试方式，不为测试引入库。DOM／焦点／原生日期中间态由 D 的真实浏览器补足，不以静态字符串断言代替全部行为。

### 2.2 A：先收紧纵向节奏，再接四页公共外观

- 奶白纸底、湖蓝／鼠尾草轻水彩、中文手写标题；正文、时间、数字与用户输入仍用正常字体。内页只保留必要页名，去重复眉题／情绪副标题，不搬演示 badge。
- 手机页顶／主要区块上下留白目标 12–16px，bottom sheet 内容上下 14–16px；通过移除重复标题、压缩 margin／padding 达成，不压小字号或按钮。保留 max-width 760px，正文随文档自然滚动，不固定 390×844、不嵌套演示手机壳。
- 有底导航页预留“导航实际高度＋safe area＋适当间隔”；无导航表单／计时／提醒页单独合理底留白，不能全部硬套 110px。目标点击区域至少 44×44px。
- 主卡只处理当前开始／进行中／结束后继续填写；补记如厕放记录标题区，进入既有 `new/toilet`，不得 start／reset／finish 当前 timer。这里“补过去”是入口的使用场景，不是新增时间校验契约：本轮不修改 EntryForm 或领域校验，不承诺禁止原表单手填未来时间；保留既有发生时间、草稿、保存与编辑规则，避免视觉实施夹带业务限制。饮食／独立症状／其他入口及真实三餐提醒保留；不能照搬演示点击轮换餐次状态。
- 历史保留真实日期导航／原生日期输入、类型筛选和编辑；清空／非法日期仍安全恢复。保留表单草稿、generation 隔离、计时跨路由与弹层持续。

### 2.3 B：范围提交事务与真实图表

- 页面只出现一个已提交范围 chip；弹 bottom sheet 选 7／30／custom。打开复制 committed 到 draft；只有有效确认才提交，取消／X／背景／Escape 都丢弃 draft 并恢复触发器焦点。模态 focus trap、背景 inert、可见标签与错误反馈完整。
- 空值、非法日、倒序及**含首尾超过 366 天**一律不提交，保留原图；恰好 366 天可用。日期函数兼容原 imports；时区转换统一 `Asia/Shanghai` helper，不用 timestamp 的 ISO 日期切片代替本地日期。
- 时点图 date×0–24h，passed／none／unsure 不合并；`estimatedTime` 用独立 `~`，不等同估计用时。小点不做小点击目标，整日期行至少 44px，点击打开真实该日列表并可编辑。
- 近时点纵向分 lane；横轴时刻不变，**日期行及 track 随 lane 数动态增高**，不会绘进相邻日期；覆盖 00:00／23:59、同分钟密集点。长范围采用可滚动日期区域／完整日期列表策略，不静默丢日期。
- 不恢复 v5 已删除的如厕总数横条；保留饮食回看与原完整度信息（可收入数据说明，不能无故删除）。形态仅 passed 的 stoolForms 逐项计算，含同次多项／unknown；known 分母正确，空数组和 unknown 可辨。用时未知不算 0，保留独立症状＋如厕不适的已知／未知。零与缺失分开，不做医学判断／因果／健康评分。
- 范围过滤、分日、统计、lane 布局 memo 化；依赖 entries／settings／committed range，而非 App 每秒 tick。用稳定 props 重渲染计数回归证明未反复全量聚合。

### 2.4 C：原设置行为不降级

- 重排提醒／食物组合／账号与保存／导出清理的水彩分区；保留真实 pending、错误、状态反馈，不能把动作换成 toast-only 或“已同步”常量。
- 保留 settings editor 草稿恢复、排队保存、revision 冲突、身份 token、显式保存与放弃草稿；组合添加不自动生效、不自动生成饮食记录。
- 保留通知前台限制／权限结果；JSON／CSV 真实下载与敏感提示；本机清理保留原确认、待同步风险与账号分区保护。退出本设备完全保留 CloudPanel 原 signOut、锁页及离线分区说明，不新增确认门、不代理点击、不改认证取消或注销时序，cloudPanel 所有真实动作保持。

### 2.5 Parent：字体与无冲突集成

- 使用本地 Xiaolai TTF 与现有 fonttools，生成静态标题所需 subset woff2 和 OFL；最终从真实源码提取字符重做 cmap 覆盖检查。正文／用户输入不依赖有限 subset；不开 CDN。
- 等 A/B/C GREEN 与两阶段 review 后集成；检查 hash 清单只出现 ownership 范围内变化，禁止误改 `src/cloud`、`server`、依赖／环境／账号配置。
- 首选不改已有 manifest 逻辑；候选 woff2 必须实际出现在 asset-manifest 且被 SW precache。若没有，先找原因，不以“理论支持”通过。

## 3. 测试与验收门（实施阶段执行，本轮未执行）

所有验证证据放 `/home/luang/ibs-marker-verification/watercolor-ui/`，RED、GREEN、baseline、final 分开，使用隔离 synthetic fixture，绝不读取真实健康资料或为 UI 新建真实云账号。

### 自动化与产物

- 各组运行表中 targeted tests；新增 spec 必须由 parent 专用 config 显式匹配，先 `npx playwright test --config e2e/watercolor.fixture.config.ts --list` 确认发现，再执行；生产 spec 使用另一个 production fixture config 显式匹配最终候选产物。
- Parent 全量：`npm test -- --reporter=json --outputFile=/home/luang/ibs-marker-verification/watercolor-ui/final-unit.json`；`npm run typecheck`；`npm run build -- --outDir /home/luang/ibs-marker-verification/watercolor-ui/release/dist`；`node scripts/server-fixture-check.mjs`。
- 530 是已知历史基线，不是本轮完成数字。用程序读取 parent baseline／final JSON，核对实际 test IDs、总数、pass／fail／skip、新增／缺失，不能把 targeted 数冒充全量或硬写“530＋N 已通过”。不得新增漏跑或以 skip 遮蔽失败。
- 保留既有 local／BFF／cookie／恢复／SW 测试路径，按原 fixture 运行 `e2e/local.fixture.config.ts`、`e2e/invite.fixture.config.ts`、`e2e/offline.fixture.config.ts`、`e2e/sw.fixture.config.ts`；缺失覆盖由 production 专用验收补足，不能将 mock SW fixture 当作候选 production Node 的替代。
- 浏览器／build 串行，独占 loopback fixture，`envDir:false`，不触碰正式服务；parent 在运行前确认所选端口与 fixture 环境。当前 namespace 没 listener 不证明公网服务停止。

### 必须交付的真实浏览器证据

- **布局**：320／390／1280 宽，最终编译 CSS 的 computed padding、页面／弹层 overflow、导航遮挡、至少 44×44 点击区域；有／无底导航页均覆盖。相同 fixture 状态截图对比 v5，证明更紧而不牺牲可读性；长中文、空态、填充态、运行 timer、错误态覆盖。
- **模态／日期**：chip 唯一；7／30／custom 确认才改图；取消／X／背景／Escape 不变图并回焦；Tab／Shift+Tab trap；打开时底导航不可点击／聚焦，原有 inert 值保留；trigger 重建及身份卸载／StrictMode cleanup 后无遗留隔离或旧节点回焦；原生 input 清空／倒序／非法／366 与 367 天、跨年／闰日及上海跨 UTC 日期边界。
- **统计**：passed／none／unsure、estimatedTime 与 estimated duration 独立、多形态＋unknown＋空数组、known 分母、已知 0 用时与未知、deleted 排除；密集时点动态行高不串日期，点击是真实当日列表；饮食与独立不适不丢。
- **真实 store 流程**：新增／编辑、表单与设置草稿、离线持久后刷新、timer 跨页／弹层／补记不重置、提醒设置显式保存、组合保存、JSON／CSV 文件内容与取消下载。取消／确认仅适用于原本具有确认的操作（例如本机清理和导出）；退出验证 CloudPanel 原直接 signOut 行为，不新增确认。均只操作 fixture 当前身份；覆盖账号分区、迟到响应／恢复锁既有回归。补记在活动／已结束 timer 下打开、取消、保存失败／成功都不改变当前 timer。
- **边界与离线**：context-wide HTTP／WebSocket 外域防火墙在导航前安装，真实浏览器外域 HTTP 请求数为 0；dev fixtures block SW 避免绕过拦截，production 验收 allow 真实 SW 并另核网络。产物不含厂商 SDK／URL／key；BFF session/cookie restore 行为不回退。
- **冷离线字体**：候选真实 Node 入口提供页面与版本化 SW，首轮 precache ready 后不额外在线预热即断网重启／刷新；字体已列 manifest、cache 中存在、离线实际加载成功且标题无缺字；文档导航／查询串／cookie恢复仍按既有边界工作。

## 4. 完成、回退与当前风险

完成条件：计划审查通过；各组 RED 证据齐；规格 PASS 后质量 APPROVED；最终全量 JSON／typecheck／候选 build／fixture checks 及上述浏览器验收真实通过，截图和候选产物路径明确。未执行、受阻或未覆盖项如实列出，不能宣称已完成。

回退仅依据 parent baseline 对本次 owner 文件逐个恢复，保留未提交工作与设计稿，不依赖不存在的 HEAD，不执行全仓 reset／clean；根 dist、运行中服务和真实数据始终不变。UI＋Node 原子发布、正式切换、commit／push 不在本次授权内。

**需协调但无阻断：** 新 e2e 不在现有根 testMatch，parent 必须显式接入新 fixture config；字体字符须在最终源码稳定后再子集化；统计旧范围上限需要补成真正验证；全量数字由 parent 真实 baseline／final JSON 决定。以上均可在本地隔离实现，不需要用户补充账号或架构决策。
