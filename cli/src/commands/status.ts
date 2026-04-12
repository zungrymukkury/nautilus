import chalk from "chalk";
import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getProvider, loadWallet, loadIdl, PROGRAM_ID, FIB, PRICE_TABLE, getPDAs, formatLamports, resolveState } from "../config";

export async function statusCommand(stateAddress: string) {
  const wallet = loadWallet();
  const provider = getProvider(wallet);
  anchor.setProvider(provider);

  const stateKey = await resolveState(stateAddress);
  const idl = loadIdl();
  const program = new anchor.Program(idl, provider);

  try {
    const state: any = await (program as any).account.nautilusState.fetch(stateKey);
    const { treasury } = getPDAs(stateKey);

    const stage = state.currentStage;
    const totalSold = state.totalSold.toNumber();
    const treasuryBalance = state.treasuryBalance.toNumber();

    const buyPrice = PRICE_TABLE[stage];
    const sellPrice = totalSold === 0 ? 0 : Math.floor(treasuryBalance / totalSold);
    const sellPriceDisplay = totalSold === 0 ? "N/A (no tokens in circulation)" : formatLamports(sellPrice);

    const actualTreasury = await provider.connection.getBalance(treasury);

    console.log(chalk.cyan("\n🐚 Nautilus Protocol Status\n"));
    console.log(chalk.white("  Stage:          "), chalk.yellow(`${stage} (FIB=${FIB[stage]})`));
    console.log(chalk.white("  Buy price:      "), chalk.green(formatLamports(buyPrice)));
    console.log(chalk.white("  Sell price:     "), chalk.green(sellPriceDisplay));
    console.log(chalk.white("  Treasury:       "), chalk.blue(formatLamports(treasuryBalance)), chalk.gray("(accounted)"));
    console.log(chalk.white("  Treasury actual:"), chalk.blue(formatLamports(actualTreasury)));
    console.log(chalk.white("  Total sold:     "), chalk.white(`${totalSold.toLocaleString()} tokens`));
    console.log(chalk.white("  State account:  "), chalk.gray(stateKey.toString()));
    console.log(chalk.white("  Treasury PDA:   "), chalk.gray(treasury.toString()));
    console.log();

  } catch (e: any) {
    console.error(chalk.red("Error fetching state:"), e.message);
    process.exit(1);
  }
}