import { useEffect, useState, useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { STATE_ADDRESS, MINT_ADDRESS, FIB, BASE_PRICE } from '../constants';
import idl from '../idl.json';

export interface NautilusState {
  currentStage: number;
  totalSold: number;
  treasuryBalance: number;
  buyPrice: number;
  sellPrice: number;
}

export function useNautilus() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [state, setState] = useState<NautilusState | null>(null);
  const [tokenBalance, setTokenBalance] = useState<number>(0);
  const [solBalance, setSolBalance] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getProgram = useCallback(() => {
    if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) return null;
    const provider = new AnchorProvider(connection, wallet as any, { commitment: 'confirmed' });
    return new Program(idl as any, provider);
  }, [connection, wallet]);

  const fetchState = useCallback(async () => {
    try {
      const provider = new AnchorProvider(connection, {} as any, { commitment: 'confirmed' });
      const program = new Program(idl as any, provider);
      const s = await (program.account as any).nautilusState.fetch(STATE_ADDRESS);

      const stage = s.currentStage;
      const totalSold = s.totalSold.toNumber();
      const treasuryBalance = s.treasuryBalance.toNumber();
      const buyPrice = BASE_PRICE * FIB[stage];
      const sellPrice = totalSold === 0 ? 0 : Math.floor(treasuryBalance / totalSold);

      setState({ currentStage: stage, totalSold, treasuryBalance, buyPrice, sellPrice });
    } catch {
      setError('Failed to fetch protocol state');
    }
  }, [connection]);

  const fetchBalances = useCallback(async () => {
    if (!wallet.publicKey) return;
    try {
      const sol = await connection.getBalance(wallet.publicKey);
      setSolBalance(sol);
      const ata = await getAssociatedTokenAddress(MINT_ADDRESS, wallet.publicKey);
      try {
        const tokenAccount = await getAccount(connection, ata);
        setTokenBalance(Number(tokenAccount.amount));
      } catch {
        setTokenBalance(0);
      }
    } catch {
      setSolBalance(0);
      setTokenBalance(0);
    }
  }, [connection, wallet.publicKey]);

  const buy = useCallback(async (amount: number) => {
    const program = getProgram();
    if (!program || !wallet.publicKey) throw new Error('Wallet not connected');
    setLoading(true);
    setError(null);
    try {
      let remaining = amount;
      while (remaining > 0) {
        const chunk = Math.min(remaining, 1_000_000);
        await program.methods
          .buy(new BN(chunk))
          .accounts({ state: STATE_ADDRESS, mint: MINT_ADDRESS, buyer: wallet.publicKey })
          .rpc();
        remaining -= chunk;
      }
      await fetchState();
      await fetchBalances();
    } finally {
      setLoading(false);
    }
  }, [getProgram, wallet.publicKey, fetchState, fetchBalances]);

  const sell = useCallback(async (amount: number) => {
    const program = getProgram();
    if (!program || !wallet.publicKey) throw new Error('Wallet not connected');
    setLoading(true);
    setError(null);
    try {
      let remaining = amount;
      while (remaining > 0) {
        const chunk = Math.min(remaining, 1_000_000);
        await program.methods
          .sell(new BN(chunk))
          .accounts({ state: STATE_ADDRESS, mint: MINT_ADDRESS, seller: wallet.publicKey })
          .rpc();
        remaining -= chunk;
      }
      await fetchState();
      await fetchBalances();
    } finally {
      setLoading(false);
    }
  }, [getProgram, wallet.publicKey, fetchState, fetchBalances]);

  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 30000);
    return () => clearInterval(interval);
  }, [fetchState]);

  useEffect(() => {
    if (wallet.publicKey) fetchBalances();
  }, [wallet.publicKey, fetchBalances]);

  return { state, tokenBalance, solBalance, loading, error, buy, sell, refresh: fetchState };
}
