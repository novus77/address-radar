# Address Radar 端到端数据闭环 SPAC

**Status:** Proposed  
**Date:** 2026-09-27  
**Scope:** Address Radar server, automation workers, wallet monitoring, developer console  
**Delivery:** User signal delivery remains disabled during implementation and shadow validation

## 1. 背景

Address Radar 当前已经具备代币发现、历史代币导入、候选证据计算、交易员能力评估、钱包监控和控制台展示等模块，但这些模块尚未形成可验证、可恢复、可降级的完整闭环。

生产环境的主要问题不是单个评分阈值，而是前置事实缺失后，系统缺乏统一的事实覆盖编排：

- Provider 请求执行完成，不等于目标事实已经补齐。
- ETH、Solana、BSC、Base、Robinhood 的主要缺口不同，但当前使用近似统一的恢复策略。
- 历史价格、市值里程碑和早期买家之间缺少显式依赖关系。
- 历史研究任务会反复进入 `pending` 或 `failed`，但无法说明正在等待什么。
- `wallet_identities` 与 `entity_wallet_identities` 分裂，身份和钱包监控无法稳定归属同一交易员。
- 钱包监控 Provider 虽然显示健康，但只有 Solana 产生实际观察记录。
- 能力评估已经运行，但输入样本的价格覆盖、结果覆盖和身份覆盖不足。
- 实时发现与历史回补共享资源，历史任务可能拖慢早期信号。

本设计将系统重构为事实驱动的双通道架构：实时通道负责尽早发现机会，历史通道负责补齐事实、发现稳定高倍地址、回测和淘汰。两条通道共享事实账本，但互不阻塞。

## 2. 目标

### 2.1 产品目标

- 尽早发现具有高市值潜力的新币机会。
- 识别沉寂后再次出现高质量资金聚集的老币异动。
- 从高价值代币中发现可重复获得超额收益的交易员和钱包。
- 将交易员从发现、候选、身份解析、回补、观察、晋级、降级到淘汰形成自动生命周期。
- 保证任何单一数据源失效都不会阻断整个雷达。
- 所有信号、评分和回测结果均可解释、可追溯、可重放。

### 2.2 工程目标

- 每个代币都能明确说明缺少什么事实、正在由谁补齐、何时重试以及是否永久不可获得。
- Provider 成功与事实产出分开统计。
- 实时任务拥有固定资源配额，不被历史回补饿死。
- 历史数据不可恢复时进入明确终态，不无限重试。
- 新旧架构可以影子并行、结果对比和快速回滚。
- 保持当前单服务器部署，不引入不必要的 Kafka、分布式数据库或微服务复杂度。

## 3. 非目标

- 本阶段不启用正式用户投递。
- 本阶段不建设通用区块浏览器。
- 本阶段不保证所有历史代币都能恢复精确早期交易。
- 本阶段不强制购买高成本商业数据源。
- 本阶段不以单次最高收益作为交易员能力的唯一标准。
- 本阶段不重新引入已经取消的完整安全门禁体系。

## 4. 核心原则

### 4.1 事实优先

评分只能消费已记录来源、时间、精度和覆盖范围的事实。未知数据不得自动解释为失败、零值或通过。

### 4.2 实时与历史分离

实时信号不等待 60 天历史回补；历史回补再慢也不能占满实时消费者。

### 4.3 精确度显式化

所有市场事实必须标记精度：

```text
exact
derived
estimated
fdv_proxy
page_observed
partial
conflicted
```

### 4.4 降级而不阻断

单一 Provider 限流、缺失或失败时切换备用来源。无法补齐的事实进入终态，但不阻止其他代币和其他链继续运行。

### 4.5 时间点正确性

回放和评分只能读取决策时间点之前已知的数据，禁止未来函数。

### 4.6 幂等和可恢复

所有采集、恢复、投影、评估和投递均需要稳定幂等键、持久化游标和可恢复检查点。

## 5. 总体架构

```text
Hot Path: live discovery -> canonical events -> fact ledger -> signal evaluation
                                         \-> candidate evidence

Cold Path: historical discovery -> recovery orchestrator -> fact ledger
                                                   \-> trader backfill
                                                   \-> ability evaluation

Shared: identity registry -> wallet monitoring -> token aggregation -> signal lifecycle
```

