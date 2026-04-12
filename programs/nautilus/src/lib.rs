//! # Nautilus Protocol vNext — Recovery Floor 1/φ
//!
//! A recovery-floor-first token launch framework for Solana.
//! Permissionless launchpad — anyone can launch a treasury-backed token.
//!
//! ## Price Design
//!
//! Buy price is taken from a precomputed constant table:
//!   buy_price(stage) = PRICE_TABLE[stage]
//!
//! The table is generated as floor(BASE_PRICE × FIB[stage]^a), where a = log_φ(2) - 1.
//! This yields a high-stage worst-case recovery floor of 1/φ.
//! Stage capital doubles asymptotically (price grows as 2/φ, supply as φ, product = 2).
//!
//! ## Architecture
//!
//! | Component         | Implementation                                    |
//! |-------------------|---------------------------------------------------|
//! | Treasury          | PDA — no private key exists                       |
//! | Mint Authority    | PDA — no private key exists                       |
//! | Buy Price         | PRICE_TABLE[stage] (precomputed constant table)   |
//! | Sell Price        | Weighted average (treasury ÷ total_sold)          |
//! | Token Metadata    | Registered via Metaplex CPI at init               |
//! | Admin functions   | None (on-chain)                                   |
//! | Upgrade Authority | Held by deployer                                  |

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Burn};
use anchor_spl::associated_token::AssociatedToken;
use mpl_token_metadata::instructions::CreateV1CpiBuilder;
use mpl_token_metadata::types::TokenStandard;

declare_id!("32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev");

// Buy price table: PRICE_TABLE[n] = floor(BASE_PRICE * FIB[n]^a)
// where a = log_φ(2) - 1 ≈ 0.44042009041255636
// This sets the high-stage worst-case recovery floor to 1/φ.
// Supply grows by φ per stage; price grows by 2/φ; product doubles asymptotically.
// Generated offline. Monotone nondecreasing. Treat as consensus-critical constants.
const PRICE_TABLE: [u64; 30] = [
    1_000_000,   // stage  0  FIB=1
    1_000_000,   // stage  1  FIB=1
    1_356_999,   // stage  2  FIB=2
    1_622_309,   // stage  3  FIB=3
    2_031_610,   // stage  4  FIB=5
    2_498_843,   // stage  5  FIB=8
    3_094_589,   // stage  6  FIB=13
    3_822_363,   // stage  7  FIB=21
    4_726_003,   // stage  8  FIB=34
    5_841_046,   // stage  9  FIB=55
    7_220_221,   // stage 10  FIB=89
    8_924_547,   // stage 11  FIB=144
    11_031_412,  // stage 12  FIB=233
    13_635_544,  // stage 13  FIB=377
    16_854_474,  // stage 14  FIB=610
    20_833_269,  // stage 15  FIB=987
    25_751_340,  // stage 16  FIB=1597
    31_830_405,  // stage 17  FIB=2584
    39_344_546,  // stage 18  FIB=4181
    48_632_533,  // stage 19  FIB=6765
    60_113_117,  // stage 20  FIB=10946
    74_303_898,  // stage 21  FIB=17711
    91_844_670,  // stage 22  FIB=28657
    113_526_255, // stage 23  FIB=46368
    140_326_169, // stage 24  FIB=75025
    173_452_684, // stage 25  FIB=121393
    214_399_308, // stage 26  FIB=196418
    265_012_119, // stage 27  FIB=317811
    327_572_994, // stage 28  FIB=514229
    404_902_488, // stage 29  FIB=832040
];

