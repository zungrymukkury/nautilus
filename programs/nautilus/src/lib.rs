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
use mpl_token_metadata::instructions::CreateMetadataAccountV3CpiBuilder;
use mpl_token_metadata::types::DataV2;

declare_id!("32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev");

// Buy price table: PRICE_TABLE[n] = floor(BASE_PRICE * FIB[n]^a)
// where a = log_φ(2) - 1 ≈ 0.44042009041255636
// This sets the high-stage worst-case recovery floor to 1/φ.
// Supply grows by φ per stage; price grows by 2/φ; product doubles asymptotically.
// Generated offline. Monotone nondecreasing. Treat as consensus-critical constants.
const PRICE_TABLE: [u64; 20] = [
    1_000_000,   // stage 0  FIB=1
    1_000_000,   // stage 1  FIB=1
    1_356_999,   // stage 2  FIB=2
    1_622_310,   // stage 3  FIB=3
    2_031_610,   // stage 4  FIB=5
    2_498_843,   // stage 5  FIB=8
    3_094_589,   // stage 6  FIB=13
    3_822_363,   // stage 7  FIB=21
    4_726_004,   // stage 8  FIB=34
    5_841_047,   // stage 9  FIB=55
    7_220_222,   // stage 10 FIB=89
    8_924_547,   // stage 11 FIB=144
    11_031_412,  // stage 12 FIB=233
    13_635_545,  // stage 13 FIB=377
    16_854_475,  // stage 14 FIB=610
    20_833_269,  // stage 15 FIB=987
    25_751_340,  // stage 16 FIB=1597
    31_830_406,  // stage 17 FIB=2584
    39_344_546,  // stage 18 FIB=4181
    48_632_533,  // stage 19 FIB=6765
];

const STAGE_SUPPLY: [u64; 20] = [
    1_000_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000,
    8_000_000, 13_000_000, 21_000_000, 34_000_000, 55_000_000,
    89_000_000, 144_000_000, 233_000_000, 377_000_000, 610_000_000,
    987_000_000, 1_597_000_000, 2_584_000_000, 4_181_000_000, 6_765_000_000,
];

const SPREAD_BPS: u64 = 50;
const MAX_AMOUNT_PER_TX: u64 = 1_000_000;

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
        state.stage_sold = [0u64; 20];
        state.treasury_balance = 0;

        // Metaplex metadata CPI — PDA signer
        let state_key = state.key();
        let mint_bump = state.mint_authority_bump;
        let mint_seeds: &[&[u8]] = &[b"nautilus", state_key.as_ref(), &[mint_bump]];
        let signer_seeds = &[mint_seeds];

        CreateMetadataAccountV3CpiBuilder::new(
            &ctx.accounts.token_metadata_program.to_account_info(),
        )
        .metadata(&ctx.accounts.metadata.to_account_info())
        .mint(&ctx.accounts.mint.to_account_info())
        .mint_authority(&ctx.accounts.mint_authority.to_account_info())
        .payer(&ctx.accounts.authority.to_account_info())
        .update_authority(&ctx.accounts.mint_authority.to_account_info(), true)
        .system_program(&ctx.accounts.system_program.to_account_info())
        .data(DataV2 {
            name,
            symbol,
            uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        })
        .is_mutable(true)
        .invoke_signed(signer_seeds)?;

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
            let target = if stage == 0 { 1_000_000u64 } else { 2_000_000u64 };
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
            let target = if stage == 0 { 1_000_000u64 } else { 2_000_000u64 };
            state.total_sold >= target
        } else {
            state.stage_sold[stage] >= STAGE_SUPPLY[stage]
        };
        if should_advance && stage < 19 {
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
        require!(state.total_sold >= amount, NautilusError::InvalidAmount);

        let avg_price = state.treasury_balance
            .checked_div(state.total_sold)
            .ok_or(NautilusError::Overflow)?;
        let gross = avg_price.checked_mul(amount).ok_or(NautilusError::Overflow)?;
        let spread = gross.checked_mul(SPREAD_BPS).ok_or(NautilusError::Overflow)? / 10_000;
        let payout = gross - spread;

        let rent_minimum = Rent::get()?.minimum_balance(0);
        require!(
            state.treasury_balance >= payout + rent_minimum,
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
    pub stage_sold: [u64; 20],
    pub treasury_balance: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 1 + 32 + 1 + 8 + 1 + 20 * 8 + 8,
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

    #[account(
        mut,
        seeds = [b"treasury", state.key().as_ref()],
        bump,
    )]
    pub treasury: SystemAccount<'info>,

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