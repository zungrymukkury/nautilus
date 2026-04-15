# Nautilus Protocol

![Automated Security Checks](https://github.com/zungrymukkury/nautilus/actions/workflows/security-check.yml/badge.svg)

> ⚠️ **This is experimental software. Nautilus may break or stop working.**
> Only participate if you can read and verify the code yourself.
> If you find a bug, please open an issue on GitHub.
> This is not financial advice. Use at your own risk.

---

A recovery-floor-first, treasury-backed token launch framework with a Fibonacci issuance ladder on Solana.

**Program ID:** `32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev`

**Frontend:** https://zungrymukkury.github.io/nautilus/

---

## Why Nautilus?

- **Large sell orders do not push the protocol sell price down.**
- **The worst-case loss range is legible by design.**
- **No private key exists for the treasury.**

## How it works

**Supply** follows a Fibonacci issuance ladder:
```
supply = FIB[stage] × 10,000 tokens
```

**Buy price** is provided by a pre-computed table:
```
PRICE_TABLE[stage] = floor(0.001 SOL × FIB[stage]^a)
a = log_φ(2) - 1 ≈ 0.4404
```

**Sell price** is defined as:
```
sell_price = treasury_balance ÷ total_sold
```

**Treasury** is a PDA — no private key exists. SOL can only leave through the sell instruction, which requires burning tokens.

**Stages** advance automatically when supply is exhausted. Advancement is irreversible.

## Three core properties

**1. Large sell orders cannot mechanically destroy the exit price.**

When a holder sells k tokens from treasury T with N tokens in circulation:
```
treasury_after   = T × (1 - 0.995k/N)
sell_price_after = treasury_after / (N - k) ≥ sell_price_before
```
No matter how large the sell order, this inequality holds. The 0.5% spread retained in the treasury means sell price tends to rise slightly after every valid sell.

**2. The worst-case loss range is legible.**

In the buy-only, high-stage, asymptotic worst case, protocol sell / current buy approaches 1/φ ≈ 0.618. The immediate downside ceiling including the 0.5% spread is approximately 38.5%. This upper bound is set by design, not by market conditions.

**3. No private key exists for the treasury.**

The treasury is a program-derived address. No one — including the deployer — can withdraw funds outside of the protocol.

## Stage table

*Reference values under buy-only completion. Actual treasury values may differ if sells occur. Assumes SOL = $100. No returns guaranteed.*

| Stage | FIB | Supply | Buy price (SOL) | Treasury at completion |
|---|---|---|---|---|
| 1 | 1 | 10,000 | 0.0010 | $1.00K |
| 2 | 1 | 10,000 | 0.0010 | $2.00K |
| 3 | 2 | 20,000 | 0.0014 | $4.71K |
| 4 | 3 | 30,000 | 0.0016 | $9.58K |
| 5 | 5 | 50,000 | 0.0020 | $19.74K |
| 6 | 8 | 80,000 | 0.0025 | $39.73K |
| 7 | 13 | 130,000 | 0.0031 | $79.96K |
| 8 | 21 | 210,000 | 0.0038 | $160.23K |
| 9 | 34 | 340,000 | 0.0047 | $320.91K |
| 10 | 55 | 550,000 | 0.0058 | $642.17K |
| 11 | 89 | 890,000 | 0.0072 | $1.28M |
| 12 | 144 | 1,440,000 | 0.0089 | $2.57M |
| 13 | 233 | 2,330,000 | 0.0110 | $5.14M |
| 14 | 377 | 3,770,000 | 0.0136 | $10.28M |
| 15 | 610 | 6,100,000 | 0.0169 | $20.56M |
| 16 | 987 | 9,870,000 | 0.0208 | $41.12M |
| 17 | 1,597 | 15,970,000 | 0.0258 | $82.25M |
| 18 | 2,584 | 25,840,000 | 0.0318 | $164.50M |
| 19 | 4,181 | 41,810,000 | 0.0393 | $329.00M |
| 20 | 6,765 | 67,650,000 | 0.0486 | $658.00M |

Full 30-stage table in the whitepaper.

## Buy price and sell price

Buy price and sell price are not the same. Buy price rises in discrete steps at each stage. Sell price builds gradually through actual market activity.

Sell price recovery is **flow-based, not time-based**. It improves as additional buy flow and token burns push up treasury / circulating supply. The central concern in Nautilus is not large sell orders, but entry quality at high stages.

See the [Whitepaper](docs/Nautilus_Whitepaper_EN.md) and [Monte Carlo simulations](tests/) for details.

## Bootstrap phase

Stage 1 and Stage 2 use circulating-supply-based advancement rather than cumulative issuance:
```
Stage 1 → 2: total_sold >= 10,000
Stage 2 → 3: total_sold >= 20,000
Stage 3+:    standard tranche exhaustion
```
Repeated buy/sell cycling cannot artificially advance the bootstrap phase.

## CLI

```bash
export NAUTILUS_RPC=https://api.mainnet-beta.solana.com
export NAUTILUS_WALLET=~/.config/solana/id.json

# Launch a new token
node cli/dist/index.js init <name> <symbol> <logo-path> --ar-key <arweave-wallet>

# Interact with a deployed token (CA or State address)
node cli/dist/index.js status    <CA_OR_STATE>
node cli/dist/index.js buy       <CA_OR_STATE> <amount>
node cli/dist/index.js sell      <CA_OR_STATE> <amount>
node cli/dist/index.js send      <CA_OR_STATE> <recipient> <amount>
node cli/dist/index.js balance   <CA_OR_STATE>
node cli/dist/index.js history   <CA_OR_STATE>
node cli/dist/index.js portfolio
```

## Architecture

| Component | Implementation |
|---|---|
| Buy price | Pre-computed PRICE_TABLE (`floor(BASE_PRICE × FIB[stage]^a)`) |
| Sell price | Weighted average (`treasury_balance ÷ total_sold`) |
| Treasury | PDA — no private key |
| Mint authority | PDA — no private key |
| Token Metadata | Registered via Metaplex CPI (Fungible, immutable) |
| Metadata storage | Arweave (permanent) |
| Admin functions | None |
| Upgrade authority | Held by deployer (verify on-chain) |

## Security

Automated security checks run on every push via GitHub Actions, checking 26 items from Trail of Bits, Neodyme, SlowMist, Zealynx, Cantina/QuillAudits, and Sealevel Attacks.

Latest result: **26/26 PASS — No critical issues flagged**

View full check history: https://github.com/zungrymukkury/nautilus/actions

## Upgrade authority

No on-chain admin functions exist. Upgrade authority is currently held by the deployer.

- v0.5 (current) — Deployer holds upgrade authority
- v0.6 (planned) — Revoked — program immutable

To verify:
```bash
solana program show 32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev
```

## Tests

28 tests passing. Covers fresh-state regression, accounted treasury regression, price table verification, bootstrap bot resistance, stage_sold overflow safety, recovery-floor design verification, and stress tests.

```bash
make test-local
```

## Documentation

- [Whitepaper (EN)](docs/Nautilus_Whitepaper_EN.md)
- [Whitepaper (JP)](docs/Nautilus_Whitepaper_JP.md)
- [Technical Specification (EN)](docs/Nautilus_Spec_EN.md)

## Status

- [x] Localnet — 28/28 tests passing
- [x] Automated security audit — 26/26 PASS on every push
- [x] Mainnet deployment — Program ID: `32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev`
- [ ] Upgrade authority revoked (v0.6 planned)

Framework: Anchor 0.32.1

---

*This is experimental software. It does not constitute financial advice.*