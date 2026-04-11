# Nautilus Protocol

## Technical Specification

*Recovery-floor-first, treasury-backed token launch framework with a Fibonacci issuance ladder on Solana.*

---

## 1. Overview

Nautilus is an open-source token launch framework for Solana. It uses an asymmetric pricing model in which buy price follows a pre-computed table derived from a recovery floor target, and sell price follows a weighted average derived from treasury balance. The treasury is a program-derived address with no private key; funds move only through protocol-defined instructions.

Nautilus has no on-chain admin functions. However, the current deployed program remains upgradeable until upgrade authority is revoked. See Section 8.

---

## 2. Architecture

| Component | Implementation | Notes |
|---|---|---|
| Buy price | Pre-computed PRICE_TABLE | `floor(BASE_PRICE × FIB[stage]^a)`, `a = log_φ(2) - 1` |
| Sell price | Weighted average | `treasury_balance ÷ total_sold` |
| Treasury | Program-derived address | No private key exists |
| Mint authority | Program-derived address | No private key exists |
| Admin functions | None | No on-chain admin |
| Upgrade authority | Held by deployer | See Section 8 |

---

## 3. Pricing Mechanism

### 3.1 Buy Price — Pre-computed Table

```
PRICE_TABLE[stage] = floor(BASE_PRICE × FIB[stage]^a)

BASE_PRICE = 1,000,000 lamports (0.001 SOL)
a = log_φ(2) - 1 ≈ 0.4404
```

The table is generated offline and stored in the program. Buy price is not computed at runtime from the Fibonacci sequence directly.

At high stages, the supply ratio between adjacent stages approaches φ. The corresponding buy price ratio approaches 2/φ, and stage capital (total SOL inflow for that stage) grows asymptotically by a factor of 2. This gives rise to the property that the high-stage buy-only asymptotic worst-case recovery floor converges to 1/φ.

### 3.2 Sell Price — Weighted Average

```
sell_price = treasury_balance ÷ total_sold
```

When `total_sold` is zero, sell price is undefined. UIs should display N/A or an equivalent fallback.

### 3.3 Spread

```
gross_payout = sell_price × amount
net_payout   = gross_payout × 0.995
```

The 0.5% spread remains in the treasury. This retained spread pushes the protocol sell price upward after valid sell transactions.

### 3.4 Price Source of Truth

Sell price is calculated from `state.treasury_balance` (accounted treasury), not from actual lamports currently sitting in the treasury PDA. Direct SOL transfers to the treasury PDA do not affect protocol pricing.

---

## 4. Fibonacci Issuance Ladder

### 4.1 Stage Table (Stages 1–20)

*Reference values under buy-only completion. Assumes SOL = $100. Actual values vary with SOL price. No returns are guaranteed.*

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

Full 30-stage table is available in the repository. Treasury at completion = treasury balance at the point when all stages up to that stage are sold out under buy-only history.

### 4.2 Recovery Floor Property

Under buy-only completion at high stages, the protocol sell price at stage completion divided by the next stage's buy price converges toward 1/φ:

```
sell_price_at_completion / next_stage_buy_price → 1/φ ≈ 0.618
```

This is a consequence of the price table design (`a = log_φ(2) - 1`) and the Fibonacci supply ladder, not an explicit on-chain parameter.

This is distinct from the in-stage sell price discussed in Section 7.1.

### 4.3 Stage Advancement

A stage advances automatically when its advancement condition is met. Advancement is irreversible.

### 4.4 Bootstrap Phase

Stage 1 and Stage 2 use a different advancement rule from later stages.

For Stage 1 and Stage 2 only, advancement is determined by current circulating supply, not by lifetime cumulative issuance.

```
Stage 1 → 2: total_sold >= 10,000
Stage 2 → 3: total_sold >= 20,000
Stage 3+:    standard tranche exhaustion (stage_sold >= STAGE_SUPPLY[stage])
```

This means repeated buy/sell cycling cannot artificially advance the bootstrap phase.

### 4.5 Maximum Amount Per Transaction

Each instruction is limited to 100,000 tokens per transaction.

### 4.6 Total Stages

The protocol defines 30 stages. This is the maximum number of stages for which cumulative treasury balance remains within the u64 range under buy-only completion.

---

## 5. Three Core Properties

### Property 1: No Private Key Exists

The treasury is a program-derived address. No private key exists. SOL can only leave via the sell instruction, which requires burning tokens.

