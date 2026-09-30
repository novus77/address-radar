# Automated Trader Backfill and Million-Token Mining SPAC

**Status:** Confirmed design

**Date:** 2026-09-26

**Project:** Address Radar

**Related specification:** `docs/specs/2026-09-26-multi-source-token-and-trader-discovery-spac.md`

## 1. Purpose

本 SPAC 定义 Address Radar 的完整自动化数据闭环，解决当前“已经观察到大量 Fomo 交易员，但钱包历史、候选证据和候选准入仍为空”的生产问题。

系统必须同时运行两条发现通道：

1. 以当前已观察交易员为起点，分层执行轻量回查、身份解析、60 天钱包历史回补、实时监控和周期复评。
2. 以 2026-08-10 至今五条链中达到过 1M 美元市值的代币为起点，反向发现早期高倍交易员，再回查其全部交易表现，验证能力能否重复。

两条通道最终必须汇入同一个规范事件、证据、候选准入和持续复评模型。

## 2. Production findings

截至本 SPAC 编写时，生产数据审计结果如下：

| Metric | Current value | Correct interpretation |
|---|---:|---|
| Trader entities | 10,722 | 已归一化的 Fomo 交易员实体，不代表钱包已解析 |
| Fomo accounts | 10,745 | 已观察到的 Fomo 账号 |
| Wallet identities | 215 | 实际已解析的钱包映射 |
| Active EVM monitored wallets | 73 | 当前实时注册表加载的 EVM 钱包 |
| Active Solana monitored wallets | 87 | 当前实时注册表加载的 Solana 钱包 |
| Probation entities | 101 | 当前非暂停实体 |
| Suspended entities | 10,621 | 被现有生命周期状态排除在实时监控之外的实体 |
| Canonical trader events | 19,721 | 已归一化交易事件，绝大部分来自 Fomo |
| Wallet monitor observations | 0 | 新钱包监控管线尚未成功形成规范观察 |
| Wallet analysis jobs | 1 | 仅存在人工创建任务 |
| Trader backfill jobs | 0 | 没有批量回查调度 |
| Recovery jobs | 0 | 没有生产恢复任务 |
| Candidate evidence v3 | 0 | 多源候选发现算法未接入生产循环 |
| Candidate discoveries | 3 | 旧历史流程生成的少量发现结果 |

额外运行问题：

- Solana 公共 RPC 对当前钱包轮询产生持续限流。
- 钱包监控历史上多次出现 `database is locked`。
- EVM 实时监控首次启动时从当前安全区块开始，不负责历史回补。
- 钱包分析服务只消费已存在的人工任务，不主动为地址库创建任务。
- 多源候选发现代码已存在且有测试，但没有生产 worker 调用。
- 控制台将“Fomo 账号已归一化”错误展示为“身份已解析”。

## 3. Goals

1. 最终轻量覆盖全部现有 10,722 个交易员及后续新增交易员。
2. 对高优先级且已解析钱包的交易员执行首次 60 天、最多 300 个代币的深度回补。
3. 对已完成首次回补的交易员持续执行增量回查。
4. 自动处理 2026-08-10 至今五条链中达到过 1M 美元市值的代币。
5. 从历史百万市值代币中发现早期高倍交易员，并用其全部历史交易验证可重复能力。
6. 将 Fomo、链上、历史索引、市场快照统一成幂等的规范交易事件。
7. 自动生成候选证据、候选准入、能力标签和持续复评结果。
8. 任一数据源故障不得阻断其他数据源、其他链或雷达实时主流程。
9. 控制台准确展示每一层真实数量、积压、吞吐、失败和数据新鲜度。
10. Gateway 用户投递保持关闭，直到生产数据验收明确通过并由开发者手动开启。

## 4. Non-goals

1. 第一版不对全部 10,722 个交易员直接执行昂贵的链上 60 天深度扫描。
2. 第一版不使用普通 EVM RPC 逐钱包扫描 60 天全链区块历史。
3. 第一版不因为单次高收益就永久认定交易员为聪明钱。
4. 第一版不将 Dune 作为唯一数据来源。
5. 第一版不因身份未解析、RPC 限流或单一数据源缺失而停止 Fomo 侧证据计算。
6. 第一版不切换到 PostgreSQL 或 Redis；当前继续使用单机 SQLite 和持久化任务队列。
7. 第一版不自动开启对用户的正式信号投递。

