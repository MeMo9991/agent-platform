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

`config/local.yaml` 的 `platform.projectGroups` 直接包含各组仓库，所有项目组都可人工提交事件。`schedules` 的任务通过 `projectKey` 指向项目组，任务 `id` 是稳定的扫描事件来源 ID。DevOps 缺陷任务在自身配置 `businessProjectId` 和 `pageSize`；GitHub PR 任务扫描组内仓库面向各自 `targetBranch` 的开放 PR。新增同组仓库只改该项目组，新增扫描类型才需要实现一次适配器。启动时校验项目组和任务并注册来源；SQLite 拒绝未注册或已禁用的来源。修改配置后需重启。

微服务项目组用 `searchRoot` 指定私有本地目录，用 `defaultRepoKey` 指定无明确代码线索时的主责仓库。组内各仓库分别配置远程项目、本地 `localPath` 和合并目标 `targetBranch`；只有路径位于 `searchRoot` 内且 Git `origin` 与受信配置一致时才可自动选择。来源文本明确包含唯一仓库键，或两个代码标识命中同一仓库的已跟踪文件名时选该仓库；否则选已就绪的默认仓库。人工提交先选项目组，可让系统自动选仓或在组内指定仓库。自动选择只创建调查范围，不授予 DevOps 或 GitHub PR 事件自动改码或提 PR 权限。既有事件和 Task 不会因配置修改重新归属。

安装依赖后运行 `./start.sh`。首次启动可以省略配置，服务监听 `http://127.0.0.1:8765`，创建本机 SQLite 与交互 API 凭据。项目组、扫描和 Agent 默认为空，可以先打开看板。需要登记项目时，参考 [通用示例](config/platform.example.yaml) 创建 Git 忽略的 `config/local.yaml`，只填写所需字段。该文件使用 `platform` 定义项目组、Agent、身份、预算和策略，使用 `schedules` 定义扫描任务。

在 `platform.agents` 的 Qoder 条目中可选填 `model`。省略时沿用 CLI 的模型选择，填 `auto` 时显式启用智能路由。指定模型时以 `qoderclicn --list-models` 的输出为准。重启后创建的 Qoder 会话使用该配置，运行记录保存 CLI 初始化时回报的模型。

可选的 `instance` 指定 `runtimeRoot` 和 `database`，`capabilities` 分别控制 `stage5Worker`、`qoderWrite` 和 `stage5Writes`，默认全部关闭。`tools` 支持 `javaHome`、`mavenSettings`、`devopsAuthProvider`。`maintenance` 支持 `workspaceRetentionDays`、`workspaceOrphanHours`。自定义数据库所在目录必须归服务账号所有且仅该账号可访问。

启动时会预检已配置凭据的代码托管仓库。预检失败会在日志标出仓库和原因，本次启动关闭外部写入，看板和本地任务仍可使用。连接恢复后重启服务重新预检。

`./start.sh --check` 打印配置来源、端口、数据库和能力开关。普通设置统一通过配置文件修改，重启服务后生效。设置页显示启动时生效的配置，重新读取可检查文件变更和校验错误。项目组 Token 和 Qoder PAT 可在设置页更新。使用内置 DevOps 鉴权时也可在页面更新凭据。旧实例可继续通过 `.env` 中的 `AGENT_PLATFORM_CONFIG` 与 `AGENT_PLATFORM_SCHEDULES` 使用两份 JSON。进程环境优先于 `.env`。从进程环境显式指定旧配置路径时，使用该进程提供的整组环境变量。切换到本机 YAML 时需移除旧文件选择变量。外部 DevOps 鉴权模块须导出异步 `authorizationHeaders()`。

### 本地 Qoder / 阶段五演练启动
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

`config/platform.json` 当前启用 Qoder；服务只在启动时读取配置，改动后必须重启。上述命令保留阶段五 review Worker 和外部写操作开关关闭。当前 `agent-platform` 仓库的 verify 使用 platform 模式，不启动 Qoder 会话；需要启用 review Worker 时，可在 `npm start` 前设置 `AGENT_PLATFORM_STAGE5_WORKER_ENABLED=1`。从所用 QoderCN 企业实例的 Integrations 页面创建专用 PAT，在「配置 → Agent 与预算 → Agent」中保存。平台将 PAT 保存在本机权限为 0600 的凭据文件中，下次 develop 运行即生效。未保存时仍可通过启动环境变量 `QODERCN_PERSONAL_ACCESS_TOKEN` 提供。Qoder 写入证明默认关闭；只有显式设置 `AGENT_PLATFORM_QODER_WRITE_ENABLED=1`，且 edit Mandate、专用 PAT 和同账号运行时隔离探针均通过时才签发。写入 Run 仅加载私有临时 Qoder 配置，并只信任该 Run 克隆，不读取个人 Qoder 配置。写模式下专用 PAT 会进入 Qoder 进程环境，开发阶段可执行命令可能读取它；此边界已获确认。阶段五外部动作仍须满足 Task Mandate、固定 SHA、风险和审批门禁；本仓库没有可固定目标 SHA 的自动合并模式，合并由人操作。

