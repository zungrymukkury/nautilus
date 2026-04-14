import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import Arweave from 'arweave';
import sharp from 'sharp';
import { getConnection, loadWallet, PROGRAM_ID } from '../config';

const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

const arweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

async function uploadToArweave(data: Buffer, contentType: string, arKey: any): Promise<string> {
  const tx = await arweave.createTransaction({ data }, arKey);
  tx.addTag('Content-Type', contentType);
  await arweave.transactions.sign(tx, arKey);
  const res = await arweave.transactions.post(tx);
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`Arweave upload failed: ${res.status}`);
  }
  console.log(`  ✓ Uploaded: https://arweave.net/${tx.id}`);
  return `https://arweave.net/${tx.id}`;
}

function getMetadataPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    MPL_TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

export async function initCommand(
  name: string,
  symbol: string,
  logoPath: string,
  arKeyPath: string
) {
  console.log('\n🐚 Nautilus Init\n');

  // ARキー読み込み
  if (!fs.existsSync(arKeyPath)) {
    throw new Error(`AR wallet not found: ${arKeyPath}`);
  }
  const arKey = JSON.parse(fs.readFileSync(arKeyPath, 'utf-8'));
  console.log('  ✓ AR wallet loaded');

  // ロゴ読み込み・リサイズ
  if (!fs.existsSync(logoPath)) {
    throw new Error(`Logo not found: ${logoPath}`);
  }
  const ext = path.extname(logoPath).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';

  console.log('  Resizing logo to 500×500px...');
  const logoBuffer = await sharp(fs.readFileSync(logoPath))
    .resize(500, 500, { fit: 'cover' })
    .toBuffer();

  const sizeMB = logoBuffer.length / 1024 / 1024;
  if (sizeMB > 1) {
    throw new Error(`Logo too large: ${sizeMB.toFixed(2)}MB (max 1MB)`);
  }
  console.log(`  ✓ Logo ready: ${(logoBuffer.length / 1024).toFixed(0)}KB`);

  // stateとmintのKeypairを先に生成（metadata.jsonにstateアドレスを含めるため）
  const stateKeypair = Keypair.generate();
  const mintKeypair = Keypair.generate();
  const metadataPDA = getMetadataPDA(mintKeypair.publicKey);

  // ARweaveにロゴをアップロード
  console.log('\n  Uploading logo to Arweave...');
  const logoUrl = await uploadToArweave(logoBuffer, contentType, arKey);

  // metadata.jsonを作成してアップロード
  const metadata = {
    name,
    symbol,
    description: `${name} - A Nautilus Protocol token.`,
    image: logoUrl,
    external_url: `https://zungrymukkury.github.io/nautilus/?state=${stateKeypair.publicKey.toString()}`,
    attributes: []
  };

  console.log('  Uploading metadata to Arweave...');
  const metaBuffer = Buffer.from(JSON.stringify(metadata));
  const metaUrl = await uploadToArweave(metaBuffer, 'application/json', arKey);

  // Solanaのinitialize
  console.log('\n  Initializing on Solana...');
  const connection = getConnection();
  const wallet = loadWallet();

  const provider = new AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: 'confirmed' }
  );

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../../target/idl/nautilus.json'), 'utf-8')
  );
  const program = new Program(idl, provider);

  await (program.methods as any)
    .initialize(name, symbol, metaUrl)
    .accounts({
      state: stateKeypair.publicKey,
      mint: mintKeypair.publicKey,
      authority: wallet.publicKey,
      metadata: metadataPDA,
      tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
    })
    .signers([stateKeypair, mintKeypair])
    .rpc();

  // .nautilus-stateに保存
  const stateData = {
    state: stateKeypair.publicKey.toString(),
    mint: mintKeypair.publicKey.toString(),
    name,
    symbol,
    logoUrl,
    metaUrl,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync('.nautilus-state', JSON.stringify(stateData, null, 2));

  console.log('\n  ✓ Init complete\n');
  console.log(`  Name:     ${name}`);
  console.log(`  Symbol:   ${symbol}`);
  console.log(`  State:    ${stateKeypair.publicKey.toString()}`);
  console.log(`  Mint:     ${mintKeypair.publicKey.toString()}`);
  console.log(`  Logo:     ${logoUrl}`);
  console.log(`  Metadata: ${metaUrl}`);
  console.log(`\n  Saved to .nautilus-state`);
  console.log(`\n  Frontend: https://zungrymukkury.github.io/nautilus/?state=${stateKeypair.publicKey.toString()}`);
}