// Stage supply: FIB[n] × 10_000 (1/100 of original design)
// Bootstrap phase gates: Stage 0→1 at total_sold >= STAGE_SUPPLY[0],
//                        Stage 1→2 at total_sold >= STAGE_SUPPLY[0] + STAGE_SUPPLY[1]
const STAGE_SUPPLY: [u64; 30] = [
    10_000,          // stage  0  FIB=1
    10_000,          // stage  1  FIB=1
    20_000,          // stage  2  FIB=2
    30_000,          // stage  3  FIB=3
    50_000,          // stage  4  FIB=5
    80_000,          // stage  5  FIB=8
    130_000,         // stage  6  FIB=13
    210_000,         // stage  7  FIB=21
    340_000,         // stage  8  FIB=34
    550_000,         // stage  9  FIB=55
    890_000,         // stage 10  FIB=89
    1_440_000,       // stage 11  FIB=144
    2_330_000,       // stage 12  FIB=233
    3_770_000,       // stage 13  FIB=377
    6_100_000,       // stage 14  FIB=610
    9_870_000,       // stage 15  FIB=987
    15_970_000,      // stage 16  FIB=1597
    25_840_000,      // stage 17  FIB=2584
    41_810_000,      // stage 18  FIB=4181
    67_650_000,      // stage 19  FIB=6765
    109_460_000,     // stage 20  FIB=10946
    177_110_000,     // stage 21  FIB=17711
    286_570_000,     // stage 22  FIB=28657
    463_680_000,     // stage 23  FIB=46368
    750_250_000,     // stage 24  FIB=75025
    1_213_930_000,   // stage 25  FIB=121393
    1_964_180_000,   // stage 26  FIB=196418
    3_178_110_000,   // stage 27  FIB=317811
    5_142_290_000,   // stage 28  FIB=514229
    8_320_400_000,   // stage 29  FIB=832040
];

const SPREAD_BPS: u64 = 50;
const MAX_AMOUNT_PER_TX: u64 = 100_000; // max per tx: 10× stage 0/1 supply

#[program]
pub mod nautilus {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        require!(name.len() <= 32, NautilusError::InvalidMetadata);
        require!(symbol.len() <= 10, NautilusError::InvalidMetadata);
        require!(uri.len() <= 200, NautilusError::InvalidMetadata);

        let state = &mut ctx.accounts.state;
        state.authority = ctx.accounts.authority.key();
        state.treasury = ctx.accounts.treasury.key();
        state.treasury_bump = ctx.bumps.treasury;
        state.mint = ctx.accounts.mint.key();
        state.mint_authority_bump = ctx.bumps.mint_authority;
        state.total_sold = 0;
        state.current_stage = 0;
        state.stage_sold = [0u64; 30];
        state.treasury_balance = 0;

        // Metaplex metadata CPI — PDA signer
        let state_key = state.key();
        let mint_bump = state.mint_authority_bump;
        let mint_seeds: &[&[u8]] = &[b"nautilus", state_key.as_ref(), &[mint_bump]];
        let signer_seeds = &[mint_seeds];

        CreateV1CpiBuilder::new(
            &ctx.accounts.token_metadata_program.to_account_info(),
        )
        .metadata(&ctx.accounts.metadata.to_account_info())
        .master_edition(None)
        .mint(&ctx.accounts.mint.to_account_info(), false)
        .authority(&ctx.accounts.mint_authority.to_account_info())
        .payer(&ctx.accounts.authority.to_account_info())
        .update_authority(&ctx.accounts.authority.to_account_info(), false)
        .system_program(&ctx.accounts.system_program.to_account_info())
        .sysvar_instructions(&ctx.accounts.sysvar_instructions.to_account_info())
        .spl_token_program(Some(&ctx.accounts.token_program.to_account_info()))
        .name(name)
        .symbol(symbol)
        .uri(uri)
        .seller_fee_basis_points(0)
        .token_standard(TokenStandard::Fungible)
        .is_mutable(false)
        .invoke_signed(signer_seeds)?;

