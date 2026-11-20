/**
 * CSV parse / stringify with the real rules: quoted fields may contain
 * commas, newlines and escaped double-quotes (`""`); CRLF and LF line
 * endings are both accepted; stringify quotes only when a field needs it.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  let rowHasContent = false;

  const endField = (): void => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    rowHasContent = false;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      rowHasContent = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      rowHasContent = true;
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Treat CRLF (and a lone CR) as one row terminator.
      endRow();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    fieldStarted = true;
    rowHasContent = true;
    i += 1;
  }
  // Flush a final unterminated row, but never invent an empty row after a
  // trailing newline.
  if (rowHasContent || fieldStarted || row.length > 0) {
    endRow();
  }
  return rows;
}

/** Convert parsed rows to objects, using the first row as the header. */
export function rowsToObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const header = rows[0] as string[];
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    header.forEach((name, index) => {
      obj[name] = row[index] ?? '';
    });
    return obj;
  });
}

function escapeField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Serialize rows to CSV (CRLF row endings, minimal quoting). */
export function stringifyCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(escapeField).join(',')).join('\r\n');
}
