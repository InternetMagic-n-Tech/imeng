import type { ToolDef } from "./index.js";
import { stateDb } from "../utils/db-state.js";
import { PII_MASK } from "../utils/pii.js";

/**
 * Read-only questions to the bookkeeping database. The model never writes SQL: it names a table, columns, filters and an order, and this builds
 * the query. Only the tables and columns config.json lists (`tools.db.tables`) can be read; only listed `filter` columns can be searched; `pii`
 * columns come back masked. Rows and time are capped. Rows past their `expires_at` are never returned.
 */
const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "like", "in"] as const;
const SQL: Record<string, string> = { eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", in: "in" };

interface TableOpt { columns?: string[]; filter?: string[]; pii?: string[] }

const tool: ToolDef = {
  name: "db",
  description: "Ask the game's database a read-only question. action select (rows) or count. Give table, columns (select), where [{column, op eq|ne|gt|gte|lt|lte|like|in, value}], order_by {column, dir asc|desc}, limit.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["select", "count"] },
      table: { type: "string" },
      columns: { type: "array", items: { type: "string" } },
      where: { type: "array", items: { type: "object", properties: { column: { type: "string" }, op: { type: "string", enum: [...OPS] }, value: {} }, required: ["column", "op", "value"] } },
      order_by: { type: "object", properties: { column: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } }, required: ["column"] },
      limit: { type: "number" },
    },
    required: ["action", "table"],
  },
  async run(args, ctx) {
    const db = stateDb();
    if (!db) return { error: "no database" };
    const tables = (ctx.options.tables ?? {}) as Record<string, TableOpt>;
    const t = tables[String(args?.table)];
    if (!t) return { error: `table not allowed; allowed: ${Object.keys(tables).join(", ") || "none"}` };
    const cols = t.columns ?? [];
    const filter = t.filter ?? cols;
    const maxRows = Math.min(100, Math.max(1, Number(ctx.options.max_rows) || 20));
    const timeout = Math.max(100, Number(ctx.options.timeout_ms) || 2000);
    try {
      const picked = (Array.isArray(args.columns) && args.columns.length ? args.columns : cols) as string[];
      const bad = picked.find((c) => !cols.includes(c));
      if (bad) return { error: `column "${bad}" not allowed; allowed: ${cols.join(", ")}` };
      let q: any = db.selectFrom(args.table);
      const has = (await db.introspection.getTables()).find((x) => x.name === args.table)?.columns.some((c) => c.name === "expires_at");
      if (has) q = q.where("expires_at", ">", Date.now());
      for (const w of (Array.isArray(args.where) ? args.where : []) as { column: string; op: string; value: unknown }[]) {
        if (!filter.includes(w.column)) return { error: `cannot filter on "${w.column}"; allowed: ${filter.join(", ")}` };
        if (!OPS.includes(w.op as never)) return { error: `op must be one of ${OPS.join(", ")}` };
        if (w.op === "in" ? !Array.isArray(w.value) || w.value.length > 50 : typeof w.value === "object") return { error: `bad value for ${w.column}` };
        q = q.where(w.column, SQL[w.op], w.value);
      }
      const run = async (): Promise<unknown> => {
        if (args.action === "count") return { count: Number((await q.select((e: any) => e.fn.countAll().as("n")).executeTakeFirst())?.n ?? 0) };
        if (args.order_by) {
          if (!cols.includes(args.order_by.column)) return { error: `cannot order by "${args.order_by.column}"` };
          q = q.orderBy(args.order_by.column, args.order_by.dir === "desc" ? "desc" : "asc");
        }
        const rows = (await q.select(picked).limit(Math.min(maxRows, Math.max(1, Number(args.limit) || maxRows))).execute()) as Record<string, unknown>[];
        const mask = new Set(t.pii ?? []);
        return { rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, mask.has(k) && v !== null && v !== "" ? PII_MASK : v]))), max_rows: maxRows };
      };
      let timer: NodeJS.Timeout | undefined;
      try { return await Promise.race([run(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("the query took too long")), timeout); })]); } finally { clearTimeout(timer); }
    } catch (e) { return { error: (e as Error).message }; }
  },
};
export default tool;
