import { Command } from 'commander';
import { statusCommand } from './commands/status';
import { buyCommand } from './commands/buy';
import { sellCommand } from './commands/sell';
import { balanceCommand } from './commands/balance';
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

program.parseAsync(process.argv).catch(console.error);
