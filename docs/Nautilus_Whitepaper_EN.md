# Nautilus Protocol

## Whitepaper

*Fibonacci-powered, treasury-backed token launch framework on Solana.*

***No on-chain admin. No private key. Just math.***

---

## 1. Introduction

Meme coins are fun.

The possibility of a small bet turning into a large return, the feeling of strangers gathering around the same coin — there is something genuinely exciting about it.

At the same time, a few structural challenges are well known. Sniper bots that buy in large quantities immediately after launch. Coordinated groups that accumulate early supply. Large sell orders that move the price significantly for everyone else.

These problems are difficult to solve completely. But it may be possible to improve things somewhat through design.

Nautilus is one such attempt.

By following the Fibonacci sequence for both price and supply, and holding sale proceeds in a program-derived address, the protocol aims to provide a few mathematically verifiable properties.

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

Under the protocol's sell-price definition, the following identity holds:

```
sell_price × circulating_supply = treasury_balance
```

This treasury-implied value corresponds to SOL held by the protocol treasury.

### Fibonacci Price and Supply

Buy price and supply per stage both follow the Fibonacci sequence.

```
sequence: 1, 1, 2, 3, 5, 8, 13, 21, 34, 55 ...

buy price = BASE_PRICE × FIB[stage]
supply    = FIB[stage] × 1,000,000 tokens
```

BASE_PRICE is 0.001 SOL (1,000,000 lamports).

Stage 1 buy price is 0.001 SOL with a supply of 1,000,000 tokens. Stage 5 buy price is 0.005 SOL with a supply of 5,000,000 tokens. Price and supply increase together.

The stepped price structure raises the cost of large early purchases. Buying out the entire Stage 1 supply requires 1,000 SOL (approximately $100,000). This makes early bulk accumulation economically costly.

A stage advances automatically when its supply is exhausted. Advancement is irreversible.

### No On-chain Admin

After initialization, the protocol has no admin functions. There are no instructions to change prices, increase supply, or manipulate the treasury balance.

The protocol operates autonomously after deployment.

### Bootstrap Phase
Stage 1 and Stage 2 use a different advancement rule from later stages.
In Stage 1 and Stage 2, a stage advances when the current circulating supply
reaches the target — not when cumulative issuance reaches it. This means
repeated buy/sell cycling cannot artificially advance these stages.
Stage 3 and beyond follow standard tranche exhaustion rules.

---

## 3. Three Core Properties

### Property 1: No Private Key Exists

The treasury is a program-derived address. No private key exists. SOL can only leave via the sell instruction, which requires burning tokens.

Nobody — including the deployer — can withdraw funds outside of the protocol.

### Property 2: For Valid Sells, the Protocol Sell Price Does Not Decrease

The sell price is calculated as:

```
sell price = treasury balance ÷ tokens in circulation
```

When a holder sells, two things happen simultaneously: the treasury decreases, and the number of tokens in circulation decreases. The sell price formula absorbs the impact of large sell orders in a way that ordinary token pricing does not.

Formally, after selling k tokens from a treasury T with N tokens in circulation:

```
treasury_after  = T × (1 - 0.995k/N)
sell_price_after = treasury_after / (N - k) ≥ sell_price_before
```

The 0.5% spread retained by the treasury means that sell price tends to rise slightly after every sell transaction.

This holds for valid sells that leave at least one token in circulation and satisfy the treasury rent constraints.

### Property 3: No DEX Required

Nautilus does not rely on any external liquidity pool or decentralized exchange. Buying and selling occur directly through the protocol. The treasury itself acts as the counterparty.

This means:
- There is no external LP position to drain or withdraw
- Sell price is determined by the treasury balance, not by a market maker

---

## 4. Buy Price and Sell Price

In Nautilus, buy price and sell price are not the same.

Buy price is fixed per stage and rises with each stage advance, following the Fibonacci sequence. Sell price is defined by the protocol as:

```
sell price = treasury balance ÷ tokens in circulation
```

That is, sell price is a weighted average determined by the SOL accumulated in the treasury and the current circulating supply. Immediately after a new stage opens, sell price is typically below that stage's buy price.

### 4.1 Worst Case at Stage Entry

Immediately after a new stage opens, the gap between buy price and sell price is at its widest. In the extreme case — where virtually no selling has occurred in prior stages — the sell/buy ratio approaches 1/φ² ≈ 0.382 at high stages.

This means a buyer who purchases at stage entry and immediately sells back to the protocol could recover only approximately 38% of their purchase, with an immediate downside of up to approximately 62%.

This is the theoretical worst-case ceiling, not a description of the typical purchase experience. Monte Carlo simulations illustrating typical experiences are available on GitHub.

### 4.2 Sell Price Formation as Trading Progresses

Sell price in Nautilus is not a fixed value. It is continuously recalculated from treasury balance and circulating supply, and evolves as market activity accumulates.

When a buy occurs, SOL enters the treasury at the current stage's buy price. This additional treasury pushes the weighted average — and therefore the sell price — upward.

When a sell occurs, both the treasury and circulating supply decrease. However, 0.5% of the sell amount remains in the treasury. As a result, after a valid sell, the protocol sell price does not decrease — it is pushed slightly upward.

Under the protocol rules, sell price tends to build upward as buying and selling accumulate. Buy price rises in discrete steps at each stage, while sell price is formed gradually through actual market activity.

---

## 5. Implementation

Nautilus is implemented as an Anchor program on Solana.

Instructions:

- `initialize` — creates state account, SPL mint, and treasury PDA
- `buy(amount)` — transfers SOL to treasury and mints tokens
- `sell(amount)` — burns tokens and transfers SOL from treasury PDA
- `get_state` — read-only query of current stage, prices, and treasury balance

A CLI tool is included for interacting with deployed instances via `status`, `buy`, `sell`, and `balance` commands.

In v0.4, upgrade authority is held by the deployer. In v0.5, upgrade authority will be revoked and the program will become immutable. The current authority status can be verified on-chain:

```
solana program show <PROGRAM_ID>
```

---

## 6. Closing

Nautilus does not claim to solve all problems with meme coins.

It cannot eliminate snipers entirely, nor can it stop speculative behavior.

But a few things can be guaranteed mathematically.

- No private key exists for the treasury.
- No admin functions exist on-chain.
- The treasury cannot be drained.
- For valid sells, the protocol sell price does not decrease.
- No DEX or external liquidity is required.

All of this is published as open-source code and can be verified by anyone.

The Fibonacci sequence was chosen. Mathematical properties known for over 2,000 years determined everything else.

*Fibonacci-powered, treasury-backed token launch framework on Solana. No on-chain admin. No private key. Just math.*

---

## Appendix: Price and Supply by Stage

The table below shows reference values for each stage.

*Reference values under buy-only completion (i.e. no intermediate sells). Actual treasury values may differ if sells occur during earlier stages. Assumes SOL = $100. Actual values vary with SOL price. No returns are guaranteed.*

| Stage | FIB | Supply | Buy (SOL) | Buy (USD) | Treasury value at stage completion |
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

Treasury value at completion = treasury balance at the point when all stages up to that stage are sold out.

---

*This document is for informational purposes only. It does not constitute financial advice or an offer to purchase any token.*

*Nautilus is open-source software. The code is publicly available.*
