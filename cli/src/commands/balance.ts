import chalk from "chalk";
import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { getProvider, loadWallet, loadIdl, PROGRAM_ID, getPDAs, formatLamports, resolveState } from "../config";

export async function balanceCommand(stateAddress: string) {
  const wallet = loadWallet();
  const provider = getProvider(wallet);
  anchor.setProvider(provider);

  const stateKey = await resolveState(stateAddress);
  const idl = loadIdl();
  const program = new anchor.Program(idl, provider);

  try {
    const state: any = await (program as any).account.nautilusState.fetch(stateKey);
    const mint = state.mint as PublicKey;

    const solBalance = await provider.connection.getBalance(wallet.publicKey);
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);

    let tokenBalance = 0;
    try {
      const tokenAccount = await getAccount(provider.connection, ata);
      tokenBalance = Number(tokenAccount.amount);
    } catch {
      // ATA doesn't exist yet
    }

    const totalSold = state.totalSold.toNumber();
    const treasuryBalance = state.treasuryBalance.toNumber();
    const sellPrice = totalSold === 0 ? 0 : Math.floor(treasuryBalance / totalSold);
    const estimatedValue = Math.floor(sellPrice * tokenBalance * 0.995);

    console.log(chalk.cyan("\n🐚 Nautilus Balance\n"));
    console.log(chalk.white("  Wallet:          "), chalk.gray(wallet.publicKey.toString()));
    console.log(chalk.white("  SOL balance:     "), chalk.blue(formatLamports(solBalance)));
    console.log(chalk.white("  Token balance:   "), chalk.yellow(`${tokenBalance.toLocaleString()} tokens`));
    if (tokenBalance > 0) {
      console.log(chalk.white("  Estimated value: "), chalk.green(formatLamports(estimatedValue)));
      console.log(chalk.gray("  (at current sell price, after 0.5% spread)"));
    }
    console.log();

  } catch (e: any) {
    console.error(chalk.red("Error:"), e.message);
    process.exit(1);
  }
}
