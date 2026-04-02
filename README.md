# Nautilus Protocol

> ⚠️ **This is a mainnet beta test. Nautilus may break or stop working.**
> Only participate if you can read and verify the code yourself.
> If you find a bug, please open an issue on GitHub.
> This is not financial advice. Use at your own risk.

---

**Mainnet deployment (v0.5)**

| | |
|---|---|
| Program ID | `32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev` |
| State | `fR1QnzzmucFwwir6o6vajBZQoZEVfYbATWGcstHKSUm` |
| Mint | `HjyDnB2z7w55mpurq3VEC2gtTdzEieYNHE1J2wpqxaEE` |

Verify on-chain: https://explorer.solana.com/address/32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev

Frontend: https://zungrymukkury.github.io/nautilus/

---

A Fibonacci-based token launch framework for Solana.

Buy price follows the Fibonacci sequence. Sell price follows the weighted average of the treasury balance. The treasury is a program-derived address with no private key.
```
Fibonacci controls supply. The market controls price. Nobody controls anything else. Just math.
```

## How it works

**Buy price** is fixed per stage:
```
buy_price = 0.001 SOL × FIB[stage]
```

**Sell price** is the weighted average of all purchases:
```
sell_price = treasury_balance ÷ total_sold
```

**Treasury** is a PDA — no private key exists. SOL can only leave through the sell instruction, which requires burning tokens.

**Stages** advance automatically when supply is exhausted. Advancement is irreversible.

**Token Metadata** is registered via Metaplex CPI at initialization. Logo and metadata are permanently stored on Arweave.

## Two guaranteed properties

**1. The treasury cannot be drained.**
As long as at least one token remains in circulation, the treasury balance stays positive. This is a mathematical guarantee independent of market conditions.

**2. A floor price exists.**
After every sell transaction (as long as at least one token remains), the floor price increases. This is a mathematical guarantee.

## Stage table

| Stage | FIB | Supply | Buy price | MC at completion |
|-------|-----|--------|-----------|-----------------|
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

*Assumes SOL = $100. MC = treasury balance = actual SOL locked.*

## The golden ratio property

When both price and supply follow the Fibonacci sequence, the buy/sell ratio converges to the golden ratio φ ≈ 1.618. This is not a design choice — it emerges from two Fibonacci identities known for over 2,000 years:
```
Σ(FIB[i]²) = FIB[n] × FIB[n+1]
Σ(FIB[i])  = FIB[n+2] - 1
```

## CLI
```bash
export NAUTILUS_RPC=https://api.mainnet-beta.solana.com
export NAUTILUS_WALLET=~/.config/solana/id.json

# Launch a new token
node cli/dist/index.js init   <name> <symbol> <logo-path> --ar-key <arweave-wallet>

# Interact with a deployed token
node cli/dist/index.js status  <STATE_ADDRESS>
node cli/dist/index.js buy     <STATE_ADDRESS> <amount>
node cli/dist/index.js sell    <STATE_ADDRESS> <amount>
node cli/dist/index.js balance <STATE_ADDRESS>
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
| Admin functions | None |
| Upgrade authority | Held by deployer (v0.5) |

## Upgrade authority

Upgrade authority is currently held by the deployer. No on-chain admin functions exist.

Planned:
- v0.5 — Deployer holds upgrade authority
- v0.6 — Revoked — program immutable

To verify current upgrade authority:
```bash
solana program show 32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev
```

## Tests

18 tests passing. Covers fresh-state regression, accounted treasury regression, ExceedsMaxAmount, and full stress test through stage 5 with panic sells.
```bash
anchor test --skip-local-validator
```

## Documentation

- [Whitepaper (EN)](docs/Nautilus_Whitepaper_EN.pdf)
- [Whitepaper (JP)](docs/Nautilus_Whitepaper_JP.pdf)
- [Technical Specification v0.4 (EN)](docs/Nautilus_Spec_v0.4_EN.pdf)
- [Technical Specification v0.4 (JP)](docs/Nautilus_Spec_v0.4_JP.pdf)

## Status

- [x] Localnet — 18/18 tests passing
- [x] Mainnet — v0.5 deployed
- [x] Token Metadata — registered via Metaplex
- [x] Logo/Metadata — permanently stored on Arweave
- [ ] Verifiable build (pending Solana Foundation Docker image update)
- [ ] Upgrade authority revoked

Framework: Anchor 0.32.1

---

*This is experimental software. It does not constitute financial advice.*
