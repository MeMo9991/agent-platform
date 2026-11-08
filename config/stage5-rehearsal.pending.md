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

以上未配置或未确认项补齐并经过受限权限、保护规则和目标 SHA 控制演练前，不启用阶段五外部写操作，也不把真实合并验收标为通过。2026-11-08 用户重启后，Qoder 克隆目录已由新服务创建，说明配置已加载；服务 API 仍报告外部写开关为 `true`，需再次以 `AGENT_PLATFORM_STAGE5_WRITES_ENABLED=0` 明确覆盖并复核。

2026-11-08 用户提供的已登录 GitHub 截图分别显示[规则页](https://github.com/MeMo9991/agent-platform/settings/rules)原来没有规则、[分支设置页](https://github.com/MeMo9991/agent-platform/settings/branches)原来没有经典保护规则，个人资料页显示账号 `MeMo9991`。随后通过[草稿 PR #1](https://github.com/MeMo9991/agent-platform/pull/1)的 GitHub Actions 得到精确检查名 `verify`，其提交 `00f7c1e` 的检查通过，并创建上述 active Ruleset。现有本机 Git 凭据经只读 API 验证为 `MeMo9991`、仓库 admin；这不等于运行服务的受限凭据。服务进程中已检测到 `AGENT_PLATFORM_GITHUB_TOKEN` 存在，但未读取令牌值，也未验证其权限。

后续顺序：先关闭当前服务的阶段五外部写开关；验证运行服务令牌的仓库权限。再用真实 PR 复核规则的阻断效果；若增加独立审查账号，再设置对应审批人数。个人账号仓库无 merge queue，自动合并保持关闭。
