# 阶段五风险规则草案（待人工审阅，未启用）

受信目标分支来自按 `repoKey` 选出的 `RepositoryConfig.targetBranch`，不是 Agent、事件或浏览器输入。`TaskMandate` 授权仓库和动作，当前没有目标分支字段；因此动作请求必须与该仓库配置的目标分支一致。配置目标变化须提高 `policyVersion`，使旧审批失效。`open_pr` 和 `merge` 的动作审批均绑定 Task、动作、sourceSha、targetBranch、targetSha 和策略版本；`merge` 另绑定 ChangeRef。开 PR/MR 前的目标 SHA 从平台目标分支 HEAD 读取；合并前从当前 ChangeSnapshot 读取，不能由 Agent 提供。

判定顺序：Mandate 范围 → 禁止规则 → 确定性风险 → `maxAutoRisk` → 必要审批 → 执行前重检。确定性规则给出最低风险等级；模型只能提高等级或要求确认，不能降低等级或解除禁止。未知规则结果、缺证据或无法比较时默认阻断。

| 情况 | 最低风险 | 判定结果 |
| --- | --- | --- |
| 仓库、目标分支与受信配置不符；动作不在 Mandate 内 | — | **禁止当前动作**；动作超范围可先申请 `scope_change`，批准并更新 Mandate 后重新判定 |
| 不可逆数据库操作、直接写生产环境、读取或修改平台凭据、绕过受信 CI/审批/保护规则 | — | **禁止**；阶段五不提供这些执行能力 |
| 涉及密钥或权限配置、数据库迁移、CI 或发布配置的路径或 diff | high | **待审批**；有权者审阅具体影响。敏感路径包括 `**/.env*`、`**/*secret*`、`**/*credential*`、`**/migrations/**`、`.github/workflows/**`、`.gitlab-ci.yml`、`**/deploy/**`、`**/release/**`；路径命中只是提高风险，仍须检查实际 diff |
| 普通源码或测试改动，未命中上述风险且有完整 diff 与检查证据 | low | Mandate 允许且 `maxAutoRisk` 不低于 low 时，验证和审查**可自动执行**；外部动作仍按下两行审批 |
| 推分支、开 PR/MR | medium | **待审批**；需当前 sourceSha、targetBranch、targetSha、policyVersion 的 `open_pr` 动作批准 |
| 合并 | high | **待审批**；需 ChangeRef、sourceSha、targetBranch、targetSha、policyVersion 的 `merge` 动作批准及通过的审查、必需 CI、平台门禁 |
| 风险高于 `maxAutoRisk`，或风险、路径影响、检查状态未知 | unknown | **暂停相关动作**，请求有权者处理；未知情况不自动执行 |
| 阻断审查意见 | high | **禁止合并**，直到修复并重审，或有权者结构化记录接受风险/误报及理由、意见 ID、受审 SHA |
| sourceSha、targetSha、目标分支、审查结论或策略版本变化 | — | **禁止沿用旧结论和批准**；重新计算并按需重新审批 |
| 平台不能原子固定目标 SHA，且没有实测有效的 merge queue/train 或等价机制 | — | **禁止自动合并**；停在 `ready_to_merge` 交人处理 |

普通代码行数不单独决定风险等级。平台保护规则与仓库配置的必需检查取并集；缺失、运行中、失败或未知均不放行。批准与副作用均在服务端以当前 Task、仓库配置、平台快照和策略版本重检。
