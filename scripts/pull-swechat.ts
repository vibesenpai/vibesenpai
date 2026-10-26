/**
 * Dev-only: pull SWE-chat's per-turn annotations (label columns only, ~70 MB of a 6 GB
 * Parquet file, via byte ranges). Parquet as a dev-only dependency: see docs/eval.md.
 * Needs a HuggingFace token at ~/.cache/huggingface/token.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';

/** Pinned so a re-run reads the same rows. `--update` is a deliberate act. */
const REVISION = '202b071f18e03c79df5a7287565ce2ebc5ee7756';
const DATASET = 'SALT-NLP/SWE-chat';

/** Every column we need and no more: each column per row group is a separate request. */
const LABEL_COLUMNS = [
  'session_id',
  'turn_number',
  'turn_type',
  'role',
  'prompt_pushback',
  'prompt_intent',
  'category',
  'bash_category',
  'queue_op_subtype',
  'tool_name',
] as const;

/** Throttled, retrying fetch: HuggingFace allows 3,000 requests per 300s and hyparquet does not retry a 429. */
function installThrottledFetch(perSecond = 9): void {
  const real = globalThis.fetch;
  const minGap = 1000 / perSecond;
  let last = 0;

  // Typed off the real `fetch`: `RequestInfo` needs the DOM lib, which is not loaded.
  globalThis.fetch = async (
    input: Parameters<typeof real>[0],
    init?: Parameters<typeof real>[1],
  ): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, last + minGap - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();

      let res: Response;
      try {
        res = await real(input, init);
      } catch (err) {
        if (attempt >= 6) throw err;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      if (res.status !== 429 && res.status < 500) return res;
      if (attempt >= 6) return res;
      // Honour Retry-After when offered; otherwise back off exponentially.
      const retryAfter = Number(res.headers.get('retry-after') ?? '0');
      const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 3000 * 2 ** attempt);
      process.stdout.write(`  rate limited, waiting ${(delay / 1000).toFixed(0)}s\n`);
      await new Promise((r) => setTimeout(r, delay));
    }
  };
}

type Row = Record<string, unknown>;

function token(): string {
  const p = join(process.env['HOME'] ?? '', '.cache/huggingface/token');
  if (!existsSync(p)) {
    throw new Error(
      'No HuggingFace token at ~/.cache/huggingface/token.\n' +
        `Accept the terms at https://huggingface.co/datasets/${DATASET} (the gate is\n` +
        'auto-approve), then run `huggingface-cli login`.',
    );
  }
  return readFileSync(p, 'utf8').trim();
}

/**
 * The canonical parquet URL on `refs/convert/parquet`. Not `/api/datasets/.../parquet/...`,
 * whose redirect started answering range requests with 400 mid-scan.
 */
function parquetUrl(config: string): string {
  return `https://huggingface.co/datasets/${DATASET}/resolve/refs%2Fconvert%2Fparquet/${config}/train/0000.parquet`;
}

export type PullOptions = { outDir: string; limitRows?: number };

