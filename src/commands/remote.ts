/**
 * `gbrain remote` thin-client commands.
 *
 * Remote health inspection remains a bounded read through `run_doctor`.
 * Generic remote job submission is deliberately not a GBrain capability:
 * GBrain is evidence/memory, not a network command queue. The old `remote
 * ping` shortcut depended on the broad `submit_job` MCP operation and now
 * fails with one explicit host-side alternative.
 */

import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult, RemoteMcpError } from '../core/mcp-client.ts';
import type { DoctorReport, Check } from './doctor.ts';

export async function runRemote(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    process.exit(0);
  }

  if (sub === 'ping') {
    return rejectRemovedRemotePing(args.slice(1));
  }

  if (sub !== 'doctor') {
    console.error(`Unknown subcommand: gbrain remote ${sub}\n`);
    printHelp();
    process.exit(1);
  }

  const config = loadConfig();
  if (!isThinClient(config)) {
    console.error(
      '`gbrain remote doctor` requires thin-client mode. This install has no remote_mcp config.\n' +
      'Run `gbrain init --mcp-only` to set up thin-client mode, or use the local CLI directly.',
    );
    process.exit(1);
  }

  return runRemoteDoctorCli(config!, args.slice(1));
}

function printHelp(): void {
  console.log('Usage: gbrain remote <subcommand>');
  console.log('');
  console.log('Subcommands:');
  console.log('  doctor          Run bounded health checks on the remote host.');
  console.log('  ping            Removed: remote GBrain is not a command queue.');
  console.log('');
  console.log('Flags:');
  console.log('  --json          Emit structured JSON instead of human output.');
}

function rejectRemovedRemotePing(args: string[]): never {
  const message =
    '`gbrain remote ping` is unavailable because generic remote job submission is host-local. ' +
    'Run the reconciliation on the GBrain host through a supervised maintenance session.';
  if (args.includes('--json')) {
    console.log(JSON.stringify({ status: 'error', reason: 'host_local_only', message }));
  } else {
    console.error(message);
  }
  process.exit(1);
}

async function runRemoteDoctorCli(
  config: NonNullable<ReturnType<typeof loadConfig>>,
  args: string[],
): Promise<void> {
  const json = args.includes('--json');

  let report: DoctorReport;
  try {
    const res = await callRemoteTool(config, 'run_doctor', {});
    report = unpackToolResult<DoctorReport>(res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const reason = e instanceof RemoteMcpError ? e.reason : 'unknown';
    if (json) {
      console.log(JSON.stringify({ status: 'error', reason, message: msg }));
    } else {
      console.error(`Failed to run remote doctor: ${msg}`);
      if (reason === 'auth' || reason === 'auth_after_refresh') {
        console.error(
          'Hint: run_doctor requires admin scope. Re-register the client with `--scopes read,write,admin`.',
        );
      }
    }
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(report));
  } else {
    renderDoctorReport(report);
  }
  process.exit(report.status === 'unhealthy' ? 1 : 0);
}

function renderDoctorReport(report: DoctorReport): void {
  console.log('\nGBrain Health Check (remote host)');
  console.log('=================================');
  for (const c of report.checks) {
    const icon = c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${icon}] ${c.name}: ${c.message}`);
  }
  console.log(`\nHealth score: ${report.health_score}/100. Status: ${report.status}.`);
  if (report.status === 'unhealthy') {
    const fails = report.checks.filter((c: Check) => c.status === 'fail');
    if (fails.length > 0) {
      console.log('\nFailures:');
      for (const f of fails) console.log(`  - ${f.name}: ${f.message}`);
    }
  }
}