## 5. Core design principles

### 5.1 Collection state is independent from performance state

现有 `suspended` 生命周期不能继续作为是否采集数据的唯一条件。系统必须拆分三个正交状态：

- `coverage_state`: `unseen`, `queued`, `backfilling`, `current`, `degraded`, `stale`。
- `performance_state`: `unknown`, `discovered`, `candidate`, `observing`, `qualified`, `degraded`。
- `monitoring_policy`: `realtime`, `periodic`, `lightweight`, `off`。

一个交易员表现未知或暂时降级，不代表系统应停止收集其低成本数据。只有明确人工禁用或风险隔离时，`monitoring_policy` 才能设置为 `off`。

### 5.2 Cheap evidence before expensive enrichment

全量交易员先使用已有 Fomo 交易事件做低成本预筛。只有出现高倍、早期、大额或重复能力迹象的交易员，才进入身份解析和钱包深度回补。

### 5.3 Event-driven plus scheduled repair

新事件到达时立即触发增量评估，同时通过周期调度修复遗漏、重试失败和处理历史积压。实时事件和历史回补使用相同的幂等键与规范化逻辑。

### 5.4 Source isolation

每个来源独立记录游标、健康状态、预算、失败和下一次重试时间。一个来源降级时，其他来源继续工作。

### 5.5 No survivorship-only scoring

从百万市值代币发现高倍钱包后，必须回查其窗口内全部有效买入，包括失败、低倍和归零样本。稳定能力不得只用成功代币计算。

## 6. Corrected discovery funnel

控制台和 API 必须使用以下漏斗，不再将 Fomo 账号映射称为身份解析：

```text
Observed Fomo handles
→ Canonical trader entities
→ Wallet-resolved traders
→ Monitoring-eligible traders
→ Initial backfill queued
→ Initial backfill completed
→ Periodic coverage current
→ Candidate evidence generated
→ Candidate admitted
→ Performance qualified
```

每层必须提供：

- 当前总数。
- 最近 24 小时新增数。
- 最旧积压年龄。
- 最近成功时间。
- 失败和降级数量。
- 从上一层到当前层的转化率。

## 7. Dual-lane architecture

### 7.1 Lane A: trader-centric backfill

#### T0: protected priority

对象：

- 手动重点交易员。
- 30 天 Top100。

策略：

- 钱包已解析后立即加入实时监控。
- 首次执行 60 天、最多 300 个代币的深度回补。
- Fomo 增量每 15 分钟检查一次。
- 钱包历史增量每 1 小时检查一次。
- 不因普通性能波动自动取消实时监控。

#### T1: evidence-backed traders

对象：

- 已解析钱包且出现高倍、早期或大额证据。
- 从历史百万市值代币中反向发现的交易员。

策略：

- 身份解析成功后立即创建首次深度回补任务。
- 完成首次回补后保持实时监控。
- 每 6 小时执行一次历史增量检查。

#### T2: unresolved promising traders

对象：

- Fomo 侧已经出现有效候选证据，但钱包尚未解析。

策略：

- Fomo 历史继续参与证据计算。
- 加入身份解析优先队列。
- 每 12 小时最多输出 25 个需要人工或付费查询的用户名。
- 钱包回填后自动转入 T1，不需要人工再创建分析任务。

#### T3: broad observed universe

对象：

- 其余已观察 Fomo 用户。

策略：

- 使用 Fomo 规范事件做轻量评分。
- 不直接启动昂贵钱包历史扫描。
- 每 7 天重新评估活跃度和潜在证据。
- 新证据达到阈值时自动升级到 T2。

### 7.2 Lane B: historical million-market-cap token mining

覆盖条件：

- 时间范围从 `2026-08-10T00:00:00+08:00` 开始。
- 链范围固定为 `solana`, `bsc`, `eth`, `base`, `robinhood`。
- 代币历史最高市值或可靠里程碑市值达到 1,000,000 美元。
- 代币必须通过 Fomo 存在性确认；无法确认的代币进入隔离队列，不进入交易员能力计算。

处理步骤：

