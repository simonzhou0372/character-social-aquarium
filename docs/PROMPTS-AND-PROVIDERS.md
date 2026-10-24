# 提示词系统与 Provider

## 七类独立配置

`promptDefinitions` 保存内置默认文本，`promptConfigs` 保存用户当前内容。条目包含 key/content/enabled/updatedAt/customized/defaultVersion，整体包含递增 version 与消息规则。默认文本更新不自动写回用户内容；`migrateDefaults` 仅允许提升未自定义条目。

编辑保存、恢复默认和导入均递增整体版本。修改条目与保存生成规则使用本地事务，避免两个标签页同时保存不同分类时丢失其他分类。导入全部配置属于显式完整替换，并先展示预览确认。

| 任务                             | 启用的规范                            |
| -------------------------------- | ------------------------------------- |
| chat（主动、用户互动）           | behavior + social                     |
| life（本地已规划生活的 AI 描述） | life                                  |
| recovery（恢复活动描述）         | recovery + life                       |
| recoveryChat（恢复具体对白）     | recovery + life + behavior + social   |
| profile（资料帮写）              | profile                               |
| memory（长期记忆）               | memory                                |
| inPerson（线下场景）             | life + behavior + inPerson            |
| offlineScene（离线场景）         | recovery + life + behavior + inPerson |

被停用的分类不会进入请求。没有将七类规范无条件拼接。程序输出契约与事实/时间/合法身份校验优先，世界事实及锁定关系其次，启用的全局规范优先于角色个人措辞。提示词是模型行为约束，结构与范围要求由代码兜底。

## 版本快照

普通任务在启动时读取最新配置。恢复任务在开始时持久化完整配置到 `taskSnapshots`，中断恢复继续使用该快照，直到目标时间完成。每次模型任务和模拟段日志都记录 promptVersion。修改提示词不会重写历史，也不会改变一个已经启动的恢复批次。

个人偏好只允许更严格的消息条数、更短的建议长度。不能通过个人口吻重新开启全局禁用的 Markdown、动作或心理描写。

## 结构化对白

内部只接受 JSON：

```json
{
  "speakerId": "c-nagi",
  "messages": ["海风有点凉。", "带件外套吧。"],
  "offsets": [0, 4]
}
```

`messages` 每项保存为一条独立 Message，递增会话 seq 并保留同一事件关联。消息中换行仍属于同一条，不使用换行或 Markdown 列表猜测分段。offsets 可选，必须与消息数相同、非负递增且不超过 60 秒，批次放在事件许可时间范围内。

默认 1～3 条，建议 10～60 个字，单条硬上限 150 个 Unicode code point，允许空数组表达沉默。关闭连续发送时有效上限一条。建议长度不是强制下限。

JSON 的引号、数组、字段名是内部结构，不受「不输出 Markdown」限制。仅对 `messages` 内正文检查常见 Markdown 标记、动作括号、心理描述前缀与服务式套话。未知角色、过长消息、非法时间偏移、无效 JSON、非法结构整批拒绝，历史与检查点不受半成品写入影响。没有无限修复循环。

格式检查无法可靠判断所有语义（例如没有标记的心理旁白）；世界观事实及自然语言人格一致性仍依赖模型遵守上下文，不能宣称程序已证明所有叙述事实正确。

## Provider 接口

```ts
interface Provider {
  complete(messages: ChatInput, signal?: AbortSignal): Promise<Completion>;
}
interface Completion {
  content: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}
```

`CompatibleProvider` 向用户指定 Base URL 的 `/chat/completions` 发送 POST，使用 Bearer 鉴权。提供商应接受 model/messages/temperature/max_tokens，返回 `choices[0].message.content` 字符串。用量优先使用 usage.prompt_tokens / completion_tokens，否则采用明确标为估算的计数。当前不启用流式输出。

模型列表通过 GET `/models` 获取，不假定任何当前可用模型 ID。连接测试使用极短请求。模型没有返回 JSON 结构时应用不写入无效内容。

HTTPS 是默认要求，回环地址 localhost / 127.0.0.1 / ::1 允许 HTTP。拒绝包含 URL 凭据、查询参数或片段的端点；禁止重定向鉴权请求；请求不携带站点 Cookie、Referrer。密钥不写入日志、URL、备份或静态构建。

错误分类：missing（未配置）、invalid（401）、permission（403）、quota（429 配额不足）、rate（429 限流）、timeout、network（浏览器通常无法进一步区分断网与 CORS）、json/schema/format/length、server（5xx）、budget。网络错误不删除密钥；401 才标记配置无效并重新提示配置。

每次任务预留 Token 与请求预算，成功后用服务商计量纠正；失败保留保守预留，避免故障时无限消耗。没有自动无限重试。用户之后的调度机会可再次尝试，但仍受每日与补全预算限制。

MockProvider 只可在测试中显式注入；正式 live 世界不会选择它。无 Key 的演示是独立模式，消息来源写为 demo 并显示标签，不能伪装真实 AI 生成。

## 后续修复：结构、压缩与输出预算

新增 worldDraft（资料 + 生活规范）和 groupDraft（资料 + 社交规范），不会套用对白的 Markdown 禁令。生成示例是完整有效 JSON 对象，先预览再采用。

所有任务经过本地上下文预算器，报告保留/省略数量。输入预算默认 32,000 Token，可配置到 1,000,000；保留已有手动配置，不根据未验证的模型名推断窗口容量。它是压缩后请求的上限，并不强制发送这么多内容；仍保留事实保护及选择性压缩。输入预算与输出预算分离，普通任务默认输出 2048 Token，整套世界与团体草稿分别保留 5000/3500。对白截断时紧缩上下文并最多恢复一次；不把半截 JSON 写入消息，不重发用户消息。

除了单个 JSON 外层围栏，程序兼容实测出现的 messages 数组括号错位。修复只提取已有的 JSON 字符串 token，不按文本行猜消息；仍校验唯一合法发送者、最多三条、单条长度和合法时间偏移。

已知 DeepSeek 日常模型的自动模式发送 `thinking: {type: "disabled"}`。DeepSeek 文档说明当前默认开启深度思考，并用 reasoning_content 返回推理；JSON 模式仍需要合理输出上限。参考 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 与 [JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。用户可显式保留模型默认行为，其他提供商不自动发送这个专用参数。

线下场景使用独立的阶段/条目契约与 300 字对白硬上限，不套用网聊 1～3 条规则。阶段、合法发言人、时间边界、顺序及总对白预算由 `core/scenes.ts` 校验。每日场景数量与抽样比例独立配置，单场对白预算按时长及事件重要性分配。内部 JSON 从不作为角色的 Markdown 内容。新增提示词会补齐旧配置，保留自定义六类内容并递增配置版本。

无限制模式只取消应用的累计请求/Token/消息与补全总预算拦截，仍保留两路并发、每次最多一次结构恢复、分段任务上限、服务商错误以及独立场景密度控制。