低风险自动开发通道仅对 `agent-platform` 的人工提交、明确要求改代码的任务开放，提交页无需选择。服务仍会检查独立克隆的开发提交、实际 diff、`src/**`、`tests/**`、`web/src/**` 路径限制、敏感内容、固定 SHA 验证和独立审查；符合条件后在待办总览生成开 PR 审批，批准前不会推送任务分支。仓库配置中的 `autoPr.enabled` 控制该通道，缺省关闭。运行服务时须显式开启阶段五 Worker、Qoder 写入证明和外部写操作三个开关，并提供专用 Qoder PAT 与仓库受限写令牌；重启后才会加载配置。批准后平台推送任务分支并创建 PR，合并仍由人在 GitHub 上操作。

在已导出 `QODERCN_PERSONAL_ACCESS_TOKEN` 的终端运行 `node --import tsx scripts/rehearse-qoder-write.ts`，可在 `.runtime/write-rehearsal/` 的一次性本地仓库演练真实 Qoder 修改、提交、diff 与隔离检查；脚本不访问 GitHub 远端，也不改动当前工作树。develop 的 Qoder 自身工具确认被跳过，工具仍限于 Read/Grep/Glob/Edit/Write/Bash，文件隔离由 macOS 沙箱执行。2026-11-08 的真实本地演练通过：基线 `93c3d56799d112a9cd36274108972fbcdec1782f`，提交 `f17ac9dc544af3db1afa73bca6da19da8cdcb879`，仅改 `probe.txt`，隔离 Git 检查通过且克隆干净；证据在 `.runtime/write-rehearsal/probe-6ajzqV/`。正式服务可在保留外部写操作关闭的同时设置 `AGENT_PLATFORM_QODER_WRITE_ENABLED=1` 与 `AGENT_PLATFORM_STAGE5_WORKER_ENABLED=1`；edit 审批会显示并要求 `maxAutoRisk=high`。完整 Task 的 develop → verify → review 链仍需单独演练。

交互 API 默认只监听 `127.0.0.1:8765`，凭据首次启动时随机生成于 `~/.config/agent-platform/local-api.token`，文件要求仅当前用户可读。打开本机看板及其 `/api/*` 请求无需输入凭据；看板写操作仍按服务端配置的角色执行，浏览器跨来源请求会被拒绝。同机能访问本机端口的进程也能操作看板。独立交互端点仍需 `Authorization: Bearer <凭据>`：`GET /inbox` 查看待人事件、问题和任务；`GET /tasks/:id`、`GET /events/:id` 查看详情；`POST /routes`、`POST /answers`、`POST /approvals` 提交对应决定。`POST /tasks/reopen` 需 `reopen` 角色，提交旧 Task ID、关联调查 Task ID、调查 Run 与成功报告 ID、复现判定、受审 SHA、预期 iteration/更新时间、幂等键和理由；成功后旧 Task 进入新一轮只读调查，关联调查 Task 记移交并停止派活。请求体不能指定 actor 或角色。上述设置可在 `config/platform.json` 的 `interaction` 中配置。

默认 DevOps 项目组未配置可用仓库，事件会进入人工复核。当前配置已启用 Qoder；四份阶段 Skill 已在 Git HEAD 中。每个 Run 使用独立的临时工作区（investigate 只做一次 `git clone`，后续阶段使用轻量副本），代码与 `.git` 都在该 Run 的目录内；复用与验证时核对克隆身份、origin 和提交。SkillLoader 只读取指定 Git 提交中的非空 Skill。本机 Qoder 1.1.83 曾验证最小 JSON 调用、指定提交 Skill 注入、图片附件，以及在生成的只读沙箱配置下由 `AgentRunner` 完成一次直接调查；原生 `--resume` 仅在旧克隆内成功，跨独立克隆找不到旧 Session。Runner 从流式输出保存原生 Session ID，只有首条助手输出或成功的最终结果才确认初始输入；初始化事件不能充当接收回执，提前退出则暂停待人核对。真实只读隔离边界已接入启动组装；浏览器登录凭据曾在服务端 `auth.getUserInfo` 返回 401；随后 QoderCN PAT 在终端直连时成功，但隔离 Run 因屏蔽用户设置中的 VPC 实例名，错误地向公共认证主机交换令牌并返回 400。现已在启动时只提取并校验 `vpcInstanceName`，通过显式 `--settings` 传给隔离 CLI，仍不加载用户插件和 Hook；2026-11-08 重启后的真实只读 investigate Run 已成功：PAT 交换与用户信息请求均在企业 VPC 主机返回 200，结果含仓库名，进程终止已确认，固定 SHA 工作区干净。阶段五 verify/review 及外部写演练仍须按结构化记录核验。可靠用量、生产写入隔离及完整 develop 结果仍未验证。本机暂不要求专用 OS 账号。具体阶段三证据见 `阶段三-Qoder验证记录.md`。

开发 Run 完成后，平台核对隔离工作区的基线、提交和非空差异，再复核工作区状态。项目组校验命令由对应代码实现提供，在 verify 阶段的固定 SHA 可写副本中执行；每条检查保存参数、结果、退出码、日志和终止确认。未归属项目组的旧仓库配置仍可使用 `localChecks` 与 `verify`，以兼容已有部署。

