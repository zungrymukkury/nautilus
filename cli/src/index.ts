import { Command } from 'commander';
import { statusCommand } from './commands/status';
import { buyCommand } from './commands/buy';
import { sellCommand } from './commands/sell';
import { balanceCommand } from './commands/balance';
import { sendCommand } from './commands/send';
import { historyCommand } from './commands/history';
import { initCommand } from './commands/init';

const program = new Command();

program
  .name('nautilus')
  .description('Nautilus Protocol CLI')
  .version('0.5.0');

program
  .command('init <name> <symbol> <logo>')
  .description('Launch a new Nautilus token')
  .requiredOption('--ar-key <path>', 'Path to Arweave wallet JSON')
  .action(async (name, symbol, logo, options) => {
    await initCommand(name, symbol, logo, options.arKey);
  });

program
  .command('status <state>')
  .description('Show protocol status')
  .action(async (state) => {
    await statusCommand(state);
  });

program
  .command('buy <state> <amount>')
  .description('Buy tokens')
  .action(async (state, amount) => {
    await buyCommand(state, parseInt(amount));
  });

program
  .command('sell <state> <amount>')
  .description('Sell tokens')
  .action(async (state, amount) => {
    await sellCommand(state, parseInt(amount));
  });

program
  .command('balance <state>')
  .description('Show token balance')
  .action(async (state) => {
    await balanceCommand(state);
  });

program
  .command('send <state> <recipient> <amount>')
  .description('Send tokens to another wallet')
  .action(async (state, recipient, amount) => {
    await sendCommand(state, recipient, parseInt(amount));
  });

program
  .command('history <state>')
  .description('Show transaction history')
  .option('-n, --limit <number>', 'Number of transactions', '20')
  .action(async (state, options) => {
    await historyCommand(state, parseInt(options.limit));
  });

program.parseAsync(process.argv).catch(console.error);
