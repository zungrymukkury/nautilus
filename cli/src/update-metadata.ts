import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createSignerFromKeypair, signerIdentity, publicKey, none } from '@metaplex-foundation/umi';
import { updateMetadataAccountV2, mplTokenMetadata, findMetadataPda } from '@metaplex-foundation/mpl-token-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const RPC = 'https://mainnet.helius-rpc.com/?api-key=347da966-6882-46a4-a3ee-ac636bddeeb3';
const MINT = 'HjyDnB2z7w55mpurq3VEC2gtTdzEieYNHE1J2wpqxaEE';
const PROGRAM_ID = '32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev';
const STATE = 'fR1QnzzmucFwwir6o6vajBZQoZEVfYbATWGcstHKSUm';

async function main() {
  const umi = createUmi(RPC).use(mplTokenMetadata());

  const walletPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
  const raw = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const keypair = umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(raw));
  const signer = createSignerFromKeypair(umi, keypair);
  umi.use(signerIdentity(signer));

  // Metadata PDAを正しく計算
  const mintPubkey = publicKey(MINT);
  const metadataPda = findMetadataPda(umi, { mint: mintPubkey });
  console.log('Metadata PDA:', metadataPda[0]);

  // mint_authority PDA
  const [mintAuthorityPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('nautilus'), new PublicKey(STATE).toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
  console.log('Mint Authority PDA (update authority):', mintAuthorityPDA.toString());
  const mintAuthorityUmi = publicKey(mintAuthorityPDA.toString());

  await updateMetadataAccountV2(umi, {
    metadata: metadataPda,
    updateAuthority: umi.identity,
    newUpdateAuthority: mintAuthorityUmi,
    data: {
      name: 'Nautilus',
      symbol: 'NAUT',
      uri: 'https://arweave.net/202ABzDB4k5WCk1AlzYgsLUg3SY5Gmb-T4O1OzLhrEM',
      sellerFeeBasisPoints: 0,
      creators: none(),
      collection: none(),
      uses: none(),
    },
    primarySaleHappened: false,
    isMutable: true,
  }).sendAndConfirm(umi);

  console.log('✓ Metadata updated');
}

main().catch(console.error);
