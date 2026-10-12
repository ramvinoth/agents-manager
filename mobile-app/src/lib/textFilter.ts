/** Case-insensitive substring search over a row's text fields — the one filter
 *  behind every searchable catalog list (plugins, skills, MCP tools). A blank
 *  query keeps every row. */
export function textFilter<T>(rows: T[], query: string, fields: (row: T) => (string | undefined)[]): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((row) => fields(row).some((f) => f?.toLowerCase().includes(q)))
}
