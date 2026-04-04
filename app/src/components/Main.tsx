import { useState, useEffect } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useNautilus } from '../hooks/useNautilus';
import { PROGRAM_ID, RPC_ENDPOINT } from '../constants';
import { Launch } from './Launch';
import './Main.css';

function lamportsToSol(lamports: number): string {
  return (lamports / 1e9).toFixed(4);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

interface TokenMeta {
  name?: string;
  symbol?: string;
  image?: string;
}

interface PortfolioToken {
  stateAddress: string;
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  balance?: number;
  sellPrice?: number;
  currentStage?: number;
}

async function fetchTokenMeta(mint: string): Promise<TokenMeta> {
  try {
    const res = await fetch(RPC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAsset',
        params: { id: mint }
      })
    });
    const data = await res.json();
    const content = data?.result?.content;
    if (!content) return {};
    const name = content.metadata?.name;
    const symbol = content.metadata?.symbol;
    let image: string | undefined;
    const jsonUri = content.json_uri;
    if (jsonUri) {
      try {
        const metaRes = await fetch(jsonUri, { redirect: 'follow', mode: 'cors' });
        const metaJson = await metaRes.json();
        image = metaJson.image;
      } catch {}
    }
    return { name, symbol, image };
  } catch {
    return {};
  }
}

