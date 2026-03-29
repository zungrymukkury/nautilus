//! # Nautilus Protocol v0.4
//!
//! A Fibonacci-based fair launch framework for Solana.
//!
//! ## Architecture
//!
//! | Component         | Implementation                           |
//! |-------------------|------------------------------------------|
//! | Treasury          | PDA — no private key exists              |
//! | Mint Authority    | PDA — no private key exists              |
//! | Buy Price         | Fibonacci fixed (BASE_PRICE × FIB[stage])|
//! | Sell Price        | Weighted average (treasury ÷ total_sold) |
//! | Admin functions   | None (on-chain)                          |
//! | Upgrade Authority | Held by deployer (see policy below)      |
//!
//! ## Upgrade Authority Policy
//!
//! Upgrade authority is currently held by the deployer.
//! This is intentional during the early phase to allow critical bug fixes.
//! No admin functions exist on-chain — upgrade authority is the only
//! remaining deployer privilege.
//!
//! Planned transitions:
//!   v0.4 — Deployer holds upgrade authority
//!   v0.5 — Transfer to multisig
//!   v0.6 — Revoke (program becomes immutable)
//!
//! To verify current upgrade authority on-chain:
//!   `solana program show <PROGRAM_ID>`
//!
//! ## Price Source of Truth
//!
//! Sell price is calculated from state.treasury_balance (accounted),
//! not from actual PDA lamports. Direct SOL transfers to the treasury
//! PDA do not affect pricing or sell calculations.
//!
//! When total_sold == 0, sell price is undefined.
//! get_state() returns 0 in this case.
//! UIs should display BASE_PRICE_LAMPORTS or "N/A" rather than 0.
//!
//! ## Treasury PDA
//!
//! The treasury is a system-owned PDA vault, verified by seeds constraint:
//!   seeds: [b"treasury", state.key()]
//! No private key exists for this address. SOL can only leave via
//! the sell instruction, which requires burning tokens.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Burn};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("32hXzUiArykkvmxZGtaAZxWgy9fZm2Zcgdc5wvsQDuev");

/// Fibonacci sequence for stage price multipliers.
/// Stage N has buy price = BASE_PRICE_LAMPORTS × FIB[N].
const FIB: [u64; 20] = [
    1, 1, 2, 3, 5, 8, 13, 21, 34, 55,
    89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765
];

/// Token supply available per stage, following the Fibonacci sequence.
const STAGE_SUPPLY: [u64; 20] = [
    1_000_000,
    1_000_000,
    2_000_000,
    3_000_000,
    5_000_000,
    8_000_000,
    13_000_000,
    21_000_000,
    34_000_000,
    55_000_000,
    89_000_000,
    144_000_000,
    233_000_000,
    377_000_000,
    610_000_000,
    987_000_000,
    1_597_000_000,
    2_584_000_000,
    4_181_000_000,
    6_765_000_000,
];

/// Base buy price in lamports. Stage 1 buy price = BASE_PRICE_LAMPORTS × 1.
/// At 1_000_000 lamports (0.001 SOL), Stage 1 MC ≈ $82K at SOL = $82.
const BASE_PRICE_LAMPORTS: u64 = 1_000_000;

/// Sell spread in basis points (50 = 0.5%).
/// Spread remains in treasury, incrementally increasing
/// sell price for remaining holders.
const SPREAD_BPS: u64 = 50;

/// Maximum tokens purchasable per transaction.
/// Prevents u64 overflow at high Fibonacci stages.
/// At stage 20: FIB[19] × BASE_PRICE = 6,765,000,000 lamports/token.
/// MAX_AMOUNT_PER_TX × 6,765,000,000 < u64::MAX (~18.4 × 10^18).
/// Large purchases should be split across multiple transactions.
const MAX_AMOUNT_PER_TX: u64 = 1_000_000;

#[program]
pub mod nautilus {
    use super::*;