1. 建立五链历史代币全集并按规范链和合约地址去重。
2. 确认 Fomo 页面或 Fomo 历史数据中存在该代币。
3. 确定首次达到 1M 美元市值的时间。
4. 提取首次达到 1M 前的买入交易员及其交易。
5. 排除累计买入低于 50 美元的证据。
6. 计算加权进入市值、理论机会倍数、可捕获倍数和已实现倍数。
7. 标记 5 秒和 10 秒内重复同步买入的疑似捆绑钱包。
8. 为符合条件的交易员生成候选证据。
9. 对新发现交易员执行轻量全历史检查。
10. 钱包解析后执行 60 天、最多 300 个代币的深度回补。
11. 使用成功和失败样本共同评估稳定能力。

## 8. Partitioning and batch execution

### 8.1 Historical token partitions

历史代币按 `chain + calendar_week` 建立分区，例如：

```text
solana:2026-08-10:2026-08-16
bsc:2026-08-10:2026-08-16
eth:2026-08-10:2026-08-16
base:2026-08-10:2026-08-16
robinhood:2026-08-10:2026-08-16
```

每个分区最多将 50 个代币组成一个执行批次。任务必须保存：

- `partition_id`
- `chain`
- `window_start`
- `window_end`
- `cursor`
- `discovered_tokens`
- `processed_tokens`
- `failed_tokens`
- `attempt_count`
- `next_attempt_at`
- `lease_expires_at`
- `last_error`
- `status`

### 8.2 Trader backfill jobs

每个交易员和数据源使用独立任务，任务键为：

```text
trader_id + source + chain_family + window_start + window_end + strategy_version
```

首次回补参数：

```text
window: 60 days
maximum tokens: 300
minimum buy evidence: 50 USD
```

增量回查必须使用上次成功游标，并保留 6 小时重叠窗口以吸收迟到事件。规范事件层负责去重。

### 8.3 Scheduler allocation

第一版资源积分固定分配：

- `40%` 用于现有交易员回补。
- `40%` 用于历史百万市值代币挖掘。
- `20%` 用于身份解析、失败重试、迟到数据和恢复任务。

历史代币挖掘内部：

- `70%` 处理最近 14 天。
- `30%` 从 2026-08-10 向当前时间推进。
- 每轮五条链各保留至少一个执行槽位。
- 其余槽位按各链未完成积压比例动态分配。

### 8.4 Initial concurrency limits

| Work type | Initial concurrency | Frequency |
|---|---:|---:|
| Fomo lightweight trader evaluation | 10 | Every minute |
| Historical token mining | 2 | Continuous |
| Deep wallet backfill | 2 | Continuous |
| Solana public RPC historical request | 1 | Adaptive |
| Identity export | 25 handles | Every 12 hours |
| Retry worker | 1 | Continuous |

所有并发和频率必须通过配置调整，不写死在业务逻辑中。

## 9. Source responsibilities

### 9.1 Fomo

用途：

- Fomo 用户发现。
- Fomo 交易和观点事实。
- 代币存在性确认。
- 未解析钱包交易员的轻量历史评估。
- 链上未显示或使用平台内部结算的交易补充。

Fomo 数据不依赖钱包解析即可进入规范事件层。

### 9.2 On-chain RPC

用途：

- 实时增量确认。
- 新区块和新签名监控。
- 交易收据、转账和交换证据确认。
- Reorg 检测。

普通 EVM RPC 不承担逐钱包 60 天历史扫描。

### 9.3 Historical indexed sources

用途：

- 历史代币全集。
- 里程碑时间。
- 里程碑前交易。
- EVM 历史钱包活动补充。

Dune 是其中一个来源，但每个任务必须允许其他索引来源或缓存结果替代。Dune 限流只暂停对应任务。

### 9.4 Market data

Dex Screener 和已保存市场快照用于：

- 价格。
- 流动性。
- 市值。
- 首次观察时间。
- 峰值和结果窗口估值。

市场数据不能替代钱包交易历史。

## 10. Solana rate-limit control

当前公共 Solana RPC 已对约 88 个钱包分区产生限流。第一版必须增加：

1. 提供方级 token bucket。
2. 实时监控和历史回补使用独立预算。
3. 检测 `429` 后执行全局冷却，而不是让全部钱包同时重试。
4. 钱包批量大小从当前 20 降为初始 3，并允许动态调整。
5. 单个钱包失败不推进其游标。
6. 主 RPC 限流时切换备用 RPC；两者均不可用时排队等待。
7. 控制台显示预算、冷却结束时间和最旧未检查钱包年龄。

