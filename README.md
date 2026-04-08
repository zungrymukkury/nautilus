# Nautilus Protocol

![Automated Security Checks](https://github.com/zungrymukkury/nautilus/actions/workflows/security-check.yml/badge.svg)

> ⚠️ **This is a mainnet beta. Nautilus may break or stop working.**
> Only participate if you can read and verify the code yourself.
> If you find a bug, please open an issue on GitHub.
> This is not financial advice. Use at your own risk.

---

**Mainnet deployment (v0.5)**

| | |
|---|---|
| Program ID | `32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev` |
| State | `fR1QnzzmucFwwir6o6vajBZQoZEVfYbATWGcstHKSUm` |
| Mint (CA) | `HjyDnB2z7w55mpurq3VEC2gtTdzEieYNHE1J2wpqxaEE` |

Verify on-chain: https://explorer.solana.com/address/32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev

Frontend: https://zungrymukkury.github.io/nautilus/

---

A Fibonacci-powered, treasury-backed token launch framework on Solana.

Buy price follows the Fibonacci sequence. Sell price is defined as treasury_balance ÷ total_sold. The treasury is a program-derived address with no private key.

```
Fibonacci-powered, treasury-backed token launch framework on Solana.
No on-chain admin. No private key. Just math.
```

## Why Nautilus?

- No on-chain admin functions
- Treasury has no private key
- No DEX required to exit

## How it works

**Buy price** is fixed per stage:
```
buy_price = 0.001 SOL × FIB[stage]
```

**Sell price** is defined as:
```
sell_price = treasury_balance ÷ total_sold
```

**Treasury** is a PDA — no private key exists. SOL can only leave through the sell instruction, which requires burning tokens.

**Stages** advance automatically when supply is exhausted. Advancement is irreversible.

**Token Metadata** is registered via Metaplex CPI at initialization. Logo and metadata are permanently stored on Arweave.

- Treasury is the counterparty
- No external LP required
- Exit is built into the protocol

## Two mathematically verifiable properties

**1. The treasury cannot be drained.**
As long as at least one token remains in circulation, the treasury balance stays positive. This holds regardless of market conditions.

**2. For valid sells, the protocol sell price does not decrease.**
After every valid sell transaction (as long as at least one token remains in circulation and the treasury rent constraint is satisfied), the sell price is pushed upward by the 0.5% spread retained in the treasury.

## Stage table

*Reference values under buy-only completion (i.e. no intermediate sells). Actual treasury values may differ if sells occur during earlier stages. Assumes SOL = $100.*

| Stage | FIB | Supply | Buy price | Treasury value at completion |
|-------|-----|--------|-----------|------------------------------|
| 1  | 1   | 1,000,000   | 0.0010 SOL | ~$100K |
| 2  | 1   | 1,000,000   | 0.0010 SOL | ~$200K |
| 3  | 2   | 2,000,000   | 0.0020 SOL | ~$600K |
| 4  | 3   | 3,000,000   | 0.0030 SOL | ~$2M   |
| 5  | 5   | 5,000,000   | 0.0050 SOL | ~$4M   |
| 6  | 8   | 8,000,000   | 0.0080 SOL | ~$10M  |
| 7  | 13  | 13,000,000  | 0.0130 SOL | ~$27M  |
| 8  | 21  | 21,000,000  | 0.0210 SOL | ~$71M  |
| 9  | 34  | 34,000,000  | 0.0340 SOL | ~$187M |
| 10 | 55  | 55,000,000  | 0.0550 SOL | ~$490M |
| 11 | 89  | 89,000,000  | 0.0890 SOL | ~$1.3B |
| 12 | 144 | 144,000,000 | 0.1440 SOL | ~$3.4B |

## The buy/sell spread

Buy price and sell price are not the same. Buy price rises in discrete steps at each stage. Sell price builds gradually through actual market activity.

Immediately after a new stage opens, the gap between buy and sell price is at its widest. In the extreme case where no selling has occurred in prior stages, the immediate downside of buying and selling back can approach approximately 62%. As trading accumulates within a stage, this gap narrows.

See the [Whitepaper](docs/Nautilus_Whitepaper_EN.pdf) and [Monte Carlo simulations](tests/) for details.

## CLI

All commands accept either a CA (Mint address) or State address — the CLI resolves automatically.

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
|-----------|---------------|
| Buy price | Fibonacci fixed |
| Sell price | Weighted average |
| Treasury | PDA — no private key |
| Mint authority | PDA — no private key |
| Token Metadata | Registered via Metaplex CPI |
| Metadata storage | Arweave (permanent) |
| Admin functions | No on-chain admin functions |
| Upgrade authority | Held by deployer (v0.5) |

## Security

Automated security checks run on every push via GitHub Actions, checking 26 items from Trail of Bits, Neodyme, SlowMist, Zealynx, Cantina/QuillAudits, and Sealevel Attacks.

Latest result: **26/26 PASS — No critical issues flagged by the current automated checks**

View full check history: https://github.com/zungrymukkury/nautilus/actions

## Upgrade authority

Upgrade authority is currently held by the deployer. No on-chain admin functions exist.

- v0.5 (current) — Deployer holds upgrade authority
- v0.6 (planned) — Revoked — program immutable

To verify current upgrade authority:
```bash
solana program show 32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev
```

## Tests

18 tests passing. Covers fresh-state regression, accounted treasury regression, ExceedsMaxAmount, and full stress test through stage 5 with panic sells.

See [DEVELOPMENT.md](DEVELOPMENT.md) for local test setup instructions.

```bash
make test-local
```

## Documentation

- [Whitepaper (EN)](docs/Nautilus_Whitepaper_EN.md)
- [Whitepaper (JP)](docs/Nautilus_Whitepaper_JP.md)
- [Technical Specification (EN)](docs/Nautilus_Spec_EN.md)

## Status

- [x] Localnet — 18/18 tests passing
- [x] Mainnet — v0.5 deployed
- [x] Token Metadata — registered via Metaplex
- [x] Logo/Metadata — permanently stored on Arweave
- [x] Automated security audit — 26/26 PASS on every push
- [ ] Verifiable build (pending Solana Foundation Docker image update)
- [ ] Upgrade authority revoked

Framework: Anchor 0.32.1

---

*This is experimental software. It does not constitute financial advice.*