        // Explicitly create the treasury PDA as a system account.
        // This ensures the account exists before any buy() attempts to transfer SOL into it.
        let treasury_bump = ctx.bumps.treasury;
        let state_key = ctx.accounts.state.key();
        let treasury_seeds = &[b"treasury".as_ref(), state_key.as_ref(), &[treasury_bump]];
        let treasury_signer = &[&treasury_seeds[..]];
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(0);
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::CreateAccount {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
                treasury_signer,
            ),
            lamports,
            0,
            &System::id(),
        )?;

        msg!("Nautilus initialized");
        msg!("Treasury PDA: {}", ctx.accounts.treasury.key());
        msg!("Mint: {}", ctx.accounts.mint.key());
        Ok(())
    }

    pub fn buy(ctx: Context<Buy>, amount: u64) -> Result<()> {
        require!(amount > 0, NautilusError::InvalidAmount);
        require!(amount <= MAX_AMOUNT_PER_TX, NautilusError::ExceedsMaxAmount);

        let state = &mut ctx.accounts.state;
        let stage = state.current_stage as usize;

        // Stage 0/1 (bootstrap phase): remaining is based on circulating supply (total_sold)
        // to prevent volume bots from advancing stages via repeated buy/sell cycles.
        // Stage 2+: standard cumulative issuance per tranche.
        let remaining = if stage <= 1 {
            let target = if stage == 0 {
                STAGE_SUPPLY[0]
            } else {
                STAGE_SUPPLY[0]
                    .checked_add(STAGE_SUPPLY[1])
                    .ok_or(NautilusError::Overflow)?
            };
            target.checked_sub(state.total_sold)
                .ok_or(NautilusError::StageSoldOut)?
        } else {
            STAGE_SUPPLY[stage]
                .checked_sub(state.stage_sold[stage])
                .ok_or(NautilusError::StageSoldOut)?
        };
        require!(amount <= remaining, NautilusError::ExceedsStageSupply);

        let price = PRICE_TABLE[stage];
        let total_cost = price.checked_mul(amount).ok_or(NautilusError::Overflow)?;

        // CEI: Update state before CPIs
        state.treasury_balance = state.treasury_balance
            .checked_add(total_cost)
            .ok_or(NautilusError::Overflow)?;
        state.stage_sold[stage] = state.stage_sold[stage]
            .checked_add(amount)
            .ok_or(NautilusError::Overflow)?;
        state.total_sold = state.total_sold
            .checked_add(amount)
            .ok_or(NautilusError::Overflow)?;

        let should_advance = if stage <= 1 {
            let target = if stage == 0 {
                STAGE_SUPPLY[0]
            } else {
                STAGE_SUPPLY[0]
                    .checked_add(STAGE_SUPPLY[1])
                    .ok_or(NautilusError::Overflow)?
            };
            state.total_sold >= target
        } else {
            state.stage_sold[stage] >= STAGE_SUPPLY[stage]
        };
        if should_advance && stage < 29 {
            state.current_stage += 1;
            msg!("Stage advanced to {}", state.current_stage);
        }

        // SOL transfer: buyer → treasury
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, total_cost)?;

        // Mint tokens to buyer
        let state_key = ctx.accounts.state.key();
        let mint_bump = ctx.accounts.state.mint_authority_bump;
        let mint_seeds = &[b"nautilus".as_ref(), state_key.as_ref(), &[mint_bump]];
        let mint_signer = &[&mint_seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.buyer_ata.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                mint_signer,
            ),
            amount,
        )?;

        msg!("Buy | stage {} | price {} | amount {} | cost {}",
            stage, price, amount, total_cost);
        Ok(())
    }

    pub fn sell(ctx: Context<Sell>, amount: u64) -> Result<()> {
        require!(amount > 0, NautilusError::InvalidAmount);
        require!(amount <= MAX_AMOUNT_PER_TX, NautilusError::ExceedsMaxAmount);

        let state = &mut ctx.accounts.state;

        // Full exit (amount == total_sold) is permitted.
        // The proof note's sell-price monotonicity applies when post-sell supply > 0.
        // When total_sold reaches 0, sell price is undefined but the protocol is quiescent.
        require!(state.total_sold >= amount, NautilusError::InvalidAmount);

        let avg_price = state.treasury_balance
            .checked_div(state.total_sold)
            .ok_or(NautilusError::Overflow)?;
        let gross = avg_price.checked_mul(amount).ok_or(NautilusError::Overflow)?;
        let spread = gross.checked_mul(SPREAD_BPS).ok_or(NautilusError::Overflow)? / 10_000;
        let payout = gross - spread;

        // Solvency check: use actual treasury lamports to verify payout is feasible.
        // state.treasury_balance is the price source of truth (accounted value),
        // but transferability must be verified against actual lamports held by the PDA.
        let rent_minimum = Rent::get()?.minimum_balance(0);
        let treasury_lamports = ctx.accounts.treasury.to_account_info().lamports();
        require!(
            treasury_lamports >= payout + rent_minimum,
            NautilusError::InsufficientTreasury
        );

        // CEI: Update state before CPIs
        state.treasury_balance = state.treasury_balance
            .checked_sub(payout)
            .ok_or(NautilusError::Overflow)?;
        state.total_sold = state.total_sold
            .checked_sub(amount)
            .ok_or(NautilusError::Overflow)?;

        // Burn tokens from seller
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.seller_ata.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            amount,
        )?;

        // SOL transfer: treasury → seller
        let state_key = ctx.accounts.state.key();
        let treasury_bump = ctx.accounts.state.treasury_bump;
        let treasury_seeds = &[b"treasury".as_ref(), state_key.as_ref(), &[treasury_bump]];
        let treasury_signer = &[&treasury_seeds[..]];

        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.treasury.to_account_info(),
                to: ctx.accounts.seller.to_account_info(),
            },
            treasury_signer,
        );
        system_program::transfer(cpi_context, payout)?;

        msg!("Sell | avg_price {} | amount {} | payout {} | spread {}",
            avg_price, amount, payout, spread);
        Ok(())
    }

    pub fn get_state(ctx: Context<GetState>) -> Result<()> {
        let state = &ctx.accounts.state;
        let buy_price = PRICE_TABLE[state.current_stage as usize];
        let sell_price = if state.total_sold == 0 { 0 } else {
            state.treasury_balance / state.total_sold
        };
        msg!("=== Nautilus State ===");
        msg!("Stage:      {}", state.current_stage);
        msg!("Buy price:  {} lamports", buy_price);
        msg!("Sell price: {} lamports", sell_price);
        msg!("Treasury:   {} lamports", state.treasury_balance);
        msg!("Total sold: {}", state.total_sold);
        msg!("=====================");
        Ok(())
    }
}

