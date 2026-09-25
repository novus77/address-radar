-- Managed source for Dune saved query: address_radar_pre_milestone_trades_v1
WITH params AS (
    SELECT
        lower('{{chain}}') AS requested_chain,
        CASE
            WHEN lower('{{chain}}') = 'bsc' THEN 'bnb'
            WHEN lower('{{chain}}') = 'eth' THEN 'ethereum'
            ELSE lower('{{chain}}')
        END AS dune_chain,
        CAST(from_iso8601_timestamp('{{start_time}}') AS timestamp) AS start_at,
        CAST(from_iso8601_timestamp('{{end_time}}') AS timestamp) AS end_at
),
requested_tokens AS (
    SELECT lower(token_address) AS token_address
    FROM UNNEST(CAST(json_parse('{{token_addresses}}') AS array(varchar))) AS t(token_address)
),
evm_trades AS (
    SELECT
        p.requested_chain AS chain,
        concat('0x', lower(to_hex(d.token_bought_address))) AS token_address,
        d.token_bought_address AS token_address_raw,
        coalesce(d.taker, d.tx_from) AS trader_raw,
        'buy' AS side,
        d.amount_usd,
        d.amount_usd / nullif(d.token_bought_amount, 0) AS price_usd,
        d.block_time,
        d.tx_hash,
        d.evt_index AS event_index,
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time)) AS bucket_at
    FROM dex.trades d
    CROSS JOIN params p
    JOIN requested_tokens r
      ON r.token_address = concat('0x', lower(to_hex(d.token_bought_address)))
    WHERE p.requested_chain <> 'solana'
      AND d.blockchain = p.dune_chain
      AND d.block_month >= date_trunc('month', p.start_at)
      AND d.block_month <= date_trunc('month', p.end_at)
      AND d.block_time >= p.start_at
      AND d.block_time < p.end_at
      AND d.amount_usd >= 5
      AND d.token_bought_amount > 0

    UNION ALL

    SELECT
        p.requested_chain,
        concat('0x', lower(to_hex(d.token_sold_address))),
        d.token_sold_address,
        coalesce(d.taker, d.tx_from),
        'sell',
        d.amount_usd,
        d.amount_usd / nullif(d.token_sold_amount, 0),
        d.block_time,
        d.tx_hash,
        d.evt_index,
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time))
    FROM dex.trades d
    CROSS JOIN params p
    JOIN requested_tokens r
      ON r.token_address = concat('0x', lower(to_hex(d.token_sold_address)))
    WHERE p.requested_chain <> 'solana'
      AND d.blockchain = p.dune_chain
      AND d.block_month >= date_trunc('month', p.start_at)
      AND d.block_month <= date_trunc('month', p.end_at)
      AND d.block_time >= p.start_at
      AND d.block_time < p.end_at
      AND d.amount_usd >= 5
      AND d.token_sold_amount > 0
),
evm_buckets AS (
    SELECT
        chain,
        token_address,
        token_address_raw,
        bucket_at,
        approx_percentile(price_usd, 0.5) AS price_usd
    FROM evm_trades
    GROUP BY 1, 2, 3, 4
    HAVING sum(amount_usd) >= 250
       AND count(*) >= 3
       AND count(DISTINCT trader_raw) >= 2
),
evm_valuations AS (
    SELECT
        b.chain,
        b.token_address,
        b.bucket_at,
        b.price_usd * s.supply AS market_cap_usd
    FROM evm_buckets b
    JOIN tokens.supply_latest s
      ON s.blockchain = (SELECT dune_chain FROM params)
     AND s.token_address = b.token_address_raw
     AND s.supply > 0
    WHERE b.price_usd * s.supply BETWEEN 100000 AND 100000000000
),
evm_evidence AS (
    SELECT
        t.chain,
        t.token_address,
        concat('0x', lower(to_hex(t.trader_raw))) AS trader_address,
        t.side,
        t.amount_usd,
        t.price_usd,
        v.market_cap_usd,
        t.block_time,
        concat('0x', lower(to_hex(t.tx_hash))) AS tx_hash,
        t.event_index
    FROM evm_trades t
    JOIN evm_valuations v
      ON v.chain = t.chain
     AND v.token_address = t.token_address
     AND v.bucket_at = t.bucket_at
    WHERE t.amount_usd >= 50
      AND t.trader_raw IS NOT NULL
      AND v.market_cap_usd <= 1000000
),
sol_trades AS (
    SELECT
        p.requested_chain AS chain,
        d.token_bought_mint_address AS token_address,
        d.trader_id AS trader_address,
        'buy' AS side,
        d.amount_usd,
        d.amount_usd / nullif(d.token_bought_amount, 0) AS price_usd,
        d.block_time,
        d.tx_id AS tx_hash,
        coalesce(
            CAST(d.inner_instruction_index AS bigint),
            CAST(d.outer_instruction_index AS bigint),
            CAST(d.tx_index AS bigint),
            0
        ) AS event_index,
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time)) AS bucket_at
    FROM dex_solana.trades d
    CROSS JOIN params p
    JOIN requested_tokens r ON r.token_address = lower(d.token_bought_mint_address)
    WHERE p.requested_chain = 'solana'
      AND d.block_month >= date_trunc('month', p.start_at)
      AND d.block_month <= date_trunc('month', p.end_at)
      AND d.block_time >= p.start_at
      AND d.block_time < p.end_at
      AND d.amount_usd >= 5
      AND d.token_bought_amount > 0

    UNION ALL

    SELECT
        p.requested_chain,
        d.token_sold_mint_address,
        d.trader_id,
        'sell',
        d.amount_usd,
        d.amount_usd / nullif(d.token_sold_amount, 0),
        d.block_time,
        d.tx_id,
        coalesce(
            CAST(d.inner_instruction_index AS bigint),
            CAST(d.outer_instruction_index AS bigint),
            CAST(d.tx_index AS bigint),
            0
        ),
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time))
    FROM dex_solana.trades d
    CROSS JOIN params p
    JOIN requested_tokens r ON r.token_address = lower(d.token_sold_mint_address)
    WHERE p.requested_chain = 'solana'
      AND d.block_month >= date_trunc('month', p.start_at)
      AND d.block_month <= date_trunc('month', p.end_at)
      AND d.block_time >= p.start_at
      AND d.block_time < p.end_at
      AND d.amount_usd >= 5
      AND d.token_sold_amount > 0
),
sol_buckets AS (
    SELECT
        chain,
        token_address,
        bucket_at,
        approx_percentile(price_usd, 0.5) AS price_usd
    FROM sol_trades
    GROUP BY 1, 2, 3
    HAVING sum(amount_usd) >= 250
       AND count(*) >= 3
       AND count(DISTINCT trader_address) >= 2
),
sol_supply AS (
    SELECT
        b.token_mint_address AS token_address,
        sum(CAST(b.token_balance AS double)) AS supply
    FROM solana_utils.latest_balances b
    JOIN requested_tokens r ON r.token_address = lower(b.token_mint_address)
    WHERE b.token_balance > 0
    GROUP BY 1
),
sol_valuations AS (
    SELECT
        b.chain,
        b.token_address,
        b.bucket_at,
        b.price_usd * s.supply AS market_cap_usd
    FROM sol_buckets b
    JOIN sol_supply s ON s.token_address = b.token_address
    WHERE b.price_usd * s.supply BETWEEN 100000 AND 100000000000
),
sol_evidence AS (
    SELECT
        t.chain,
        t.token_address,
        t.trader_address,
        t.side,
        t.amount_usd,
        t.price_usd,
        v.market_cap_usd,
        t.block_time,
        t.tx_hash,
        t.event_index
    FROM sol_trades t
    JOIN sol_valuations v
      ON v.chain = t.chain
     AND v.token_address = t.token_address
     AND v.bucket_at = t.bucket_at
    WHERE t.amount_usd >= 50
      AND t.trader_address IS NOT NULL
      AND v.market_cap_usd <= 1000000
)
SELECT * FROM evm_evidence
UNION ALL
SELECT * FROM sol_evidence
ORDER BY block_time, tx_hash, event_index
LIMIT 100000
