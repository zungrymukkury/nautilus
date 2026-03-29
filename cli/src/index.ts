#!/usr/bin/env node
import { Command } from "commander";
import { statusCommand } from "./commands/status";
import { buyCommand } from "./commands/buy";
import { sellCommand } from "./commands/sell";
import { balanceCommand } from "./commands/balance";

const program = new Command();

program
  .name("nautilus")
  .description("Nautilus Protocol CLI — Fibonacci fair launch for Solana")
  .version("0.4.0");

program
  .command("status <state>")
  .description("Show current stage, buy price, sell price, treasury balance")
  .action(statusCommand);

program
  .command("buy <state> <amount>")
  .description("Buy tokens at current Fibonacci stage price")
  .action((state, amount) => buyCommand(state, parseInt(amount)));

program
  .command("sell <state> <amount>")
  .description("Sell tokens at current weighted average price")
  .action((state, amount) => sellCommand(state, parseInt(amount)));

program
  .command("balance <state>")
  .description("Show wallet SOL and token balance")
  .action(balanceCommand);

program.addHelpText("after", `
Environment variables:
  NAUTILUS_WALLET   Path to keypair JSON (default: ~/.config/solana/id.json)
  NAUTILUS_RPC      RPC endpoint (default: http://127.0.0.1:8899)

Examples:
  nautilus status  <STATE_ADDRESS>
  nautilus buy     <STATE_ADDRESS> 1000
  nautilus sell    <STATE_ADDRESS> 500
  nautilus balance <STATE_ADDRESS>

Mainnet:
  NAUTILUS_RPC=https://api.mainnet-beta.solana.com nautilus status <STATE>
`);

program.parse();
