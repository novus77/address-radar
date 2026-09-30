-- Managed source for Dune saved query: address_radar_token_universe_v1
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
evm_trade_sides AS (
    SELECT
        p.requested_chain AS chain,
        d.token_bought_address AS token_address_raw,
        concat('0x', lower(to_hex(d.token_bought_address))) AS token_address,
        d.token_bought_symbol AS symbol,
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time)) AS observed_at,
        d.amount_usd / nullif(d.token_bought_amount, 0) AS price_usd,
        d.amount_usd AS trade_usd,
        d.taker AS trader
    FROM dex.trades d
    CROSS JOIN params p
    WHERE p.requested_chain <> 'solana'
      AND d.blockchain = p.dune_chain
      AND d.block_month >= date_trunc('month', p.start_at)
      AND d.block_month <= date_trunc('month', p.end_at)
      AND d.block_time >= p.start_at
      AND d.block_time < p.end_at
      AND d.amount_usd >= 5
      AND d.token_bought_address IS NOT NULL
      AND d.token_bought_amount > 0

    UNION ALL

    SELECT
        p.requested_chain,
        d.token_sold_address,
        concat('0x', lower(to_hex(d.token_sold_address))),
        d.token_sold_symbol,
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time)),
        d.amount_usd / nullif(d.token_sold_amount, 0),
        d.amount_usd,
        d.taker
    FROM dex.trades d
    CROSS JOIN params p
    WHERE p.requested_chain <> 'solana'
      AND d.blockchain = p.dune_chain
      AND d.block_month >= date_trunc('month', p.start_at)
      AND d.block_month <= date_trunc('month', p.end_at)
      AND d.block_time >= p.start_at
      AND d.block_time < p.end_at
      AND d.amount_usd >= 5
      AND d.token_sold_address IS NOT NULL
      AND d.token_sold_amount > 0
),
evm_buckets AS (
    SELECT
        chain,
        token_address_raw,
        token_address,
        max_by(symbol, observed_at) AS symbol,
        observed_at,
        approx_percentile(price_usd, 0.5) AS price_usd
    FROM evm_trade_sides
    WHERE upper(coalesce(symbol, '')) NOT IN (
        'USDT','USDC','USDS','DAI','FDUSD','TUSD','WETH','ETH','WBNB','BNB',
        'WBTC','BTCB','SOL','WSOL'
    )
    GROUP BY 1, 2, 3, 5
    HAVING sum(trade_usd) >= 250
       AND count(*) >= 3
       AND count(DISTINCT trader) >= 2
),
evm_valuations AS (
    SELECT
        b.chain,
        b.token_address,
        b.symbol,
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
        d.token_bought_symbol AS symbol,
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time)) AS observed_at,
        d.amount_usd / nullif(d.token_bought_amount, 0) AS price_usd,
        d.amount_usd AS trade_usd,
        d.trader_id AS trader
    FROM dex_solana.trades d
    CROSS JOIN params p
    WHERE p.requested_chain = 'solana'
      AND d.block_month >= date_trunc('month', p.start_at)
      AND d.block_month <= date_trunc('month', p.end_at)
      AND d.block_time >= p.start_at
      AND d.block_time < p.end_at
      AND d.amount_usd >= 5
      AND d.token_bought_mint_address IS NOT NULL
      AND d.token_bought_amount > 0

    UNION ALL

    SELECT
        p.requested_chain,
        d.token_sold_mint_address,
        d.token_sold_symbol,
        date_add('minute', -mod(minute(d.block_time), 5), date_trunc('minute', d.block_time)),
        d.amount_usd / nullif(d.token_sold_amount, 0),
        d.amount_usd,
        d.trader_id
    FROM dex_solana.trades d
    CROSS JOIN params p
    WHERE p.requested_chain = 'solana'
      AND d.block_month >= date_trunc('month', p.start_at)
      AND d.block_month <= date_trunc('month', p.end_at)
      AND d.block_time >= p.start_at
      AND d.block_time < p.end_at
      AND d.amount_usd >= 5
      AND d.token_sold_mint_address IS NOT NULL
      AND d.token_sold_amount > 0
),
sol_buckets AS (
    SELECT
        chain,
        token_address,
        max_by(symbol, observed_at) AS symbol,
        observed_at,
        approx_percentile(price_usd, 0.5) AS price_usd,
        sum(trade_usd) AS bucket_volume_usd
    FROM sol_trade_sides
    WHERE upper(coalesce(symbol, '')) NOT IN (
        'USDT','USDC','USDS','DAI','FDUSD','TUSD','SOL','WSOL','BTC','WBTC'
    )
    GROUP BY 1, 2, 4
    HAVING sum(trade_usd) >= 250
       AND count(*) >= 3
       AND count(DISTINCT trader) >= 2
),
sol_summary AS (
    SELECT
        b.chain,
        b.token_address,
        max_by(b.symbol, b.observed_at) AS symbol,
        min(b.observed_at) AS first_trade_at,
        max_by(b.observed_at, b.price_usd) AS peak_price_at,
        max(b.price_usd) AS peak_price_usd,
        sum(b.bucket_volume_usd) AS trade_volume_usd
    FROM sol_buckets b
    JOIN tokens_solana.fungible f ON f.token_mint_address = b.token_address
    CROSS JOIN params p
    WHERE f.token_version IN ('spl_token', 'token2022')
      AND f.created_at >= date_add('day', -30, p.start_at)
      AND f.created_at < p.end_at
    GROUP BY 1, 2
),
evm_summary AS (
    SELECT
        chain,
        token_address,
        max_by(symbol, observed_at) AS symbol,
        min(observed_at) AS first_trade_at,
        min(observed_at) FILTER (WHERE market_cap_usd >= 1000000) AS first_reached_1m_at,
        max(market_cap_usd) AS peak_market_cap_usd
    FROM evm_valuations
    GROUP BY 1, 2
    HAVING max(market_cap_usd) >= 1000000
)
SELECT
    chain,
    token_address,
    symbol,
    first_trade_at,
    first_reached_1m_at,
    peak_market_cap_usd,
    CAST(NULL AS double) AS peak_price_usd,
    CAST(NULL AS timestamp) AS peak_price_at,
    CAST(NULL AS double) AS trade_volume_usd,
    CAST(NULL AS varchar) AS image_url
FROM evm_summary

UNION ALL

SELECT
    chain,
    token_address,
    symbol,
    first_trade_at,
    CAST(NULL AS timestamp) AS first_reached_1m_at,
    CAST(NULL AS double) AS peak_market_cap_usd,
    peak_price_usd,
    peak_price_at,
    trade_volume_usd,
    CAST(NULL AS varchar) AS image_url
FROM sol_summary
ORDER BY coalesce(peak_market_cap_usd, trade_volume_usd) DESC
LIMIT 2000
