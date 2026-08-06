function parseArgs(argv = []) {
  return { command: argv[0], options: {}, positionals: [], passthrough: [] };
}

async function handleExec() {
  return { exitCode: 7, stdout: "fixture stdout", stderr: "fixture stderr" };
}

export { handleExec, parseArgs };