    /// Initialize a new Nautilus launch.
    /// Creates state account and SPL mint.
    /// Treasury is a system-owned PDA vault — no init needed.
    /// No admin functions exist on-chain after initialization.
    /// Upgrade authority is separately documented in module-level docs.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
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
        msg!("Nautilus v0.4 initialized");
        msg!("Treasury PDA: {}", ctx.accounts.treasury.key());
        msg!("Mint: {}", ctx.accounts.mint.key());
        Ok(())
    }

    /// Purchase tokens at the current Fibonacci stage price.
    ///
    /// Buy price = BASE_PRICE_LAMPORTS × FIB[current_stage]
    ///
    /// SOL is transferred to the treasury PDA.
    /// Tokens are minted to the buyer's associated token account.
    /// Stage advances automatically when supply is exhausted.
    ///
    /// Maximum amount per transaction: MAX_AMOUNT_PER_TX.
    /// Larger purchases must be split across multiple transactions.
    pub fn buy(ctx: Context<Buy>, amount: u64) -> Result<()> {
        require!(amount > 0, NautilusError::InvalidAmount);
        require!(amount <= MAX_AMOUNT_PER_TX, NautilusError::ExceedsMaxAmount);

        let state = &mut ctx.accounts.state;
        let stage = state.current_stage as usize;

        // Stage supply check
        let remaining = STAGE_SUPPLY[stage]
            .checked_sub(state.stage_sold[stage])
            .ok_or(NautilusError::StageSoldOut)?;
        require!(amount <= remaining, NautilusError::ExceedsStageSupply);

        // Buy price: Fibonacci fixed
        let price = BASE_PRICE_LAMPORTS
            .checked_mul(FIB[stage])
            .ok_or(NautilusError::Overflow)?;

        let total_cost = price
            .checked_mul(amount)
            .ok_or(NautilusError::Overflow)?;

        // Transfer SOL: buyer → treasury PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, total_cost)?;

        // Mint tokens → buyer ATA
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

        // Update state
        state.treasury_balance = state.treasury_balance
            .checked_add(total_cost)
            .ok_or(NautilusError::Overflow)?;
        state.stage_sold[stage] += amount;
        state.total_sold += amount;

        // Advance stage when supply exhausted
        if state.stage_sold[stage] >= STAGE_SUPPLY[stage] && stage < 19 {
            state.current_stage += 1;
            msg!("Stage advanced to {}", state.current_stage);
        }

        msg!("Buy | stage {} | price {} lamports | amount {} | cost {} lamports",
            stage, price, amount, total_cost);

        Ok(())
    }

    /// Sell tokens at the current weighted average price.
    ///
    /// Sell price = state.treasury_balance ÷ state.total_sold
    /// Payout = sell_price × amount × (1 - 0.5% spread)
    ///
    /// Spread remains in treasury, incrementally increasing
    /// the sell price for remaining holders.
    ///
    /// Tokens are burned. SOL is transferred from treasury PDA
    /// using PDA signer seeds — no private key required.
    ///
    /// Maximum amount per transaction: MAX_AMOUNT_PER_TX.
    pub fn sell(ctx: Context<Sell>, amount: u64) -> Result<()> {
        require!(amount > 0, NautilusError::InvalidAmount);
        require!(amount <= MAX_AMOUNT_PER_TX, NautilusError::ExceedsMaxAmount);

        let state = &mut ctx.accounts.state;
        require!(state.total_sold >= amount, NautilusError::InvalidAmount);

        // Sell price: weighted average (accounted treasury)
        let avg_price = state.treasury_balance
            .checked_div(state.total_sold)
            .ok_or(NautilusError::Overflow)?;

        let gross = avg_price
            .checked_mul(amount)
            .ok_or(NautilusError::Overflow)?;

        // 0.5% spread stays in treasury
        let spread = gross
            .checked_mul(SPREAD_BPS)
            .ok_or(NautilusError::Overflow)?
            / 10_000;
        let payout = gross - spread;

        // Ensure treasury retains minimum rent balance
        let rent_minimum = Rent::get()?.minimum_balance(0);
        require!(
            state.treasury_balance >= payout + rent_minimum,
            NautilusError::InsufficientTreasury
        );

        // Burn tokens from seller ATA
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

        // Transfer SOL: treasury PDA → seller (PDA signer, no private key)
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

        // Update state
        state.treasury_balance = state.treasury_balance
            .checked_sub(payout)
            .ok_or(NautilusError::Overflow)?;
        state.total_sold = state.total_sold
            .checked_sub(amount)
            .ok_or(NautilusError::Overflow)?;

        msg!("Sell | avg_price {} lamports | amount {} | payout {} lamports | spread {} lamports",
            avg_price, amount, payout, spread);

        Ok(())
    }

    /// Read current protocol state.
    ///
    /// sell_price returns 0 when total_sold == 0 (undefined state).
    /// UIs should display BASE_PRICE_LAMPORTS or "N/A" in this case.
    pub fn get_state(ctx: Context<GetState>) -> Result<()> {
        let state = &ctx.accounts.state;
        let buy_price = BASE_PRICE_LAMPORTS * FIB[state.current_stage as usize];
        let sell_price = if state.total_sold == 0 {
            0 // undefined — display BASE_PRICE or N/A in UI
        } else {
            state.treasury_balance / state.total_sold
        };

        msg!("=== Nautilus State ===");
        msg!("Stage:           {}", state.current_stage);
        msg!("Buy price:       {} lamports", buy_price);
        msg!("Sell price:      {} lamports (0 = undefined)", sell_price);
        msg!("Treasury:        {} lamports (accounted)", state.treasury_balance);
        msg!("Total sold:      {}", state.total_sold);
        msg!("=====================");

        Ok(())
    }
}