新格式按 `verification.type` 选择组级校验。每个参与校验的仓库需要 `localPath`，实例需要开启 `capabilities.stage5Worker`。省略 `verification` 或设为 `false` 时，开发完成后等待人工交付审批。

- **仓库内 Maven** 可使用 `"verification": { "type": "maven" }`。默认在固定 SHA 的隔离副本中以 `pom.xml` 执行 `mvn verify`，可通过 `buildFile` 选择仓库内其他相对路径。
- **跨仓库 Maven** 使用 `"verification": { "type": "maven", "scope": "group", "buildFile": "build/pom.xml" }`。项目组提供 `searchRoot`。平台固定组内仓库快照，按 Git 差异选择 Maven 模块，并只运行本次新增或修改的测试类。项目专用 JVM 参数可放在 `testJvmArgs`。
- **npm** 可使用 `"verification": { "type": "npm", "checks": [{ "command": "npm", "args": ["test"], "timeoutMs": 120000 }] }`。依赖准备使用 `npm ci --ignore-scripts`。检查命令由本机受信配置声明，在固定 SHA 副本中执行。

`tools.javaHome` 和 `tools.mavenSettings` 可按需指定本机 JDK 和 Maven settings。组级校验和托管平台的 `requiredChecks` 分别执行，修改配置后需重启服务。

旧实例可运行 `npm run --silent config:migrate` 预览新 YAML。预览只向标准输出打印配置，待处理旧字段和凭据环境变量名称写到标准错误。确认后将结果保存为 `config/local.yaml`，并归档旧 `config/local.json` 或从 `.env` 移除旧文件选择变量。同时存在 `local.yaml` 和 `local.json` 时，启动会报告冲突。已有项目、仓库和扫描 ID，以及数据库路径和能力开关会保留。`credentials.devopsFile`、`credentials.codeHostFile`、`credentials.qoderPatFile` 可保存凭据文件路径，令牌值仍由原凭据来源提供。兼容期内旧启动方式仍支持原有布尔配置。

可选的 `"functionalVerificationUrl": "http://127.0.0.1:8888"` 仅接受本机 HTTP 地址，且要求该项目组启用 `verification`。未配置时，verify 编译与现有检查通过后直接进入 review；配置后，平台在 review 前安排独立的只读 Agent Run，针对任务目标调用本地服务观察修改后的功能。Agent 返回通过、失败或无法本地验证；失败可返回 develop 修复，无法验证时等待人工处理。若功能验证 Run 超时、暂停或因无效结果阻塞，平台在确认进程已结束且固定 SHA 的 verify 通过后请求人工审批；批准后进入 review，驳回后可重试功能验证。已处理的审批保留在任务「待处理」历史中，不计入待审批数量。服务由使用者启动，平台目前不能证明它运行的就是任务提交，必要时需人工核对服务版本。配置保存后需重启服务。

运行目录按保留策略清理：`closed`、`cancelled`、`released` 状态且没有活跃 Run 的 Task，其 `clones/` 下的 Run 克隆在超过 `AGENT_PLATFORM_WORKSPACE_RETENTION_DAYS`（默认 7 天）后删除；`check-workspaces/` 在对应 Run 结束后超过 `AGENT_PLATFORM_WORKSPACE_ORPHAN_HOURS`（默认 24 小时）后删除；没有 Run 记录的孤儿目录也按同一个 orphan 宽限期清理。清理只在服务启动时执行一次，不在运行期间定时执行；正在运行、等待人工、暂停、待审或待合并的 Task 不会被清理。

清理策略也可手动演练：`npm run prune-workspaces -- --dry-run` 只统计不删除；去掉 `--dry-run` 才执行。建议在停服后运行，避免与正在创建克隆的 Worker 竞争。维护脚本使用与服务相同的配置入口，保留周期来自 `maintenance`，数据库和运行根目录来自 `instance`。旧环境变量仍可读取。

服务启动任务集中在 `src/bootstrap/runtime/startup-tasks.ts`：先按保留策略清理 Run 克隆和检查副本，再检查 `platform.agents` 中已注册且启用的智能体。当前对 `qoder` 执行 `qoderclicn status`，没有有效 `Username` 或命令失败时，不阻断服务启动，而是在待办总览的“待处理事件”区域显示“智能体 qoder 未连接”，并附带检查时间和原因。该状态只在启动时检查一次，修改登录状态后需重启服务。

工作区复用改为“每个 Task 一次 `git clone` + 每阶段独立轻量副本”：investigate 首次从 `localPath` 克隆一次；develop 从 investigate 的固定基线副本复制；verify/review 及修复 develop 从对应 develop commit 的副本复制。macOS 上使用 APFS clonefile（`cp -cR`），其他平台回退普通复制。每个副本复制后会重置到固定 SHA、清理未跟踪文件和构建产物，并重建 `.git/config`、移除 hooks 与 `agent-input`，因此各阶段仍是独立工作树，不共享 develop 的残留状态。
