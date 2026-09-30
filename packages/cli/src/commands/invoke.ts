import { Kernel, MemoryStore, newId } from '@tcpcore1/kernel';
import type { Actor } from '@tcpcore1/kernel';
import { loadAdapterFile } from '@tcpcore1/adapters';
import pc from 'picocolors';
import { flagBoolean, flagString, type ParsedArgv } from '../lib/commands.js';
import { riskLabel, symbols, write, writeErr } from '../lib/output.js';
import { parseArgs } from '../lib/resolve.js';

/**
 * `tcpctl invoke` — run one capability through the kernel and show the decision.
 *
 * This is the command that makes the governance model tangible: a low-risk
 * capability executes and returns data, a medium-risk one comes back
 * `pending_approval` with an approval id, and a high-risk or agent_forbidden one
 * is refused. No code, no database.
 */
export async function runInvoke(parsed: ParsedArgv): Promise<number> {
  const capability = parsed.positionals[0];
  const adaptersFlag = parsed.flags['--adapter'];

  if (!capability) {
    writeErr(
      `${symbols.fail} Missing <integration.capability>. Run ${pc.bold('tcpctl invoke --help')}.`,
    );
    return 1;
  }

  const adapterFiles =
    typeof adaptersFlag === 'string'
      ? adaptersFlag
          .split(',')
          .map((file) => file.trim())
          .filter(Boolean)
      : [];

  if (adapterFiles.length === 0) {
    writeErr(
      `${symbols.fail} --adapter is required so the kernel knows which integrations exist. ` +
        `Example: ${pc.bold('tcpctl invoke internal.set_priority --adapter adapters/builtin/internal.yaml')}`,
    );
    return 1;
  }

  const pretty = flagBoolean(parsed, '--pretty', true);

  let args: Record<string, unknown>;
  try {
    args = parseArgs(flagString(parsed, '--args', '{}'));
  } catch (error) {
    writeErr(`${symbols.fail} ${(error as Error).message}`);
    return 1;
  }

  const asAgent = (flagString(parsed, '--as', 'agent') ?? 'agent') !== 'human';

  const kernel = new Kernel({
    store: new MemoryStore(),
    requireHttps: false,
    // A local one-shot invocation should be able to reach whatever the adapter
    // points at; there is no demo sandbox to enforce here.
    outboundHostAllowlist: [],
  });

  await kernel.start();

  for (const file of adapterFiles) {
    try {
      const adapter = await loadAdapterFile(file);
      await kernel.registerAdapter(adapter, { enabled: true });
    } catch (error) {
      writeErr(`${symbols.fail} ${file}: ${(error as Error).message}`);
      return 1;
    }
  }

  const resolved = kernel.registry.resolve(capability);
  if (!resolved) {
    writeErr(
      `${symbols.fail} Capability "${capability}" is not registered by the given adapter(s).`,
    );
    const available = kernel.registry.listCapabilities().map((c) => c.fullName);
    if (available.length > 0) {
      writeErr(`${symbols.info} Available: ${available.join(', ')}`);
    }
    return 1;
  }

  if ('ambiguous' in resolved) {
    writeErr(
      `${symbols.fail} "${capability}" is ambiguous. Qualify it as one of: ` +
        resolved.ambiguous.map((c) => c.fullName).join(', '),
    );
    return 1;
  }

  const { capability: record } = resolved;

  const grantsFlag = flagString(parsed, '--grant');
  const grants = grantsFlag
    ? grantsFlag
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean)
    : [record.fullName];

  const actor: Actor = asAgent
    ? { id: 'agent_cli', name: 'cli-agent', type: 'AGENT', capabilities: grants }
    : { id: 'user_cli', name: 'cli-human', type: 'HUMAN', capabilities: [] };

  write(
    `${symbols.info} ${pc.bold(record.fullName)} ${pc.dim(`(${record.method} ${record.pathTemplate}, `)}${riskLabel(record.riskLevel)}${pc.dim(' risk)')}`,
  );
  write(`${symbols.info} Acting as ${pc.bold(actor.type)} "${actor.name}"`);
  write('');

  const result = await kernel.invoke(record.fullName, args, actor, { requestId: newId('req') });

  switch (result.status) {
    case 'executed':
      write(
        `${symbols.ok} ${pc.green('executed')} in ${result.latencyMs}ms (HTTP ${result.httpStatus})`,
      );
      if (result.sanitized) {
        write(
          `${symbols.warn} ${pc.yellow('Response was rewritten by the prompt-injection sanitiser:')} ` +
            result.injectionSignals.join(', '),
        );
      }
      write('');
      write(pretty ? JSON.stringify(result.data, null, 2) : JSON.stringify(result.data));
      break;

    case 'pending_approval':
      write(
        `${symbols.warn} ${pc.yellow('pending_approval')} — the risk gate enqueued this for a human.`,
      );
      write('');
      write(`  approvalId: ${pc.bold(result.approvalId)}`);
      write(`  riskLevel:  ${riskLabel(result.riskLevel)}`);
      write('');
      write(
        pc.dim(
          'Nothing was sent to the target API. A human must approve the exact payload before it executes.',
        ),
      );
      break;

    case 'denied':
      writeErr(`${symbols.fail} ${pc.red('denied')} — ${result.reason}`);
      break;

    case 'failed':
      writeErr(`${symbols.fail} ${pc.red('failed')} — ${result.error}`);
      break;
  }

  write('');
  write(`${pc.dim('auditId:')} ${result.auditId || '(none)'}`);

  return result.status === 'executed' || result.status === 'pending_approval' ? 0 : 1;
}
