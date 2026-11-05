# Agent 自动化中台

当前完成阶段 1 的领域契约、SQLite 迁移和本地事件保存；阶段 2 已实现 DevOps 缺陷列表与详情适配器、五分钟轮询、去重和 pending 事件交接。尚未提供鉴权方案，未调用真实接口。

要求 Node.js 24+。本地运行：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run selfcheck
```

`src/event` 只负责来源标准化与保存；`src/agent/kernel` 定义统一信号和协调端口，阶段 3 才实现两个循环；`src/agent/task` 的状态转换同时生成历史记录并由 SQLite 原子提交；`src/agent/worker` 定义 Run 与 Agent 契约；`src/bootstrap` 按来源、Agent、仓库和发布环境选择已注册适配器。样本事件直接调用 `EventIngress`，不对外提供任意事件提交接口。

事件来源配置必须为每个 `sourceId` 指定可保留的 `metaData` 字段；入口和仓储都拒绝未列入的字段。默认 Mandate 仅由受信接单规则生成低风险调查授权；扩大授权必须来自平台核验过的人工审批记录。`actor.kind='human'` 和 `approvalRef` 是数据契约，不等于身份验证：接入交互 API 时仍须核验登录身份、审批角色与记录归属，且外部动作继续由门禁执行前重检。

阶段 2 的任务由 `config/schedules.json` 配置间隔、启停和参数；`config/platform.json` 注册受信来源。启动时先校验任务参数、来源身份与启停状态，再注册来源并启动定时器；同一来源不能配置多个扫描任务。SQLite 写入也会拒绝未注册或已禁用的来源。修改配置后需重启。

服务入口是 `npm start`（先运行 `npm run build`）。启动前需设置 `AGENT_PLATFORM_AUTH_PROVIDER` 为受信 JavaScript 模块路径，该模块导出异步 `authorizationHeaders()`，返回当前请求所需的请求头；仓库尚未实现凭据获取与刷新。可用 `AGENT_PLATFORM_CONFIG`、`AGENT_PLATFORM_SCHEDULES`、`AGENT_PLATFORM_DATABASE` 覆盖三个默认路径。默认缺陷任务启动即扫描，此后每 300 秒扫描一次；停止时等待当前扫描完成并关闭数据库。每轮从第一页重扫，页码在并发增删时可能移动。真实接口演练待鉴权方案提供后进行。

阶段 3 再实测 Qoder 的 Session 恢复、输入、取消、图片、Skill 和用量能力；阶段 5/6 再验证 GitHub/GitLab 的 CI、合并及发布接口与真实执行隔离。
