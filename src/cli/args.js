// A small argument parser: --flag, --key value, --key=value, -h, and positionals.

/**
 * @param {string[]} argv
 * @param {{boolean?:string[], string?:string[], alias?:Record<string,string>}} spec
 */
export function parseArgs(argv, { boolean = [], string = [], alias = {} } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length === 2)) {
      let [key, value] = arg.replace(/^--?/, '').split(/=(.*)/s, 2);
      key = alias[key] || key;
      if (boolean.includes(key)) {
        flags[key] = value === undefined ? true : !['false', '0', 'no'].includes(value);
      } else if (string.includes(key)) {
        if (value === undefined) {
          value = argv[i + 1];
          if (value === undefined) throw new Error(`--${key} needs a value`);
          i++;
        }
        flags[key] = value;
      } else {
        throw new Error(`Unknown option ${arg}`);
      }
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}
