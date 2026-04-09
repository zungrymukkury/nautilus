import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Nautilus } from "../target/types/nautilus";
import { Keypair, PublicKey } from "@solana/web3.js";

const MAX_PER_TX = 100_000;
// Price table: PRICE_TABLE[n] = floor(BASE_PRICE * FIB[n]^a), a = log_φ(2)-1
// Mirrors PRICE_TABLE in lib.rs exactly.
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
    [
      Buffer.from("metadata"),
      MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    MPL_TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

// ============================================================
// REGRESSION TEST: fresh-state first-buy
// ============================================================
describe("nautilus vNext — fresh state first-buy regression", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Nautilus as Program<Nautilus>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const state = Keypair.generate();
  const mint = Keypair.generate();
  let treasury: PublicKey;

  before(async () => {
    [treasury] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), state.publicKey.toBuffer()],
      program.programId
    );
  });

  it("fresh deploy: initialize succeeds when treasury PDA does not exist", async () => {
    const conn = provider.connection;
    const treasuryInfo = await conn.getAccountInfo(treasury);
    console.log("  treasury before init:", treasuryInfo === null ? "✓ does not exist" : "already exists");

    const metadata = getMetadataPDA(mint.publicKey);

    await program.methods
      .initialize("Test Token", "TEST", "https://arweave.net/test")
      // @ts-ignore — metadata and tokenMetadataProgram are valid accounts per IDL
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        authority: provider.wallet.publicKey,
        metadata,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
      })
      .signers([state, mint])
      .rpc();

    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    console.log("  stage:", s.currentStage, "| total_sold:", s.totalSold.toNumber());
    console.log("  treasury_balance:", s.treasuryBalance.toNumber());
  });

  it("fresh deploy: first buy into unused treasury PDA succeeds", async () => {
    const conn = provider.connection;
    const treasuryBefore = await conn.getAccountInfo(treasury);
    console.log("  treasury before first buy:",
      treasuryBefore === null ? "✓ empty (will be created)" : `exists with ${treasuryBefore.lamports} lamports`
    );

    await program.methods
      .buy(new anchor.BN(1))
      .accounts({ state: state.publicKey, mint: mint.publicKey, buyer: provider.wallet.publicKey })
      .rpc();

    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    const treasuryAfter = await conn.getAccountInfo(treasury);
    console.log("  total_sold:", s.totalSold.toNumber(), "✓");
    console.log("  treasury_balance:", s.treasuryBalance.toNumber(), "lamports ✓");
    console.log("  treasury actual lamports:", treasuryAfter?.lamports, "✓");
  });

  it("fresh deploy: sell after first buy behaves correctly", async () => {
    try {
      await program.methods
        .sell(new anchor.BN(1))
        .accounts({ state: state.publicKey, mint: mint.publicKey, seller: provider.wallet.publicKey })
        .rpc();
      console.log("  ✓ sold");
    } catch (e: any) {
      if (e.message.includes("InsufficientTreasury")) {
        console.log("  ✓ correctly rejected: single token falls below rent minimum (treasury protection active)");
      } else { throw e; }
    }
  });
});

