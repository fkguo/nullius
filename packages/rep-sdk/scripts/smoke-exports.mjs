const modules = [
  '@nullius/rep-sdk',
  '@nullius/rep-sdk/client',
  '@nullius/rep-sdk/server',
  '@nullius/rep-sdk/transport',
  '@nullius/rep-sdk/validation',
  '@nullius/rep-sdk/discovery',
  '@nullius/rep-sdk/signals',
];

await Promise.all(modules.map((name) => import(name)));
