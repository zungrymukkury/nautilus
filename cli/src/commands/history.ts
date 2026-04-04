import chalk from "chalk";
import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { getProvider, loadWallet, loadIdl, resolveState } from "../config";

export async function historyCommand(stateAddress: string, limit: number = 20) {
  const wallet = loadWallet();
  const provider = getProvider(wallet);
  anchor.setProvider(provider);

  const stateKey = await resolveState(stateAddress);
  const idl = loadIdl();
  const program = new anchor.Program(idl, provider);

  try {
    const state: any = await (program as any).account.nautilusState.fetch(stateKey);
    const mint = state.mint as PublicKey;
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);

    console.log(chalk.cyan("\n🐚 Nautilus History\n"));
    console.log(chalk.gray(`  Wallet: ${wallet.publicKey.toString()}`));
    console.log(chalk.gray(`  Token:  ${mint.toString()}`));
    console.log();

    // ATAのtx履歴を取得
    const sigs = await provider.connection.getSignaturesForAddress(ata, { limit });

    if (sigs.length === 0) {
      console.log(chalk.gray("  No transactions found.\n"));
      return;
    }

    for (const sig of sigs) {
      const date = sig.blockTime
        ? new Date(sig.blockTime * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
        : "unknown";
      const status = sig.err ? chalk.red("FAIL") : chalk.green(" OK ");
      const shortSig = sig.signature.slice(0, 16) + "...";
      const url = chalk.gray(`https://solscan.io/tx/${sig.signature}`);

      console.log(`  ${status}  ${chalk.white(date)}  ${chalk.yellow(shortSig)}`);
      console.log(`         ${url}`);
    }

    console.log();

  } catch (e: any) {
    console.error(chalk.red("Error:"), e.message);
    process.exit(1);
  }
}