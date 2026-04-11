# Nautilus Protocol

## Whitepaper

*A recovery-floor-first, treasury-backed token launch framework with a Fibonacci issuance ladder on Solana.*

***No on-chain admin. No private key. Just math.***

---

## 1. Introduction

Meme coins are fun.

The possibility of a small bet turning into a large return, the feeling of strangers gathering around the same coin — there is something genuinely exciting about it.

At the same time, a few structural challenges are well known. Sniper bots that buy in large quantities immediately after launch. Coordinated groups that accumulate early supply. Large sell orders that move the price significantly for everyone else.

These problems are difficult to solve completely. But it may be possible to improve things somewhat through design.

Nautilus is one such attempt.

Supply follows a Fibonacci issuance ladder, and buy prices follow a pre-computed table derived from a recovery floor target. Sale proceeds are held in a program-derived address, providing a set of mathematically verifiable properties.

Nautilus first aims to protect three things: that large sell orders cannot mechanically destroy the exit price, that the worst-case loss range is legible by design, and that no private key exists for the treasury.

Nautilus is designed so that growth changes scale, but not the geometry of worst-case recovery.

---

## 2. Design

### Treasury

At the center of Nautilus is the treasury.

When tokens are purchased, SOL enters the treasury. When tokens are sold, SOL leaves the treasury.

The treasury is managed by a program-derived address (PDA). No private key exists for this address. SOL can only leave through the sell instruction, which requires burning tokens. Nobody — including the deployer — can withdraw treasury funds outside of the protocol.

The sell price is the weighted average of the treasury balance divided by tokens in circulation.

```
sell price = treasury balance ÷ tokens in circulation
```

Under this definition, the following identity always holds:

```
sell price × circulating supply = treasury balance
```

### Fibonacci Issuance Ladder and Price Design

Each stage's token supply follows the Fibonacci sequence.

```
sequence: 1, 1, 2, 3, 5, 8, 13, 21, 34, 55 ...

supply = FIB[stage] × 10,000 tokens
```

The buy price is not the Fibonacci sequence itself. On-chain, it is provided by a pre-computed PRICE_TABLE. This table is generated offline using the following formula:

```
PRICE_TABLE[stage] = floor(BASE_PRICE × FIB[stage]^a)
a = log_φ(2) - 1 ≈ 0.4404
BASE_PRICE = 0.001 SOL
```

At high stages, the supply ratio between adjacent stages approaches φ. The corresponding buy price ratio approaches 2/φ, and as a result, stage capital (total inflow for that stage) grows asymptotically by a factor of 2. This gives rise to the property that the high-stage buy-only asymptotic worst-case recovery floor converges to 1/φ.

A stage advances automatically when its supply is exhausted. Advancement is irreversible.

### No On-chain Admin

After initialization, the protocol has no admin functions. There are no instructions to change prices, increase supply, or manipulate the treasury balance.

The protocol operates autonomously after deployment.

### Bootstrap Phase

Stage 1 and Stage 2 use a different advancement rule from later stages. In Stage 1 and Stage 2, a stage advances when the current circulating supply reaches the target — not when cumulative issuance reaches it. In the current model, Stage 1 → 2 advances when total_sold >= 10,000, and Stage 2 → 3 advances when total_sold >= 20,000. This means repeated buy/sell cycling cannot artificially advance these stages. Stage 3 and beyond follow standard tranche exhaustion rules.

---

## 3. Three Core Properties

### Property 1: Large Sell Orders Cannot Mechanically Destroy the Exit Price

In ordinary tokens, large sell orders push the price down directly. In Nautilus, this does not happen.

The sell price is calculated as:

```
sell price = treasury balance ÷ tokens in circulation
```

When a holder sells, both the treasury balance and the number of tokens in circulation decrease simultaneously. Formally, after selling k tokens from a treasury T with N tokens in circulation:

```
treasury_after   = T × (1 - 0.995k/N)
sell_price_after = treasury_after / (N - k) ≥ sell_price_before
```

No matter how large the sell order, this inequality holds. The 0.5% spread retained by the treasury means that sell price tends to rise slightly after every valid sell transaction.

This holds for valid sells that leave at least one token in circulation and satisfy the treasury rent constraints.

### Property 2: The Worst-Case Loss Range Is Legible

In the buy-only, high-stage, asymptotic worst case, the protocol sell / current buy ratio approaches 1/φ ≈ 0.618. The resulting immediate downside ceiling, including the 0.5% spread, is approximately 38.5%.

This upper bound is determined by design, not by market conditions. In practice, as selling occurs and circulating supply decreases, sell price moves in a better direction than this worst case.

Monte Carlo simulations illustrating typical experiences are available on GitHub.

### Property 3: No Private Key Exists

The treasury is a program-derived address. No private key exists. SOL can only leave via the sell instruction, which requires burning tokens.

Nobody — including the deployer — can withdraw funds outside of the protocol.

### A Consequence of the Design: No DEX Required

Nautilus does not rely on any external liquidity pool or decentralized exchange. Buying and selling occur directly through the protocol. The treasury itself acts as the counterparty. There is no external LP position to drain or withdraw.

---

## 4. Buy Price and Sell Price

In Nautilus, buy price and sell price are not the same.

Buy price is fixed per stage and rises with each stage advance. Sell price is a weighted average continuously recalculated from treasury balance and circulating supply. Immediately after a new stage opens, sell price is typically below that stage's buy price.

### 4.1 Sell Price Formation as Trading Progresses