## 11. SQLite write coordination

第一版继续使用 SQLite，但所有服务必须遵循统一写入约束：

1. 网络请求和市场查询不得发生在数据库事务中。
2. 所有写事务必须短小，并通过共享 `withWriteTransaction` 执行。
3. `SQLITE_BUSY` 和 `SQLITE_LOCKED` 使用有限次数指数退避和随机抖动重试。
4. 任务领取使用短租约，进程崩溃后允许其他 worker 回收。
5. 检查点只在事件和派生结果持久化成功后推进。
6. 写入失败时任务返回队列，不允许仅写日志后丢弃。
7. 大批量派生结果按有限行数分块提交。
8. 备份、迁移和批量重算期间暂停重型 worker，但保留实时事件到持久化输入队列。

如果在上述约束下仍持续发生数据库锁或写入延迟超过 10 秒，再单独评估 PostgreSQL 迁移，不在本阶段提前引入。

## 12. Canonical event and deduplication model

相同交易可能来自 Fomo、实时 RPC、历史 RPC 或索引来源。系统必须保留来源观察，同时只生成一个规范事件。

优先幂等键：

```text
chain + transaction_hash + log_index + wallet_address + token_address + side
```

没有链上交易哈希的 Fomo 事件使用：

```text
fomo_account_id + chain + token_address + side + occurred_at_bucket + normalized_amount
```

来源状态：

- `FOMO_ONLY`
- `ONCHAIN_ONLY`
- `CROSS_CONFIRMED`
- `CONFLICTED`

后续来源到达时更新来源状态，不重复生成候选证据。

## 13. Candidate evidence and stability model

### 13.1 Discovery admission

候选发现继续使用已确认规则：

- 一条强证据可以准入。
- 或者至少两个不同代币的早期证据可以准入。
- 同一个代币的重复观察只计算一次最强证据。
- 单笔或累计有效买入不得低于 50 美元。

### 13.2 Evidence ladders

支持以下可配置里程碑标签：

- `100k_3x`
- `100k_5x`
- `200k_3x`
- `200k_5x`
- `300k_5x`
- `500k_5x`
- `500k_10x`
- `1m_10x`
- `1m_20x`

### 13.3 Ability labels

第一版能力标签：

- `discovered`: 一条强证据或两个不同代币早期证据。
- `candidate`: 至少三个不同代币存在有效高倍表现。
- `stable`: 至少八个有效完整样本、至少三个成功代币、样本跨越不少于 14 天，且单个代币不得贡献超过 50% 的总盈利。
- `degraded`: 最近 30 天胜率、捕获倍数或活跃度显著低于自身历史基线。
- `bundle_risk`: 在多个代币上反复出现 5 秒或 10 秒同步买入。

这些标签用于排序和监控策略，不直接作为永久删除条件。阈值必须版本化并保留历史快照，为未来训练接口提供输入。

## 14. Automated triggers

以下事件必须自动触发任务：

| Trigger | Required action |
|---|---|
| New Fomo account observed | Create or refresh lightweight evaluation |
| New canonical trader event | Re-evaluate token evidence and trader priority |
| Wallet mapping resolved | Register wallet and enqueue initial 60-day backfill |
| Token crosses 1M | Enqueue historical early-buyer recovery |
| Historical buyer discovered | Create trader evidence and identity-resolution request when needed |
| Backfill completed | Recompute samples, ability and admission |
| Late source observation arrives | Merge canonical event and re-evaluate affected evidence |
| Provider recovers | Resume due jobs from saved cursor |
| Trader coverage becomes stale | Enqueue incremental repair |

## 15. Recovery and retry

任务状态统一为：

```text
pending
leased
running
waiting_source
retryable
completed
terminal
cancelled
```

默认重试策略：

- 网络错误：指数退避，最大 6 小时。
- 提供方限流：遵守 `Retry-After` 或提供方冷却时间。
- 缺少市场数据：6 小时后重试，最多 7 天。
- 身份未解析：保留 Fomo 证据，进入身份队列，不阻塞候选发现。
- 数据冲突：进入人工冲突队列，不覆盖现有身份。
- 不支持链：隔离记录，不进入五链生产漏斗。
- 永久无效数据：写入 terminal 原因，保留审计记录。

