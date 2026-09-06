/**
 * IExecutionContext does not declare its error mode yet, so two shapes flow
 * through it: BoundExec's ExecError ({ exitCode, stderr }) and
 * NodeExecutionContext's raw promisified-execFile errors ({ code, stderr },
 * where code is 'ENOENT' when the binary is missing). Accept both until the
 * unified ExecError lands (.scratch/exec-and-layering/map.md).
 */
export type ExecFailure = { exitCode: number | null; stderr: string; spawnFailed: boolean };

export function readExecFailure(error: unknown): ExecFailure | null {
  if (typeof error !== 'object' || error === null) return null;
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  if ('exitCode' in error && (typeof error.exitCode === 'number' || error.exitCode === null)) {
    return { exitCode: error.exitCode, stderr, spawnFailed: false };
  }
  if ('code' in error) {
    if (error.code === 'ENOENT') return { exitCode: null, stderr, spawnFailed: true };
    if (typeof error.code === 'number') return { exitCode: error.code, stderr, spawnFailed: false };
  }
  return null;
}

/**
 * The binary is missing from PATH or the shell reported "command not found".
 * `BoundExec` reports a failed spawn as an `ExecError` with a null exit code
 * and the Node error message ("spawn tmux ENOENT") as stderr, so that shape
 * counts too.
 */
export function isMissingBinaryFailure(failure: ExecFailure): boolean {
  if (failure.spawnFailed) return true;
  if (failure.exitCode === null && /\bENOENT\b/.test(failure.stderr)) return true;
  return failure.exitCode === 127 || /command not found|not found/i.test(failure.stderr);
}