系统划分为八层：

1. 规范身份层。
2. 原始事件账本。
3. 事实账本。
4. 事实覆盖编排器。
5. 候选证据引擎。
6. 交易员生命周期。
7. 信号引擎。
8. 评估与运维控制面。

## 6. 规范身份层

### 6.1 ChainRegistry

每条链必须配置以下字段：

```text
canonical_chain_id
display_name
chain_family
rpc_network
native_asset
dexscreener_chain_id
gecko_network_id
blockscout_chain_id
finality_policy
address_normalization
```

第一版仅允许以下五条链进入下游分析：

```text
solana
eth
bsc
base
robinhood
```

必须确认 `robinhood` 的底层网络、RPC、地址规范和 Provider 映射，禁止只依赖产品界面标签。

### 6.2 TokenRegistry

代币唯一键：

```text
canonical_chain_id + normalized_token_address
```

保存：

```text
token_id
canonical_chain_id
token_address
symbol
name
decimals
first_observed_at
launchpad_id
identity_status
```

同名、同符号、不同 CA 必须视为不同代币。

### 6.3 MarketRegistry

一个代币允许绑定多个市场：

```text
market_id
token_id
dex_id
pool_address
quote_token
market_type
opened_at
closed_at
liquidity_rank
canonical_from
canonical_to
```

`market_type` 至少支持：

```text
launchpad_curve
dex_pool
migrated_pool
aggregator_route
```

主市场必须按时间选择，不能只使用当前流动性最大的池子解释历史。

### 6.4 TraderRegistry

统一以下实体：

```text
trader_entities
trader_accounts
entity_wallet_identities
trader_tags
identity_conflicts
```

`wallet_identities` 作为旧数据来源迁移或投影到 `entity_wallet_identities`，后者成为唯一钱包关系真源。

交易员允许只有钱包、没有 Fomo 用户名；也允许只有 Fomo 用户、暂时没有钱包。

## 7. 原始事件账本

所有外部数据必须先保存原始观察，再进入规范化和评分。

建议数据结构：

```text
raw_source_events
source_payload_archive
source_observations
source_observation_conflicts
source_cursors
source_health
```

要求：

- 原始事件追加写入，不覆盖旧版本。
- `collected_at` 单独变化不视为业务冲突。
- 业务字段变化生成修订记录。
- 大型原始响应压缩归档，数据库保留索引字段和内容哈希。
- 所有规范事件保留 `source_event_id` 和原始载荷引用。

经济事件幂等键优先使用：

```text
chain + transaction_hash + wallet + token + side
```

没有交易哈希的 Fomo 事件使用：

```text
fomo_event_id
```

金额和时间桶只能用于辅助去重，不能覆盖明确交易哈希。

## 8. 事实账本

### 8.1 数据结构

新增：

```text
token_fact_status
token_fact_attempts
token_fact_dependencies
token_fact_conflicts
token_fact_watermarks
```

`token_fact_status` 建议字段：

```text
token_id
fact_type
status
precision
primary_source
coverage_start_at
coverage_end_at
observed_at
known_at
fresh_until
attempt_count
next_attempt_at
terminal_reason
strategy_version
updated_at
```

事实类型：

```text
token_identity
fomo_presence
market_identity
price_history
supply_history
milestone_crossings
early_trades
trader_attribution
candidate_evidence
ability_outcomes
```

### 8.2 状态机

```text
missing
scheduled
fetching
available
partial
degraded
retry_scheduled
conflicted
terminal_unavailable
```

合法流转：

```text
missing -> scheduled -> fetching
fetching -> available
fetching -> partial
fetching -> retry_scheduled
fetching -> conflicted
fetching -> terminal_unavailable
partial -> scheduled
degraded -> scheduled
conflicted -> available
```

### 8.3 完成语义

恢复任务必须按以下顺序执行：

```text
provider_request
normalize
persist_fact
validate_fact
update_fact_status
wake_dependencies
complete_job
```

Provider 返回 HTTP 200、空数组或当前快照，不代表历史事实补齐。

## 9. 事实覆盖编排器

### 9.1 职责

编排器只负责数据覆盖，不负责评分：

