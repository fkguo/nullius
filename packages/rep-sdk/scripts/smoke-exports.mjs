const modules = [
  '@autoresearch/rep-sdk',
  '@autoresearch/rep-sdk/client',
  '@autoresearch/rep-sdk/server',
  '@autoresearch/rep-sdk/transport',
  '@autoresearch/rep-sdk/validation',
  '@autoresearch/rep-sdk/discovery',
];

await Promise.all(modules.map((name) => import(name)));
