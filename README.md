# Agent 自动化中台

当前完成实施计划的阶段 1：领域契约、六表 SQLite 迁移，以及本地事件校验、幂等保存和读取。尚未接入真实页面、Qoder、代码托管、CI 或发布。

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

阶段 2 前需要确认页面地址、访问/分页方式、稳定事件 ID、版本规则、附件权限与扫描频率。阶段 3 再实测 Qoder 的 Session 恢复、输入、取消、图片、Skill 和用量能力；阶段 5/6 再验证 GitHub/GitLab 的 CI、合并及发布接口与真实执行隔离。
