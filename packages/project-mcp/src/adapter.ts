import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invalidParams } from '@nullius/shared';
import { readFile, writeFile } from './files.js';
import { projectRoot, guardRuntimePaths, projectIdentity, assertProjectIdentity, type ProjectIdentity } from './paths.js';
import { coreArguments, coreSpecs, isBackground, samplingTools, type Context } from './policy.js';
import { extraSchemas, toolsList } from './registry.js';
import { cliArguments, cliWrites, cliSchema } from './cli.js';
import { readDelivery, submitDelivery } from './delivery.js';
import { acquireExecution, releaseExecution } from './execution-lock.js';
import { execute } from './execute.js';
import { errorResult, jsonResult, type Result } from './result.js';

const deliverySchema = z.object({ delivery_id: z.string(), timeout_seconds: z.number().int().min(1).max(3600).default(300) });
export class ProjectAdapter {
  readonly root: string;
  private readonly identity: ProjectIdentity;
  constructor(root: string) { this.root = projectRoot(root); this.identity = projectIdentity(this.root); }
  listTools() { return toolsList(); }
  async call(name: string, args: Record<string, unknown>, host: Pick<Context, 'createMessage'> = {}): Promise<Result> {
    try {
      // Detect a root replaced with a symlink since server startup.
      assertProjectIdentity(this.root, this.identity);
      if (name === 'project_capabilities') {
        extraSchemas.project_capabilities.parse(args);
        return jsonResult({ project_root: this.root, transport: 'stdio', control_plane: '@nullius/orchestrator',
          files: { read_max_bytes: 65536, upload_max_bytes: 1048576 },
          background: { journal: 'RunManifestManager', replay: 'committed_only', unknown: 'local_reconciliation_required', scheduler: false },
          sampling: host.createMessage ? 'available_while_connected' : 'unavailable',
          local_processes: 'trusted_host_code_not_os_sandboxed',
          approvals: 'local_host_only', provider_servers: 'separate_hep_and_idea',
          remote_connection: 'configured_by_host',
          tools: coreSpecs.map(spec => spec.name),
        });
      }
      if (name === 'project_file_read') {
        const input = extraSchemas.project_file_read.parse(args);
        return jsonResult(readFile(this.root, input.path, input.offset, input.max_bytes));
      }
      if (name === 'project_file_write') {
        const input = extraSchemas.project_file_write.parse(args);
        return jsonResult(writeFile(this.root, input.path, input.content, input.expected_sha256));
      }
      if (name === 'project_delivery_read') {
        const input = extraSchemas.project_delivery_read.parse(args);
        return jsonResult(readDelivery(this.root, input.delivery_id, input.offset, input.max_bytes));
      }
      if (name === 'project_cli') {
        guardRuntimePaths(this.root);
        const input = cliSchema.parse(args);
        cliArguments(this.root, input);
        if (!cliWrites(input.action)) return execute(this.root, name, input);
        return this.submit(name, input);
      }
      const parsed = coreArguments(this.root, name, args);
      guardRuntimePaths(this.root, typeof parsed.manifest_path === 'string' ? parsed.manifest_path : undefined);
      if (samplingTools.has(name)) {
        if (!host.createMessage) return jsonResult({ status: 'unavailable', reason: 'This client does not supply MCP sampling. Use an authenticated native host runtime; copying a skill does not provide one.' }, true);
        const owner = `sampling-${randomUUID()}`;
        acquireExecution(this.root, owner);
        try {
          return await execute(this.root, name, parsed, {
            createMessage: host.createMessage,
            // Internal ownership is a closure, never a caller-supplied argument.
            callTool: (tool, input) => {
              if (samplingTools.has(tool)) throw invalidParams('Recursive delegated runtimes are not exposed.');
              coreArguments(this.root, tool, input);
              return execute(this.root, tool, input);
            },
          });
        } finally { releaseExecution(this.root, owner); }
      }
      if (isBackground(name)) return this.submit(name, { ...parsed, delivery_id: args.delivery_id, timeout_seconds: args.timeout_seconds });
      return execute(this.root, name, parsed);
    } catch (error) { return errorResult(error); }
  }
  private submit(name: string, input: Record<string, unknown>): Result {
    const delivery = deliverySchema.parse(input);
    const args = { ...input };
    delete args.delivery_id;
    delete args.timeout_seconds;
    return jsonResult(submitDelivery({ root: this.root, root_identity: this.identity, name, args, ...delivery }));
  }
}
