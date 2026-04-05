# Nautilus — Local Test Guide

## Running Tests Locally

### 1. Download Metaplex binary (first time only)
```bash
solana program dump \
  --url "https://mainnet.helius-rpc.com/?api-key=347da966-6882-46a4-a3ee-ac636bddeeb3" \
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  /tmp/mpl_token_metadata.so
```

### 2. Start local validator with Metaplex loaded (background)
```bash
pkill -f solana-test-validator  # stop any running validator

solana-test-validator \
  --reset \
  --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s /tmp/mpl_token_metadata.so \
  > /tmp/validator.log 2>&1 &

sleep 8 && solana -u localhost program show metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s 2>&1 | head -3
```

Confirm `Program Id: metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` appears before running tests.

### 3. Run tests
```bash
cd ~/nautilus && make test-local
```

All 18 tests should pass.

---

## Notes

- `Anchor.toml` keeps `cluster = "mainnet"` — the Makefile switches it to `localnet` automatically during tests and restores it afterward.
- `/tmp/mpl_token_metadata.so` persists across validator restarts — no need to re-download.
- Stop the validator with `pkill -f solana-test-validator`.

---

## Mainnet Deploy
```bash
anchor deploy
```

