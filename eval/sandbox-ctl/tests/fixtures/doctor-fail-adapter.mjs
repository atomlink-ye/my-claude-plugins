function parseArgs(argv = []) { return { command: argv[0], options: {}, positionals: [], passthrough: [] }; }
async function handleDoctor() { return { ok: false, connected: false, category: "connection_error", error: "fixture failure" }; }
export { handleDoctor, parseArgs };
