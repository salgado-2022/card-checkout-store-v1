/**
 * Dependency rule for the hexagonal layout (Requirement 4, Property 8).
 *
 * `to.path` matches the module name as well as the resolved `node_modules/` path, so a
 * forbidden package is reported even when it is not installed (bare name in the graph).
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-no-framework-imports',
      severity: 'error',
      comment: 'Domain code must not import NestJS, AWS SDK or HTTP client libraries.',
      from: { path: '^src/domain' },
      to: {
        path: '(^|node_modules/)(@nestjs/|@aws-sdk/|express($|/)|axios($|/)|node-fetch($|/)|got($|/)|undici($|/)|superagent($|/))',
      },
    },
    {
      name: 'domain-no-outer-layers',
      severity: 'error',
      comment: 'Domain code must not depend on application or infrastructure layers.',
      from: { path: '^src/domain' },
      to: { path: '^src/(application|infrastructure)' },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
  },
};
