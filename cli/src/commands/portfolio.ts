import chalk from "chalk";
import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getProvider, loadWallet, loadIdl, PROGRAM_ID, formatLamports } from "../config";

interface PortfolioToken {
  stateAddress: string;
  mint: string;
  balance: number;
  sellPrice: number;
  currentStage: number;
  name?: string;
  symbol?: string;
}

async function fetchTokenName(mint: string, rpcUrl: string): Promise<{ name?: string; symbol?: string }> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: mint,
        method: "getAsset",
        params: { id: mint }
      })
    });
    const data = await res.json() as any;
    const meta = data?.result?.content?.metadata;
    return { name: meta?.name, symbol: meta?.symbol };
  } catch {
    return {};
  }
}

export async function portfolioCommand() {
  const wallet = loadWallet();
  const provider = getProvider(wallet);
  const rpcUrl = process.env.NAUTILUS_RPC || "http://127.0.0.1:8899";

  console.log(chalk.cyan("\n🐚 Nautilus Portfolio\n"));
  console.log(chalk.gray(`  Wallet: ${wallet.publicKey.toString()}\n`));

  try {
    // 1. ウォレットのSPLトークンを全取得
    const holdingsRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "holdings",
        method: "getTokenAccountsByOwner",
        params: [
          wallet.publicKey.toString(),
          { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
          { encoding: "jsonParsed" }
        ]
      })
    });
    const holdingsData = await holdingsRes.json() as any;
    const allTokenAccounts = holdingsData.result?.value || [];

    const mintsWithBalance: { mint: string; balance: number }[] = allTokenAccounts
      .map((ta: any) => {
        const info = ta.account.data.parsed?.info;
        return { mint: info?.mint as string, balance: parseInt(info?.tokenAmount?.amount || "0") };
      })
      .filter((t: { mint: string; balance: number }) => t.mint && t.balance > 0);

    if (mintsWithBalance.length === 0) {
      console.log(chalk.gray("  No tokens found.\n"));
      return;
    }

    // 2. 各mintでNautilusのStateを並列検索
    const tokens: PortfolioToken[] = [];
    await Promise.all(mintsWithBalance.map(async ({ mint, balance }) => {
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: mint,
            method: "getProgramAccounts",
            params: [
              PROGRAM_ID.toString(),
              {
                encoding: "base64",
                filters: [
                  { dataSize: 283 },
                  { memcmp: { offset: 73, bytes: mint } }
                ]
              }
            ]
          })
        });
        const data = await res.json() as any;
        if (data.result && data.result.length > 0) {
          const stateAcc = data.result[0];
          const raw = Buffer.from(stateAcc.account.data[0], "base64");
          const totalSold = Number(raw.readBigUInt64LE(106));
          const currentStage = raw.readUInt8(114);
          const treasuryBalance = Number(raw.readBigUInt64LE(275));
          const sellPrice = totalSold > 0 ? Math.floor(treasuryBalance / totalSold) : 0;
          tokens.push({ stateAddress: stateAcc.pubkey, mint, balance, sellPrice, currentStage });
        }
      } catch {}
    }));

    if (tokens.length === 0) {
      console.log(chalk.gray("  No Nautilus tokens found.\n"));
      return;
    }

    // 3. 名前・シンボルを並列取得
    await Promise.all(tokens.map(async (t) => {
      const meta = await fetchTokenName(t.mint, rpcUrl);
      t.name = meta.name;
      t.symbol = meta.symbol;
    }));

    // 4. 合計価値
    const totalValueLamports = tokens.reduce((sum, t) => sum + t.balance * t.sellPrice * 0.995, 0);

    console.log(chalk.white("  PORTFOLIO VALUE"));
    console.log(chalk.bold.green(`  ${formatLamports(Math.floor(totalValueLamports))}\n`));
    console.log(chalk.gray("  ─────────────────────────────────────────────────"));

    for (const t of tokens) {
      const value = Math.floor(t.balance * t.sellPrice * 0.995);
      const displayName = t.name
        ? chalk.bold.white(`  ${t.name}`) + (t.symbol ? chalk.gray(` (${t.symbol})`) : "")
        : chalk.white(`  ${t.mint.slice(0, 8)}...${t.mint.slice(-6)}`);

      console.log();
      console.log(displayName);
      console.log(chalk.gray(`  CA:      `) + chalk.yellow(t.mint));
      console.log(chalk.gray(`  Stage:   `) + chalk.white(t.currentStage.toString()));
      console.log(chalk.gray(`  Balance: `) + chalk.white(`${t.balance.toLocaleString()} tokens`));
      console.log(chalk.gray(`  Value:   `) + chalk.green(`≈ ${formatLamports(value)}`));
    }

    console.log(chalk.gray("\n  ─────────────────────────────────────────────────\n"));

  } catch (e: any) {
    console.error(chalk.red("Error:"), e.message);
    process.exit(1);
  }
}