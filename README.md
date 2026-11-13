# Agent 自动化中台

阶段 1/2 已实现领域契约、SQLite、DevOps 缺陷列表与详情适配器及五分钟轮询。阶段 3 已接入来源归属、Task/Run 状态、人工复核与本机交互 API。真实 DevOps 鉴权方案仍待提供，因此尚未调用真实接口。

要求 Node.js 24+。本地运行：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run selfcheck
```

`src/event` 负责来源标准化与保存；`src/agent/kernel` 处理来源归属和 Worker 结构化结果；`src/agent/task` 的状态转换与历史记录由 SQLite 原子提交；`src/agent/worker` 领取 Run，并在启动前核对 Mandate、Skill、工作区和执行隔离。样本事件直接调用 `EventIngress`，不对外提供任意事件提交接口。

事件来源配置必须为每个 `sourceId` 指定可保留的 `metaData` 字段；入口和仓储都拒绝未列入的字段。默认 Mandate 仅由受信接单规则生成低风险调查授权；扩大授权必须来自平台核验过的人工审批记录，或经显式启用的低风险自动 PR 规则。交互 API 在每次请求中校验 Bearer 凭据，并由服务端指定人工身份；审批角色、请求状态、Task iteration、策略版本和代码 SHA 在写入时校验。外部动作仍由后续阶段的门禁在执行前重检。

`config/platform.json` 的 `projectGroups` 直接包含各组仓库；所有项目组都可人工提交事件。`config/schedules.json` 的任务通过 `projectKey` 指向项目组，任务 `id` 是稳定的扫描事件来源 ID。DevOps 缺陷任务在自身配置 `businessProjectId` 和 `pageSize`；GitHub PR 任务扫描组内仓库面向各自 `targetBranch` 的开放 PR。新增同组仓库只改该项目组，新增扫描类型才需要实现一次适配器。启动时校验项目组和任务并注册来源；SQLite 拒绝未注册或已禁用的来源。修改配置后需重启。

微服务项目组用 `searchRoot` 指定私有本地目录，用 `defaultRepoKey` 指定无明确代码线索时的主责仓库。组内各仓库分别配置远程项目、本地 `localPath` 和合并目标 `targetBranch`；只有路径位于 `searchRoot` 内且 Git `origin` 与受信配置一致时才可自动选择。来源文本明确包含唯一仓库键，或两个代码标识命中同一仓库的已跟踪文件名时选该仓库；否则选已就绪的默认仓库。人工提交先选项目组，可让系统自动选仓或在组内指定仓库。自动选择只创建调查范围，不授予 DevOps 或 GitHub PR 事件自动改码或提 PR 权限。既有事件和 Task 不会因配置修改重新归属。

仓库内的 `config/platform.json` 保留一个空的 DevOps 项目组示例和一个平台自身项目组。实际本机路径应放在 Git 忽略的 `.runtime/` 配置文件中，通过 `AGENT_PLATFORM_CONFIG` 指向该文件；配置页不会回显绝对 `searchRoot` 和 `localPath`。未配置可用仓库的缺陷事件进入人工复核。默认 GitHub PR 任务需 `AGENT_PLATFORM_GITHUB_TOKEN` 提供读取 PR 的令牌；它只发现开放 PR，跳过平台任务创建的 PR 分支。平台已关联的 PR 状态仍由原有代码托管轮询处理。

服务入口是 `npm start`（先运行 `npm run build`）。启动前需设置 `AGENT_PLATFORM_AUTH_PROVIDER` 为受信 JavaScript 模块路径，该模块导出异步 `authorizationHeaders()`，返回当前请求所需的请求头；仓库尚未实现凭据获取与刷新。可用 `AGENT_PLATFORM_CONFIG`、`AGENT_PLATFORM_SCHEDULES`、`AGENT_PLATFORM_DATABASE` 覆盖三个默认路径。默认数据库位于 `.runtime/state/agent-platform.sqlite3`；自定义数据库所在目录必须归当前服务账号所有，且权限不能开放给其他账号。旧位置的数据库不会自动迁移，已有数据应在停服后备份并迁入私有目录。默认缺陷任务启动即扫描，此后每 300 秒扫描一次；停止时等待当前扫描完成并关闭数据库。每轮从第一页重扫，页码在并发增删时可能移动。真实接口演练待鉴权方案提供后进行。

### 本地 Qoder / 阶段五演练启动
cat ~/.config/agent-platform/local-api.token | pbcopy
先停止正在运行的服务，在同一个终端执行以下命令。令牌只在终端中输入，不写入仓库或命令历史。`.runtime/preview/schedules.json` 关闭 DevOps 轮询，因此这里的空鉴权模块只用于本地演练；真实 DevOps 来源须换成受信鉴权模块。

```zsh
cd '/Users/suijiaxuan/Program/Project/Python/Personal/agent-platform'
mkdir -p .runtime/preview
printf 'export async function authorizationHeaders() { return {}; }\n' > .runtime/preview/auth-provider.mjs
printf '{"tasks":[]}\n' > .runtime/preview/schedules.json
if [[ -z ${AGENT_PLATFORM_GITHUB_TOKEN:-} ]]; then
  printf 'GitHub 受限令牌: '
  IFS= read -rs AGENT_PLATFORM_GITHUB_TOKEN
  printf '\n'
  export AGENT_PLATFORM_GITHUB_TOKEN
