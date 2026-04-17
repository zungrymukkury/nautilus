import { PublicKey } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey('32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev');

const DEFAULT_STATE = 'GQTkDuEKyvWm9YuYmpqmyS6PS2bpTYwDVw9XaCN1wUHF';
const DEFAULT_MINT  = '4JxkJUUddtSTTvdjAb7Hk7bCv4ETFsyRdzigiw7mns2T';

const params = new URLSearchParams(
  typeof window !== 'undefined' ? window.location.search : ''
);

const urlState = params.get('state');
const urlMint  = params.get('mint');

export const STATE_ADDRESS = new PublicKey(urlState ?? DEFAULT_STATE);
export const MINT_ADDRESS  = new PublicKey(urlMint  ?? DEFAULT_MINT);

// true = official canonical Nautilus instance (DEFAULT_STATE)
// false = user-supplied or third-party instance via ?state=
export const IS_CANONICAL = !urlState || urlState === DEFAULT_STATE;

export const RPC_ENDPOINT = 'https://mainnet.helius-rpc.com/?api-key=347da966-6882-46a4-a3ee-ac636bddeeb3';

export const BASE_PRICE = 1_000_000;
export const MAX_PER_TX = 100_000;
export const SPREAD_BPS = 50;

export const FIB = [
  1, 1, 2, 3, 5, 8, 13, 21, 34, 55,
  89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765,
  10946, 17711, 28657, 46368, 75025, 121393, 196418, 317811, 514229, 832040
];

// Buy price table: floor(BASE_PRICE × FIB[n]^a), a = log_φ(2) - 1
// Matches PRICE_TABLE in lib.rs exactly.
export const PRICE_TABLE = [
  1_000_000,  // stage  0
  1_000_000,  // stage  1
  1_356_999,  // stage  2
  1_622_309,  // stage  3
  2_031_610,  // stage  4
  2_498_843,  // stage  5
  3_094_589,  // stage  6
  3_822_363,  // stage  7
  4_726_003,  // stage  8
  5_841_046,  // stage  9
  7_220_221,  // stage 10
  8_924_547,  // stage 11
  11_031_412, // stage 12
  13_635_544, // stage 13
  16_854_474, // stage 14
  20_833_269, // stage 15
  25_751_340, // stage 16
  31_830_405, // stage 17
  39_344_546, // stage 18
  48_632_533, // stage 19
  60_113_117, // stage 20
  74_303_898, // stage 21
  91_844_670, // stage 22
  113_526_255,// stage 23
  140_326_169,// stage 24
  173_452_684,// stage 25
  214_399_308,// stage 26
  265_012_119,// stage 27
  327_572_994,// stage 28
  404_902_488,// stage 29
];