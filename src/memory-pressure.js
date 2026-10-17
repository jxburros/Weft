import { readFile } from 'node:fs/promises';
import os from 'node:os';

/**
 * System memory-pressure signal for tab suspension (#30, ADR 015). Combined with the person's optional
 * renderer budget: a budget suspends least recently used tabs until page renderers fit it; this signal
 * suspends a few idle background tabs while the operating system itself is short of memory.
 *
 * What each platform offers cheaply (no native module, no child process):
 * - Linux: kernel pressure-stall information in /proc/pressure/memory (kernel 4.20+ with PSI enabled):
 *   the share of the last 10 s in which some ("some") or all ("full") tasks stalled on memory. Available
 *   memory comes from os.freemem() (MemAvailable). Without PSI only available memory is used.
 * - Windows: os.freemem() is available physical memory; only its fraction is used.
 * - macOS: os.freemem() counts free pages only (not inactive, purgeable or compressible memory), so it
 *   understates what is available. Only a very low free fraction counts, and only as "moderate"; the
 *   kernel's own pressure level (memory_pressure, DISPATCH_SOURCE_TYPE_MEMORYPRESSURE) is not read.
 * - Electron's process.getSystemMemoryInfo() is a fallback when os reports nothing; its "free" excludes
 *   disk cache, so it is treated like the macOS free-page figure.
 */
export const PRESSURE_THRESHOLDS = Object.freeze({ psiSomeModerate: 10, psiSomeCritical: 40, psiFullCritical: 10, availableModerate: 0.10, availableCritical: 0.05, freePagesModerate: 0.02 });
const LEVELS = ['normal', 'moderate', 'critical'];
const higher = (a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a);

/** Parse /proc/pressure/memory ("some avg10=1.23 avg60=… avg300=… total=…" and a "full" line). */
export function parsePsi(text) {
  const result = {};
  for (const line of String(text).split('\n')) {
    const match = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)/.exec(line.trim());
    if (match) result[match[1]] = { avg10: Number(match[2]), avg60: Number(match[3]), avg300: Number(match[4]) };
  }
  if (!result.some) throw new Error('No memory pressure-stall data');
  return result;
}

/** Pressure level from the measurements a platform provides; `reasons` names what triggered it. */
export function classifyPressure({ psi = null, availableBytes = null, totalBytes = null, availableIsFreePages = false } = {}) {
  let level = 'normal';
  const reasons = [];
  const t = PRESSURE_THRESHOLDS;
  if (psi) {
    if ((psi.full?.avg10 ?? 0) >= t.psiFullCritical || psi.some.avg10 >= t.psiSomeCritical) { level = 'critical'; reasons.push('psi'); }
    else if (psi.some.avg10 >= t.psiSomeModerate) { level = higher(level, 'moderate'); reasons.push('psi'); }
  }
  if (Number.isFinite(availableBytes) && Number.isFinite(totalBytes) && totalBytes > 0) {
    const fraction = availableBytes / totalBytes;
    if (availableIsFreePages) { if (fraction < t.freePagesModerate) { level = higher(level, 'moderate'); reasons.push('free_pages'); } }
    else if (fraction < t.availableCritical) { level = 'critical'; reasons.push('available_memory'); }
    else if (fraction < t.availableModerate) { level = higher(level, 'moderate'); reasons.push('available_memory'); }
  }
  return { level, reasons };
}

/**
 * An async sampler `() => signal`. Every source is injectable for tests. A failed or missing source
 * degrades to the next one; with nothing usable the signal reports `available: false` and level normal.
 */
export function createMemoryPressureSource({ platform = process.platform, readPsi = () => readFile('/proc/pressure/memory', 'utf8'), freemem = os.freemem, totalmem = os.totalmem,
  systemMemoryInfo = typeof process.getSystemMemoryInfo === 'function' ? () => process.getSystemMemoryInfo() : null } = {}) {
  let psiSupported = platform === 'linux';
  return async function sample() {
    let psi = null;
    if (psiSupported) { try { psi = parsePsi(await readPsi()); } catch { psiSupported = false; } }
    let availableBytes = null;
    let totalBytes = null;
    let availableIsFreePages = platform === 'darwin';
    let memorySource = null;
    try { availableBytes = Number(freemem()); totalBytes = Number(totalmem()); memorySource = platform === 'darwin' ? 'os_free_pages' : 'os_available_memory'; } catch { /* next source */ }
    if (!(totalBytes > 0) && systemMemoryInfo) {
      try { const info = systemMemoryInfo(); availableBytes = Number(info.free) * 1024; totalBytes = Number(info.total) * 1024; availableIsFreePages = true; memorySource = 'electron_free_memory'; } catch { /* none */ }
    }
    if (!(totalBytes > 0)) { availableBytes = null; totalBytes = null; memorySource = null; }
    const { level, reasons } = classifyPressure({ psi, availableBytes, totalBytes, availableIsFreePages });
    return { available: Boolean(psi || memorySource), platform, level, reasons, sources: [...(psi ? ['linux_psi'] : []), ...(memorySource ? [memorySource] : [])],
      ...(totalBytes ? { availableMb: Math.round(availableBytes / 1048576), totalMb: Math.round(totalBytes / 1048576) } : {}),
      ...(psi ? { psi: { someAvg10: psi.some.avg10, fullAvg10: psi.full?.avg10 ?? null } } : {}), at: new Date().toISOString() };
  };
}
