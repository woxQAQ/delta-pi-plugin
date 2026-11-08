# Delta / Pi 接口调查与验收依据

## 来源

本实现根据以下一手资料编写：

- [Delta CLI Get Started](https://delta.dev/docs/cli/get-started)：安装、认证、组织、分享范围、worktree 与 JSON 输出。
- [Build a Coding Agent Plugin](https://delta.dev/docs/cli/build-a-plugin)：recording contract 8、序列号、ACP v2 更新、watch 生命周期、挂载、接管与恢复。
- [Claude Code Plugin](https://delta.dev/docs/cli/claude-code)：用户可见的分享／加入行为及隐私范围。
- [delta-claude](https://github.com/zed-industries/delta-claude)：完整参考实现。本次调查的浅克隆位于 `/home/woxQAQ/git-for-agents/delta-claude`，提交为 [`9c6cac8a11e26c9932f0cc491fd6393c175f0b25`](https://github.com/zed-industries/delta-claude/tree/9c6cac8a11e26c9932f0cc491fd6393c175f0b25)。
- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)、[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)：扩展注册、session 生命周期、包清单及验证接口。

Pi 的适用依据为本机 **1.4.0** 文档及 `@earendil-works/pi-coding-agent@1.4.0` 的运行时代码／类型声明，优先于在线 main 分支。项目锁文件固定了开发验证所用版本。

## 协议结论

1. Delta CLI 是唯一集成接口；不能直接访问 Delta 数据库。[来源：Build a Coding Agent Plugin](https://delta.dev/docs/cli/build-a-plugin)
2. `thread contract` 的版本与记录的 `schemaVersion` 是两套版本。本文档描述 contract 8，记录仍使用 `schemaVersion: 1`。本插件要求 CLI 的支持区间包含 8；不推断更高版本具有相同语义。[来源：Connect a session](https://delta.dev/docs/cli/build-a-plugin#connect-a-session)
3. `source` 与 `external-id` 联合标识 producer。重复 create 可恢复同一线程；丢失本机序列／outbox 后不能从 1 重建同一个 producer。[来源：Connect a session、Recover safely](https://delta.dev/docs/cli/build-a-plugin)
4. worktree attach 只声明附件。持续运行 mount 才上传和同步文件；其 ready 行是文件就绪边界，watch 的 `live` 和 turn 的 `idle` 都不能代替它。[来源：Prepare files for joining](https://delta.dev/docs/cli/build-a-plugin#prepare-files-for-joining)
5. append 的输入是 UTF-8 JSONL。running 更新的 `turnSequence` 等于其 `sequence`，同一 turn 的内容、idle 与迟到输出必须沿用此值。完整消息可重复使用相同 `messageId`；逐 token chunk 更新不受支持。[来源：Send conversation updates](https://delta.dev/docs/cli/build-a-plugin#send-conversation-updates)
6. 只有逐条确认后才能删除 outbox。相同内容重放返回 duplicate；fenced 表示旧 turn 被接管、该记录未写入。producer.turn superseded 与当前 turn 的 fenced 都要求取消本地工作。[来源：Recover safely](https://delta.dev/docs/cli/build-a-plugin#recover-safely)
7. watch 没有续传游标，每次重连先发送完整快照。item 替换、item.append 扩展、remove 删除；after_id 定义顺序。新活动只能加入上下文，不能自动启动 agent turn。[来源：Receive shared activity](https://delta.dev/docs/cli/build-a-plugin#receive-shared-activity)
8. 重试由 JSON `error.retryable` 和 `retry_after_ms` 决定，`reason` 只用于诊断。[来源：Recover safely](https://delta.dev/docs/cli/build-a-plugin#recover-safely)
9. thread share 默认为组织范围；thread invite 保留已有范围，逐地址结果需要展示。unshare 保留显式邀请访问。[来源：Get Started](https://delta.dev/docs/cli/get-started)
10. Git 忽略文件和本地 Git 状态不共享；joined checkout 可能在 mount 退出后删除。[来源：Claude Code Plugin](https://delta.dev/docs/cli/claude-code)

## Pi 适配

- 通过 `session_start` 恢复连接，通过 `session_shutdown` 释放进程和状态锁。扩展 factory 只注册 handler，不启动后台资源。[来源：Pi extensions runtime lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- `before_agent_start` 建立 Delta turn 所有权；`message_end` 导出完整消息；`agent_settled` 标记最终 idle。`agent_end` 之后仍可能继续重试或队列工作，因此不能作为结束边界。[来源：Pi extensions lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- `ctx.abort()` 取消执行；`tool_call` 的 block 结果阻止后续工具。远端内容使用不触发 turn 的 `pi.sendMessage()`，不走 `sendUserMessage()`。[来源：Pi extension API 类型声明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- Pi 1.4.0 的 `newSession()` 不提供 cwd 参数。加入流程使用 `SessionManager.create(directory)`，写入不触发工作的初始化消息以持久化 session，再用 `ctx.switchSession()`；替换后只使用 fresh context。该方案通过 Pi 原生 session 文件携带 cwd，不修改进程全局 cwd。[来源：Pi session manager](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)、[extension context](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- 包清单通过 `pi.extensions` 声明入口；host-provided Pi 包放在 peerDependencies，开发时额外安装以检查类型。[来源：Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

## 实现边界

- 采用手动分享，不实现 Claude 的自动安装、自动更新、项目自动同步、模型生成摘要与子代理工作流。
- 按完整消息导出，逐条 append，减少流式输入和部分 batch 确认的状态组合。
- outbox、序列分配、已捕获消息集合保存在同一个原子替换的 JSON 文件内。写文件后 fsync；POSIX 上 rename 后再 fsync 父目录。
- 只有持有文件锁的进程可以使用 producer。锁丢失会终止操作，避免继续分配冲突序列。
- 连接断开时主动暂停本地工作，避免无法确认所有权时继续写共享 checkout。现阶段没有承诺无缝离线协作。
- 接收远端内容时去掉 thinking；消息／工具内容保留协作者身份标签，作为外部上下文传入。单项最多 8,000 字符，快照保留最新约 64,000 字符，并提供读取省略历史的说明。
- `nextTurn` 交付在 Pi 1.4.0 中先进入内存队列。恢复时从 session 的 `custom_message` 条目重建交付状态，重发尚未落盘的远端消息，避免提前标记完成后丢失上下文。
- 未改变系统配置，也没有安装／登录 Delta。当前 PATH 中 `delta --help` 显示的是 Git diff viewer，因此不能据此宣称完成真实云端验证。

## 验证

自动检查分为 TypeScript 类型检查、独立 CLI 进程集成测试和实际 Pi RPC 加载检查。CLI 模拟器实现 contract 8 的相关消息形状、回执及故障，不访问账号或网络。

使用真实 Delta 的人工验收步骤：

1. 在有 remote 的测试仓库中启动 Pi。运行 `/delta share`，拒绝确认，检查没有创建线程或 mount。
2. 再次分享并确认。核对 Delta 线程的用户消息、thinking、工具参数／输出，以及 staged、unstaged、非 ignored 的 untracked 文件。
3. 第二台机器用链接执行 `/delta join`。检查 Pi session cwd 在 Delta 返回的目录内；原会话仍可恢复，旧会话内容没有上传到该线程。
4. A 修改文件并完成 turn 后，B 读取该文件验证同步。B 发送请求接管 A 的运行 turn，检查 A 被取消，迟到内容不会复活旧 turn。
5. 中断 append 的回执传输后恢复，验证没有重复消息、序列复用或丢记录。中断 watch，再连接，验证快照没有重复注入。
6. 重启 Pi 并恢复原 session，检查 producer 不变、pending 继续重放、旧 turn 使用原 turnSequence 结束。
7. 退出 joined session，检查 mount 退出和非 ignored 变更上传；不要依赖 ignored 文件或本地分支保留。
8. 邀请多个测试地址（含失败地址），确认结果逐项可见。执行 unshare，核对组织访问取消而显式邀请仍有效。

上述真实云端步骤尚未在本环境执行。
