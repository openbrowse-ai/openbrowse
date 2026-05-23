import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface SheetViewerProps {
  blob: Blob;
  fileName: string;
  className?: string;
}

interface SheetData {
  /** Sheet name (e.g. "Sheet1"). For CSV this is just "Sheet". */
  name: string;
  /** Rows including the (presumed) header. Cells are pre-formatted strings. */
  rows: string[][];
}

interface ParsedWorkbook {
  sheets: SheetData[];
  /** True when at least one row was truncated to MAX_PARSED_ROWS. */
  truncated: boolean;
  /** Total row count before truncation, summed across all sheets. */
  totalRows: number;
}

/** Soft caps to keep parsing + DOM rendering snappy. */
const MAX_BLOB_BYTES_CSV = 10 * 1024 * 1024; // 10 MB
const MAX_BLOB_BYTES_XLSX = 25 * 1024 * 1024; // 25 MB
/** Render at most this many rows per sheet by default (excluding header). */
const DEFAULT_ROW_LIMIT = 1000;
/** Render at most this many columns. */
const COLUMN_LIMIT = 50;

function isCsvLike(fileName: string): boolean {
  return /\.(csv|tsv)$/i.test(fileName);
}

function isTsv(fileName: string): boolean {
  return /\.tsv$/i.test(fileName);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function parseCsv(blob: Blob, fileName: string): Promise<ParsedWorkbook> {
  const Papa = (await import("papaparse")).default;
  const text = await blob.text();
  const result = Papa.parse<string[]>(text, {
    delimiter: isTsv(fileName) ? "\t" : "", // empty = auto-detect
    skipEmptyLines: "greedy",
  });
  // Coerce all cells to string. Papa returns strings already when no header
  // mode is used, but defensive coercion keeps types simple.
  const rows = result.data.map((row) =>
    Array.isArray(row) ? row.map((cell) => (cell == null ? "" : String(cell))) : [],
  );
  return {
    sheets: [{ name: "Sheet", rows }],
    truncated: false,
    totalRows: rows.length,
  };
}

async function parseXlsx(blob: Blob): Promise<ParsedWorkbook> {
  const XLSX = await import("xlsx");
  const buf = await blob.arrayBuffer();
  // `cellDates: true` returns JS Dates so we can format consistently.
  // `raw: false` on sheet_to_json then preserves the cell's number-format
  // string for numbers/dates.
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheets: SheetData[] = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const arr = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false,
    });
    const rows = arr.map((row) =>
      Array.isArray(row) ? row.map((cell) => (cell == null ? "" : String(cell))) : [],
    );
    return { name, rows };
  });
  const totalRows = sheets.reduce((acc, s) => acc + s.rows.length, 0);
  return { sheets, truncated: false, totalRows };
}

export function SheetViewer({ blob, fileName, className }: SheetViewerProps) {
  const csv = useMemo(() => isCsvLike(fileName), [fileName]);
  const sizeCap = csv ? MAX_BLOB_BYTES_CSV : MAX_BLOB_BYTES_XLSX;
  const oversize = blob.size > sizeCap;

  const [forceLoad, setForceLoad] = useState(false);
  const [data, setData] = useState<ParsedWorkbook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (oversize && !forceLoad) return;
    let cancelled = false;
    setData(null);
    setError(null);
    setActiveSheet(0);
    setShowAll(false);
    (async () => {
      try {
        const parsed = csv ? await parseCsv(blob, fileName) : await parseXlsx(blob);
        if (!cancelled) setData(parsed);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob, fileName, csv, oversize, forceLoad]);

  if (oversize && !forceLoad) {
    return (
      <div className={cn("flex flex-col items-center justify-center p-10 gap-3 text-center", className)}>
        <span className="text-sm text-muted-foreground">
          File is large ({formatBytes(blob.size)}) — preview may be slow.
        </span>
        <Button size="sm" variant="secondary" onClick={() => setForceLoad(true)}>
          Open anyway
        </Button>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("p-6 text-destructive text-sm", className)}>
        Failed to parse spreadsheet: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className={cn("p-6 text-muted-foreground text-sm", className)}>
        Parsing…
      </div>
    );
  }

  const sheet = data.sheets[activeSheet] ?? data.sheets[0];
  if (!sheet) {
    return (
      <div className={cn("p-6 text-muted-foreground text-sm", className)}>
        Empty workbook.
      </div>
    );
  }

  const allRows = sheet.rows;
  // First row used as header (Excel + most CSVs). If sheet has a single row,
  // treat it as data with no header.
  const hasHeader = allRows.length > 1;
  const header = hasHeader ? allRows[0] : null;
  const body = hasHeader ? allRows.slice(1) : allRows;

  const rowLimit = showAll ? body.length : Math.min(body.length, DEFAULT_ROW_LIMIT);
  const visibleBody = body.slice(0, rowLimit);
  const truncatedRows = body.length - rowLimit;

  // Column count: max across visible rows + header (capped).
  const widestRow = Math.max(
    header?.length ?? 0,
    ...visibleBody.map((r) => r.length),
    0,
  );
  const colCount = Math.min(widestRow, COLUMN_LIMIT);
  const truncatedCols = widestRow - colCount;

  return (
    <div className={cn("flex flex-col h-full min-h-0", className)}>
      {data.sheets.length > 1 && (
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-muted/20 overflow-x-auto shrink-0">
          {data.sheets.map((s, i) => (
            <button
              key={`${s.name}-${i}`}
              type="button"
              onClick={() => {
                setActiveSheet(i);
                setShowAll(false);
              }}
              className={cn(
                "px-2.5 py-1 text-xs rounded-md font-mono whitespace-nowrap transition-colors",
                i === activeSheet
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/60",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="text-xs font-mono border-collapse w-max">
          {header && (
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th className="sticky left-0 z-20 bg-muted text-muted-foreground/60 border-b border-r border-border px-2 py-1.5 text-right select-none w-10">
                  {/* row-index gutter header */}
                </th>
                {header.slice(0, colCount).map((cell, ci) => (
                  <th
                    key={ci}
                    className="border-b border-r border-border px-2 py-1.5 text-left font-semibold text-foreground/90 align-top max-w-[24rem] truncate"
                    title={cell}
                  >
                    {cell || <span className="text-muted-foreground/50">—</span>}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {visibleBody.map((row, ri) => (
              <tr key={ri} className="even:bg-muted/20">
                <td className="sticky left-0 bg-inherit text-muted-foreground/60 border-b border-r border-border px-2 py-1 text-right select-none w-10">
                  {hasHeader ? ri + 2 : ri + 1}
                </td>
                {Array.from({ length: colCount }).map((_, ci) => {
                  const cell = row[ci] ?? "";
                  return (
                    <td
                      key={ci}
                      className="border-b border-r border-border px-2 py-1 align-top max-w-[24rem] truncate text-foreground/90"
                      title={cell}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(truncatedRows > 0 || truncatedCols > 0) && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-border bg-muted/20 text-xs text-muted-foreground shrink-0">
          <span>
            Showing {visibleBody.length.toLocaleString()} of{" "}
            {body.length.toLocaleString()} row{body.length === 1 ? "" : "s"}
            {truncatedCols > 0 && `, ${colCount} of ${widestRow} columns`}.
          </span>
          {truncatedRows > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setShowAll(true)}
            >
              Show all rows
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
