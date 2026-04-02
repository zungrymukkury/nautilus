//! # Nautilus Protocol v0.5
//!
//! A Fibonacci-based fair launch framework for Solana.
//! Permissionless launchpad — anyone can launch a treasury-backed token.
//!
//! ## Architecture
//!
//! | Component         | Implementation                           |
//! |-------------------|------------------------------------------|
//! | Treasury          | PDA — no private key exists              |
//! | Mint Authority    | PDA — no private key exists              |
//! | Buy Price         | Fibonacci fixed (BASE_PRICE × FIB[stage])|
//! | Sell Price        | Weighted average (treasury ÷ total_sold) |
//! | Token Metadata    | Registered via Metaplex CPI at init      |
//! | Admin functions   | None (on-chain)                          |
//! | Upgrade Authority | Revoked (immutable)                      |

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Burn};
use anchor_spl::associated_token::AssociatedToken;
use mpl_token_metadata::instructions::CreateMetadataAccountV3CpiBuilder;
use mpl_token_metadata::types::DataV2;

declare_id!("32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev");

const FIB: [u64; 20] = [
    1, 1, 2, 3, 5, 8, 13, 21, 34, 55,
    89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765
];

const STAGE_SUPPLY: [u64; 20] = [
    1_000_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000,
    8_000_000, 13_000_000, 21_000_000, 34_000_000, 55_000_000,
    89_000_000, 144_000_000, 233_000_000, 377_000_000, 610_000_000,
    987_000_000, 1_597_000_000, 2_584_000_000, 4_181_000_000, 6_765_000_000,
];

const BASE_PRICE_LAMPORTS: u64 = 1_000_000;
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

        msg!("Nautilus v0.5 initialized");
        msg!("Treasury PDA: {}", ctx.accounts.treasury.key());
        msg!("Mint: {}", ctx.accounts.mint.key());
        Ok(())
    }

    pub fn buy(ctx: Context<Buy>, amount: u64) -> Result<()> {
        require!(amount > 0, NautilusError::InvalidAmount);
        require!(amount <= MAX_AMOUNT_PER_TX, NautilusError::ExceedsMaxAmount);

        let state = &mut ctx.accounts.state;
        let stage = state.current_stage as usize;

        let remaining = STAGE_SUPPLY[stage]
            .checked_sub(state.stage_sold[stage])
            .ok_or(NautilusError::StageSoldOut)?;
        require!(amount <= remaining, NautilusError::ExceedsStageSupply);

        let price = BASE_PRICE_LAMPORTS
            .checked_mul(FIB[stage])
            .ok_or(NautilusError::Overflow)?;
        let total_cost = price.checked_mul(amount).ok_or(NautilusError::Overflow)?;

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, total_cost)?;

        let state_key = state.key();
        let mint_bump = state.mint_authority_bump;
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

        state.treasury_balance = state.treasury_balance
            .checked_add(total_cost)
            .ok_or(NautilusError::Overflow)?;
        state.stage_sold[stage] += amount;
        state.total_sold += amount;

        if state.stage_sold[stage] >= STAGE_SUPPLY[stage] && stage < 19 {
            state.current_stage += 1;
            msg!("Stage advanced to {}", state.current_stage);
        }

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

        let state_key = state.key();
        let treasury_bump = state.treasury_bump;
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

        state.treasury_balance = state.treasury_balance
            .checked_sub(payout)
            .ok_or(NautilusError::Overflow)?;
        state.total_sold = state.total_sold
            .checked_sub(amount)
            .ok_or(NautilusError::Overflow)?;

        msg!("Sell | avg_price {} | amount {} | payout {} | spread {}",
            avg_price, amount, payout, spread);
        Ok(())
    }

    pub fn get_state(ctx: Context<GetState>) -> Result<()> {
        let state = &ctx.accounts.state;
        let buy_price = BASE_PRICE_LAMPORTS * FIB[state.current_stage as usize];
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

    /// CHECK: Metaplex token metadata program
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
}
