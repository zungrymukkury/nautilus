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
// SELL THEN BUY DEMO
//
// Compares two scenarios after Stage 4 completes:
//
//   Scenario A (no sell): Stage 1→4 complete → buy Stage 5 & 6
//   Scenario B (with sell): Stage 1→4 complete → 50% sell → buy Stage 5 & 6
//
// Question: does the sell in Scenario B leave remaining holders
// better off when Stage 6 completes?
// ============================================================

describe("📊 Sell-then-Buy Demo — does selling help remaining holders?", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Nautilus as Program<Nautilus>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  // Two independent instances
  const stateA = Keypair.generate();
  const mintA   = Keypair.generate();
  const stateB = Keypair.generate();
  const mintB   = Keypair.generate();

  let treasuryA: PublicKey;
  let treasuryB: PublicKey;

  before(async () => {
    [treasuryA] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), stateA.publicKey.toBuffer()],
      program.programId
    );
    [treasuryB] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), stateB.publicKey.toBuffer()],
      program.programId
    );
  });

  const buyAccounts  = (state: PublicKey, mint: PublicKey) => ({
    state, mint, buyer: provider.wallet.publicKey,
  });
  const sellAccounts = (state: PublicKey, mint: PublicKey) => ({
    state, mint, seller: provider.wallet.publicKey,
  });

  async function buyChunked(state: PublicKey, mint: PublicKey, total: number) {
    let rem = total;
    while (rem > 0) {
      const chunk = Math.min(rem, MAX_PER_TX);
      await program.methods.buy(new anchor.BN(chunk)).accounts(buyAccounts(state, mint)).rpc();
      rem -= chunk;
    }
  }

  async function sellChunked(state: PublicKey, mint: PublicKey, total: number) {
    let rem = total;
    while (rem > 0) {
      const chunk = Math.min(rem, MAX_PER_TX);
      await program.methods.sell(new anchor.BN(chunk)).accounts(sellAccounts(state, mint)).rpc();
      rem -= chunk;
    }
  }

  async function snap(state: PublicKey, mint: PublicKey) {
    const s  = await (program.account as any).nautilusState.fetch(state);
    const tb = s.treasuryBalance.toNumber();
    const ts = s.totalSold.toNumber();
    return {
      stage:     s.currentStage as number,
      buyPrice:  PRICE_TABLE[Math.min(s.currentStage, 29)],
      sellPrice: ts === 0 ? 0 : Math.floor(tb / ts),
      treasury:  tb,
      sold:      ts,
    };
  }

  function printSnap(label: string, v: Awaited<ReturnType<typeof snap>>) {
    const ratio = v.buyPrice > 0 ? v.sellPrice / v.buyPrice : 0;
    const bar   = "█".repeat(Math.round(ratio * 20)) + "░".repeat(20 - Math.round(ratio * 20));
    console.log(`  │  ${label.padEnd(20)} stage=${v.stage}  sold=${v.sold.toLocaleString()}  sell=${v.sellPrice.toLocaleString()} lam  ratio=${(ratio*100).toFixed(2)}%  [${bar}]`);
  }

  // ── setup ──────────────────────────────────────────────────

  it("setup: initialize Scenario A (no sell)", async () => {
    const metadata = getMetadataPDA(mintA.publicKey);
    await program.methods.initialize("NautilusA", "NAUTA", "https://arweave.net/test")
      .accounts({ state: stateA.publicKey, mint: mintA.publicKey, authority: provider.wallet.publicKey, metadata, tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID } as any)
      .signers([stateA, mintA]).rpc();
  });

  it("setup: initialize Scenario B (with sell)", async () => {
    const metadata = getMetadataPDA(mintB.publicKey);
    await program.methods.initialize("NautilusB", "NAUTB", "https://arweave.net/test")
      .accounts({ state: stateB.publicKey, mint: mintB.publicKey, authority: provider.wallet.publicKey, metadata, tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID } as any)
      .signers([stateB, mintB]).rpc();
  });

  it("both: advance Stage 1→4 complete", async () => {
    // Stage 1→4: 10k + 10k + 20k + 30k = 70k tokens
    for (const [state, mint] of [[stateA.publicKey, mintA.publicKey], [stateB.publicKey, mintB.publicKey]] as [PublicKey, PublicKey][]) {
      await buyChunked(state, mint, 10_000);
      await buyChunked(state, mint, 10_000);
      await buyChunked(state, mint, 20_000);
      await buyChunked(state, mint, 30_000);
    }
    const a = await snap(stateA.publicKey, mintA.publicKey);
    console.log(`\n  Both scenarios: Stage 4 complete. Circulating: ${a.sold.toLocaleString()} tokens`);
  });

  // ── diverge ────────────────────────────────────────────────

  it("Scenario B only: sell 50% of circulating supply", async () => {
    const b = await snap(stateB.publicKey, mintB.publicKey);
    const sellAmount = Math.floor(b.sold * 0.5);
    console.log(`\n  Scenario B: selling ${sellAmount.toLocaleString()} tokens (50% of ${b.sold.toLocaleString()})`);
    await sellChunked(stateB.publicKey, mintB.publicKey, sellAmount);
  });

  // ── continue buying ────────────────────────────────────────

  it("both: buy Stage 5 & 6 complete", async () => {
    // Stage 5: 50k, Stage 6: 80k
    for (const [state, mint] of [[stateA.publicKey, mintA.publicKey], [stateB.publicKey, mintB.publicKey]] as [PublicKey, PublicKey][]) {
      await buyChunked(state, mint, 50_000);
      await buyChunked(state, mint, 80_000);
    }
  });

  // ── comparison ─────────────────────────────────────────────

  it("comparison: sell price after Stage 6 complete", async () => {
    const a = await snap(stateA.publicKey, mintA.publicKey);
    const b = await snap(stateB.publicKey, mintB.publicKey);

    console.log("\n");
    console.log("  ╔══════════════════════════════════════════════════════════════════╗");
    console.log("  ║  SELL-THEN-BUY DEMO                                              ║");
    console.log("  ║  Same later demand. Different middle path.                       ║");
    console.log("  ║  Does an earlier sell help remaining holders?                    ║");
    console.log("  ╚══════════════════════════════════════════════════════════════════╝");
    console.log();
    console.log("  Shared conditions:");
    console.log("    - Both scenarios begin at Stage 4 complete");
    console.log("    - Both receive the same later buys: Stage 5 + Stage 6");
    console.log("    - The only difference: Scenario B had a 50% sell after Stage 4");
    console.log();
    console.log("  Result at Stage 6 complete:");
    console.log(`    Scenario A (buy-only path)             sell price: ${a.sellPrice.toLocaleString()} lam`);
    console.log(`    Scenario B (50% sell, then same buys)  sell price: ${b.sellPrice.toLocaleString()} lam`);
    console.log();

    const diff    = b.sellPrice - a.sellPrice;
    const diffPct = (diff / a.sellPrice * 100);

    if (diff > 0) {
      console.log(`  Difference: +${diff.toLocaleString()} lam per token (+${diffPct.toFixed(4)}%)`);
      console.log();
      console.log("  Verdict:");
      console.log("  ✅ For holders who did not sell in Stage 4,");
      console.log("     the sell-then-buy path left them better off than the buy-only path.");
    } else if (diff === 0) {
      console.log("  ➡ Both scenarios have the same sell price.");
    } else {
      console.log(`  ❌ Scenario B sell price is LOWER by ${Math.abs(diff).toLocaleString()} lam`);
    }
    console.log();
    console.log("  (supplemental)");
    console.log(`    Scenario A: stage=${a.stage}  sold=${a.sold.toLocaleString()}  sell/buy=${(a.sellPrice/a.buyPrice*100).toFixed(2)}%`);
    console.log(`    Scenario B: stage=${b.stage}  sold=${b.sold.toLocaleString()}  sell/buy=${(b.sellPrice/b.buyPrice*100).toFixed(2)}%`);
    console.log();

    assert.ok(b.sellPrice >= a.sellPrice,
      `Scenario B sell price should be >= Scenario A: ${b.sellPrice} vs ${a.sellPrice}`);
  });
});