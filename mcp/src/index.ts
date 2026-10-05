import { runStdioServer } from './server';

runStdioServer().catch((error) => {
  console.error('[remoat-mcp] fatal:', error);
  process.exitCode = 1;
});
