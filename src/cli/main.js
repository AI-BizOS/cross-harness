// Command line entry. Subcommands are loaded lazily so `troupe mcp`, which every
// agent starts, stays fast and loads nothing it does not need.

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'mcp') {
    const { serve } = await import('../collab/mcp-server.js');
    await serve();
    return 0;
  }
  const { run } = await import('./commands.js');
  return run(argv);
}