- 计算每个代币缺失的事实。
- 根据链、事实类型和预算选择 Provider。
- 记录每次尝试和实际产出。
- 控制重试、退避、熔断和终止。
- 在事实变化后唤醒候选证据任务。
- 防止同一缺口产生重复任务。

### 9.2 路由键

```text
canonical_chain_id + fact_type + provider_id
```

现有全局“主 Provider + 一个备用 Provider”改为链级 Provider 列表：

```text
ProviderRoute[]
```

每个路由保存：

```text
priority
enabled
cost_class
coverage_capability
rate_limit_policy
circuit_policy
quality_rank
```

### 9.3 重试策略

```text
5m -> 30m -> 2h -> 8h -> 24h
```

以下情况不应继续普通重试：

- Provider 明确不支持该链。
- 请求时间早于 Provider 可用历史窗口。
- 已达到结果上限且未覆盖目标开始时间。
- 所有池均已尝试。
- 代币身份或链映射明确冲突。
- 已达到配置的尝试次数和时间预算。

这些任务应转为 `terminal_unavailable`、`partial` 或人工处理，而不是继续占用消费者。

## 10. 双通道调度

### 10.1 Hot Path

目标延迟：

| 阶段 | 目标 |
|---|---:|
| 代币或池发现 | 30 秒内 |
| 已知钱包买入规范化 | 60 秒内 |
| 代币聚合刷新 | 90 秒内 |
| 初步信号判断 | 2 分钟内 |

实时通道最低事实：

```text
token_identity
market_identity
current_market_fact
known_trader_buy
buy_amount
token_stage
```

实时通道不得等待 60 天回补、完整历史 OHLCV 或长期能力重算。

### 10.2 Cold Path

历史通道负责：

```text
historical_token_discovery
price_history_recovery
milestone_reconstruction
early_trade_recovery
candidate_evidence
identity_resolution
initial_wallet_backfill
ability_evaluation
```

### 10.3 调度配额

| Lane | 最低份额 |
|---|---:|
| 实时事件 | 40% |
| 候选证据 | 20% |
| 地址回补 | 15% |
| 历史价格与里程碑 | 15% |
| 修复与人工任务 | 10% |

空闲份额可以借用，但实时 Lane 必须保留最低并发。

## 11. 数据源矩阵

### 11.1 代币发现与真实性

| 优先级 | 数据源 | 作用 |
|---|---|---|
| P0 | Fomo network response | Fomo 存在性、页面身份、交易员操作 |
| P0 | Launchpad/DEX contract events | 实时发射、迁池、交易 |
| P1 | DexScreener | 当前池、当前价格、流动性、创建时间 |
| P1 | GeckoTerminal | 池发现、OHLCV、近期交易 |
| P2 | Dune | 大范围历史研究，非实时依赖 |

Fomo 状态：

```text
confirmed
pending
unverified
address_mismatch
conflicted
```

Fomo 未找到只降低优先级；明确 CA 不匹配才排除。

### 11.2 历史价格

```text
local_trade_prices
-> gecko_ohlcv
-> persisted_market_snapshots
-> rpc_swap_reconstruction
-> dune_optional
-> terminal_unavailable
```

从本设计上线后开始持续保存新发现代币的分钟级或五分钟级市场快照，减少未来对第三方历史接口的依赖。

### 11.3 市值里程碑

里程碑证据优先级：

```text
direct_market_cap
historical_supply_times_price
current_supply_times_historical_price
fdv_proxy
fomo_page_observation
launchpad_state_inference
```

保存：

```text
threshold_usd
crossed_at
market_cap_usd
precision
price_source
supply_source
market_id
```

### 11.4 Solana 早期交易

```text
fomo_canonical_trades
-> launchpad_program_transactions
-> pool_getSignaturesForAddress
-> getTransaction_decode
-> gecko_recent_trades
-> dune_optional
```

公共 RPC 仅作为低吞吐降级来源。生产大规模回补需要专用 RPC 或可分页历史索引服务。

### 11.5 EVM 早期交易

```text
fomo_canonical_trades
-> launchpad_contract_events
-> dex_swap_logs
-> blockscout_address_history
-> gecko_recent_trades
-> dune_optional
```

Blockscout Token Transfer 只能提供资金和代币转移事实；真实买入仍需结合 Swap、路由合约、报价资产和交易方向解析。

## 12. 市场事实正确性

