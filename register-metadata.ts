import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createSignerFromKeypair, signerIdentity, publicKey } from '@metaplex-foundation/umi';
import { createMetadataAccountV3, mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MINT = '5pSePHCbFyMjkfHMmqoZq5yc3wUxNrQfoVcXX6hDBGLS';
const RPC = 'https://mainnet.helius-rpc.com/?api-key=347da966-6882-46a4-a3ee-ac636bddeeb3';

async function main() {
  const umi = createUmi(RPC).use(mplTokenMetadata());

  const walletPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
  const raw = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const keypair = umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(raw));
  const signer = createSignerFromKeypair(umi, keypair);
  umi.use(signerIdentity(signer));

  const metadata = {
    name: 'Nautilus',
    symbol: 'NAUT',
    uri: 'https://raw.githubusercontent.com/zungrymukkury/nautilus/main/metadata.json',
    sellerFeeBasisPoints: 0,
    creators: null,
    collection: null,
    uses: null,
  };

  await createMetadataAccountV3(umi, {
    mint: publicKey(MINT),
    mintAuthority: signer,
    payer: signer,
    updateAuthority: signer,
    data: metadata,
    isMutable: true,
    collectionDetails: null,
  }).sendAndConfirm(umi);

  console.log('✓ Metadata registered');
}

main().catch(console.error);
