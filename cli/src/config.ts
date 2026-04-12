import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const FIB = [1,1,2,3,5,8,13,21,34,55,89,144,233,377,610,987,1597,2584,4181,6765,10946,17711,28657,46368,75025,121393,196418,317811,514229,832040];
export const BASE_PRICE = 1_000_000;
export const MAX_PER_TX = 100_000;

// Buy price table: floor(BASE_PRICE × FIB[n]^a), a = log_φ(2) - 1
// Matches PRICE_TABLE in lib.rs exactly.
export const PRICE_TABLE = [
  1_000_000,  // stage  0
  1_000_000,  // stage  1
  1_356_999,  // stage  2
  1_622_309,  // stage  3
  2_031_610,  // stage  4
  2_498_843,  // stage  5
  3_094_589,  // stage  6
  3_822_363,  // stage  7
  4_726_003,  // stage  8
  5_841_046,  // stage  9
  7_220_221,  // stage 10
  8_924_547,  // stage 11
  11_031_412, // stage 12
  13_635_544, // stage 13
  16_854_474, // stage 14
  20_833_269, // stage 15
  25_751_340, // stage 16
  31_830_405, // stage 17
  39_344_546, // stage 18
  48_632_533, // stage 19
  60_113_117, // stage 20
  74_303_898, // stage 21
  91_844_670, // stage 22
  113_526_255,// stage 23
  140_326_169,// stage 24
  173_452_684,// stage 25
  214_399_308,// stage 26
  265_012_119,// stage 27
  327_572_994,// stage 28
  404_902_488,// stage 29
];
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
            { dataSize: 363 },
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