import chalk from "chalk";
import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getProvider, loadWallet, loadIdl, PROGRAM_ID, MAX_PER_TX, getPDAs, formatLamports, resolveState } from "../config";

export async function sellCommand(stateAddress: string, amount: number) {
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
    const { treasury } = getPDAs(stateKey);
    const mint = state.mint as PublicKey;

    const totalSold = state.totalSold.toNumber();
    const treasuryBalance = state.treasuryBalance.toNumber();

    if (totalSold === 0) {
      console.error(chalk.red("No tokens in circulation"));
      process.exit(1);
    }

    const sellPrice = Math.floor(treasuryBalance / totalSold);
    const payout = Math.floor(sellPrice * amount * 0.995); // 0.5% spread

    console.log(chalk.cyan("\n🐚 Nautilus Sell\n"));
    console.log(chalk.white("  Sell price/token:"), chalk.green(formatLamports(sellPrice)));
    console.log(chalk.white("  Amount:          "), chalk.white(`${amount.toLocaleString()} tokens`));
    console.log(chalk.white("  Estimated payout:"), chalk.yellow(formatLamports(payout)));
    console.log(chalk.gray("  (0.5% spread applied)"));
    console.log();

    const sellerAta = await getAssociatedTokenAddress(mint, wallet.publicKey);

    let remaining = amount;
    let txCount = 0;

    while (remaining > 0) {
      const chunk = Math.min(remaining, MAX_PER_TX);
      const sig = await program.methods
        .sell(new anchor.BN(chunk))
        .accounts({
          state: stateKey,
          mint,
          seller: wallet.publicKey,
          sellerAta,
          treasury,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      txCount++;
      remaining -= chunk;
      console.log(chalk.green(`  ✓ tx ${txCount}: ${chunk.toLocaleString()} tokens sold`), chalk.gray(`(${sig.slice(0, 16)}...)`));
    }

    console.log(chalk.green("\n  ✓ Sell complete\n"));

  } catch (e: any) {
    console.error(chalk.red("Error:"), e.message);
    process.exit(1);
  }
}