/// Core protocol state account.
///
/// treasury_balance is the accounted SOL balance (source of truth).
/// Direct SOL transfers to treasury PDA do not affect this value.
#[account]
pub struct NautilusState {
    /// Deployer address. No on-chain admin privileges post-initialization.
    /// Upgrade authority is held separately (see module docs).
    pub authority: Pubkey,
    /// Treasury PDA address (seeds: [b"treasury", state.key()])
    pub treasury: Pubkey,
    /// Treasury PDA bump seed for signer derivation
    pub treasury_bump: u8,
    /// SPL token mint address
    pub mint: Pubkey,
    /// Mint authority PDA bump seed
    pub mint_authority_bump: u8,
    /// Total tokens currently in circulation
    pub total_sold: u64,
    /// Current Fibonacci stage (0-indexed)
    pub current_stage: u8,
    /// Tokens sold per stage
    pub stage_sold: [u64; 20],
    /// Accounted SOL in treasury (lamports). Source of truth for pricing.
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

    /// Mint authority PDA. No private key exists.
    /// seeds: [b"nautilus", state.key()]
    /// CHECK: PDA verified by seeds constraint
    #[account(
        seeds = [b"nautilus", state.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// Treasury PDA vault. No private key exists.
    /// seeds: [b"treasury", state.key()]
    /// System-owned PDA verified by seeds constraint.
    /// SOL can only leave via the sell instruction.
    #[account(
        mut,
        seeds = [b"treasury", state.key().as_ref()],
        bump,
    )]
    pub treasury: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

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

    /// Mint authority PDA. No private key exists.
    /// CHECK: PDA verified by seeds + bump constraint
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

    /// Treasury PDA vault — receives SOL from buyers.
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

    /// Treasury PDA vault — sends SOL to sellers via PDA signer.
    /// No private key required for this transfer.
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
    #[msg("Amount exceeds maximum per transaction (1,000,000). Split into multiple transactions.")]
    ExceedsMaxAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Treasury balance insufficient for payout plus rent minimum")]
    InsufficientTreasury,
}