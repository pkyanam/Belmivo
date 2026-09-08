import { performance } from 'node:perf_hooks';

export const PHOTON_TIMING_PHASES = ['sdkImportMs', 'initMs', 'spaceLookupMs', 'operationMs', 'shutdownMs'] as const;
export type PhotonTimingPhase = typeof PHOTON_TIMING_PHASES[number];
export type PhotonOperationKind = 'text' | 'media' | 'fetch' | 'typing-start' | 'typing-stop' | 'reaction' | 'rich';
export type PhotonTiming = Readonly<{
  operationKind: PhotonOperationKind;
  outcome: 'success' | 'failed' | 'uncertain';
  totalMs: number;
} & Partial<Record<PhotonTimingPhase, number>>>;
export type PhotonTimingObserver = (timing: PhotonTiming) => void | Promise<void>;

const MAX_MS = 120_000;
const milliseconds = (value: number): number => Math.min(MAX_MS, Math.max(0, Math.round(value)));

/** No provider output or identifiers enter this logger. Observability cannot fail an operation. */
export const logPhotonTiming: PhotonTimingObserver = timing => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event: 'photon-sdk-timing', ...timing }));
};

/** One bounded side-channel summary, independent of the worker's stdout result protocol. */
export function createPhotonTimingRecorder(operationKind: PhotonOperationKind, observer?: PhotonTimingObserver) {
  const start = performance.now();
  const phases: Partial<Record<PhotonTimingPhase, number>> = {};
  let buffered = '', bytes = 0, records = 0, stopped = false, finished = false;
  return {
    accept(chunk: Buffer): void {
      if (stopped || finished || !observer) return;
      bytes += chunk.length;
      if (bytes > 2048) { stopped = true; buffered = ''; return; }
      buffered += chunk.toString('utf8');
      for (;;) {
        const end = buffered.indexOf('\n');
        if (end < 0) { if (buffered.length > 256) { stopped = true; buffered = ''; } return; }
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (++records > PHOTON_TIMING_PHASES.length) { stopped = true; buffered = ''; return; }
        try {
          const value: unknown = JSON.parse(line);
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const record = value as Record<string, unknown>;
          if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'phase') || !Object.hasOwn(record, 'durationMs')) continue;
          if (!PHOTON_TIMING_PHASES.includes(record.phase as PhotonTimingPhase)) continue;
          if (typeof record.durationMs !== 'number' || !Number.isFinite(record.durationMs) || record.durationMs < 0 || record.durationMs > MAX_MS) continue;
          const phase = record.phase as PhotonTimingPhase;
          if (!Object.hasOwn(phases, phase)) phases[phase] = milliseconds(record.durationMs);
        } catch { /* Raw side-channel data is never logged. */ }
      }
    },
    finish(outcome: PhotonTiming['outcome']): void {
      if (finished) return;
      finished = true;
      if (!observer) return;
      try { void Promise.resolve(observer(Object.freeze({ operationKind, outcome, totalMs: milliseconds(performance.now() - start), ...phases }))).catch(() => {}); }
      catch { /* A metrics consumer must not affect provider acceptance. */ }
    },
  };
}
