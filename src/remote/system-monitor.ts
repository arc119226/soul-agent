import { cpus, freemem, totalmem, platform, arch, uptime as osUptime, hostname } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const execFileAsync = promisify(execFile);
const MODULE = 'system-monitor';

export interface SystemInfo {
  platform: string;
  arch: string;
  hostname: string;
  cpuCount: number;
  cpuModel: string;
  totalMem: number;
  freeMem: number;
  usedMem: number;
  memPercent: number;
  osUptime: number;
  nodeVersion: string;
}

export interface ProcessInfo {
  pid: number;
  uptime: number;
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
}

export interface DiskUsage {
  filesystem: string;
  total: string;
  used: string;
  free: string;
  percent: string;
  mount: string;
}

/** Get system information */
export function getSystemInfo(): Result<SystemInfo> {
  try {
    const cpuList = cpus();
    const totalMemBytes = totalmem();
    const freeMemBytes = freemem();

    const info: SystemInfo = {
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      cpuCount: cpuList.length,
      cpuModel: cpuList[0]?.model ?? 'unknown',
      totalMem: totalMemBytes,
      freeMem: freeMemBytes,
      usedMem: totalMemBytes - freeMemBytes,
      memPercent: ((totalMemBytes - freeMemBytes) / totalMemBytes) * 100,
      osUptime: osUptime(),
      nodeVersion: process.version,
    };

    return ok('System info retrieved', info);
  } catch (err) {
    logger.error(MODULE, 'Failed to get system info', err);
    return fail(`Failed to get system info: ${(err as Error).message}`);
  }
}

/** Get current process information */
export function getProcessInfo(): Result<ProcessInfo> {
  try {
    const mem = process.memoryUsage();
    const info: ProcessInfo = {
      pid: process.pid,
      uptime: process.uptime(),
      memoryUsage: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
      },
    };

    return ok('Process info retrieved', info);
  } catch (err) {
    logger.error(MODULE, 'Failed to get process info', err);
    return fail(`Failed to get process info: ${(err as Error).message}`);
  }
}

/** Get disk usage */
export async function getDiskUsage(path: string = '/'): Promise<Result<DiskUsage[]>> {
  try {
    const { stdout } = await execFileAsync('df', ['-h', path], { timeout: 5000 });
    const lines = stdout.trim().split('\n');

    const disks: DiskUsage[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i]!.split(/\s+/);
      if (parts.length >= 6) {
        disks.push({
          filesystem: parts[0]!,
          total: parts[1]!,
          used: parts[2]!,
          free: parts[3]!,
          percent: parts[4]!,
          mount: parts[5]!,
        });
      }
    }

    return ok('Disk usage retrieved', disks);
  } catch (err) {
    logger.error(MODULE, 'Failed to get disk usage', err);
    return fail(`Failed to get disk usage: ${(err as Error).message}`);
  }
}

/** Format system info as a readable Telegram message */
export function formatSystemInfo(info: SystemInfo): string {
  const memTotal = formatBytes(info.totalMem);
  const memUsed = formatBytes(info.usedMem);
  const memFree = formatBytes(info.freeMem);
  const uptimeStr = formatUptime(info.osUptime);

  return [
    '*System Information*',
    '',
    `*Host:* ${info.hostname}`,
    `*Platform:* ${info.platform} (${info.arch})`,
    `*CPU:* ${info.cpuModel}`,
    `*Cores:* ${info.cpuCount}`,
    `*Memory:* ${memUsed} / ${memTotal} (${info.memPercent.toFixed(1)}%)`,
    `*Free Memory:* ${memFree}`,
    `*OS Uptime:* ${uptimeStr}`,
    `*Node.js:* ${info.nodeVersion}`,
  ].join('\n');
}

/** Format process info as a readable Telegram message */
export function formatProcessInfo(info: ProcessInfo): string {
  const mem = info.memoryUsage;
  return [
    '*Bot Process*',
    '',
    `*PID:* ${info.pid}`,
    `*Uptime:* ${formatUptime(info.uptime)}`,
    `*RSS:* ${formatBytes(mem.rss)}`,
    `*Heap:* ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`,
    `*External:* ${formatBytes(mem.external)}`,
  ].join('\n');
}

/** Format disk usage as a readable Telegram message */
export function formatDiskUsage(disks: DiskUsage[]): string {
  const lines = ['*Disk Usage*', ''];
  for (const disk of disks) {
    lines.push(`\`${disk.mount}\`: ${disk.used} / ${disk.total} (${disk.percent})`);
  }
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}
