import chalk from "chalk";
import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getProvider, loadWallet, loadIdl, getPDAs, formatLamports, resolveState } from "../config";
import { Transaction } from "@solana/web3.js";

export async function sendCommand(stateAddress: string, recipient: string, amount: number) {
  if (amount <= 0) {
    console.error(chalk.red("Amount must be greater than 0"));
    process.exit(1);
  }

  const wallet = loadWallet();
  const provider = getProvider(wallet);
  anchor.setProvider(provider);

  const stateKey = await resolveState(stateAddress);
  const recipientKey = new PublicKey(recipient);
  const idl = loadIdl();
  const program = new anchor.Program(idl, provider);

  try {
    const state: any = await (program as any).account.nautilusState.fetch(stateKey);
    const mint = state.mint as PublicKey;

    // 送信元ATA
    const senderAta = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const senderAtaInfo = await provider.connection.getTokenAccountBalance(senderAta);
    const senderBalance = parseInt(senderAtaInfo.value.amount);

    console.log(chalk.cyan("\n🐚 Nautilus Send\n"));
    console.log(chalk.white("  From:    "), chalk.gray(wallet.publicKey.toString()));
    console.log(chalk.white("  To:      "), chalk.gray(recipientKey.toString()));
    console.log(chalk.white("  Amount:  "), chalk.white(`${amount.toLocaleString()} tokens`));
    console.log(chalk.white("  Balance: "), chalk.yellow(`${senderBalance.toLocaleString()} tokens`));
    console.log();

    if (senderBalance < amount) {
      console.error(chalk.red(`Insufficient token balance. Need ${amount.toLocaleString()}, have ${senderBalance.toLocaleString()}`));
      process.exit(1);
    }

    // 受信者のATAを取得（なければ作成）
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet,
      mint,
      recipientKey
    );

    // transfer instruction
    const tx = new Transaction().add(
      createTransferInstruction(
        senderAta,
        recipientAta.address,
        wallet.publicKey,
        amount,
        [],
        TOKEN_PROGRAM_ID
      )
    );

    const sig = await provider.sendAndConfirm(tx);

    console.log(chalk.green(`  ✓ Sent ${amount.toLocaleString()} tokens`), chalk.gray(`(${sig.slice(0, 16)}...)`));
    console.log(chalk.green("\n  ✓ Send complete\n"));

  } catch (e: any) {
    console.error(chalk.red("Error:"), e.message);
    process.exit(1);
  }
}