There is no protocol instruction allowing the deployer to withdraw treasury funds directly.

### Property 2: For Valid Sells, the Protocol Sell Price Does Not Decrease

```
sell_price = treasury_balance ÷ total_sold
```

When a holder sells, both treasury balance and `total_sold` decrease simultaneously. Formally, after selling k tokens from a treasury T with N tokens in circulation:

```
treasury_after   = T × (1 - 0.995k/N)
sell_price_after = treasury_after / (N - k)
```

For valid sells with positive post-sell circulating supply:

```
sell_price_after ≥ sell_price_before
```

The 0.5% spread retained by the treasury means that valid sells push protocol sell price slightly upward.

This monotonicity statement applies when the sell satisfies protocol constraints, including the treasury rent constraint, and when post-sell circulating supply remains positive.

### Property 3: No DEX Required

Nautilus does not rely on any external liquidity pool or decentralized exchange. Buying and selling occur directly through the protocol. The treasury itself acts as the counterparty.

This means:
- There is no external LP position to drain or withdraw
- Sell price is determined by treasury state, not by an external market maker

---

## 6. Treasury

### 6.1 Program-Derived Address

```
seeds: [b"treasury", state.key()]
```

No private key exists for this address. SOL can only leave through protocol-defined instructions.

### 6.2 Accounted vs Actual Balance

`state.treasury_balance` is the source of truth for protocol pricing. Direct SOL transfers to the treasury PDA may change actual lamports held at the PDA, but they do not change protocol sell price.

---

## 7. Buy Price and Sell Price

In Nautilus, buy price and sell price are not the same.

Buy price is fixed per stage and rises with each stage advance. Sell price is a weighted average determined by treasury balance and current circulating supply. Immediately after a new stage opens, sell price is typically below that stage's buy price.

### 7.1 Worst Case at Stage Entry

In the buy-only, high-stage, asymptotic worst case, the protocol sell / current buy ratio approaches 1/φ ≈ 0.618. The resulting immediate downside ceiling, including the 0.5% spread, is approximately 38.5%.

This is a theoretical worst-case ceiling under buy-only conditions at high stages, not a description of typical purchase experience. Monte Carlo simulations illustrating typical experience are available in the repository.

### 7.2 Sell Price Formation as Trading Progresses

Sell price is not fixed. It is recalculated continuously from treasury balance and circulating supply.

- Buys add SOL to the treasury while also increasing circulating supply.
- Valid sells reduce circulating supply and leave a 0.5% spread in the treasury.

Sell price improvement does not happen automatically over time. It happens because additional buy flow and burn push up the treasury / circulating supply ratio.

---

## 8. Upgrade Authority

No on-chain admin functions exist in the protocol itself. However, the deployed program remains upgradeable until upgrade authority is revoked.

| Version | Upgrade authority status |
|---|---|
| v0.4 | Held by deployer |
| v0.5 | Held by deployer |
| v0.6 (planned) | Revoked — program immutable |

To verify current upgrade authority status:

```bash
solana program show <PROGRAM_ID>
```

---

## 9. Implementation

### 9.1 Instructions

- `initialize` — creates state account, SPL mint, and treasury PDA
- `buy(amount)` — transfers SOL to treasury and mints tokens to buyer ATA
- `sell(amount)` — burns tokens and transfers SOL from treasury PDA
- `get_state` — read-only query of stage, prices, and treasury balance

### 9.2 Tech Stack

- Runtime: Solana
- Framework: Anchor 0.32.1
- Token: SPL Token
- Language: Rust + TypeScript

### 9.3 CLI

```bash
nautilus status  <STATE_ADDRESS>
nautilus buy     <STATE_ADDRESS> <amount>
nautilus sell    <STATE_ADDRESS> <amount>
nautilus balance <STATE_ADDRESS>
```

---

## 10. Known Limitations

- Upgrade authority remains with the deployer until it is revoked.
- Direct SOL transfers to the treasury PDA do not affect protocol pricing.
- Sell price is undefined when circulating supply is zero.
- Stage supply caps are global, not per-wallet.
- Maximum 100,000 tokens per transaction.
- No profit is guaranteed at any stage.

---

*This document is a technical specification. It does not constitute financial advice or an offer to purchase any token.*

*Nautilus is open-source software. Its behavior is defined by published code and on-chain state.*