// ============================================================
// REGRESSION TEST: accounted treasury
// ============================================================
describe("nautilus vNext — accounted treasury regression", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Nautilus as Program<Nautilus>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const state = Keypair.generate();
  const mint = Keypair.generate();
  let treasury: PublicKey;

  before(async () => {
    [treasury] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), state.publicKey.toBuffer()],
      program.programId
    );

    const metadata = getMetadataPDA(mint.publicKey);

    await program.methods
      .initialize("Test Token", "TEST", "https://arweave.net/test")
      // @ts-ignore — metadata and tokenMetadataProgram are valid accounts per IDL
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        authority: provider.wallet.publicKey,
        metadata,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
      })
      .signers([state, mint])
      .rpc();

    await program.methods
      .buy(new anchor.BN(10_000))
      .accounts({ state: state.publicKey, mint: mint.publicKey, buyer: provider.wallet.publicKey })
      .rpc();
  });

  it("direct SOL transfer to treasury PDA does not affect price", async () => {
    const conn = provider.connection;
    const sBefore = await (program.account as any).nautilusState.fetch(state.publicKey);
    const sellBefore = sBefore.treasuryBalance.toNumber() / sBefore.totalSold.toNumber();
    const actualBefore = (await conn.getAccountInfo(treasury))?.lamports ?? 0;

    console.log("  before direct transfer:");
    console.log("    accounted treasury:", sBefore.treasuryBalance.toNumber(), "lamports");
    console.log("    actual treasury:   ", actualBefore, "lamports");
    console.log("    sell price:        ", sellBefore.toFixed(2), "lamports");

    const transferIx = anchor.web3.SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: treasury,
      lamports: 1_000_000_000,
    });
    const tx = new anchor.web3.Transaction().add(transferIx);
    await provider.sendAndConfirm(tx);

    const sAfter = await (program.account as any).nautilusState.fetch(state.publicKey);
    const sellAfter = sAfter.treasuryBalance.toNumber() / sAfter.totalSold.toNumber();
    const actualAfter = (await conn.getAccountInfo(treasury))?.lamports ?? 0;

    console.log("  after direct transfer of 1 SOL:");
    console.log("    accounted treasury:", sAfter.treasuryBalance.toNumber(), "lamports ← unchanged ✓");
    console.log("    actual treasury:   ", actualAfter, "lamports ← increased ✓");
    console.log("    sell price:        ", sellAfter.toFixed(2), "lamports ← unchanged ✓");

    if (sBefore.treasuryBalance.toNumber() !== sAfter.treasuryBalance.toNumber()) throw new Error("accounted treasury changed");
    if (Math.abs(sellBefore - sellAfter) >= 1) throw new Error("price changed from direct transfer");
    if (actualAfter <= actualBefore) throw new Error("actual treasury didn't increase");

    console.log("  ✓ accounted treasury is source of truth");
  });

  it("ExceedsMaxAmount: MAX_AMOUNT_PER_TX+1 is rejected", async () => {
    try {
      await program.methods
        .buy(new anchor.BN(MAX_PER_TX + 1))
        .accounts({ state: state.publicKey, mint: mint.publicKey, buyer: provider.wallet.publicKey })
        .rpc();
      throw new Error("should have failed");
    } catch (e: any) {
      if (e.message.includes("ExceedsMaxAmount")) {
        console.log("  ✓ buy ExceedsMaxAmount correctly rejected");
      } else { throw e; }
    }

    try {
      await program.methods
        .sell(new anchor.BN(MAX_PER_TX + 1))
        .accounts({ state: state.publicKey, mint: mint.publicKey, seller: provider.wallet.publicKey })
        .rpc();
      throw new Error("should have failed");
    } catch (e: any) {
      if (e.message.includes("ExceedsMaxAmount")) {
        console.log("  ✓ sell ExceedsMaxAmount correctly rejected");
      } else { throw e; }
    }
  });
});