价格、市值、FDV、供应量和流动性必须分开保存：

```text
token_price_usd
circulating_supply
total_supply
fdv_usd
market_cap_usd
liquidity_usd
```

禁止将当前 FDV 直接写成历史市值。

对增发、销毁、Rebase、精度变化和迁池代币：

- 记录供应量观察时间。
- 使用对应时间点的供应量。
- 无历史供应量时标记 `estimated`。
- 多池价格使用当时规范市场或成交量加权价格。
- 极端价格尖峰需要成交量或连续 K 线确认。

## 13. 候选证据引擎

### 13.1 代币里程碑标签

| 市值阶段 | 证据标签 |
|---|---|
| 100K | 3x、5x |
| 200K | 3x、5x |
| 300K | 5x |
| 500K | 5x、10x |
| 1M | 10x、20x |

基础条件：

- 早期买入金额不低于 50 USD。
- 同一钱包、同一代币只生成一组主证据。
- 多次加仓不算多个独立成功代币。
- 证据必须记录价格和里程碑精度。
- `partial` 覆盖可以进入候选，但降低置信度。

### 13.2 强证据

强证据满足：

```text
high_multiple
meaningful_buy_amount
early_entry
independent_wallet
acceptable_bundle_risk
fact_precision >= estimated
```

一条强证据允许进入候选，两条不同代币的独立证据允许进入观察。

### 13.3 捆绑与关联钱包

保存以下特征：

```text
within_5s_same_token
within_10s_same_token
repeated_co_buy_tokens
shared_funding_source
shared_exit_timing
router_similarity
```

捆绑风险用于降低独立证据权重，不直接删除地址。

## 14. 交易员生命周期

```text
discovered
evidence_pending
candidate
identity_pending
backfill_pending
observed
promoted
suspended
retired
```

准入来源：

- 30 天 TOP 100 直接进入观察。
- 人工重点地址直接进入观察。
- 一条强证据进入候选。
- 两个独立代币证据进入观察。
- 无 Fomo 用户名的钱包允许进入候选和观察。

降级依据：

- 最近 30 天能力持续下降。
- 样本覆盖率不足。
- 捆绑风险升高。
- 单一代币收益依赖过高。
- 高频小额试单但没有有效收益。
- 地址长期无活动。
- 身份或钱包归属发生冲突。

降级进入 `suspended`，保留历史证据，不物理删除。

## 15. 地址历史回补

新地址进入回补时：

```text
lookback_days = 60
maximum_tokens = 300
```

按链和时间分区，保存：

```text
cursor
coverage_start_at
coverage_end_at
oldest_event_at
provider
attempt_count
completion_reason
```

每个代币样本计算：

```text
weighted_entry_price
weighted_entry_market_cap
position_size_usd
paper_multiple
maximum_multiple
realized_multiple
captured_multiple
mfe_multiple
mae_multiple
```

需要识别转账、卖出、分批买卖、费用、滑点和无法归属的外部流入。

## 16. 稳定能力评估

时间窗口：

```text
24h
7d
30d
lifetime
```

指标：

```text
total_samples
valid_samples
coverage_rate
win_rate
median_return
hit_2x_rate
hit_5x_rate
hit_10x_rate
independent_high_multiple_cases
early_entry_rate
captured_return
single_win_dependency
recent_validity
bundle_risk
```

评分必须同时输出：

```text
ability_score
coverage_confidence
source_confidence
sample_confidence
```

未知结果不计为失败。低覆盖率只能降低置信度，不能伪造胜率。

## 17. 钱包实时监控

所有已观察钱包必须进入对应监控分区：

```text
solana
evm:eth
evm:bsc
evm:base
evm:robinhood
```

Provider 健康拆分为：

```text
transport_healthy
cursor_advancing
events_observed
events_normalized
events_attributed
```

只有 RPC 可访问不得显示为完整健康。

Fomo 与链上事件统一后进入 `canonical_trader_events`，同一经济事件只计算一次。

## 18. 信号引擎

### 18.1 信号等级

```text
provisional
confirmed
```

`provisional` 用于早期发现，允许部分历史事实缺失。`confirmed` 要求地址质量、聚集度和关键事实达到更高置信度。

### 18.2 新币发现

考虑：