fi
if [[ -z ${AGENT_PLATFORM_GITHUB_TOKEN:-} ]]; then
  printf '缺少 AGENT_PLATFORM_GITHUB_TOKEN\n' >&2
else
  if npm run build; then
    AGENT_PLATFORM_AUTH_PROVIDER="$PWD/.runtime/preview/auth-provider.mjs" \
    AGENT_PLATFORM_CONFIG="$PWD/config/platform.json" \
    AGENT_PLATFORM_SCHEDULES="$PWD/.runtime/preview/schedules.json" \
    AGENT_PLATFORM_DATABASE="$PWD/.runtime/state/agent-platform.sqlite3" \
    AGENT_PLATFORM_STAGE5_WORKER_ENABLED=0 \
    AGENT_PLATFORM_QODER_WRITE_ENABLED=0 \
    AGENT_PLATFORM_STAGE5_WRITES_ENABLED=0 \
    npm start
  fi
fi
```

`config/platform.json` 当前启用 Qoder；服务只在启动时读取配置，改动后必须重启。上述命令保留阶段五 review Worker 和外部写操作开关关闭。当前 `agent-platform` 仓库的 verify 使用 platform 模式，不启动 Qoder 会话；需要启用 review Worker 时，可在 `npm start` 前设置 `AGENT_PLATFORM_STAGE5_WORKER_ENABLED=1`。若 QoderCN 浏览器登录后真实请求仍返回 401，可从所用企业实例的 Integrations 页面创建专用 PAT，并在启动服务的终端设置 `QODERCN_PERSONAL_ACCESS_TOKEN`；平台只将它传给隔离的 QoderCN 进程，不写入仓库。Qoder 写入证明默认关闭；只有显式设置 `AGENT_PLATFORM_QODER_WRITE_ENABLED=1`，且 edit Mandate、专用 PAT 和同账号运行时隔离探针均通过时才签发。写入 Run 仅加载私有临时 Qoder 配置，并只信任该 Run 克隆，不读取个人 Qoder 配置。写模式下专用 PAT 会进入 Qoder 进程环境，开发阶段可执行命令可能读取它；此边界已获确认。阶段五外部动作仍须满足 Task Mandate、固定 SHA、风险和审批门禁；本仓库没有可固定目标 SHA 的自动合并模式，合并由人操作。

低风险自动开发通道仅对 `agent-platform` 的人工提交、明确要求改代码的任务开放，提交页无需选择。服务仍会检查独立克隆的开发提交、实际 diff、`src/**`、`tests/**`、`web/src/**` 路径限制、敏感内容、固定 SHA 验证和独立审查；符合条件后在待办总览生成开 PR 审批，批准前不会推送任务分支。仓库配置中的 `autoPr.enabled` 控制该通道，缺省关闭。运行服务时须显式开启阶段五 Worker、Qoder 写入证明和外部写操作三个开关，并提供专用 Qoder PAT 与仓库受限写令牌；重启后才会加载配置。批准后平台推送任务分支并创建 PR，合并仍由人在 GitHub 上操作。

在已导出 `QODERCN_PERSONAL_ACCESS_TOKEN` 的终端运行 `node --import tsx scripts/rehearse-qoder-write.ts`，可在 `.runtime/write-rehearsal/` 的一次性本地仓库演练真实 Qoder 修改、提交、diff 与隔离检查；脚本不访问 GitHub 远端，也不改动当前工作树。develop 的 Qoder 自身工具确认被跳过，工具仍限于 Read/Grep/Glob/Edit/Write/Bash，文件隔离由 macOS 沙箱执行。2026-11-08 的真实本地演练通过：基线 `93c3d56799d112a9cd36274108972fbcdec1782f`，提交 `f17ac9dc544af3db1afa73bca6da19da8cdcb879`，仅改 `probe.txt`，隔离 Git 检查通过且克隆干净；证据在 `.runtime/write-rehearsal/probe-6ajzqV/`。正式服务可在保留外部写操作关闭的同时设置 `AGENT_PLATFORM_QODER_WRITE_ENABLED=1` 与 `AGENT_PLATFORM_STAGE5_WORKER_ENABLED=1`；edit 审批会显示并要求 `maxAutoRisk=high`。完整 Task 的 develop → verify → review 链仍需单独演练。

交互 API 默认只监听 `127.0.0.1:8765`，凭据首次启动时随机生成于 `~/.config/agent-platform/local-api.token`，文件要求仅当前用户可读。`GET /inbox` 查看待人事件、问题和任务；`GET /tasks/:id`、`GET /events/:id` 查看详情；`POST /routes`、`POST /answers`、`POST /approvals` 提交对应决定。`POST /tasks/reopen` 需 `reopen` 角色，提交旧 Task ID、关联调查 Task ID、调查 Run 与成功报告 ID、复现判定、受审 SHA、预期 iteration/更新时间、幂等键和理由；成功后旧 Task 进入新一轮只读调查，关联调查 Task 记移交并停止派活。所有请求均需 `Authorization: Bearer <凭据>`；请求体不能指定 actor 或角色。上述设置可在 `config/platform.json` 的 `interaction` 中配置。

默认 DevOps 项目组未配置可用仓库，事件会进入人工复核。当前配置已启用 Qoder；四份阶段 Skill 已在 Git HEAD 中。每个 Run 使用独立的临时 Git 克隆，代码与 `.git` 都在该 Run 的目录内；复用与验证时核对克隆身份、origin 和提交。SkillLoader 只读取指定 Git 提交中的非空 Skill。本机 Qoder 1.1.83 曾验证最小 JSON 调用、指定提交 Skill 注入、图片附件，以及在生成的只读沙箱配置下由 `AgentRunner` 完成一次直接调查；原生 `--resume` 仅在旧克隆内成功，跨独立克隆找不到旧 Session。Runner 从流式输出保存原生 Session ID，只有首条助手输出或成功的最终结果才确认初始输入；初始化事件不能充当接收回执，提前退出则暂停待人核对。真实只读隔离边界已接入启动组装；浏览器登录凭据曾在服务端 `auth.getUserInfo` 返回 401；随后 QoderCN PAT 在终端直连时成功，但隔离 Run 因屏蔽用户设置中的 VPC 实例名，错误地向公共认证主机交换令牌并返回 400。现已在启动时只提取并校验 `vpcInstanceName`，通过显式 `--settings` 传给隔离 CLI，仍不加载用户插件和 Hook；2026-11-08 重启后的真实只读 investigate Run 已成功：PAT 交换与用户信息请求均在企业 VPC 主机返回 200，结果含仓库名，进程终止已确认，固定 SHA 工作区干净。阶段五 verify/review 及外部写演练仍须按结构化记录核验。可靠用量、生产写入隔离及完整 develop 结果仍未验证。本机暂不要求专用 OS 账号。具体阶段三证据见 `阶段三-Qoder验证记录.md`。

仓库配置的 `localChecks` 使用 `command`、`args[]`、`timeoutMs` 定义受信命令；默认仓库执行 `npm run typecheck` 和 Node 自动发现测试。后者仅在隔离 Run 中排除 6 项依赖宿主机临时目录、全局 Git 身份或会在只读克隆中构建的测试，宿主机仍执行完整 `npm test`。开发 Run 结束后，WorkerManager 先核对独立克隆归属、基线祖先关系、干净工作区、HEAD 和非空 diff，再将这些命令交给同一 Run 的已验证隔离边界执行，最后复核 HEAD 与工作区状态。检查修改代码、超时、无法运行或进程终止未确认都会阻断 verify。每条检查保存实际参数、起止时间、结果、退出码、日志引用和终止确认状态。临时仓库中的真实 Qoder 和沙箱检查已有分项探针，但尚未形成经 WorkerManager 的完整执行链。

仓库可在 `verify` 中声明 `mode: "platform"`，让 verify Run 直接由平台在固定 SHA 的可写副本里执行 `prepare` 与 `localChecks`，不启动 Qoder 会话；`workspace` 必须为 `copy`。`prepare` 使用与 `localChecks` 相同的 `command`、`args[]`、`timeoutMs` 结构，`env` 支持 `${CACHE}` 和 `${CHECK_WORKSPACE}` 占位符，且拒绝 `*TOKEN*`、`*SECRET*`、`*KEY*` 等敏感变量名。`cacheKeyFiles` 中的锁文件内容共同决定缓存目录 `.runtime/caches/<repoKey>/<hash>`；锁文件变化会自动切换缓存。当前 `agent-platform` 仓库的 verify 已使用该模式，缓存 npm 下载物，不缓存 `node_modules`。平台 verify 仍要求 stage5 Worker 的沙箱运行能力；它不需要 Qoder 会话，但需要已验证的执行边界。

运行目录按保留策略清理：`closed`、`cancelled`、`released` 状态且没有活跃 Run 的 Task，其 `clones/` 下的 Run 克隆在超过 `AGENT_PLATFORM_WORKSPACE_RETENTION_DAYS`（默认 7 天）后删除；`check-workspaces/` 在对应 Run 结束后超过 `AGENT_PLATFORM_WORKSPACE_ORPHAN_HOURS`（默认 24 小时）后删除；没有 Run 记录的孤儿目录也按同一个 orphan 宽限期清理。清理只在服务启动时执行一次，不在运行期间定时执行；正在运行、等待人工、暂停、待审或待合并的 Task 不会被清理。

清理策略也可手动演练：`npm run prune-workspaces -- --dry-run` 只统计不删除；去掉 `--dry-run` 才执行。建议在停服后运行，避免与正在创建克隆的 Worker 竞争。保留周期用 `AGENT_PLATFORM_WORKSPACE_RETENTION_DAYS`（默认 7）和 `AGENT_PLATFORM_WORKSPACE_ORPHAN_HOURS`（默认 24）调整；数据库和运行根目录分别由 `AGENT_PLATFORM_DATABASE`、`AGENT_PLATFORM_RUNTIME_ROOT` 指定。