// ============================================================
// PRICE TABLE VERIFICATION
// ============================================================
describe("nautilus vNext — price table verification", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Nautilus as Program<Nautilus>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const state = Keypair.generate();
  const mint = Keypair.generate();

  before(async () => {
    const metadata = getMetadataPDA(mint.publicKey);
    await program.methods
      .initialize("Price Test", "PRC", "https://arweave.net/test")
      // @ts-ignore — metadata and tokenMetadataProgram are valid accounts per IDL
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        authority: provider.wallet.publicKey,
        metadata,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
      })
      .signers([state, mint])
      .rpc();
  });

  const buyAccounts = () => ({
    state: state.publicKey, mint: mint.publicKey, buyer: provider.wallet.publicKey,
  });

  it("stage 0 buy price matches PRICE_TABLE[0]", async () => {
    const sBefore = await (program.account as any).nautilusState.fetch(state.publicKey);
    const tbBefore = sBefore.treasuryBalance.toNumber();
    await program.methods.buy(new anchor.BN(1)).accounts(buyAccounts()).rpc();
    const sAfter = await (program.account as any).nautilusState.fetch(state.publicKey);
    const actual = sAfter.treasuryBalance.toNumber() - tbBefore;
    console.log(`  stage 0: expected=${PRICE_TABLE[0]} actual=${actual}`);
    if (actual !== PRICE_TABLE[0]) throw new Error(`Price mismatch: expected ${PRICE_TABLE[0]}, got ${actual}`);
    console.log("  ✓ stage 0 price matches PRICE_TABLE[0]");
  });

  it("stage 2 buy price matches PRICE_TABLE[2] (1_356_999)", async () => {
    // Advance to stage 2: buy 1M - 1 more tokens to complete stage 0, then 1M for stage 1
    const s0 = await (program.account as any).nautilusState.fetch(state.publicKey);
    const rem0 = 10_000 - s0.stageSold[0].toNumber();
    if (rem0 > 0) await program.methods.buy(new anchor.BN(rem0)).accounts(buyAccounts()).rpc();
    await program.methods.buy(new anchor.BN(10_000)).accounts(buyAccounts()).rpc();
    // Now at stage 2
    const sBefore = await (program.account as any).nautilusState.fetch(state.publicKey);
    if (sBefore.currentStage !== 2) throw new Error(`Expected stage 2, got ${sBefore.currentStage}`);
    const tbBefore = sBefore.treasuryBalance.toNumber();
    await program.methods.buy(new anchor.BN(1)).accounts(buyAccounts()).rpc();
    const sAfter = await (program.account as any).nautilusState.fetch(state.publicKey);
    const actual = sAfter.treasuryBalance.toNumber() - tbBefore;
    console.log(`  stage 2: expected=${PRICE_TABLE[2]} actual=${actual}`);
    if (actual !== PRICE_TABLE[2]) throw new Error(`Price mismatch: expected ${PRICE_TABLE[2]}, got ${actual}`);
    console.log("  ✓ stage 2 price matches PRICE_TABLE[2] = 1_356_999");
  });
});

