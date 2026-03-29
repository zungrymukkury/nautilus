import * as anchor from "@coral-xyz/anchor";
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getProvider, loadWallet, loadIdl, PROGRAM_ID, getPDAs } from "./config";
import * as fs from "fs";

async function main() {
  const wallet = loadWallet();
  const provider = getProvider(wallet);
  anchor.setProvider(provider);

  const idl = loadIdl();
  const program = new anchor.Program(idl, provider);

  const state = Keypair.generate();
  const mint = Keypair.generate();
  const { mintAuthority, treasury } = getPDAs(state.publicKey);

  await program.methods
    .initialize()
    .accounts({
      state: state.publicKey,
      mint: mint.publicKey,
      mintAuthority,
      treasury,
      authority: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([state, mint])
    .rpc();

  console.log("✓ Initialized");
  console.log("STATE:", state.publicKey.toString());
  console.log("MINT: ", mint.publicKey.toString());

  // save to file for CLI use
  fs.writeFileSync(".nautilus-state", state.publicKey.toString());
  console.log("\nSaved to .nautilus-state");
}

main().catch(console.error);
