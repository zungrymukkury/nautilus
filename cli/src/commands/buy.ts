import chalk from "chalk";
import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getProvider, loadWallet, loadIdl, PROGRAM_ID, PRICE_TABLE, MAX_PER_TX, getPDAs, formatLamports, resolveState } from "../config";

export async function buyCommand(stateAddress: string, amount: number) {
  if (amount <= 0) {
    console.error(chalk.red("Amount must be greater than 0"));
    process.exit(1);
  }

  const wallet = loadWallet();
  const provider = getProvider(wallet);
  anchor.setProvider(provider);

  const stateKey = await resolveState(stateAddress);
  const idl = loadIdl();
  const program = new anchor.Program(idl, provider);

  try {
    const state: any = await (program as any).account.nautilusState.fetch(stateKey);
    const { mintAuthority, treasury } = getPDAs(stateKey);
    const mint = state.mint as PublicKey;
    const stage = state.currentStage;
    const buyPrice = PRICE_TABLE[stage];
    const totalCost = buyPrice * amount;

    console.log(chalk.cyan("\n🐚 Nautilus Buy\n"));
    console.log(chalk.white("  Stage:      "), chalk.yellow(stage.toString()));
    console.log(chalk.white("  Price/token:"), chalk.green(formatLamports(buyPrice)));
    console.log(chalk.white("  Amount:     "), chalk.white(`${amount.toLocaleString()} tokens`));
    console.log(chalk.white("  Est. cost:  "), chalk.yellow(formatLamports(totalCost)), chalk.gray("(at current stage, assuming no stage advance)"));
    console.log();

    // Re-fetch state immediately before submitting to catch stage advances.
    const freshState: any = await (program as any).account.nautilusState.fetch(stateKey);
    const freshStage = freshState.currentStage;
    if (freshStage !== stage) {
      const freshPrice = PRICE_TABLE[freshStage];
      console.error(chalk.yellow(`  ⚠ Stage advanced to ${freshStage} while preparing tx.`));
      console.error(chalk.yellow(`    New buy price: ${formatLamports(freshPrice)}`));
      console.error(chalk.red("  Aborted. Re-run to buy at the new price."));
      process.exit(1);
    }

    // Check wallet balance
    const balance = await provider.connection.getBalance(wallet.publicKey);
    if (balance < totalCost) {
      console.error(chalk.red(`Insufficient balance. Need ${formatLamports(totalCost)}, have ${formatLamports(balance)}`));
      process.exit(1);
    }

    const buyerAta = await getAssociatedTokenAddress(mint, wallet.publicKey);

    // Split into chunks if needed
    let remaining = amount;
    let expectedStage = stage;
    let txCount = 0;

    while (remaining > 0) {
      // Re-check stage before every chunk to catch advances mid-buy.
      const chunkFresh: any = await (program as any).account.nautilusState.fetch(stateKey);
      const chunkStage = chunkFresh.currentStage;
      if (chunkStage !== expectedStage) {
        const freshPrice = PRICE_TABLE[chunkStage];
        if (txCount > 0) {
          console.error(chalk.yellow(`  ⚠ Stage advanced to ${chunkStage} after partial fill (${txCount} tx completed).`));
          console.error(chalk.yellow(`    New buy price: ${formatLamports(freshPrice)}`));
          console.error(chalk.red("  Aborted after partial fill. Re-run to continue at the new price."));
        } else {
          console.error(chalk.yellow(`  ⚠ Stage advanced to ${chunkStage} while preparing tx.`));
          console.error(chalk.yellow(`    New buy price: ${formatLamports(freshPrice)}`));
          console.error(chalk.red("  Aborted. Re-run to buy at the new price."));
        }
        process.exit(1);
      }
      const chunk = Math.min(remaining, MAX_PER_TX);
      const sig = await program.methods
        .buy(new anchor.BN(chunk))
        .accounts({
          state: stateKey,
          mint,
          mintAuthority,
          buyer: wallet.publicKey,
          buyerAta,
          treasury,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      txCount++;
      remaining -= chunk;
      expectedStage = chunkStage;
      console.log(chalk.green(`  ✓ tx ${txCount}: ${chunk.toLocaleString()} tokens`), chalk.gray(`(${sig.slice(0, 16)}...)`));
    }

    // Fetch updated state
    const updated: any = await (program as any).account.nautilusState.fetch(stateKey);
    console.log(chalk.cyan("\n  New stage:  "), chalk.yellow(updated.currentStage.toString()));
    console.log(chalk.cyan("  Total sold: "), chalk.white(`${updated.totalSold.toNumber().toLocaleString()} tokens`));
    console.log(chalk.green("\n  ✓ Buy complete\n"));

  } catch (e: any) {
    console.error(chalk.red("Error:"), e.message);
    process.exit(1);
  }
}