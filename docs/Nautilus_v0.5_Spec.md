# Nautilus Protocol v0.5 — Launchpad Specification

> One-shot deployment. Get everything right before touching mainnet.

---

## Overview

v0.5 transforms Nautilus from a single hardcoded token into a permissionless launchpad.  
Anyone can launch a Fibonacci-powered, treasury-backed token from a browser — no terminal required.

---

## What Changes from v0.4

| Component | v0.4 | v0.5 |
|-----------|------|------|
| Token name/symbol | None | Set at initialize |
| Token Metadata | Not registered | Registered via Metaplex CPI |
| Frontend | Hardcoded state address | Dynamic via URL param |
| Launch UI | None | Browser-based |
| IPFS | Not used | Logo + metadata JSON |
| Upgrade authority | Held by deployer | Revoked (immutable) |

---

## 1. Contract Changes

### 1.1  `initialize` — New Arguments

```rust
pub fn initialize(
    ctx: Context<Initialize>,
    name: String,
    symbol: String,
    uri: String,   // IPFS URL pointing to metadata JSON
) -> Result<()>
```

**Validation:**
- `name`: max 32 chars
- `symbol`: max 10 chars  
- `uri`: max 200 chars, must start with `https://`

---

### 1.2  Metaplex Metadata CPI

Inside `initialize`, after creating the mint, call Metaplex `create_metadata_accounts_v3` via CPI.

```rust
// Pseudocode
let metadata_accounts = CreateMetadataAccountsV3 {
    metadata: ctx.accounts.metadata,
    mint: ctx.accounts.mint,
    mint_authority: ctx.accounts.mint_authority, // PDA signer
    payer: ctx.accounts.authority,
    update_authority: ctx.accounts.mint_authority, // PDA owns metadata
    system_program: ctx.accounts.system_program,
    rent: ctx.accounts.rent,
};

let data = DataV2 {
    name,
    symbol,
    uri,
    seller_fee_basis_points: 0,
    creators: None,
    collection: None,
    uses: None,
};

create_metadata_accounts_v3(
    CpiContext::new_with_signer(
        ctx.accounts.token_metadata_program.to_account_info(),
        metadata_accounts,
        &[mint_authority_seeds],
    ),
    data,
    true,  // is_mutable — can update metadata later
    true,  // update_authority_is_signer
    None,  // collection_details
)?;
```

**Key point:** `mint_authority` PDA is the signer. No deployer key required.

---

### 1.3  `Cargo.toml` — New Dependency

```toml
[dependencies]
mpl-token-metadata = { version = "4.x", features = ["cpi"] }
```

**Watch out:** Version conflicts with existing Anchor/SPL dependencies.  
Test on localnet before mainnet.

---

### 1.4  New Account in `Initialize` Context

```rust
#[derive(Accounts)]
pub struct Initialize<'info> {
    // ... existing accounts ...

    /// CHECK: Metaplex metadata PDA
    #[account(
        mut,
        seeds = [
            b"metadata",
            mpl_token_metadata::ID.as_ref(),
            mint.key().as_ref(),
        ],
        bump,
        seeds::program = mpl_token_metadata::ID,
    )]
    pub metadata: UncheckedAccount<'info>,

    pub token_metadata_program: Program<'info, MplTokenMetadata>,
}
```

---

### 1.5  Updated Tests

Add to test suite:

```typescript
it("initialize with metadata", async () => {
  // initialize with name/symbol/uri
  // verify metadata account exists on-chain
  // verify name/symbol match
  // verify URI matches
});

it("metadata PDA is derived correctly", async () => {
  // verify metadata PDA derivation
});
```

**Total tests after v0.5: 20+ (18 existing + metadata tests)**

---

## 2. Frontend Changes

### 2.1  Dynamic State Address via URL Parameter

```typescript
// src/constants.ts
const params = new URLSearchParams(window.location.search);
export const STATE_ADDRESS = new PublicKey(
  params.get('state') ?? 'HN72wCf1joPw5XAKqXdhPnTEqWxyKwvzjkqwod9NUHaE'
);
```

