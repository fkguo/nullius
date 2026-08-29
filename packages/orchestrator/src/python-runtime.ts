export function defaultPythonRuntime(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return env.NULLIUS_PYTHON || (platform === 'win32' ? 'python' : 'python3');
}
