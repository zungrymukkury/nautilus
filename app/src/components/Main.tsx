import { useState, useEffect } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { useNautilus } from '../hooks/useNautilus';
import { FIB, STATE_ADDRESS } from '../constants';
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

export function Main() {
  const { connected } = useWallet();
  const { state, tokenBalance, solBalance, loading, error, buy, sell, refresh } = useNautilus();
  const [tab, setTab] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [meta, setMeta] = useState<TokenMeta>({});
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState<'home' | 'launch'>('home');

  useEffect(() => {
    if (!state) return;
    const fetchMeta = async () => {
      try {
        const res = await fetch(
          'https://mainnet.helius-rpc.com/?api-key=347da966-6882-46a4-a3ee-ac636bddeeb3',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1,
              method: 'getAsset',
              params: { id: state.mint.toString() }
            })
          }
        );
        const data = await res.json();
        const content = data?.result?.content;
        if (content) {
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
          setMeta({ name, symbol, image });
        }
      } catch {}
    };
    fetchMeta();
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

  const handleSearch = () => {
    const addr = searchInput.trim();
    if (!addr) return;
    window.location.href = '?state=' + addr;
  };

  const cost = state && amount ? (parseInt(amount) || 0) * state.buyPrice / 1e9 : 0;
  const payout = state && amount ? (parseInt(amount) || 0) * state.sellPrice * 0.995 / 1e9 : 0;

  const tokenName = meta.name || 'Nautilus';
  const tokenSymbol = meta.symbol || '';
  const tokenImage = meta.image;

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

      {page === 'home' && (
        <div>
          <section className="search-card">
            <div className="search-row">
              <input
                type="text"
                placeholder="Enter State address to view another token..."
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                className="search-input"
              />
              <button className="search-btn" onClick={handleSearch}>→</button>
            </div>
            <div className="current-state">
              Current: <span className="addr">{STATE_ADDRESS.toString().slice(0, 8)}...{STATE_ADDRESS.toString().slice(-4)}</span>
            </div>
          </section>

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
                  <span className="value">{state.currentStage} <span className="dim">(FIB x {FIB[state.currentStage]})</span></span>
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
                  <div className="estimate">
                    Cost: <strong>{cost.toFixed(4)} SOL</strong>
                  </div>
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
                  <button
                    className="action-btn buy-btn"
                    onClick={handleBuy}
                    disabled={loading || !amount || parseInt(amount) <= 0}
                  >
                    {loading ? 'Processing...' : 'Buy'}
                  </button>
                ) : (
                  <button
                    className="action-btn sell-btn"
                    onClick={handleSell}
                    disabled={loading || !amount || parseInt(amount) <= 0}
                  >
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
        </div>
      )}

      {error && <div className="error-bar">{error}</div>}

      <footer className="footer">
        <p>Mainnet beta. No guarantees provided.</p>
        <p>Only participate if you can read the code.</p>
        <a href="https://github.com/zungrymukkury/nautilus" target="_blank" rel="noopener noreferrer">
          GitHub →
        </a>
      </footer>
    </div>
  );
}
