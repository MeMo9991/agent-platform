# 阶段五 GitHub 真实演练待填配置

仓库：`MeMo9991/agent-platform`（`repoKey: agent-platform`）。下表是演练输入清单，不由平台读取；“未确认”不能解释为“无此规则”或“检查通过”。

| 变量/配置项 | 当前值 | 演练前需确认或填写 |
| --- | --- | --- |
| `repositories[agent-platform].credentialsRef` | `env:AGENT_PLATFORM_GITHUB_TOKEN`；2026-11-08 本机服务进程中检测到变量存在，令牌权限未验证 | 用运行服务的受限令牌验证仅有演练仓库所需权限；令牌不写入仓库或文档 |
| `repositories[agent-platform].targetBranch` | `main`（本地配置；[GitHub 分支页](https://github.com/MeMo9991/agent-platform/branches)确认是默认分支） | 已确认演练目标分支；执行前仍重读目标 SHA |
| `repositories[agent-platform].requiredChecks` | `["verify"]`；[草稿 PR #1 的 CI](https://github.com/MeMo9991/agent-platform/actions/runs/42441815367) 在提交 `00f7c1e` 上通过，GitHub Check Run 精确名称为 `verify` | 已写入配置并设为 `main` 必需检查；继续用新 PR 验证规则实际阻断效果 |
| `main` 分支保护 / ruleset | [Ruleset #26785258](https://github.com/MeMo9991/agent-platform/rules/26785258) 已创建并复读为 active；GitHub 生效规则接口确认 `main` 上有要求 PR、`verify` 严格跟随目标分支、解决讨论、禁止删除/强推四项规则；绕过名单为空 | 待真实 PR 阻断场景复核；当前仅有一个已确认账号，必需 GitHub 审批数为 0，平台动作审批仍单独要求 |
| `main` merge queue | 当前无仓库级规则配置；GitHub 文档说明个人账号仓库不能使用 merge queue | 本仓库只允许人工合并；若未来迁至支持 merge queue 的组织仓库，另行配置并实测 |
| `interaction.actorId` 对应的审批人 | 平台为 `local-owner`；用户截图及现有 Git 凭据确认 GitHub 账号 `MeMo9991`，两者的运行时身份映射未验证 | 核对平台凭据绑定人员与 GitHub 操作者 |
| `interaction.roles` 中的审批角色 | `approve`（本地配置）；GitHub 协作者接口只返回仓库所有者 `MeMo9991`（admin），当前没有独立 PR 审查账号 | 核对该身份是否可批准平台 `open_pr`、`merge` 与高风险例外；若要求独立 GitHub PR 审查，先添加有权账号，再提高规则审批数 |

以上未配置或未确认项补齐并经过受限权限、保护规则和目标 SHA 控制演练前，不启用阶段五外部写操作，也不把真实合并验收标为通过。2026-11-08 当前服务进程已加载 Qoder，`AGENT_PLATFORM_STAGE5_WORKER_ENABLED=1`、`AGENT_PLATFORM_STAGE5_WRITES_ENABLED=0`；本地 API 同样报告外部写关闭。浏览器登录凭据在真实请求的 `auth.getUserInfo` 收到 401 后被 CLI 清除；本地 `status` 短暂显示已登录不能证明服务端接受。按 [Qoder CN CLI 官方认证文档](https://docs.qoder.cn/cli/authentication)，平台已支持把 `QODERCN_PERSONAL_ACCESS_TOKEN` 传给隔离进程，服务进程也确认该变量存在。两条真实只读探针事件 `65acb8ea-f14f-48ab-83bc-8b4f263abd59`、`cb71acfe-1ee6-4db1-9918-4d44d8503467` 的 investigate Run 均因认证失败而暂停；各自的 Qoder 进程组确认退出后，已清理两个测试 Task，解除旧服务的全局终止门禁。更新 PAT 后，终端直连 QoderCN 的 `auth.exchangeJobToken` 请求发往企业 VPC 主机并返回 200，真实回复为 `READY`、退出码 0；平台隔离 Run 的相同 PAT 却被发往公共主机并返回 400，服务端请求 ID 示例 `EB0F75E7-DE4C-40E1-96AE-99DABA725B5A`。根因是隔离参数 `--setting-sources ''` 同时屏蔽了用户设置里的 `vpcInstanceName`。平台现已只读取经校验的实例名，通过显式 `--settings` 传给隔离 CLI；不开放用户插件与 Hook。用户提供的企业实例 Integrations 截图确认令牌类型为 Qoder CLI CN 可用的个人访问令牌、账号为企业成员、过期时间 2027-11-01。重启后的真实只读 investigate Run（事件 `7f3c7dd9-f47f-46c6-b555-5331c98ac55c`，Task `9f041965-64f0-438f-b0db-c78c29b803cf`）已成功：PAT 交换和用户信息请求均向企业 VPC 主机返回 200，结果含仓库名且有持久引用，进程终止已确认，固定 SHA 工作区保持干净。已修复并加载“CLI 启动失败但进程组确认退出，仍全局阻塞其他 Run”的本地逻辑。

2026-11-08 用户提供的已登录 GitHub 截图分别显示[规则页](https://github.com/MeMo9991/agent-platform/settings/rules)原来没有规则、[分支设置页](https://github.com/MeMo9991/agent-platform/settings/branches)原来没有经典保护规则，个人资料页显示账号 `MeMo9991`。随后通过[草稿 PR #1](https://github.com/MeMo9991/agent-platform/pull/1)的 GitHub Actions 得到精确检查名 `verify`，其提交 `00f7c1e` 的检查通过，并创建上述 active Ruleset。现有本机 Git 凭据经只读 API 验证为 `MeMo9991`、仓库 admin；这不等于运行服务的受限凭据。服务进程中已检测到 `AGENT_PLATFORM_GITHUB_TOKEN` 存在，但未读取令牌值，也未验证其权限。

后续顺序：已用 QoderCN 专用 PAT 恢复只读 investigate Run，继续保持阶段五外部写开关关闭；验证运行服务 GitHub 令牌的仓库权限，并完成 verify/review 的真实固定 SHA 演练。再用真实 PR 复核规则的阻断效果；若增加独立审查账号，再设置对应审批人数。个人账号仓库无 merge queue，自动合并保持关闭。
