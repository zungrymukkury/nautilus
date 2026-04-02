import { PublicKey } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey('32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev');

const DEFAULT_STATE = 'fR1QnzzmucFwwir6o6vajBZQoZEVfYbATWGcstHKSUm';
const DEFAULT_MINT  = 'HjyDnB2z7w55mpurq3VEC2gtTdzEieYNHE1J2wpqxaEE';

const params = new URLSearchParams(
  typeof window !== 'undefined' ? window.location.search : ''
);

export const STATE_ADDRESS = new PublicKey(params.get('state') ?? DEFAULT_STATE);
export const MINT_ADDRESS  = new PublicKey(params.get('mint')  ?? DEFAULT_MINT);

export const RPC_ENDPOINT = 'https://mainnet.helius-rpc.com/?api-key=347da966-6882-46a4-a3ee-ac636bddeeb3';

export const BASE_PRICE = 1_000_000;
export const MAX_PER_TX = 1_000_000;
export const SPREAD_BPS = 50;

export const FIB = [
  1, 1, 2, 3, 5, 8, 13, 21, 34, 55,
  89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765
];
