// Command line entry. Subcommands are loaded lazily so `cross-harness mcp`, which every
// agent starts, stays fast and loads nothing it does not need.

export async function main(argv) {
  // Accept old installations' environment settings during the command rename.
  for (const key of ['HOME', 'MAILBOX', 'TOKEN', 'NO_STAR_PROMPT', 'NO_UPDATE_CHECK', 'UPDATE_REPOSITORY']) {
    const current = `CROSS_HARNESS_${key}`;
    const legacy = `TROUPE_${key}`;
    if (!process.env[current] && process.env[legacy]) process.env[current] = process.env[legacy];
  }
  const [command, ...rest] = argv;
  if (command === 'mcp') {
    const { serve } = await import('../collab/mcp-server.js');
    await serve();
    return 0;
  }
  const { run } = await import('./commands.js');
  return run(argv);
}
