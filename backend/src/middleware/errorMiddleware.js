import { colors, formatTimestamp } from './terminalLogger.js';

export const errorHandler = (err, req, res, next) => {
  const ts = formatTimestamp();
  const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  const border = '═'.repeat(78);
  const thinBorder = '─'.repeat(78);

  console.error(`\n${colors.brightRed}╔${border}╗${colors.reset}`);
  console.error(`${colors.brightRed}║ ❌ [BACKEND ERROR] ${String(req.method || 'METHOD')} ${String(req.originalUrl || req.url || '').padEnd(54)}║${colors.reset}`);
  console.error(`${colors.brightRed}╠${thinBorder}╣${colors.reset}`);
  console.error(`${colors.brightRed}║  Timestamp: ${ts.padEnd(65)}║${colors.reset}`);
  console.error(`${colors.brightRed}║  Status:    ${String(statusCode).padEnd(65)}║${colors.reset}`);
  console.error(`${colors.brightRed}║  Message:   ${String(err.message || 'Unknown error').padEnd(65)}║${colors.reset}`);

  if (err.stack) {
    console.error(`${colors.brightRed}╠${thinBorder}╣${colors.reset}`);
    const stackLines = err.stack.split('\n').slice(0, 8);
    for (const line of stackLines) {
      const truncated = line.length > 74 ? line.substring(0, 71) + '...' : line;
      console.error(`${colors.brightRed}║${colors.reset} ${colors.dim}${truncated.padEnd(76)}${colors.reset} ${colors.brightRed}║${colors.reset}`);
    }
  }
  console.error(`${colors.brightRed}╚${border}╝${colors.reset}\n`);

  res.status(statusCode).json({
    error: err.message || 'Internal Server Error',
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
};
