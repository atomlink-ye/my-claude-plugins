function parseArgs(argv = []) {
  return { command: argv[0], options: {}, positionals: [], passthrough: [] };
}

async function handleExec() {
  return { exitCode: 125, stdout: "", stderr: "control failure", error: "control failure" };
}

export { handleExec, parseArgs };