// ===== トークン個別ページ（?state=... の場合） =====
function TokenPage() {
  const { connected } = useWallet();
  const { state, tokenBalance, solBalance, loading, error, buy, sell, refresh } = useNautilus();
  const [tab, setTab] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [meta, setMeta] = useState<TokenMeta>({});

  useEffect(() => {
    if (!state) return;
    fetchTokenMeta(state.mint.toString()).then(setMeta);
  }, [state]);

  const handleBuy = async () => {
    const n = parseInt(amount);
    if (!n || n <= 0) return;
    try {
      setTxStatus('Confirm in Phantom...');
      await buy(n);
      setTxStatus('Done');
      setAmount('');
    } catch (e: any) {
      setTxStatus('Error: ' + e.message?.slice(0, 60));
    }
  };

  const handleSell = async () => {
    const n = parseInt(amount);
    if (!n || n <= 0) return;
    try {
      setTxStatus('Confirm in Phantom...');
      await sell(n);
      setTxStatus('Done');
      setAmount('');
    } catch (e: any) {
      setTxStatus('Error: ' + e.message?.slice(0, 60));
    }
  };

  const cost = state && amount ? (parseInt(amount) || 0) * state.buyPrice / 1e9 : 0;
  const payout = state && amount ? (parseInt(amount) || 0) * state.sellPrice * 0.995 / 1e9 : 0;

  const tokenName = meta.name || 'Nautilus';
  const tokenSymbol = meta.symbol || '';
  const tokenImage = meta.image;

  return (
    <div>
      <button className="back-btn" onClick={() => { window.location.href = '/nautilus/'; }}>← Back</button>

      {state && (
        <section className="status-card">
          <div className="status-title">
            <div className="token-header">
              {tokenImage
                ? <img src={tokenImage} alt={tokenName} className="token-logo-sm" />
                : <span>🪙</span>
              }
              <div className="token-name-block">
                <span className="token-name">{tokenName}</span>
                <span className="token-symbol">{tokenSymbol}</span>
              </div>
            </div>
            <button className="refresh-btn" onClick={refresh}>↻</button>
          </div>
          <div className="status-grid">
            <div className="status-item">
              <span className="label">Stage</span>
              <span className="value">{state.currentStage}</span>
            </div>
            <div className="status-item">
              <span className="label">Buy price</span>
              <span className="value">{lamportsToSol(state.buyPrice)} SOL</span>
            </div>
            <div className="status-item">
              <span className="label">Sell price</span>
              <span className="value">
                {state.totalSold === 0 ? 'N/A' : lamportsToSol(state.sellPrice) + ' SOL'}
              </span>
            </div>
            <div className="status-item">
              <span className="label">Treasury</span>
              <span className="value">{lamportsToSol(state.treasuryBalance)} SOL</span>
            </div>
            <div className="status-item">
              <span className="label">Total sold</span>
              <span className="value">{formatNumber(state.totalSold)} tokens</span>
            </div>
          </div>
        </section>
      )}

      {connected && (
        <section className="balance-card">
          <div className="status-title">Your Balance</div>
          <div className="status-grid">
            <div className="status-item">
              <span className="label">SOL</span>
              <span className="value">{lamportsToSol(solBalance)} SOL</span>
            </div>
            <div className="status-item">
              <span className="label">Tokens</span>
              <span className="value">{formatNumber(tokenBalance)}</span>
            </div>
            {state && tokenBalance > 0 && (
              <div className="status-item">
                <span className="label">Est. value</span>
                <span className="value">
                  {(tokenBalance * state.sellPrice * 0.995 / 1e9).toFixed(4)} SOL
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {connected && (
        <section className="trade-card">
          <div className="tab-row">
            <button
              className={'tab' + (tab === 'buy' ? ' active' : '')}
              onClick={() => { setTab('buy'); setAmount(''); setTxStatus(null); }}
            >Buy</button>
            <button
              className={'tab' + (tab === 'sell' ? ' active' : '')}
              onClick={() => { setTab('sell'); setAmount(''); setTxStatus(null); }}
            >Sell</button>
          </div>
          <div className="trade-form">
            <input
              type="number"
              placeholder="Amount (tokens)"
              value={amount}
              onChange={e => { setAmount(e.target.value); setTxStatus(null); }}
              min="1"
              className="amount-input"
            />
            {tab === 'buy' && amount && (
              <div className="estimate">Cost: <strong>{cost.toFixed(4)} SOL</strong></div>
            )}
            {tab === 'sell' && amount && (
              <div className="estimate">
                Est. payout: <strong>{payout.toFixed(4)} SOL</strong>
                <span className="dim"> (0.5% spread)</span>
              </div>
            )}
            {txStatus && (
              <div className={'tx-status' + (txStatus.startsWith('Done') ? ' success' : txStatus.startsWith('Error') ? ' err' : '')}>
                {txStatus}
              </div>
            )}
            {tab === 'buy' ? (
              <button className="action-btn buy-btn" onClick={handleBuy} disabled={loading || !amount || parseInt(amount) <= 0}>
                {loading ? 'Processing...' : 'Buy'}
              </button>
            ) : (
              <button className="action-btn sell-btn" onClick={handleSell} disabled={loading || !amount || parseInt(amount) <= 0}>
                {loading ? 'Processing...' : 'Sell'}
              </button>
            )}
          </div>
        </section>
      )}

      {!connected && (
        <section className="connect-prompt">
          <p>Connect your wallet to buy and sell.</p>
        </section>
      )}

      {error && <div className="error-bar">{error}</div>}
    </div>
  );
}

// ===== ホーム画面 =====
function HomePage() {
  const { connected, publicKey } = useWallet();
  const [searchInput, setSearchInput] = useState('');
  const [portfolio, setPortfolio] = useState<{ holdings: PortfolioToken[]; created: PortfolioToken[] } | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioTab, setPortfolioTab] = useState<'holdings' | 'created'>('holdings');

  useEffect(() => {
    if (!connected || !publicKey) {
      setPortfolio(null);
      return;
    }
    const walletStr = publicKey.toString();

    const load = async () => {
      setPortfolioLoading(true);
      try {
        // 1. ウォレットのSPLトークンを取得
        const holdingsRes = await fetch(RPC_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 'holdings',
            method: 'getTokenAccountsByOwner',
            params: [
              walletStr,
              { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
              { encoding: 'jsonParsed' }
            ]
          })
        });
        const holdingsData = await holdingsRes.json();
        const allTokenAccounts = holdingsData.result?.value || [];

        const mintsWithBalance: { mint: string; balance: number }[] = allTokenAccounts
          .map((ta: any) => {
            const info = ta.account.data.parsed?.info;
            return { mint: info?.mint as string, balance: parseInt(info?.tokenAmount?.amount || '0') };
          })
          .filter((t: { mint: string; balance: number }) => t.mint && t.balance > 0);

        // 2. 各mintでNautilusのStateを並列検索
        const holdingTokens: PortfolioToken[] = [];
        await Promise.all(mintsWithBalance.map(async ({ mint, balance }) => {
          try {
            const res = await fetch(RPC_ENDPOINT, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0', id: mint,
                method: 'getProgramAccounts',
                params: [
                  PROGRAM_ID.toString(),
                  { encoding: 'base64', filters: [{ dataSize: 283 }, { memcmp: { offset: 73, bytes: mint } }] }
                ]
              })
            });
            const data = await res.json();
            if (data.result && data.result.length > 0) {
              const stateAcc = data.result[0];
              const raw = Buffer.from(stateAcc.account.data[0], 'base64');
              const totalSold = Number(raw.readBigUInt64LE(106));
              const currentStage = raw.readUInt8(114);
              const treasuryBalance = Number(raw.readBigUInt64LE(275));
              const sellPrice = totalSold > 0 ? Math.floor(treasuryBalance / totalSold) : 0;
              holdingTokens.push({ stateAddress: stateAcc.pubkey, mint, balance, sellPrice, currentStage });
            }
          } catch {}
        }));

        // 3. Createdトークン取得
        const createdRes = await fetch(RPC_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 'created',
            method: 'getProgramAccounts',
            params: [
              PROGRAM_ID.toString(),
              { encoding: 'base64', filters: [{ dataSize: 283 }, { memcmp: { offset: 8, bytes: walletStr } }] }
            ]
          })
        });
        const createdData = await createdRes.json();
        const createdByWallet: PortfolioToken[] = (createdData.result || []).map((acc: any) => {
          const raw = Buffer.from(acc.account.data[0], 'base64');
          const mint = new PublicKey(raw.slice(73, 105)).toString();
          const totalSold = Number(raw.readBigUInt64LE(106));
          const currentStage = raw.readUInt8(114);
          const treasuryBalance = Number(raw.readBigUInt64LE(275));
          const sellPrice = totalSold > 0 ? Math.floor(treasuryBalance / totalSold) : 0;
          return { stateAddress: acc.pubkey, mint, sellPrice, currentStage };
        });

        // 4. メタデータ並行取得
        const fetchMetas = async (tokens: PortfolioToken[]) => {
          const results = await Promise.all(tokens.map(t => fetchTokenMeta(t.mint)));
          return tokens.map((t, i) => ({ ...t, ...results[i] }));
        };
        const [holdingsWithMeta, createdWithMeta] = await Promise.all([
          fetchMetas(holdingTokens),
          fetchMetas(createdByWallet),
        ]);

        setPortfolio({ holdings: holdingsWithMeta, created: createdWithMeta });
      } catch (e) {
        console.error('Portfolio fetch error:', e);
      } finally {
        setPortfolioLoading(false);
      }
    };

    load();
  }, [connected, publicKey]);

  const handleSearch = async () => {
    const addr = searchInput.trim();
    if (!addr) return;
    if (addr.length >= 32) {
      try {
        const res = await fetch(RPC_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getProgramAccounts',
            params: [
              PROGRAM_ID.toString(),
              { encoding: 'base64', filters: [{ dataSize: 283 }, { memcmp: { offset: 73, bytes: addr } }] }
            ]
          })
        });
        const data = await res.json();
        if (data.result && data.result.length > 0) {
          window.location.href = '?state=' + data.result[0].pubkey;
          return;
        }
      } catch {}
    }
    window.location.href = '?state=' + addr;
  };

  // 合計ポートフォリオ価値（SOL）
  const totalValueLamports = portfolio?.holdings.reduce((sum, t) => {
    return sum + (t.balance || 0) * (t.sellPrice || 0) * 0.995;
  }, 0) ?? 0;
  const totalValueSol = (totalValueLamports / 1e9).toFixed(4);

  return (
    <div>
      <section className="search-card">
        <div className="search-row">
          <input
            type="text"
            placeholder="Search by CA or State address..."
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            className="search-input"
          />
          <button className="search-btn" onClick={handleSearch}>→</button>
        </div>
      </section>

      {connected && (
        <section className="portfolio-card">
          {/* 合計価値 */}
          {portfolio && !portfolioLoading && (
            <div className="portfolio-total">
              <div className="portfolio-total-label">Portfolio Value</div>
              <div className="portfolio-total-value">{totalValueSol} SOL</div>
            </div>
          )}

          <div className="tab-row" style={{ marginTop: '16px' }}>
            <button
              className={'tab' + (portfolioTab === 'holdings' ? ' active' : '')}
              onClick={() => setPortfolioTab('holdings')}
            >Holdings</button>
            <button
              className={'tab' + (portfolioTab === 'created' ? ' active' : '')}
              onClick={() => setPortfolioTab('created')}
            >Created</button>
          </div>

          {portfolioLoading && <div className="portfolio-loading">Loading...</div>}

          {!portfolioLoading && portfolio && portfolioTab === 'holdings' && (
            portfolio.holdings.length === 0
              ? <div className="portfolio-empty">No Nautilus tokens held.</div>
              : <div className="portfolio-list">
                  {portfolio.holdings.map(t => (
                    <div
                      key={t.stateAddress}
                      className="portfolio-item"
                      onClick={() => { window.location.href = '?state=' + t.stateAddress; }}
                    >
                      <div className="portfolio-item-left">
                        {t.image
                          ? <img src={t.image} alt={t.name} className="token-logo-xs" />
                          : <span className="token-logo-placeholder">🪙</span>
                        }
                        <div>
                          <div className="portfolio-name">{t.name || t.mint.slice(0, 8) + '...'}</div>
                          <div className="portfolio-symbol dim">{t.symbol || ''}</div>
                        </div>
                      </div>
                      <div className="portfolio-item-right">
                        <div className="portfolio-balance">{formatNumber(t.balance || 0)}</div>
                        {t.sellPrice && t.sellPrice > 0 && (
                          <div className="portfolio-value dim">
                            ≈ {((t.balance || 0) * t.sellPrice * 0.995 / 1e9).toFixed(4)} SOL
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
          )}

          {!portfolioLoading && portfolio && portfolioTab === 'created' && (
            portfolio.created.length === 0
              ? <div className="portfolio-empty">No tokens created yet.</div>
              : <div className="portfolio-list">
                  {portfolio.created.map(t => (
                    <div
                      key={t.stateAddress}
                      className="portfolio-item"
                      onClick={() => { window.location.href = '?state=' + t.stateAddress; }}
                    >
                      <div className="portfolio-item-left">
                        {t.image
                          ? <img src={t.image} alt={t.name} className="token-logo-xs" />
                          : <span className="token-logo-placeholder">🪙</span>
                        }
                        <div>
                          <div className="portfolio-name">{t.name || t.mint.slice(0, 8) + '...'}</div>
                          <div className="portfolio-symbol dim">{t.symbol || ''}</div>
                        </div>
                      </div>
                      <div className="portfolio-item-right">
                        <div className="portfolio-stage dim">Stage {t.currentStage}</div>
                        {t.sellPrice && t.sellPrice > 0 && (
                          <div className="portfolio-value dim">
                            Floor: {lamportsToSol(t.sellPrice)} SOL
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
          )}
        </section>
      )}

      {!connected && (
        <section className="connect-prompt">
          <p>Connect your wallet to view your portfolio.</p>
        </section>
      )}
    </div>
  );
}

// ===== メインコンポーネント =====
export function Main() {
  const params = new URLSearchParams(window.location.search);
  const hasState = params.has('state');
  const [page, setPage] = useState<'home' | 'launch'>('home');

  // ?state= がある場合はトークン個別ページを表示
  if (hasState) {
    return (
      <div className="container">
        <header className="header">
          <div className="logo"><span>🐚</span></div>
          <div className="title-block">
            <h1>Nautilus Protocol</h1>
            <p className="subtitle">Fibonacci-powered, treasury-backed launch</p>
          </div>
          <WalletMultiButton />
        </header>
        <TokenPage />
        <footer className="footer">
          <p>Mainnet beta. No guarantees provided.</p>
          <a href="https://github.com/zungrymukkury/nautilus" target="_blank" rel="noopener noreferrer">GitHub →</a>
        </footer>
      </div>
    );
  }

  return (
    <div className="container">
      <header className="header">
        <div className="logo"><span>🐚</span></div>
        <div className="title-block">
          <h1>Nautilus Protocol</h1>
          <p className="subtitle">Fibonacci-powered, treasury-backed launch</p>
        </div>
        <WalletMultiButton />
      </header>

      <div className="page-tab-row">
        <button className={'page-tab' + (page === 'home' ? ' active' : '')} onClick={() => setPage('home')}>Home</button>
        <button className={'page-tab' + (page === 'launch' ? ' active' : '')} onClick={() => setPage('launch')}>Launch</button>
      </div>

      {page === 'launch' && <Launch />}
      {page === 'home' && <HomePage />}

      <footer className="footer">
        <p>Mainnet beta. No guarantees provided.</p>
        <p>Only participate if you can read the code.</p>
        <a href="https://github.com/zungrymukkury/nautilus" target="_blank" rel="noopener noreferrer">GitHub →</a>
      </footer>
    </div>
  );
}