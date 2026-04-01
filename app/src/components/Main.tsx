import { useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { useNautilus } from '../hooks/useNautilus';
import { FIB } from '../constants';
import './Main.css';

function lamportsToSol(lamports: number): string {
  return (lamports / 1e9).toFixed(4);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function Main() {
  const { connected } = useWallet();
  const { state, tokenBalance, solBalance, loading, error, buy, sell, refresh } = useNautilus();
  const [tab, setTab] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [txStatus, setTxStatus] = useState<string | null>(null);

  const handleBuy = async () => {
    const n = parseInt(amount);
    if (!n || n <= 0) return;
    try {
      setTxStatus('Confirm in Phantom...');
      await buy(n);
      setTxStatus('✓ Buy complete');
      setAmount('');
    } catch (e: any) {
      setTxStatus(`Error: ${e.message?.slice(0, 60)}`);
    }
  };

  const handleSell = async () => {
    const n = parseInt(amount);
    if (!n || n <= 0) return;
    try {
      setTxStatus('Confirm in Phantom...');
      await sell(n);
      setTxStatus('✓ Sell complete');
      setAmount('');
    } catch (e: any) {
      setTxStatus(`Error: ${e.message?.slice(0, 60)}`);
    }
  };

  const cost = state && amount ? (parseInt(amount) || 0) * state.buyPrice / 1e9 : 0;
  const payout = state && amount ? (parseInt(amount) || 0) * state.sellPrice * 0.995 / 1e9 : 0;

  return (
    <div className="container">
      <header className="header">
        <div className="logo">🐚</div>
        <div className="title-block">
          <h1>Nautilus Protocol</h1>
          <p className="subtitle">Fibonacci-powered, treasury-backed launch</p>
        </div>
        {/* @ts-ignore */}
        <WalletMultiButton />
      </header>

      {state && (
        <section className="status-card">
          <div className="status-title">
            Protocol Status
            <button className="refresh-btn" onClick={refresh}>↻</button>
          </div>
          <div className="status-grid">
            <div className="status-item">
              <span className="label">Stage</span>
              <span className="value">{state.currentStage} <span className="dim">(FIB × {FIB[state.currentStage]})</span></span>
            </div>
            <div className="status-item">
              <span className="label">Buy price</span>
              <span className="value">{lamportsToSol(state.buyPrice)} SOL</span>
            </div>
            <div className="status-item">
              <span className="label">Sell price</span>
              <span className="value">
                {state.totalSold === 0 ? 'N/A' : `${lamportsToSol(state.sellPrice)} SOL`}
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
              className={`tab ${tab === 'buy' ? 'active' : ''}`}
              onClick={() => { setTab('buy'); setAmount(''); setTxStatus(null); }}
            >Buy</button>
            <button
              className={`tab ${tab === 'sell' ? 'active' : ''}`}
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
              <div className={`tx-status ${txStatus.startsWith('✓') ? 'success' : txStatus.startsWith('Error') ? 'err' : ''}`}>
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

      {error && <div className="error-bar">{error}</div>}

      <footer className="footer">
        <p>⚠️ Mainnet beta. No guarantees provided.</p>
        <p>Only participate if you can read the code.</p>
        <a href="https://github.com/zungrymukkury/nautilus" target="_blank" rel="noopener noreferrer">
          GitHub →
        </a>
      </footer>
    </div>
  );
}