## 16. Console requirements

控制台新增“自动化闭环”模块，至少包含：

1. 正确的交易员漏斗。
2. T0 至 T3 各层数量和最旧积压。
3. 现有交易员回补队列。
4. 历史百万市值代币分区和完成率。
5. 五链处理吞吐与失败率。
6. Solana RPC 限流、冷却和备用源状态。
7. 钱包历史覆盖率。
8. 候选证据生成数量。
9. 从候选到稳定标签的转化。
10. SQLite 锁重试次数和最长写等待。
11. 每个失败任务的中文原因和手动重试入口。

新增 API：

```text
GET  /api/v2/automation/overview
GET  /api/v2/backfill/traders
GET  /api/v2/backfill/traders/:traderId
POST /api/v2/backfill/traders/:traderId/retry
GET  /api/v2/mining/partitions
GET  /api/v2/mining/tokens
POST /api/v2/mining/partitions/:partitionId/retry
GET  /api/v2/coverage/traders
GET  /api/v2/coverage/sources
```

公开 `/health` 仍只表示服务存活，不暴露业务数据。

## 17. Data model changes

保留现有数据，不做破坏性迁移。新增或扩展以下持久化概念：

- `trader_coverage_state`
- `trader_monitoring_policy`
- `trader_backfill_jobs`
- `historical_token_partitions`
- `historical_token_mining_jobs`
- `candidate_evidence_v3`
- `candidate_admission_snapshots`
- `provider_rate_limit_state`
- `automation_runtime_snapshots`

所有新表必须具有稳定主键、创建时间、更新时间、策略版本和必要索引。迁移必须支持重复运行。

## 18. Phased implementation

### Phase 0: truth and safety

- 修正控制台漏斗语义。
- 增加生产数据审计命令。
- 修复大数据库自动备份超时。
- 保持 Gateway 投递关闭。

### Phase 1: state separation and scheduler

- 分离覆盖状态、表现状态和监控策略。
- 建立统一任务租约、重试和恢复机制。
- 为当前 160 个监控钱包创建幂等首次回补任务。
- 为全部 Fomo 实体建立轻量评估游标。

### Phase 2: trader-centric automation

- 接通身份解析完成事件。
- 自动创建 60 天、300 代币回补任务。
- 建立周期增量回查。
- 将钱包监控观察写入规范事件层。

### Phase 3: historical million-token mining

- 建立五链历史代币分区。
- 回补 2026-08-10 至今达到过 1M 的代币。
- 接通 Fomo 验证、里程碑和早期买家恢复。
- 实施五链公平调度和近期优先策略。

### Phase 4: evidence and admission

- 将多源候选发现算法接入生产 worker。
- 生成 `candidate_evidence_v3`。
- 执行一条强证据或两个不同代币早期证据准入。
- 加入捆绑钱包检测和证据降权。

### Phase 5: stability evaluation

- 对候选交易员回查成功和失败样本。
- 生成 discovered、candidate、stable、degraded 和 bundle-risk 标签。
- 保存 24 小时、7 天和 30 天能力快照。

### Phase 6: console and shadow acceptance

- 完成自动化闭环控制台。
- 执行离线重放和生产 shadow 验收。
- 保持正式用户投递关闭，直到人工批准。

## 19. Testing strategy

### 19.1 Unit tests

- 分层优先级和资源积分分配。
- 任务幂等键、租约和重试。
- 游标和 6 小时重叠窗口。
- 五链公平调度。
- Fomo 与链上事件去重。
- 一条强证据和两个不同代币早期证据规则。
- 捆绑钱包 5 秒和 10 秒检测。
- 稳定能力标签。
- 生命周期与监控策略解耦。

### 19.2 Integration tests

- 钱包回填后自动进入监控和首次历史回补。
- 服务重启后从游标继续。
- Solana 限流不影响 EVM 和 Fomo。
- Dune 不可用不影响实时钱包监控。
- SQLite 锁冲突重试后不丢事件、不提前推进检查点。
- 历史代币分区重复执行不生成重复证据。
- 迟到来源将 `FOMO_ONLY` 更新为 `CROSS_CONFIRMED`。

### 19.3 Production shadow tests