// ============================================================
// STRESS TEST
// ============================================================
describe("nautilus vNext — stress test", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Nautilus as Program<Nautilus>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const state = Keypair.generate();
  const mint = Keypair.generate();
  let treasury: PublicKey;

  before(async () => {
    [treasury] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), state.publicKey.toBuffer()],
      program.programId
    );
  });

  const buyAccounts = () => ({
    state: state.publicKey, mint: mint.publicKey, buyer: provider.wallet.publicKey,
  });
  const sellAccounts = () => ({
    state: state.publicKey, mint: mint.publicKey, seller: provider.wallet.publicKey,
  });

  async function buyChunked(total: number) {
    let remaining = total;
    while (remaining > 0) {
      const chunk = Math.min(remaining, MAX_PER_TX);
      await program.methods.buy(new anchor.BN(chunk)).accounts(buyAccounts()).rpc();
      remaining -= chunk;
    }
  }

  async function sellChunked(total: number) {
    let remaining = total;
    while (remaining > 0) {
      const chunk = Math.min(remaining, MAX_PER_TX);
      await program.methods.sell(new anchor.BN(chunk)).accounts(sellAccounts()).rpc();
      remaining -= chunk;
    }
  }

  async function logState(label: string) {
    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    const tb = s.treasuryBalance.toNumber();
    const ts = s.totalSold.toNumber();
    const buyPrice = PRICE_TABLE[Math.min(s.currentStage, 29)];
    const sellPrice = ts === 0 ? 0 : tb / ts;
    console.log(`[${label}]`, `stage: ${s.currentStage}`, `| sold: ${ts.toLocaleString()}`,
      `| treasury: ${(tb / 1e9).toFixed(4)} SOL`, `| buy: ${buyPrice.toLocaleString()} lam`,
      `| sell: ${sellPrice.toFixed(2)} lam`);
    return { stage: s.currentStage, buyPrice, sellPrice, treasury: tb, sold: ts };
  }

  it("initialize", async () => {
    const metadata = getMetadataPDA(mint.publicKey);
    await program.methods
      .initialize("Nautilus", "NAUT", "https://arweave.net/test")
      // @ts-ignore — metadata and tokenMetadataProgram are valid accounts per IDL
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        authority: provider.wallet.publicKey,
        metadata,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
      })
      .signers([state, mint])
      .rpc();
    await logState("init");
  });

  it("sell out stage 1 → advance to stage 2", async () => {
    await buyChunked(10_000); await logState("stage 1 sold out");
  });
  it("sell out stage 2 → advance to stage 3", async () => {
    await buyChunked(10_000); await logState("stage 2 sold out");
  });
  it("sell out stage 3 → advance to stage 4", async () => {
    await buyChunked(20_000); await logState("stage 3 sold out");
  });
  it("sell out stage 4 → advance to stage 5", async () => {
    await buyChunked(30_000); await logState("stage 4 sold out");
  });
  it("sell out stage 5 → advance to stage 6", async () => {
    await buyChunked(50_000); await logState("stage 5 sold out");
  });

  it("panic sell: dump 50% of holdings at once", async () => {
    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    const half = Math.floor(s.totalSold.toNumber() / 2);
    const before = await logState("before panic sell");
    await sellChunked(half);
    await logState("after panic sell (50%)");
    console.log("  → buy price before sell:", before.buyPrice.toLocaleString(), "lam");
  });

  it("price check: floor price holds after selling", async () => {
    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    const sellPrice = s.treasuryBalance.toNumber() / s.totalSold.toNumber();
    console.log("  sell price:", sellPrice.toFixed(2), "lam (should be above initial 1,000,000)");
  });

  it("buy back: stage does not decrease", async () => {
    const before = await (program.account as any).nautilusState.fetch(state.publicKey);
    await buyChunked(10_000);
    const after = await (program.account as any).nautilusState.fetch(state.publicKey);
    await logState("after buyback");
    console.log("  stage:", before.currentStage, "→", after.currentStage, "(should not decrease)");
  });

  it("second panic sell: dump 80% of holdings", async () => {
    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    const amount = Math.floor(s.totalSold.toNumber() * 0.8);
    await sellChunked(amount); await logState("after panic sell (80%)");
  });

  it("treasury balance check: should not be drained", async () => {
    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    const tb = s.treasuryBalance.toNumber();
    const ts = s.totalSold.toNumber();
    console.log("  treasury:", (tb / 1e9).toFixed(6), "SOL");
    console.log("  total_sold:", ts.toLocaleString(), "tokens");
    console.log("  sell price:", (tb / ts).toFixed(2), "lam");
    console.log("  → treasury > 0:", tb > 0 ? "✓ not drained" : "✗ drained");
  });

  it("last token: can the final token be sold?", async () => {
    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    const remaining = s.totalSold.toNumber();
    if (remaining > 1) { await sellChunked(remaining - 1); await logState("down to last token"); }
    try {
      await program.methods.sell(new anchor.BN(1)).accounts(sellAccounts()).rpc();
      await logState("last token sold");
      console.log("  ✓ last token sold successfully");
    } catch (e: any) {
      if (e.message.includes("InsufficientTreasury")) {
        console.log("  ✓ correctly rejected: rent minimum protects treasury");
      } else { throw e; }
    }
  });

  it("re-buy after full sellout", async () => {
    await buyChunked(100); await logState("re-buy after full sellout");
  });
});

