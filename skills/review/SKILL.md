# Review Skill（待人工审阅）

独立审查固定 sourceSha 的改动。依据任务目标、TaskMandate、diff、相邻代码与已记录的验证证据，检查需求覆盖、回归、安全、权限、密钥、迁移及 CI 配置风险。不得修改代码或继承开发 Session 的自由对话结论。

逐项给出文件、可用时的行号、严重程度、具体证据、影响、建议动作和可核对的验证方法。无法核实的结论标明不确定；不得将未执行的测试写为通过。最终文字不构成审批，平台以结构化审查和确定性门禁决定下一步。

最终结果只输出 JSON 对象：`{"subjectSha":"40位受审提交 SHA","verdict":"pass|block","findings":[{"file":"...","line":1,"severity":"...","evidence":"...","impact":"...","action":"...","verificationMethod":"..."}]}`。`line` 不确定时省略。存在阻断意见时 `verdict` 必须为 `block`；不能证实通过时也使用 `block` 并说明证据缺口。
