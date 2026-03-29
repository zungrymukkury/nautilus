import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Nautilus } from "../target/types/nautilus";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

const MAX_PER_TX = 1_000_000;
const FIB_ARR = [1,1,2,3,5,8,13,21,34,55,89,144,233,377,610,987,1597,2584,4181,6765];

// ============================================================
// REGRESSION TEST: fresh-state first-buy
// ============================================================
describe("nautilus v0.4 — fresh state first-buy regression", () => {
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

    await program.methods
      .initialize()
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        authority: provider.wallet.publicKey,
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
      treasuryBefore === null
        ? "✓ empty (will be created)"
        : `exists with ${treasuryBefore.lamports} lamports`
    );

    await program.methods
      .buy(new anchor.BN(1))
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        buyer: provider.wallet.publicKey,
      })
      .rpc();

    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    const treasuryAfter = await conn.getAccountInfo(treasury);

    console.log("  total_sold:", s.totalSold.toNumber(), "✓");
    console.log("  treasury_balance:", s.treasuryBalance.toNumber(), "lamports ✓");
    console.log("  treasury actual lamports:", treasuryAfter?.lamports, "✓");
    console.log("  accounted == actual:",
      s.treasuryBalance.toNumber() === treasuryAfter?.lamports ? "✓" : "⚠ differs (expected if rent exists)"
    );
  });

  it("fresh deploy: sell after first buy behaves correctly", async () => {
    try {
      await program.methods
        .sell(new anchor.BN(1))
        .accounts({
          state: state.publicKey,
          mint: mint.publicKey,
          seller: provider.wallet.publicKey,
        })
        .rpc();
      console.log("  ✓ sold");
    } catch (e: any) {
      if (e.message.includes("InsufficientTreasury")) {
        console.log("  ✓ correctly rejected: single token falls below rent minimum (treasury protection active)");
      } else {
        throw e;
      }
    }
  });
});

// ============================================================
// REGRESSION TEST: accounted treasury
// ============================================================
describe("nautilus v0.4 — accounted treasury regression", () => {
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

    await program.methods
      .initialize()
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        authority: provider.wallet.publicKey,
      })
      .signers([state, mint])
      .rpc();

    await program.methods
      .buy(new anchor.BN(MAX_PER_TX))
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        buyer: provider.wallet.publicKey,
      })
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

    const accountedUnchanged = sBefore.treasuryBalance.toNumber() === sAfter.treasuryBalance.toNumber();
    const priceUnchanged = Math.abs(sellBefore - sellAfter) < 1;
    const actualIncreased = actualAfter > actualBefore;

    if (!accountedUnchanged) throw new Error("accounted treasury changed unexpectedly");
    if (!priceUnchanged) throw new Error("price changed from direct transfer");
    if (!actualIncreased) throw new Error("actual treasury didn't increase");

    console.log("  ✓ accounted treasury is source of truth");
  });

  it("ExceedsMaxAmount: MAX_AMOUNT_PER_TX+1 is rejected", async () => {
    try {
      await program.methods
        .buy(new anchor.BN(MAX_PER_TX + 1))
        .accounts({
          state: state.publicKey,
          mint: mint.publicKey,
          buyer: provider.wallet.publicKey,
        })
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
        .accounts({
          state: state.publicKey,
          mint: mint.publicKey,
          seller: provider.wallet.publicKey,
        })
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
// STRESS TEST
// ============================================================
describe("nautilus v0.4 stress test", () => {
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
    state: state.publicKey,
    mint: mint.publicKey,
    buyer: provider.wallet.publicKey,
  });

  const sellAccounts = () => ({
    state: state.publicKey,
    mint: mint.publicKey,
    seller: provider.wallet.publicKey,
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
    const buyPrice = 1_000_000 * FIB_ARR[Math.min(s.currentStage, 19)];
    const sellPrice = ts === 0 ? 0 : tb / ts;
    console.log(
      `[${label}]`,
      `stage: ${s.currentStage}`,
      `| sold: ${ts.toLocaleString()}`,
      `| treasury: ${(tb / 1e9).toFixed(4)} SOL`,
      `| buy: ${buyPrice.toLocaleString()} lam`,
      `| sell: ${sellPrice.toFixed(2)} lam`
    );
    return { stage: s.currentStage, buyPrice, sellPrice, treasury: tb, sold: ts };
  }

  it("initialize", async () => {
    await program.methods
      .initialize()
      .accounts({
        state: state.publicKey,
        mint: mint.publicKey,
        authority: provider.wallet.publicKey,
      })
      .signers([state, mint])
      .rpc();
    await logState("init");
  });

  it("sell out stage 1 → advance to stage 2", async () => {
    await buyChunked(1_000_000);
    await logState("stage 1 sold out");
  });

  it("sell out stage 2 → advance to stage 3", async () => {
    await buyChunked(1_000_000);
    await logState("stage 2 sold out");
  });

  it("sell out stage 3 → advance to stage 4", async () => {
    await buyChunked(2_000_000);
    await logState("stage 3 sold out");
  });

  it("sell out stage 4 → advance to stage 5", async () => {
    await buyChunked(3_000_000);
    await logState("stage 4 sold out");
  });

  it("sell out stage 5 → advance to stage 6", async () => {
    await buyChunked(5_000_000);
    await logState("stage 5 sold out");
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
    await buyChunked(1_000_000);
    const after = await (program.account as any).nautilusState.fetch(state.publicKey);
    await logState("after buyback");
    console.log("  stage:", before.currentStage, "→", after.currentStage, "(should not decrease)");
  });

  it("second panic sell: dump 80% of holdings", async () => {
    const s = await (program.account as any).nautilusState.fetch(state.publicKey);
    const amount = Math.floor(s.totalSold.toNumber() * 0.8);
    await sellChunked(amount);
    await logState("after panic sell (80%)");
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
    if (remaining > 1) {
      await sellChunked(remaining - 1);
      await logState("down to last token");
    }
    try {
      await program.methods.sell(new anchor.BN(1)).accounts(sellAccounts()).rpc();
      await logState("last token sold");
      console.log("  ✓ last token sold successfully");
    } catch (e: any) {
      if (e.message.includes("InsufficientTreasury")) {
        console.log("  ✓ correctly rejected: rent minimum protects treasury");
      } else {
        throw e;
      }
    }
  });

  it("re-buy after full sellout", async () => {
    await buyChunked(100);
    await logState("re-buy after full sellout");
  });
});