```text
token_age
market_cap_stage
early_trader_count
independent_trader_count
buy_amount_usd
cluster_window
trader_ability
bundle_risk
market_momentum
```

### 18.3 老币异动

考虑：

```text
token_age
large_buy_count
large_buy_amount_usd
independent_quality_traders
dormancy_duration
volume_reactivation
price_reactivation
bundle_risk
```

同一代币再次满足条件时，更新原信号：

```text
signal_count += 1
```

同时保留每次播报的时间、市值、价格和证据快照。

## 19. 时间点正确性与回放

所有事实必须保存：

```text
occurred_at
observed_at
known_at
ingested_at
provider_time
strategy_version
```

回放查询必须满足：

```text
known_at <= replay_timestamp
```

禁止使用后续解析身份、未来最高价、未来主池或当前供应量作为过去决策时已知事实。

固定回放时间点：

```text
T0 signal time
T1 24h outcome
T2 7d outcome
T3 30d outcome
```

## 20. 运维与故障兜底

| 故障 | 自动处理 |
|---|---|
| Provider 429 | 使用 `Retry-After` 和指数退避 |
| 连续 Provider 失败 | 打开链级、事实级熔断 |
| 成功响应但空数据 | 标记 `empty_unverified`，不算完成 |
| 多源冲突 | 保存全部证据并进入 `conflicted` |
| Fomo 登录过期 | 报警，链上通道继续运行 |
| WebSocket 断开 | HTTP 补块并切换备用 RPC |
| SQLite 锁冲突 | 单写者、短事务、退避重试 |
| 磁盘超过 75% | 压缩归档并暂停低优先级回补 |
| 磁盘超过 85% | 停止历史抓取，保留实时通道 |
| 队列暴涨 | Lane 配额和全局背压 |
| 多次无产出 | 转 `terminal_unavailable` 或人工队列 |
| 链重组 | 达到确认深度后固化事件 |
| 页面改版 | network response 失败后 DOM 降级 |
| 服务重启 | 从持久化游标和检查点恢复 |
| 新版本异常 | 原子切回上一 release |

SQLite 继续使用 WAL，但所有历史大载荷应外部压缩归档，避免数据库和系统日志再次快速占满磁盘。

## 21. 可观测性

控制台按链展示完整漏斗：

```text
discovered_tokens
fomo_confirmed_tokens
price_history_ready
milestone_ready
early_trades_ready
candidate_evidence_created
candidate_traders
identity_resolved
wallets_backfilled
ability_evaluated
observed_traders
live_wallet_events
aggregated_tokens
provisional_signals
confirmed_signals
```

每个阶段展示：

- 总数量。
- 最近 1 小时新增。
- 最近 24 小时新增。
- 成功率。
- 部分覆盖数量。
- 最老等待时间。
- 失败原因 Top 10。
- Provider 调用成功率。
- Provider 事实产出率。
- 阶段中位延迟和 P95 延迟。

控制台必须使用中文解释业务状态，不直接暴露数据库枚举值。

## 22. 数据保留与容量

建议：

| 数据 | 保留策略 |
|---|---|
| 原始事件索引 | 长期 |
| 压缩原始载荷 | 至少 90 天 |
| 市场分钟快照 | 30 天后降采样 |
| 小时级市场数据 | 长期 |
| 候选证据 | 长期 |
| 交易员能力快照 | 长期，按策略版本 |
| 雷达信号 | 至少长期保存汇总，原始详情不少于 90 天 |
| 服务日志 | 日志轮转，设置大小和时间上限 |

## 23. 迁移方案

### 23.1 基线与备份

- 保存数据库快照和 WAL checkpoint。
- 记录当前 release、服务配置和策略版本。
- 固定一组五链测试代币和交易员。
- 保留旧 systemd unit 和 release 目录。

### 23.2 兼容投影

```text
legacy_tables -> migration_projector -> new_fact_ledger
```

旧数据来源标记为：

```text
legacy_import
```

### 23.3 影子运行

```text
old_engine active
new_engine shadow_only
gateway_delivery disabled
```

比较同一输入下的新旧事实覆盖、候选证据、能力评分和信号结果。

### 23.4 切换与回滚

验证通过后原子切换读取路径。发生异常时切回上一 release 和旧数据库只读快照，不进行历史重写。

## 24. 实施阶段