#[account]
pub struct NautilusState {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub treasury_bump: u8,
    pub mint: Pubkey,
    pub mint_authority_bump: u8,
    pub total_sold: u64,
    pub current_stage: u8,
    pub stage_sold: [u64; 30],
    pub treasury_balance: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 1 + 32 + 1 + 8 + 1 + 30 * 8 + 8,
    )]
    pub state: Account<'info, NautilusState>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 0,
        mint::authority = mint_authority,
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: PDA verified by seeds
    #[account(seeds = [b"nautilus", state.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: Treasury PDA — created explicitly in initialize() via system_program::create_account CPI
    #[account(
        mut,
        seeds = [b"treasury", state.key().as_ref()],
        bump,
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Metaplex metadata PDA
    #[account(
        mut,
        seeds = [
            b"metadata",
            mpl_token_metadata::ID.as_ref(),
            mint.key().as_ref(),
        ],
        bump,
        seeds::program = mpl_token_metadata::ID,
    )]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: Validated against mpl_token_metadata::ID constant
    #[account(constraint = token_metadata_program.key() == mpl_token_metadata::ID @ NautilusError::InvalidTokenMetadataProgram)]
    pub token_metadata_program: UncheckedAccount<'info>,

    /// CHECK: Sysvar instructions — required by CreateV1
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub sysvar_instructions: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub state: Account<'info, NautilusState>,

    #[account(mut, constraint = mint.key() == state.mint)]
    pub mint: Account<'info, Mint>,

    /// CHECK: PDA verified by seeds + bump
    #[account(
        seeds = [b"nautilus", state.key().as_ref()],
        bump = state.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
    )]
    pub buyer_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"treasury", state.key().as_ref()],
        bump = state.treasury_bump,
        constraint = treasury.key() == state.treasury,
    )]
    pub treasury: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub state: Account<'info, NautilusState>,

    #[account(mut, constraint = mint.key() == state.mint)]
    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = seller,
    )]
    pub seller_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"treasury", state.key().as_ref()],
        bump = state.treasury_bump,
        constraint = treasury.key() == state.treasury,
    )]
    pub treasury: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GetState<'info> {
    pub state: Account<'info, NautilusState>,
}

#[error_code]
pub enum NautilusError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Stage supply exhausted")]
    StageSoldOut,
    #[msg("Amount exceeds remaining stage supply")]
    ExceedsStageSupply,
    #[msg("Amount exceeds maximum per transaction")]
    ExceedsMaxAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Treasury balance insufficient for payout plus rent minimum")]
    InsufficientTreasury,
    #[msg("Invalid metadata: name/symbol/uri too long")]
    InvalidMetadata,
    #[msg("Invalid token metadata program")]
    InvalidTokenMetadataProgram,
}