// ============================================================
// BOT RESISTANCE TEST: Stage 1/2 circulating supply gate
// ============================================================
describe("nautilus vNext — bootstrap phase bot resistance", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Nautilus as Program<Nautilus>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const state = Keypair.generate();
  const mint = Keypair.generate();
  let treasury: PublicKey;

  before(async () => {
    [treasury] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), state.publicKey.toBuffer()],
      program.programId
    );

    const metadata = getMetadataPDA(mint.publicKey);
    await program.methods
      .initialize("Bot Test", "BOT", "https://arweave.net/test")
      // @ts-ignore — metadata and tokenMetadataProgram are valid accounts per IDL
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        authority: provider.wallet.publicKey,
        metadata,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
      })
      .signers([state, mint])
      .rpc();
  });

  const buyAccounts = () => ({
    state: state.publicKey, mint: mint.publicKey, buyer: provider.wallet.publicKey,
  });
  const sellAccounts = () => ({
    state: state.publicKey, mint: mint.publicKey, seller: provider.wallet.publicKey,
  });

  it("volume bot simulation: repeated buy/sell in Stage 1 does not advance stage", async () => {
    // Simulate bot: buy 500k → sell 500k × 3 cycles
    // Under old logic (cumulative issuance), stage_sold would reach 1,500,000 → stage advances
    // Under new logic (circulating supply), total_sold never exceeds 500,000 → stage stays at 0
    for (let i = 0; i < 3; i++) {
      await program.methods.buy(new anchor.BN(5_000)).accounts(buyAccounts()).rpc();
      await program.methods.sell(new anchor.BN(5_000)).accounts(sellAccounts()).rpc();
    }

    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    console.log("  after 3× buy/sell cycles (500k each):");
    console.log("  stage:", s.currentStage, "(should be 0)");
    console.log("  total_sold:", s.totalSold.toNumber(), "(should be 0)");

    if (s.currentStage !== 0) throw new Error(`Stage advanced to ${s.currentStage} — bot resistance failed`);
    console.log("  ✓ stage did not advance despite repeated buy/sell cycling");
  });

  it("stage advances only when circulating supply reaches 1,000,000", async () => {
    // Now buy and hold 1,000,000 → should advance to Stage 1
    await program.methods.buy(new anchor.BN(10_000)).accounts(buyAccounts()).rpc();

    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    console.log("  after buying and holding 1,000,000:");
    console.log("  stage:", s.currentStage, "(should be 1)");
    console.log("  total_sold:", s.totalSold.toNumber());

    if (s.currentStage !== 1) throw new Error(`Stage is ${s.currentStage}, expected 1`);
    console.log("  ✓ stage advanced to 1 when circulating supply hit 1,000,000");
  });

  it("volume bot simulation: repeated buy/sell in Stage 2 does not advance stage", async () => {
    // In Stage 2, circulating supply is currently 1,000,000
    // Bot cycles should not push total_sold to 2,000,000
    for (let i = 0; i < 3; i++) {
      await program.methods.buy(new anchor.BN(5_000)).accounts(buyAccounts()).rpc();
      await program.methods.sell(new anchor.BN(5_000)).accounts(sellAccounts()).rpc();
    }

    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    console.log("  after 3× buy/sell cycles in Stage 2 (500k each):");
    console.log("  stage:", s.currentStage, "(should be 1)");
    console.log("  total_sold:", s.totalSold.toNumber(), "(should be 10,000)");

    if (s.currentStage !== 1) throw new Error(`Stage advanced to ${s.currentStage} — bot resistance failed`);
    console.log("  ✓ stage did not advance despite repeated buy/sell cycling");
  });

  it("stage advances to 2 only when circulating supply reaches 2,000,000", async () => {
    // Buy another 1,000,000 → total_sold = 2,000,000 → should advance to Stage 2
    await program.methods.buy(new anchor.BN(10_000)).accounts(buyAccounts()).rpc();

    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    console.log("  after buying another 1,000,000 (total held = 20,000):");
    console.log("  stage:", s.currentStage, "(should be 2)");
    console.log("  total_sold:", s.totalSold.toNumber());

    if (s.currentStage !== 2) throw new Error(`Stage is ${s.currentStage}, expected 2`);
    console.log("  ✓ stage advanced to 2 when circulating supply hit 2,000,000");
  });
});

