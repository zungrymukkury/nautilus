import { useState, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
// import { PROGRAM_ID } from '../constants';
import idl from '../idl.json';

const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const UPLOAD_API = 'https://nautilus-api-ruby.vercel.app/api/upload';

function getMetadataPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

async function uploadToArweave(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  const res = await fetch(UPLOAD_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: base64, contentType: file.type })
  });
  const data = await res.json();
  if (!data.url) throw new Error('Upload failed');
  return data.url;
}

export function Launch() {
  const { connected, publicKey, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const handleLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
  };

  const handleLaunch = useCallback(async () => {
    if (!connected || !publicKey || !signTransaction || !signAllTransactions) return;
    if (!name || !symbol || !logoFile) return;
    if (symbol.length > 10) { setStatus('Error: Symbol must be 10 chars or less'); return; }
    if (name.length > 32) { setStatus('Error: Name must be 32 chars or less'); return; }

    setLoading(true);
    setStatus(null);

    try {
      // 1. ロゴをArweaveにアップ
      setStatus('Uploading logo to Arweave...');
      const logoUrl = await uploadToArweave(logoFile);

      // 2. stateとmintのKeypairを生成
      const stateKeypair = Keypair.generate();
      const mintKeypair = Keypair.generate();
      const metadataPDA = getMetadataPDA(mintKeypair.publicKey);

      // 3. metadata.jsonをArweaveにアップ
      setStatus('Uploading metadata to Arweave...');
      const metadata = {
        name,
        symbol,
        description: `${name} - Fibonacci-powered, treasury-backed token on Solana.`,
        image: logoUrl,
        external_url: `https://zungrymukkury.github.io/nautilus/?state=${stateKeypair.publicKey.toString()}`,
        attributes: []
      };
      const metaBlob = new File(
        [JSON.stringify(metadata)],
        'metadata.json',
        { type: 'application/json' }
      );
      const metaUrl = await uploadToArweave(metaBlob);

      // 4. Solanaでinitialize
      setStatus('Confirm in Phantom...');
      const wallet = { publicKey, signTransaction, signAllTransactions };
      const provider = new AnchorProvider(connection, wallet as any, { commitment: 'confirmed' });
      const program = new Program(idl as any, provider);

      await (program.methods as any)
        .initialize(name, symbol, metaUrl)
        .accounts({
          state: stateKeypair.publicKey,
          mint: mintKeypair.publicKey,
          authority: publicKey,
          metadata: metadataPDA,
          tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
        })
        .signers([stateKeypair, mintKeypair])
        .rpc();

      const stateAddr = stateKeypair.publicKey.toString();
      setDone(stateAddr);
      setStatus(`✓ Launch complete!`);

    } catch (e: any) {
      setStatus(`Error: ${e.message?.slice(0, 80)}`);
    } finally {
      setLoading(false);
    }
  }, [connected, publicKey, signTransaction, signAllTransactions, connection, name, symbol, logoFile]);

  if (done) {
    return (
      <section className="status-card">
        <div className="launch-success">
          <div className="launch-success-icon">🐚</div>
          <h2>Token Launched!</h2>
          <p className="launch-addr">{done.slice(0, 16)}...{done.slice(-8)}</p>
          
            <a href={`?state=${done}`}
            className="action-btn buy-btn"
            style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: 16 }}
          >
            View Token →
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="status-card">
      <div className="status-title">Launch a new token</div>

      {!connected && (
        <p style={{ color: '#888', fontSize: 13 }}>Connect your wallet to launch.</p>
      )}

      {connected && (
        <div className="launch-form">
          <div className="launch-field">
            <label className="label">Token Name</label>
            <input
              className="search-input"
              placeholder="e.g. My Token"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={32}
              disabled={loading}
            />
          </div>

          <div className="launch-field">
            <label className="label">Symbol</label>
            <input
              className="search-input"
              placeholder="e.g. MTK"
              value={symbol}
              onChange={e => setSymbol(e.target.value.toUpperCase())}
              maxLength={10}
              disabled={loading}
            />
          </div>

          <div className="launch-field">
            <label className="label">Logo</label>
            <div className="logo-upload">
              {logoPreview && (
                <img src={logoPreview} alt="preview" className="logo-preview" />
              )}
              <input
                type="file"
                accept="image/*"
                onChange={handleLogo}
                disabled={loading}
                className="file-input"
              />
            </div>
          </div>

          {status && (
            <div className={`tx-status ${status.startsWith('✓') ? 'success' : status.startsWith('Error') ? 'err' : ''}`}>
              {status}
            </div>
          )}

          <button
            className="action-btn buy-btn"
            onClick={handleLaunch}
            disabled={loading || !name || !symbol || !logoFile}
          >
            {loading ? status || 'Processing...' : '🐚 Launch Token'}
          </button>

          <p className="launch-note">
            Logo and metadata will be permanently stored on Arweave.
          </p>
        </div>
      )}
    </section>
  );
}