URL format:
```
https://zungrymukkury.github.io/nautilus/?state=<STATE_ADDRESS>
```

---

### 2.2  Launch UI

New page/section for launching a new token.

**Fields:**
- Token name (required, max 32 chars)
- Symbol (required, max 10 chars, auto-uppercase)
- Description (optional)
- Logo image (required, JPG/PNG, uploaded to IPFS)

**Flow:**
```
1. User fills in form
2. Logo uploaded to IPFS → get URI
3. metadata.json uploaded to IPFS → get metadata URI
4. Phantom signs initialize tx
5. State address displayed
6. Redirect to /?state=<new_state>
```

---

### 2.3  IPFS Upload

Use **NFT.storage** (free, permanent):

```typescript
import { NFTStorage, File } from 'nft.storage';

const client = new NFTStorage({ token: NFT_STORAGE_API_KEY });

// Upload logo
const logoFile = new File([logoBlob], 'logo.png', { type: 'image/png' });
const logoCid = await client.storeBlob(logoFile);
const logoUrl = `https://nftstorage.link/ipfs/${logoCid}`;

// Upload metadata JSON
const metadata = {
  name,
  symbol,
  description,
  image: logoUrl,
  external_url: `https://zungrymukkury.github.io/nautilus/?state=${stateAddress}`,
};
const metaCid = await client.storeBlob(
  new Blob([JSON.stringify(metadata)], { type: 'application/json' })
);
const metaUri = `https://nftstorage.link/ipfs/${metaCid}`;
```

**Alternative:** Pinata (free tier available)

---

### 2.4  State List Page (Optional)

Simple list of known Nautilus launches.

```
/                    → Default token (NAUT)
/?state=<address>    → Specific token
/launches            → List of all launches (optional)
```

Store launch list in a simple JSON file in the repo, or on-chain via a registry account (v0.6+).

---

## 3. Pre-deployment Checklist

### Localnet
- [ ] `anchor build` succeeds with Metaplex dependency
- [ ] All existing 18 tests pass
- [ ] New metadata tests pass
- [ ] initialize with name/symbol/uri works
- [ ] Metadata account exists on-chain after initialize
- [ ] buy/sell still works after metadata change
- [ ] Frontend dynamic state address works

### Mainnet
- [ ] `anchor build --verifiable` (if Solana Foundation fixes Docker image)
- [ ] Deploy to mainnet
- [ ] initialize new state with name/symbol/uri
- [ ] Verify metadata on Solana Explorer
- [ ] Token shows name/symbol in Phantom
- [ ] RugCheck score looks clean
- [ ] **upgrade authority revoke** (final step — irreversible)

---

## 4. Upgrade Authority Revoke

After all checks pass:

```bash
solana program set-upgrade-authority \
  32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev \
  --final
```

**This is irreversible. Do not run until everything is confirmed working.**

Verify:
```bash
solana program show 32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev
```

After revoke, `Upgrade Authority` should show `none`.

---

## 5. Known Risks

- **Metaplex version conflict**: `mpl-token-metadata` may conflict with Anchor/SPL versions. Pin exact versions and test thoroughly.
- **IPFS availability**: NFT.storage is free but third-party. Content is permanent but gateway may change.
- **Single deployment**: No room for mistakes. Full localnet test before mainnet.
- **CPI complexity**: Metaplex CPI with PDA signer is more complex than regular CPI. Test edge cases.

---

## 6. Out of Scope for v0.5

- Token registry (on-chain list of all launches) → v0.6
- Secondary market / DEX integration → not planned
- Batch/pro-rata launch → not planned
- DAO governance → not planned

---

## Summary

```
v0.4: Single token, hardcoded, no metadata
v0.5: Launchpad, dynamic, metadata via Metaplex CPI, immutable
```

The shell grows by adding chambers.  
Each chamber is sealed forever.

---

*Internal specification document. Not financial advice.*