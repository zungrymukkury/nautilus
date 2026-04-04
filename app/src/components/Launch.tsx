import { useState, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
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
  const [doneMint, setDoneMint] = useState<string | null>(null);

  // Step 1の結果を保持
  const [_uploadedLogoUrl, setUploadedLogoUrl] = useState<string | null>(null);
  const [uploadedMetaUrl, setUploadedMetaUrl] = useState<string | null>(null);
  const [pendingState, setPendingState] = useState<Keypair | null>(null);
  const [pendingMint, setPendingMint] = useState<Keypair | null>(null);
  const [step, setStep] = useState<1 | 2>(1);

  const handleLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
    // ステップをリセット
    setStep(1);
    setUploadedLogoUrl(null);
    setUploadedMetaUrl(null);
  };

  // Step 1: Arweaveにアップロード
  const handleUpload = useCallback(async () => {
    if (!name || !symbol || !logoFile) return;
    if (symbol.length > 10) { setStatus('Error: Symbol must be 10 chars or less'); return; }
    if (name.length > 32) { setStatus('Error: Name must be 32 chars or less'); return; }

    setLoading(true);
    setStatus(null);

    try {
      const stateKeypair = Keypair.generate();
      const mintKeypair = Keypair.generate();

      setStatus('Uploading logo to Arweave...');
      const logoUrl = await uploadToArweave(logoFile);

      setStatus('Uploading metadata to Arweave...');
      const metadata = {
        name,
        symbol,
        description: name + ' - Fibonacci-powered, treasury-backed token on Solana.',
        image: logoUrl,
        external_url: 'https://zungrymukkury.github.io/nautilus/?state=' + stateKeypair.publicKey.toString(),
        attributes: []
      };
      const metaBlob = new File(
        [JSON.stringify(metadata)],
        'metadata.json',
        { type: 'application/json' }
      );
      const metaUrl = await uploadToArweave(metaBlob);

      setUploadedLogoUrl(logoUrl);
      setUploadedMetaUrl(metaUrl);
      setPendingState(stateKeypair);
      setPendingMint(mintKeypair);
      setStep(2);
      setStatus('Upload complete. Ready to launch.');

    } catch (e: any) {
      setStatus('Error: ' + e.message?.slice(0, 80));
    } finally {
      setLoading(false);
    }
  }, [name, symbol, logoFile]);

  // Step 2: Solanaでinitialize（Phantomで先に署名してから送信）
  const handleLaunch = useCallback(async () => {
    if (!connected || !publicKey || !signTransaction || !signAllTransactions) return;
    if (!uploadedMetaUrl || !pendingState || !pendingMint) return;

    setLoading(true);
    setStatus('Confirm in Phantom...');

    try {
      const metadataPDA = getMetadataPDA(pendingMint.publicKey);
      const wallet = { publicKey, signTransaction, signAllTransactions };
      const provider = new AnchorProvider(connection, wallet as any, { commitment: 'confirmed' });
      const program = new Program(idl as any, provider);

      // トランザクションを構築
      const tx = await (program.methods as any)
        .initialize(name, symbol, uploadedMetaUrl)
        .accounts({
          state: pendingState.publicKey,
          mint: pendingMint.publicKey,
          authority: publicKey,
          metadata: metadataPDA,
          tokenMetadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
        })
        .signers([pendingState, pendingMint])
        .transaction();

      // blockhashを取得
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      // stateとmintで先に署名
      tx.partialSign(pendingState);
      tx.partialSign(pendingMint);

      // Phantomで署名（1サイナーとして認識される）
      const signed = await signTransaction(tx);

      // 送信
      setStatus('Sending transaction...');
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });

      setDone(pendingState.publicKey.toString());
      setDoneMint(pendingMint.publicKey.toString());
      setStatus('Launch complete!');

    } catch (e: any) {
      setStatus('Error: ' + e.message?.slice(0, 80));
    } finally {
      setLoading(false);
    }
  }, [connected, publicKey, signTransaction, signAllTransactions, connection, name, symbol, uploadedMetaUrl, pendingState, pendingMint]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (done) {
    return (
      <section className="status-card">
        <div className="launch-success">
          <div className="launch-success-icon">🐚</div>
          <h2>Token Launched!</h2>
          <div className="ca-row">
            <span className="label">CA (Mint)</span>
            <div className="ca-value-row">
              <span className="launch-addr">{doneMint?.slice(0, 16)}...{doneMint?.slice(-8)}</span>
              <button className="copy-btn" onClick={() => copyToClipboard(doneMint || '')}>Copy</button>
            </div>
          </div>
          <a href={'?state=' + done}
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
              placeholder="e.g. Sunflower"
              value={name}
              onChange={e => { setName(e.target.value); setStep(1); }}
              maxLength={32}
              disabled={loading}
            />
          </div>

          <div className="launch-field">
            <label className="label">Symbol</label>
            <input
              className="search-input"
              placeholder="e.g. SUNF"
              value={symbol}
              onChange={e => { setSymbol(e.target.value.toUpperCase()); setStep(1); }}
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
            <div className={'tx-status' + (status.includes('complete') ? ' success' : status.startsWith('Error') ? ' err' : '')}>
              {status}
            </div>
          )}

          {step === 1 && (
            <button
              className="action-btn buy-btn"
              onClick={handleUpload}
              disabled={loading || !name || !symbol || !logoFile}
            >
              {loading ? (status || 'Uploading...') : 'Step 1: Upload to Arweave'}
            </button>
          )}

          {step === 2 && (
            <button
              className="action-btn buy-btn"
              onClick={handleLaunch}
              disabled={loading}
            >
              {loading ? 'Launching...' : 'Step 2: Launch Token 🐚'}
            </button>
          )}

          <p className="launch-note">
            Step 1 uploads to Arweave. Step 2 signs with Phantom.
          </p>
        </div>
      )}
    </section>
  );
}