/** Stream the label columns to JSONL, one row group at a time, to keep memory flat. */
export async function pullTurnLabels(opts: PullOptions): Promise<number> {
  installThrottledFetch();
  const auth = { headers: { Authorization: `Bearer ${token()}` } };
  const file = await asyncBufferFromUrl({ url: parquetUrl('conversations'), requestInit: auth });
  const metadata = await parquetMetadataAsync(file);

  const totalRows = Number(metadata.num_rows);
  const cap = opts.limitRows ?? totalRows;
  mkdirSync(opts.outDir, { recursive: true });
  const out = join(opts.outDir, 'turn-labels.jsonl');
  writeFileSync(out, '');

  // Row-group boundaries, so each read is one contiguous range per column.
  const bounds: number[] = [0];
  for (const rg of metadata.row_groups) {
    bounds.push((bounds.at(-1) as number) + Number(rg.num_rows));
  }

  // Counts stay in memory; only rows needed for a per-session join are written.
  const tally = new Map<string, Map<string, number>>();
  const bump = (col: string, value: unknown): void => {
    if (value == null || value === '') return;
    const m = tally.get(col) ?? new Map<string, number>();
    const k = String(value);
    m.set(k, (m.get(k) ?? 0) + 1);
    tally.set(col, m);
  };

  let written = 0;
  const chunks: string[] = [];
  for (let g = 0; g < metadata.row_groups.length && written < cap; g++) {
    const rowStart = bounds[g] as number;
    const rowEnd = Math.min(bounds[g + 1] as number, cap);
    if (rowEnd <= rowStart) continue;

    const rows = (await parquetReadObjects({
      file,
      metadata,
      columns: [...LABEL_COLUMNS],
      rowStart,
      rowEnd,
    })) as Row[];

    for (const r of rows) {
      for (const col of ['turn_type', 'role', 'prompt_pushback', 'prompt_intent', 'category',
        'bash_category', 'queue_op_subtype', 'tool_name'] as const) {
        bump(col, r[col]);
      }
      // Everything is counted, but only annotated prompt turns are written.
      if (r['prompt_pushback'] == null && r['prompt_intent'] == null) continue;
      chunks.push(JSON.stringify(r, bigIntSafe));
    }
    written = rowEnd;

    if (chunks.length > 50_000) {
      appendChunk(out, chunks);
      chunks.length = 0;
    }
    if (g % 25 === 0) {
      const pct = ((g / metadata.row_groups.length) * 100).toFixed(0);
      process.stdout.write(`  row group ${g}/${metadata.row_groups.length} (${pct}%, ${written} rows scanned)\n`);
    }
  }
  if (chunks.length > 0) appendChunk(out, chunks);

  const counts: Record<string, Record<string, number>> = {};
  for (const [col, m] of tally) {
    counts[col] = Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
  }
  writeFileSync(
    join(opts.outDir, 'turn-counts.json'),
    `${JSON.stringify({ dataset: DATASET, revision: REVISION, rowsScanned: written, counts }, null, 2)}\n`,
  );

  return written;
}

/** Int64 columns arrive as `BigInt`; these values are far below 2^53, so Number is safe. */
function bigIntSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}

function appendChunk(path: string, lines: string[]): void {
  appendFileSync(path, `${lines.join('\n')}\n`);
}

if (import.meta.filename === process.argv[1]) {
  const mode = process.argv[2];
  if (mode === 'labels') {
    const outDir = process.argv[3] ?? '/tmp/swechat-labels';
    const limit = process.argv[4] !== undefined ? Number(process.argv[4]) : undefined;
    console.log(`pulling turn labels (revision ${REVISION.slice(0, 8)}) -> ${outDir}`);
    const n = await pullTurnLabels({ outDir, ...(limit !== undefined ? { limitRows: limit } : {}) });
    console.log(`done: scanned ${n} rows`);
  } else if (mode === 'transcripts') {
    const listFile = process.argv[3];
    const outDir = process.argv[4];
    if (listFile === undefined || outDir === undefined) {
      console.error('usage: pull-swechat.ts transcripts <list-file> <out-dir>');
      process.exit(1);
    }
    const paths = readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    console.log(`fetching ${paths.length} transcripts @ ${REVISION.slice(0, 8)} -> ${outDir}`);
    const r = await pullTranscripts(paths, outDir);
    console.log(`done: ${r.ok} ok, ${r.failed} failed, ${(r.bytes / 1048576).toFixed(0)} MB`);
  } else {
    console.error('usage: pull-swechat.ts <labels|transcripts> ...');
    process.exit(1);
  }
}

/** Fetch a pinned list of transcripts at a pinned revision to a scratch dir; never vendored. */
export async function pullTranscripts(
  paths: string[],
  outDir: string,
  concurrency = 8,
): Promise<{ ok: number; failed: number; bytes: number }> {
  const auth = { Authorization: `Bearer ${token()}` };
  mkdirSync(outDir, { recursive: true });

  let ok = 0;
  let failed = 0;
  let bytes = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= paths.length) return;
      const path = paths[i] as string;
      const name = path.split('/').pop() as string;
      const dest = join(outDir, name);
      if (existsSync(dest)) { ok++; continue; }

      const url = `https://huggingface.co/datasets/${DATASET}/resolve/${REVISION}/${path}`;
      try {
        const res = await fetch(url, { headers: auth });
        if (!res.ok) { failed++; continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(dest, buf);
        bytes += buf.byteLength;
        ok++;
      } catch {
        failed++;
      }
      if ((ok + failed) % 100 === 0) {
        process.stdout.write(`  ${ok + failed}/${paths.length} (${(bytes / 1048576).toFixed(0)} MB)\n`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { ok, failed, bytes };
}