Sell price in Nautilus is not a fixed value. It is continuously recalculated from treasury balance and circulating supply, and evolves as market activity accumulates.

When a buy occurs, SOL enters the treasury, pushing the weighted average — and therefore the sell price — upward. When a sell occurs, both the treasury and circulating supply decrease. However, 0.5% of the sell amount remains in the treasury, so after a valid sell, the protocol sell price does not decrease.

This improvement does not happen automatically over time. It happens because additional buy flow and burn push up the treasury / circulating supply ratio.

Therefore, the central concern in Nautilus is not large sell orders themselves, but entry quality at high stages.

---

## 5. Implementation

Nautilus is implemented as an Anchor program on Solana.

Instructions:

- `initialize` — creates state account, SPL mint, and treasury PDA
- `buy(amount)` — transfers SOL to treasury and mints tokens
- `sell(amount)` — burns tokens and transfers SOL from treasury PDA
- `get_state` — read-only query of current stage, prices, and treasury balance

A CLI tool is included for interacting with deployed instances via `status`, `buy`, `sell`, and `balance` commands.

The current upgrade authority status can be verified on-chain:

```
solana program show <PROGRAM_ID>
```

---

## 6. Closing

Nautilus does not claim to solve all problems with meme coins.

It cannot eliminate snipers entirely, nor can it stop speculative behavior.

But a few things can be guaranteed mathematically.

- Large sell orders do not push the protocol sell price down.
- Under buy-only worst-case conditions, the recovery floor approaches 1/φ at high stages.
- No private key exists for the treasury.
- No admin functions exist on-chain.
- The treasury cannot be withdrawn arbitrarily.
- No DEX or external liquidity is required.

All of this is published as open-source code and can be verified by anyone.

The fundamental identity of the golden ratio governs the recovery geometry of this design.

*A recovery-floor-first, treasury-backed token launch framework with a Fibonacci issuance ladder on Solana. No on-chain admin. No private key. Just math.*

---

## Appendix: Price and Supply by Stage

The table below shows reference values for each stage.

*Reference values under buy-only completion. Actual treasury values may differ if sells occur during earlier stages. Assumes SOL = $100. Actual values vary with SOL price. No returns are guaranteed.*

| Stage | FIB | Supply | Buy (SOL) | Buy (USD) | Treasury at completion |
|---|---|---|---|---|---|
| 1 | 1 | 10,000 | 0.0010 | $0.10 | $1.00K |
| 2 | 1 | 10,000 | 0.0010 | $0.10 | $2.00K |
| 3 | 2 | 20,000 | 0.0014 | $0.14 | $4.71K |
| 4 | 3 | 30,000 | 0.0016 | $0.16 | $9.58K |
| 5 | 5 | 50,000 | 0.0020 | $0.20 | $19.74K |
| 6 | 8 | 80,000 | 0.0025 | $0.25 | $39.73K |
| 7 | 13 | 130,000 | 0.0031 | $0.31 | $79.96K |
| 8 | 21 | 210,000 | 0.0038 | $0.38 | $160.23K |
| 9 | 34 | 340,000 | 0.0047 | $0.47 | $320.91K |
| 10 | 55 | 550,000 | 0.0058 | $0.58 | $642.17K |
| 11 | 89 | 890,000 | 0.0072 | $0.72 | $1.28M |
| 12 | 144 | 1,440,000 | 0.0089 | $0.89 | $2.57M |
| 13 | 233 | 2,330,000 | 0.0110 | $1.10 | $5.14M |
| 14 | 377 | 3,770,000 | 0.0136 | $1.36 | $10.28M |
| 15 | 610 | 6,100,000 | 0.0169 | $1.69 | $20.56M |
| 16 | 987 | 9,870,000 | 0.0208 | $2.08 | $41.12M |
| 17 | 1,597 | 15,970,000 | 0.0258 | $2.58 | $82.25M |
| 18 | 2,584 | 25,840,000 | 0.0318 | $3.18 | $164.50M |
| 19 | 4,181 | 41,810,000 | 0.0393 | $3.93 | $329.00M |
| 20 | 6,765 | 67,650,000 | 0.0486 | $4.86 | $658.00M |
| 21 | 10,946 | 109,460,000 | 0.0601 | $6.01 | $1.32B |
| 22 | 17,711 | 177,110,000 | 0.0743 | $7.43 | $2.63B |
| 23 | 28,657 | 286,570,000 | 0.0918 | $9.18 | $5.26B |
| 24 | 46,368 | 463,680,000 | 0.1135 | $11.35 | $10.53B |
| 25 | 75,025 | 750,250,000 | 0.1403 | $14.03 | $21.06B |
| 26 | 121,393 | 1,213,930,000 | 0.1735 | $17.35 | $42.11B |
| 27 | 196,418 | 1,964,180,000 | 0.2144 | $21.44 | $84.22B |
| 28 | 317,811 | 3,178,110,000 | 0.2650 | $26.50 | $168.45B |
| 29 | 514,229 | 5,142,290,000 | 0.3276 | $32.76 | $336.90B |
| 30 | 832,040 | 8,320,400,000 | 0.4049 | $40.49 | $673.79B |

Treasury at completion = treasury balance at the point when all stages up to that stage are sold out.

These are reference values assuming buy-only completion and do not constitute a guarantee of future price or investment returns.

---

*This document is for informational purposes only. It does not constitute financial advice or an offer to purchase any token.*

*Nautilus is open-source software. The code is publicly available.*