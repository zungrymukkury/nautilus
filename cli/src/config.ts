import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const FIB = [1,1,2,3,5,8,13,21,34,55,89,144,233,377,610,987,1597,2584,4181,6765];
export const BASE_PRICE = 1_000_000;
export const MAX_PER_TX = 1_000_000;
export const PROGRAM_ID = new PublicKey("32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev");

const IDL_PATH = path.resolve(__dirname, "../../target/idl/nautilus.json");

export function loadIdl() {
  if (!fs.existsSync(IDL_PATH)) {
    throw new Error(`IDL not found: ${IDL_PATH}\nRun: anchor build`);
  }
  return JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
}

export function loadWallet(): Keypair {
  const walletPath = process.env.NAUTILUS_WALLET
    || path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet not found: ${walletPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function getConnection(): Connection {
  const rpc = process.env.NAUTILUS_RPC || "http://127.0.0.1:8899";
  return new Connection(rpc, "confirmed");
}

export function getProvider(wallet: Keypair): anchor.AnchorProvider {
  const conn = getConnection();
  const anchorWallet = new anchor.Wallet(wallet);
  return new anchor.AnchorProvider(conn, anchorWallet, { commitment: "confirmed" });
}

export function getPDAs(stateKey: PublicKey) {
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("nautilus"), stateKey.toBuffer()],
    PROGRAM_ID
  );
  const [treasury] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), stateKey.toBuffer()],
    PROGRAM_ID
  );
  return { mintAuthority, treasury };
}

export function formatLamports(lamports: number): string {
  const sol = lamports / 1e9;
  if (sol >= 1) return `${sol.toFixed(4)} SOL`;
  return `${lamports.toLocaleString()} lamports`;
}

// CAまたはStateアドレスを受け取ってStateのPublicKeyを返す
// CAの場合: getProgramAccountsでmint offset:73を検索
// Stateアドレスの場合: そのまま返す
export async function resolveState(input: string): Promise<PublicKey> {
  const conn = getConnection();
  const inputKey = new PublicKey(input);

  // まずStateアドレスとして試す（getNautilusStateでfetchできるか）
  // getProgramAccountsでmint=inputのStateを検索してみる
  const rpcUrl = process.env.NAUTILUS_RPC || "http://127.0.0.1:8899";
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "getProgramAccounts",
      params: [
        PROGRAM_ID.toString(),
        {
          encoding: "base64",
          filters: [
            { dataSize: 283 },
            { memcmp: { offset: 73, bytes: input } }
          ]
        }
      ]
    })
  });
  const data = await res.json() as any;

  if (data.result && data.result.length > 0) {
    // CAとしてヒット → StateアドレスをPublicKeyで返す
    return new PublicKey(data.result[0].pubkey);
  }

  // CAとしてヒットしなかった → Stateアドレスとして扱う
  return inputKey;
}