import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Nautilus } from "../target/types/nautilus";
import { Keypair, PublicKey } from "@solana/web3.js";
import assert from "assert";

const MAX_PER_TX = 100_000;
const PRICE_TABLE = [
  1_000_000,   1_000_000,   1_356_999,   1_622_309,   2_031_610,
  2_498_843,   3_094_589,   3_822_363,   4_726_003,   5_841_046,
  7_220_221,   8_924_547,  11_031_412,  13_635_544,  16_854_474,
 20_833_269,  25_751_340,  31_830_405,  39_344_546,  48_632_533,
 60_113_117,  74_303_898,  91_844_670, 113_526_255, 140_326_169,
173_452_684, 214_399_308, 265_012_119, 327_572_994, 404_902_488,
];
const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function getMetadataPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

// ============================================================
// WHALE DUMP DEMO
//
// Demonstrates that when a whale sells 80% of all circulating
// supply after Stage 4 completes, the remaining holders'
// protocol sell price does NOT decrease — it increases.
// ============================================================

describe("🐋 Whale Dump Demo — Stage 4 complete, 80% dump", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Nautilus as Program<Nautilus>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const state = Keypair.generate();
  const mint  = Keypair.generate();
  let treasury: PublicKey;

  before(async () => {
    [treasury] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), state.publicKey.toBuffer()],
      program.programId
    );
  });

  const buyAccounts  = () => ({ state: state.publicKey, mint: mint.publicKey, buyer:  provider.wallet.publicKey });
  const sellAccounts = () => ({ state: state.publicKey, mint: mint.publicKey, seller: provider.wallet.publicKey });

  async function buyChunked(total: number) {
    let rem = total;
    while (rem > 0) {
      const chunk = Math.min(rem, MAX_PER_TX);
      await program.methods.buy(new anchor.BN(chunk)).accounts(buyAccounts()).rpc();
      rem -= chunk;
    }
  }

  async function sellChunked(total: number) {
    let rem = total;
    while (rem > 0) {
      const chunk = Math.min(rem, MAX_PER_TX);
      await program.methods.sell(new anchor.BN(chunk)).accounts(sellAccounts()).rpc();
      rem -= chunk;
    }
  }

  async function snap() {
    const s  = await (program.account as any).nautilusState.fetch(state.publicKey);
    const tb = s.treasuryBalance.toNumber();
    const ts = s.totalSold.toNumber();
    return {
      stage:     s.currentStage as number,
      buyPrice:  PRICE_TABLE[Math.min(s.currentStage, 29)],
      sellPrice: ts === 0 ? 0 : tb / ts,
      treasury:  tb,
      sold:      ts,
    };
  }

  function printSnap(label: string, v: Awaited<ReturnType<typeof snap>>) {
    const ratio = v.buyPrice > 0 ? v.sellPrice / v.buyPrice : 0;
    const bar   = "█".repeat(Math.round(ratio * 20)) + "░".repeat(20 - Math.round(ratio * 20));
    console.log(`\n  ┌─ ${label}`);
    console.log(`  │  Stage      : ${v.stage}`);
    console.log(`  │  Circulating: ${v.sold.toLocaleString()} tokens`);
    console.log(`  │  Treasury   : ${(v.treasury / 1e9).toFixed(4)} SOL`);
    console.log(`  │  Buy price  : ${v.buyPrice.toLocaleString()} lam`);
    console.log(`  │  Sell price : ${v.sellPrice.toFixed(2)} lam`);
    console.log(`  │  Sell/Buy   : ${(ratio * 100).toFixed(2)}%  [${bar}]`);
    console.log(`  └${"─".repeat(50)}`);
  }

  // ── setup ──────────────────────────────────────────────────

  it("initialize", async () => {
    const metadata = getMetadataPDA(mint.publicKey);
    await program.methods
      .initialize("Nautilus", "NAUT", "https://arweave.net/test")
      .accounts({
        state: state.publicKey, mint: mint.publicKey,
        authority: provider.wallet.publicKey,
        metadata, tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
      } as any)
      .signers([state, mint])
      .rpc();
  });

  it("advance to Stage 4 complete (buy Stage 1→4)", async () => {
    await buyChunked(10_000); // stage 0→1
    await buyChunked(10_000); // stage 1→2
    await buyChunked(20_000); // stage 2→3
    await buyChunked(30_000); // stage 3→4 complete
    const s = await snap();
    console.log(`\n  Stage 4 complete. Circulating: ${s.sold.toLocaleString()} tokens`);
  });

  // ── demo ───────────────────────────────────────────────────

  it("whale dumps 80% — remaining holders' sell price must not decrease", async () => {
    const before      = await snap();
    const whaleAmount = Math.floor(before.sold * 0.8);
    const remaining   = before.sold - whaleAmount;

    console.log("\n");
    console.log("  ╔══════════════════════════════════════════════════════╗");
    console.log("  ║        WHALE DUMP DEMO                               ║");
    console.log("  ║  Stage 4 complete. Whale dumps 80% at once.          ║");
    console.log("  ║  Does the remaining 20% lose their exit price?       ║");
    console.log("  ╚══════════════════════════════════════════════════════╝");

    printSnap("BEFORE dump", before);

    console.log(`\n  🐋 Whale sells ${whaleAmount.toLocaleString()} tokens`);
    console.log(`     (80% of ${before.sold.toLocaleString()} circulating)`);
    console.log(`     Remaining holders: ${remaining.toLocaleString()} tokens`);

    await sellChunked(whaleAmount);

    const after = await snap();
    printSnap("AFTER dump", after);

    const delta    = after.sellPrice - before.sellPrice;
    const deltaPct = (delta / before.sellPrice * 100);

    console.log("\n  ── Verdict ──────────────────────────────────────────");
    if (delta >= 0) {
      console.log(`  ✅ Sell price: ${before.sellPrice.toFixed(2)} → ${after.sellPrice.toFixed(2)} lam`);
      console.log(`     Change: +${delta.toFixed(2)} lam (+${deltaPct.toFixed(4)}%)`);
      console.log(`     Remaining ${remaining.toLocaleString()} holders' exit price IMPROVED.`);
    } else {
      console.log(`  ❌ Sell price decreased: ${before.sellPrice.toFixed(2)} → ${after.sellPrice.toFixed(2)}`);
    }
    console.log(`  ✅ Treasury: ${(after.treasury / 1e9).toFixed(4)} SOL (not drained)`);
    console.log("  ─────────────────────────────────────────────────────\n");

    assert.ok(
      after.sellPrice >= before.sellPrice,
      `sell price must not decrease: ${before.sellPrice.toFixed(2)} → ${after.sellPrice.toFixed(2)}`
    );
    assert.ok(after.treasury > 0, "treasury must not be drained");
    assert.strictEqual(after.stage, before.stage, "stage must not change on sell");
  });
});