- 对当前已解析钱包生成完整回补队列。
- 验证至少一条真实 Fomo 历史事件进入候选证据计算。
- 验证至少一条真实钱包事件或明确的“无新交易”检查点。
- 验证五条链均产生分区进度或可解释的来源降级状态。
- 验证任务失败后能自动恢复而不阻断其他任务。

## 20. Acceptance criteria

1. 控制台不再将 10,722 个 Fomo 实体显示为钱包已解析。
2. 当前已解析钱包 100% 进入明确的监控策略。
3. 当前监控钱包 100% 具有首次回补任务或可解释的终止原因。
4. 新钱包映射在 60 秒内自动创建首次回补任务。
5. 任务重启后能够从已保存游标继续。
6. 生产连续 24 小时无未恢复的 `database is locked` 数据丢失。
7. Solana 限流时 EVM、Fomo 和历史分区继续运行。
8. 五链历史代币分区全部建立，且无 Monad 或其他非目标链进入生产漏斗。
9. 2026-08-10 至今符合条件的百万市值代币均具有处理状态。
10. 多源候选 worker 能从固定重放样本稳定生成预期 `candidate_evidence_v3`。
11. 同一交易和同一代币证据重复回放不会增加计数。
12. 候选准入结果能够追溯到原始来源事件、里程碑和策略版本。
13. 身份未解析不会阻止 Fomo-only 候选证据计算。
14. 控制台展示队列总数、最旧积压、处理速率、失败率和预计清空时间。
15. Gateway 投递保持关闭，除非开发者单独批准。

## 21. Rollout and rollback

- 所有新 worker 默认以 shadow 模式启动。
- 首次部署只生成任务、证据和控制台数据，不投递用户信号。
- 每个阶段部署前创建经过完整性校验的 SQLite 备份。
- 数据库迁移只新增表、列和索引，不删除旧数据。
- worker 可通过独立环境变量关闭。
- 回滚代码时保留新表和任务记录，旧版本忽略未知表。
- 出现不可恢复锁冲突、错误游标推进或证据重复时，立即停止对应 worker，不停止其他链路。

## 22. Initial configuration defaults

```text
ADDRESS_RADAR_AUTOMATION_ENABLED=false
ADDRESS_RADAR_TRADER_LIGHTWEIGHT_BATCH_SIZE=10
ADDRESS_RADAR_TRADER_DEEP_BACKFILL_CONCURRENCY=2
ADDRESS_RADAR_TOKEN_MINING_CONCURRENCY=2
ADDRESS_RADAR_SOLANA_HISTORY_CONCURRENCY=1
ADDRESS_RADAR_SOLANA_WALLET_BATCH_SIZE=3
ADDRESS_RADAR_IDENTITY_EXPORT_BATCH_SIZE=25
ADDRESS_RADAR_IDENTITY_EXPORT_INTERVAL_MS=43200000
ADDRESS_RADAR_BACKFILL_WINDOW_DAYS=60
ADDRESS_RADAR_BACKFILL_MAX_TOKENS=300
ADDRESS_RADAR_EVIDENCE_MINIMUM_BUY_USD=50
ADDRESS_RADAR_HISTORY_START_AT=2026-08-09T16:00:00.000Z
ADDRESS_RADAR_RECENT_TOKEN_SHARE=0.70
ADDRESS_RADAR_HISTORICAL_TOKEN_SHARE=0.30
ADDRESS_RADAR_EXISTING_TRADER_SHARE=0.40
ADDRESS_RADAR_TOKEN_MINING_SHARE=0.40
ADDRESS_RADAR_REPAIR_SHARE=0.20
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false
```

## 23. Final system behavior

完成本 SPAC 后，Address Radar 的目标行为是：

```text
持续发现 Fomo 用户和代币
→ 对全量用户做低成本预筛
→ 对高价值用户自动解析和回补
→ 对已解析钱包持续实时监控
→ 分批处理历史百万市值代币
→ 反向发现新的高倍交易员
→ 用全部成功和失败样本验证稳定能力
→ 自动生成候选证据和准入结果
→ 持续复评、降级和恢复
→ 在控制台完整解释每一步
```

该闭环必须持续运行、可恢复、可审计、可限流，并允许未来在不重写数据模型的前提下接入训练模型和更多数据源。