### Phase 0: Baseline and Recovery Safety

- 建立生产数据基线。
- 固定回放样本。
- 配置日志轮转、磁盘水位和数据库备份。
- 确认用户投递保持关闭。

### Phase 1: Canonical Registries

- 建立 Chain、Token、Market、Trader、Wallet 注册表。
- 合并钱包身份真源。
- 建立旧数据兼容投影。

### Phase 2: Fact Ledger

- 新增事实状态、尝试、依赖、冲突和水位表。
- 修改任务完成语义。
- 增加事实变化唤醒机制。

### Phase 3: Coverage Orchestrator

- 实现链级、事实级 Provider 路由。
- 实现预算、退避、熔断和终态。
- 分离 Provider 成功率和事实产出率。

### Phase 4: Market History and Milestones

- 投影本地事件价格。
- 接入多池 OHLCV。
- 增加供应量历史和精度分级。
- 增加 Swap 重建降级路径。

### Phase 5: Early Trade Recovery

- 闭合 Fomo 查询消费链路。
- 实现 Solana 池签名和交易解析。
- 实现 EVM Launchpad、DEX 日志和 Blockscout 回补。
- 增加覆盖边界和跨源去重。

### Phase 6: Candidate and Identity Lifecycle

- 重算候选证据。
- 支持 wallet-only candidate。
- 修复身份解析后的候选状态流转。
- 增加人工身份和标签。

### Phase 7: Backfill and Ability

- 新地址回补 60 天、最多 300 个代币。
- 计算完整仓位结果。
- 增加覆盖置信度和稳定能力生命周期。

### Phase 8: Five-Chain Live Monitoring

- 验证五条链均产生真实钱包观察。
- 增加监控分区诊断。
- 统一 Fomo 与链上经济事件。

### Phase 9: Signal Engine

- 实现新币发现和老币异动策略。
- 支持 provisional/confirmed。
- 保留重复播报次数和每次证据快照。

### Phase 10: Console and Replay

- 展示逐链事实漏斗和错误原因。
- 增加时间点回放。
- 增加日报、周报和月报。

### Phase 11: Shadow Acceptance

- 运行新旧引擎影子对比。
- 完成五链生产样本验收。
- 用户投递保持关闭，另行审批后再开启。

## 25. 验收标准

### 25.1 固定样本

每条链至少包含：

```text
20 recent tokens
20 historical tokens
5 migrated tokens
5 multi-pool tokens
5 incomplete-data tokens
```

### 25.2 数据指标

| 指标 | 初始目标 |
|---|---:|
| 高价值代币身份确认率 | >= 90% |
| 历史价格可用率 | >= 80% |
| 里程碑可用率 | >= 80% |
| 有里程碑代币的早期交易恢复率 | >= 70% |
| 候选证据可解释率 | 100% |
| 已入库钱包五链监控覆盖率 | >= 90% |
| 无原因等待任务 | 0 |
| 无限重试任务 | 0 |
| 事实补齐到重新评估延迟 | <= 10 minutes |

### 25.3 正确性指标

- 所有证据可以追溯到原始来源。
- 所有估算事实明确标记精度。
- 回放不读取未来数据。
- 同一经济事件不会重复计数。
- Provider 空响应不会标记为事实完成。
- 单一 Provider 故障不会停止其他链和其他数据源。
- 五条链均有真实业务观察，不只显示连接健康。

## 26. 发布门禁

在以下条件满足前，不允许启用 Gateway 用户投递：

- 五链实时监控通过生产验收。
- 事实编排器无无限重试。
- 影子回放差异已经解释。
- 磁盘、日志、数据库锁和队列积压告警可用。
- 新旧版本回滚演练通过。
- 信号结果可以在开发者控制台完整查看。
- `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` 保持不变。

## 27. 关键决策摘要

- 采用事实驱动的双通道架构。
- 实时发现不等待历史研究。
- 使用链级、事实级多 Provider 路由。
- Provider 请求成功不等于事实完成。
- 无法恢复的数据进入明确终态。
- 统一交易员和钱包身份真源。
- 保持 SQLite 单服务器架构，同时加强 WAL、归档、备份和磁盘保护。
- 所有评分和回测执行时间点隔离。
- 用户投递在完整生产验收前保持关闭。
