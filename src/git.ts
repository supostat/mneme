const GIT_EXECUTABLE = "git";
const STRIPPED_ENV_KEYS: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
]);

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function isStrippedGitEnvKey(key: string): boolean {
  return STRIPPED_ENV_KEYS.has(key) || key.startsWith("GIT_CONFIG");
}

function sanitizedGitEnv(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isStrippedGitEnvKey(key)) {
      environment[key] = value;
    }
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

export async function runGit(
  repoDir: string,
  args: string[],
  pathArgs: string[] = [],
): Promise<GitResult> {
  const command = [GIT_EXECUTABLE, "-C", repoDir, ...args];
  if (pathArgs.length > 0) {
    command.push("--", ...pathArgs);
  }
  const subprocess = Bun.spawn({
    cmd: command,
    env: sanitizedGitEnv(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function isRepo(repoDir: string): Promise<boolean> {
  const result = await runGit(repoDir, ["rev-parse", "--git-dir"]);
  return result.exitCode === 0 && result.stdout.trim() === ".git";
}

export async function initRepo(repoDir: string): Promise<void> {
  const result = await runGit(repoDir, ["init", "-q", "-b", "main"]);
  if (result.exitCode !== 0) {
    throw new Error(`git init failed in ${repoDir}: ${result.stderr.trim()}`);
  }
}