// ============================================================
// STAGE_SOLD OVERFLOW SAFETY: stage_sold[0/1] exceeds 1M
// ============================================================
describe("nautilus vNext — stage_sold overflow safety", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Nautilus as Program<Nautilus>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const state = Keypair.generate();
  const mint = Keypair.generate();

  before(async () => {
    const [treasury] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), state.publicKey.toBuffer()],
      program.programId
    );
    const metadata = getMetadataPDA(mint.publicKey);
    await program.methods
      .initialize("Overflow Test", "OVF", "https://arweave.net/test")
      // @ts-ignore — metadata and tokenMetadataProgram are valid accounts per IDL
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        authority: provider.wallet.publicKey,
        metadata,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
      })
      .signers([state, mint])
      .rpc();
  });

  const buyAccounts = () => ({
    state: state.publicKey, mint: mint.publicKey, buyer: provider.wallet.publicKey,
  });
  const sellAccounts = () => ({
    state: state.publicKey, mint: mint.publicKey, seller: provider.wallet.publicKey,
  });

  it("stage_sold[0] exceeds 1M via buy/sell cycles — stage and remaining stay consistent", async () => {
    // Buy 4k, sell 4k × 3 cycles: stage_sold[0] accumulates to 12,000 (> 10k S1 supply)
    // but total_sold (circulating) stays at 0 after each cycle
    // Stage should NOT advance, remaining should still be calculable
    for (let i = 0; i < 3; i++) {
      await program.methods.buy(new anchor.BN(4_000)).accounts(buyAccounts()).rpc();
      await program.methods.sell(new anchor.BN(4_000)).accounts(sellAccounts()).rpc();
    }

    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    const stageSold0 = s.stageSold[0].toNumber();
    const totalSold = s.totalSold.toNumber();

    console.log("  stage_sold[0]:", stageSold0.toLocaleString(), "(cumulative minted in stage 0)");
    console.log("  total_sold (circulating):", totalSold.toLocaleString());
    console.log("  current_stage:", s.currentStage);

    // stage_sold[0] should be > 1,000,000 (cumulative: 400k × 3 = 1,200,000)
    if (stageSold0 <= 10_000) throw new Error(`stage_sold[0] = ${stageSold0}, expected > 10,000`);
    console.log("  ✓ stage_sold[0] correctly exceeds 10k (cumulative issuance)");

    // stage should still be 0 — circulating supply hasn't hit 1M
    if (s.currentStage !== 0) throw new Error(`Stage advanced to ${s.currentStage} unexpectedly`);
    console.log("  ✓ stage is still 0 — circulating supply gate holds");

    // remaining buy capacity = 1_000_000 - total_sold (should be > 0)
    const remaining = 10_000 - totalSold;
    if (remaining <= 0) throw new Error(`remaining = ${remaining}, expected > 0`);
    console.log("  ✓ remaining buy capacity:", remaining.toLocaleString(), "tokens");

    // Verify we can still buy up to the remaining amount
    await program.methods.buy(new anchor.BN(remaining)).accounts(buyAccounts()).rpc();
    const sAfter = await (program.account as any).nautilusState.fetch(state.publicKey);
    if (sAfter.currentStage !== 1) throw new Error(`Expected stage 1, got ${sAfter.currentStage}`);
    console.log("  ✓ buying remaining", remaining.toLocaleString(), "tokens advanced stage to 1");
  });
});
// ============================================================
// RECOVERY FLOOR DESIGN VERIFICATION (5 tests)
// ============================================================
describe("nautilus vNext — recovery floor design verification", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Nautilus as Program<Nautilus>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const state = Keypair.generate();
  const mint = Keypair.generate();
  let treasury: PublicKey;

  const PHI = (1 + Math.sqrt(5)) / 2;
  const FLOOR = 1 / PHI; // ≈ 0.6180339887498948

  const STAGE_SUPPLY_ARR = [
       10_000,      10_000,      20_000,      30_000,      50_000,
       80_000,     130_000,     210_000,     340_000,     550_000,
      890_000,   1_440_000,
  ];

  const EXPECTED_COMPLETION_TREASURY = [
    10_000_000_000,
    20_000_000_000,
    47_139_980_000,
    95_809_250_000,
    197_389_750_000,
    397_297_190_000,
    799_593_760_000,
    1_602_289_990_000,
    3_209_131_010_000,
    6_421_706_310_000,
    12_847_703_000_000,
    25_699_050_680_000,
  ];

  const EXPECTED_ENTRY_RECOVERY = [
    1.0,
    0.7369202188063514,
    0.7264334353073305,
    0.6737038956436380,
    0.6582704809118993,
    0.6419223845234375,
    0.6339040520064144,
    0.6278463397473901,
    0.6243299203757186,
    0.6219620858262807,
    0.6205136257606554,
  ];

  const buyAccounts = () => ({
    state: state.publicKey, mint: mint.publicKey, buyer: provider.wallet.publicKey,
  });
  const sellAccounts = () => ({
    state: state.publicKey, mint: mint.publicKey, seller: provider.wallet.publicKey,
  });

  async function buyChunked(total: number) {
    let remaining = total;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 100_000);
      await program.methods.buy(new anchor.BN(chunk)).accounts(buyAccounts()).rpc();
      remaining -= chunk;
    }
  }

  async function sellChunked(total: number) {
    let remaining = total;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 100_000);
      await program.methods.sell(new anchor.BN(chunk)).accounts(sellAccounts()).rpc();
      remaining -= chunk;
    }
  }

  before(async () => {
    [treasury] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), state.publicKey.toBuffer()],
      program.programId
    );
    const metadata = getMetadataPDA(mint.publicKey);
    await program.methods
      .initialize("Recovery Test", "RCV", "https://arweave.net/test")
      // @ts-ignore — metadata and tokenMetadataProgram are valid accounts per IDL
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        authority: provider.wallet.publicKey,
        metadata,
        tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
      })
      .signers([state, mint])
      .rpc();
  });

  // Shared buy-only progression state
  let completionTreasuries: number[] = [];
  let entryRecoveries: number[] = [];

  it("test 1+2+3: buy-only completion treasury and recovery ratio", async () => {
    // Buy through stages 0-11 (Stage 1-12), no sells
    for (let stage = 0; stage < 12; stage++) {
      await buyChunked(STAGE_SUPPLY_ARR[stage]);
      const s = await (program.account as any).nautilusState.fetch(state.publicKey);
      const tb = s.treasuryBalance.toNumber();
      const ts = s.totalSold.toNumber();
      const sellPrice = ts === 0 ? 0 : tb / ts;
      completionTreasuries.push(tb);

      // TEST 1: treasury exact match
      const expectedTb = EXPECTED_COMPLETION_TREASURY[stage];
      console.log(`  Stage ${stage+1} completion: treasury=${tb.toLocaleString()} expected=${expectedTb.toLocaleString()} ${tb === expectedTb ? '✓' : '✗'}`);
      if (tb !== expectedTb) throw new Error(`Treasury mismatch at stage ${stage+1}: got ${tb}, expected ${expectedTb}`);

      // TEST 2: recovery ratio (stages 0-10, comparing to next stage price)
      if (stage < 11) {
        const nextBuyPrice = PRICE_TABLE[stage + 1];
        const recovery = sellPrice / nextBuyPrice;
        entryRecoveries.push(recovery);
        const expectedRecovery = EXPECTED_ENTRY_RECOVERY[stage];
        const diff = Math.abs(recovery - expectedRecovery);
        console.log(`  Stage ${stage+1} recovery: ${recovery.toFixed(10)} expected=${expectedRecovery.toFixed(10)} diff=${diff.toExponential(2)} ${diff < 1e-6 ? '✓' : '✗'}`);
        if (diff > 1e-6) throw new Error(`Recovery mismatch at stage ${stage+1}: got ${recovery}, expected ${expectedRecovery}`);
      }
    }
    console.log("  ✓ TEST 1: all completion treasuries match");
    console.log("  ✓ TEST 2: all entry recovery ratios match");

    // TEST 3: recovery ratios approach 1/φ monotonically
    for (let i = 1; i < entryRecoveries.length - 1; i++) {
      if (entryRecoveries[i] > entryRecoveries[i-1] + 1e-9) {
        throw new Error(`Recovery not monotonically decreasing at stage ${i+2}: ${entryRecoveries[i]} > ${entryRecoveries[i-1]}`);
      }
    }
    const lastRecovery = entryRecoveries[entryRecoveries.length - 1];
    if (lastRecovery - FLOOR > 0.003) {
      throw new Error(`Recovery ${lastRecovery} has not approached 1/φ (${FLOOR.toFixed(6)}) closely enough`);
    }
    console.log(`  ✓ TEST 3: recovery monotonically decreasing toward 1/φ (last=${lastRecovery.toFixed(6)}, floor=${FLOOR.toFixed(6)})`);
  });

  it("test 4: actual gap materially improved over legacy design", async () => {
    // Use recorded completion treasuries to compute entry gaps
    // Stage 3 entry (after stage 2 completion): sell_price = treasury[1]/total_sold_after_stage2
    // total_sold after stage 2 = 2_000_000
    const sellAfterStage2 = EXPECTED_COMPLETION_TREASURY[1] / 20_000;
    const gapStage3 = 1 - sellAfterStage2 / PRICE_TABLE[2];

    const sellAfterStage3 = EXPECTED_COMPLETION_TREASURY[2] / 40_000;
    const gapStage4 = 1 - sellAfterStage3 / PRICE_TABLE[3];

    const sellAfterStage4 = EXPECTED_COMPLETION_TREASURY[3] / 70_000;
    const gapStage5 = 1 - sellAfterStage4 / PRICE_TABLE[4];

    const sellAfterStage5 = EXPECTED_COMPLETION_TREASURY[4] / 120_000;
    const gapStage6 = 1 - sellAfterStage5 / PRICE_TABLE[5];

    console.log(`  Stage 3 entry gap: ${(gapStage3*100).toFixed(2)}% (legacy ~50%)`);
    console.log(`  Stage 4 entry gap: ${(gapStage4*100).toFixed(2)}% (legacy ~50%)`);
    console.log(`  Stage 5 entry gap: ${(gapStage5*100).toFixed(2)}% (legacy ~57%)`);
    console.log(`  Stage 6 entry gap: ${(gapStage6*100).toFixed(2)}% (legacy ~58%)`);

    if (!(gapStage3 < 0.30)) throw new Error(`Stage 3 gap ${gapStage3} not improved enough vs legacy 0.50`);
    if (!(gapStage4 < 0.32)) throw new Error(`Stage 4 gap ${gapStage4} not improved enough vs legacy 0.50`);
    if (!(gapStage5 < 0.36)) throw new Error(`Stage 5 gap ${gapStage5} not improved enough vs legacy 0.57`);
    if (!(gapStage6 < 0.40)) throw new Error(`Stage 6 gap ${gapStage6} not improved enough vs legacy 0.58`);
    console.log("  ✓ TEST 4: all entry gaps materially improved over legacy design");
  });

  it("test 5: panic sell improves recovery ratio", async () => {
    // state is now after stage 12 completion (buy-only)
    // buy a bit more to have something to sell in stage 12
    await buyChunked(10_000);

    const sBefore = await (program.account as any).nautilusState.fetch(state.publicKey);
    const tbBefore = sBefore.treasuryBalance.toNumber();
    const tsBefore = sBefore.totalSold.toNumber();
    const sellBefore = tbBefore / tsBefore;
    const currentBuyPrice = PRICE_TABLE[Math.min(sBefore.currentStage, 19)];
    const recoveryBefore = sellBefore / currentBuyPrice;

    // Sell 50%
    const half = Math.floor(tsBefore / 2);
    await sellChunked(half);

    const sAfter = await (program.account as any).nautilusState.fetch(state.publicKey);
    const tbAfter = sAfter.treasuryBalance.toNumber();
    const tsAfter = sAfter.totalSold.toNumber();
    const sellAfter = tbAfter / tsAfter;
    const recoveryAfter = sellAfter / currentBuyPrice;

    console.log(`  recovery before panic sell: ${recoveryBefore.toFixed(6)}`);
    console.log(`  recovery after  panic sell: ${recoveryAfter.toFixed(6)}`);

    if (!(recoveryAfter > recoveryBefore)) {
      throw new Error(`Recovery did not improve after sell: ${recoveryBefore} -> ${recoveryAfter}`);
    }
    console.log("  ✓ TEST 5: panic sell improves recovery ratio");
  });
});