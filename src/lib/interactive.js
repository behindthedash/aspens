import { CliError } from './errors.js';

// Non-interactive stdin (no TTY, e.g. worktrail's subprocess.run(capture_output=True))
// never resolves an @clack/prompts confirm/select — it blocks forever, since @clack
// has no data and no EOF to react to. Every prompt must resolve via a flag/--yes
// default, or fail fast here, before ever calling into @clack/prompts.
export function isInteractive() {
  return Boolean(process.stdin.isTTY);
}

export function failNonInteractive(description) {
  throw new CliError(
    `Cannot prompt ("${description}") in a non-interactive session (stdin is not a TTY). ` +
    'Pass the flag that resolves this choice explicitly (e.g. --yes) and retry.'
  );
}
