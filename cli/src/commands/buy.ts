import chalk from "chalk";
import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getProvider, loadWallet, loadIdl, PROGRAM_ID, FIB, BASE_PRICE, MAX_PER_TX, getPDAs, formatLamports, resolveState } from "../config";

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
    const buyPrice = BASE_PRICE * FIB[stage];
    const totalCost = buyPrice * amount;

    console.log(chalk.cyan("\n🐚 Nautilus Buy\n"));
    console.log(chalk.white("  Stage:      "), chalk.yellow(stage.toString()));
    console.log(chalk.white("  Price/token:"), chalk.green(formatLamports(buyPrice)));
    console.log(chalk.white("  Amount:     "), chalk.white(`${amount.toLocaleString()} tokens`));
    console.log(chalk.white("  Total cost: "), chalk.yellow(formatLamports(totalCost)));
    console.log();

    // Check wallet balance
    const balance = await provider.connection.getBalance(wallet.publicKey);
    if (balance < totalCost) {
      console.error(chalk.red(`Insufficient balance. Need ${formatLamports(totalCost)}, have ${formatLamports(balance)}`));
      process.exit(1);
    }

    const buyerAta = await getAssociatedTokenAddress(mint, wallet.publicKey);

    // Split into chunks if needed
    let remaining = amount;
    let txCount = 0;

    while (remaining > 0) {
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
