# Nautilus Protocol

## Technical Specification

*Fibonacci-powered, treasury-backed token launch framework on Solana.*

---

## 1. Overview

Nautilus is an open-source token launch framework for Solana. It uses an asymmetric pricing model in which buy price follows the Fibonacci sequence and sell price follows a weighted average derived from treasury balance. The treasury is a program-derived address with no private key; funds move only through protocol-defined instructions.

Nautilus has no on-chain admin functions. However, the current deployed program remains upgradeable until upgrade authority is revoked. See Section 8.

---

## 2. Architecture

| Component | Implementation | Notes |
|---|---|---|
| Buy price | Fibonacci fixed | `BASE_PRICE × FIB[current_stage]` |
| Sell price | Weighted average | `treasury_balance ÷ total_sold` |
| Treasury | Program-derived address | No private key exists |
| Mint authority | Program-derived address | No private key exists |
| Admin functions | None | No on-chain admin |
| Upgrade authority | Held by deployer | See Section 8 |

---

## 3. Pricing Mechanism

### 3.1 Buy Price — Fibonacci Fixed

```
buy_price = BASE_PRICE_LAMPORTS × FIB[current_stage]

BASE_PRICE_LAMPORTS = 1,000,000 (0.001 SOL)
```

The price schedule is fixed by the program logic.

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

## 4. Fibonacci Supply Stages

### 4.1 Stage Table (Stages 1–12)

*Reference values under buy-only completion. Assumes SOL = $100. Actual values vary with SOL price. No returns are guaranteed.*

| Stage | FIB | Supply | Buy (SOL) | Buy (USD) | Treasury value at completion |
|---|---|---|---|---|---|
| 1 | 1 | 1,000,000 | 0.0010 | $0.10 | $100K |
| 2 | 1 | 1,000,000 | 0.0010 | $0.10 | $200K |
| 3 | 2 | 2,000,000 | 0.0020 | $0.20 | $600K |
| 4 | 3 | 3,000,000 | 0.0030 | $0.30 | $2M |
| 5 | 5 | 5,000,000 | 0.0050 | $0.50 | $4M |
| 6 | 8 | 8,000,000 | 0.0080 | $0.80 | $10M |
| 7 | 13 | 13,000,000 | 0.0130 | $1.30 | $27M |
| 8 | 21 | 21,000,000 | 0.0210 | $2.10 | $71M |
| 9 | 34 | 34,000,000 | 0.0340 | $3.40 | $187M |
| 10 | 55 | 55,000,000 | 0.0550 | $5.50 | $490M |
| 11 | 89 | 89,000,000 | 0.0890 | $8.90 | $1.28B |
| 12 | 144 | 144,000,000 | 0.1440 | $14.40 | $3.36B |

Treasury value at completion means treasury balance at the point when all stages up to that stage have been sold out under buy-only history.

### 4.2 Golden Ratio Property

Under buy-only completion, the ratio between the current stage buy price and the protocol sell price at stage completion converges toward the golden ratio:

```
buy_price / sell_price → φ ≈ 1.618033
```

This is a mathematical consequence of the Fibonacci sequence, not an explicit design parameter.

At Stage 8, the ratio is approximately 1.5882. By Stage 20, it approaches approximately 1.6179.

This is distinct from the worst-case next-stage entry ratio discussed in Section 7.1, where `sell_price / buy_price` approaches `1 / φ²`.

### 4.3 Stage Advancement

A stage advances automatically when its advancement condition is met. Advancement is irreversible.

### 4.4 Bootstrap Phase

Stage 1 and Stage 2 use a different advancement rule from later stages.

For Stage 1 and Stage 2 only, advancement is determined by current circulating supply, not by lifetime cumulative issuance. In the implementation, `total_sold` represents current circulating supply for this purpose.

This means repeated buy/sell cycling cannot artificially advance the bootstrap phase.

```
Stage 1 → 2: circulating supply >= 1,000,000
Stage 2 → 3: circulating supply >= 2,000,000
Stage 3+:    standard tranche exhaustion
```

From Stage 3 onward, Nautilus follows standard tranche exhaustion rules.

### 4.5 Maximum Amount Per Transaction

Each instruction is limited to 1,000,000 tokens per transaction to avoid arithmetic overflow at high Fibonacci stages.

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

This monotonicity statement applies when the sell satisfies protocol constraints, including the treasury rent constraint, and when post-sell circulating supply remains positive. If circulating supply becomes zero, sell price is no longer defined.

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

Buy price is fixed per stage and rises with each stage advance, following the Fibonacci sequence. Sell price is a weighted average determined by treasury balance and current circulating supply. Immediately after a new stage opens, sell price is typically below that stage's buy price.

### 7.1 Worst Case at Stage Entry

In the extreme case where virtually no selling has occurred in prior stages, the stage-entry ratio approaches:

```
sell_price / buy_price → 1 / φ² ≈ 0.382
```

At high stages, a buyer who purchases at stage entry and immediately sells back to the protocol could therefore recover only approximately 38% of the purchase value before accounting for market path improvements within the stage.

This is a theoretical worst-case ceiling, not a description of typical purchase experience. Monte Carlo simulations illustrating typical experience are available in the repository.

### 7.2 Sell Price Formation as Trading Progresses

Sell price is not fixed. It is recalculated continuously from treasury balance and circulating supply, and changes as market activity accumulates.

- Buys add SOL to the treasury while also increasing circulating supply.
- Valid sells reduce circulating supply and leave a 0.5% spread in the treasury.

As a result, under the protocol rules, sell price tends to build upward over time as trading activity accumulates.

---

## 8. Upgrade Authority

No on-chain admin functions exist in the protocol itself. However, the deployed program remains upgradeable until upgrade authority is revoked.

| Version | Upgrade authority status |
|---|---|
| v0.4 | Held by deployer |
| v0.5 (current) | Held by deployer |
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
- Maximum 1,000,000 tokens per transaction.
- No profit is guaranteed at any stage.

---

*This document is a technical specification. It does not constitute financial advice or an offer to purchase any token.*

*Nautilus is open-source software. Its behavior is defined by published code and on-chain state.*