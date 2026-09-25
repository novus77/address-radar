-- Managed source for Dune saved query: address_radar_milestone_crossings_v1
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
evm_trade_sides AS (
    SELECT
        p.requested_chain AS chain,
        d.token_bought_address AS token_address_raw,
        concat('0x', lower(to_hex(d.token_bought_address))) AS token_address,
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time)) AS observed_at,
        d.amount_usd / nullif(d.token_bought_amount, 0) AS price_usd,
        d.amount_usd AS trade_usd,
        d.taker AS trader
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
        d.token_sold_address,
        concat('0x', lower(to_hex(d.token_sold_address))),
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time)),
        d.amount_usd / nullif(d.token_sold_amount, 0),
        d.amount_usd,
        d.taker
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
        token_address_raw,
        token_address,
        observed_at,
        approx_percentile(price_usd, 0.5) AS price_usd
    FROM evm_trade_sides
    GROUP BY 1, 2, 3, 4
    HAVING sum(trade_usd) >= 250
       AND count(*) >= 3
       AND count(DISTINCT trader) >= 2
),
evm_valuations AS (
    SELECT
        b.chain,
        b.token_address,
        b.observed_at,
        b.price_usd * s.supply AS market_cap_usd
    FROM evm_buckets b
    JOIN tokens.supply_latest s
      ON s.blockchain = (SELECT dune_chain FROM params)
     AND s.token_address = b.token_address_raw
     AND s.supply > 0
    WHERE b.price_usd * s.supply BETWEEN 100000 AND 100000000000
),
sol_trade_sides AS (
    SELECT
        p.requested_chain AS chain,
        d.token_bought_mint_address AS token_address,
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time)) AS observed_at,
        d.amount_usd / nullif(d.token_bought_amount, 0) AS price_usd,
        d.amount_usd AS trade_usd,
        d.trader_id AS trader
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
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time)),
        d.amount_usd / nullif(d.token_sold_amount, 0),
        d.amount_usd,
        d.trader_id
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
        observed_at,
        approx_percentile(price_usd, 0.5) AS price_usd
    FROM sol_trade_sides
    GROUP BY 1, 2, 3
    HAVING sum(trade_usd) >= 250
       AND count(*) >= 3
       AND count(DISTINCT trader) >= 2
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
        b.observed_at,
        b.price_usd * s.supply AS market_cap_usd
    FROM sol_buckets b
    JOIN sol_supply s ON s.token_address = b.token_address
    WHERE b.price_usd * s.supply BETWEEN 100000 AND 100000000000
),
valuations AS (
    SELECT * FROM evm_valuations
    UNION ALL
    SELECT * FROM sol_valuations
),
thresholds(milestone_market_cap_usd) AS (
    VALUES 100000e0, 200000e0, 300000e0, 500000e0, 1000000e0
)
SELECT
    v.chain,
    v.token_address,
    t.milestone_market_cap_usd,
    min(v.observed_at) AS crossed_at,
    'estimated_latest_supply_5m_median' AS precision,
    concat('dune:address_radar_milestone_crossings_v1:', v.token_address) AS source_reference
FROM valuations v
CROSS JOIN thresholds t
WHERE v.market_cap_usd >= t.milestone_market_cap_usd
GROUP BY 1, 2, 3
ORDER BY token_address, milestone_market_cap_usd
