import { query, withTransaction } from "./postgres-db.js";

function toPgSql(sql) {
  let index = 0;
  return String(sql).replace(/\?/g, () => `$${++index}`);
}

function makeExecutor(runQuery) {
  return {
    async exec(sql) {
      await runQuery(sql, []);
    },
    prepare(sql) {
      const pgSql = toPgSql(sql);
      return {
        async get(...params) {
          const res = await runQuery(pgSql, params);
          return res.rows[0] ?? null;
        },
        async all(...params) {
          const res = await runQuery(pgSql, params);
          return res.rows;
        },
        async run(...params) {
          const res = await runQuery(pgSql, params);
          return { changes: res.rowCount ?? 0, rows: res.rows };
        },
      };
    },
  };
}

export function createPgAdapter() {
  const base = makeExecutor((text, params) => query(text, params));

  return {
    ...base,
    transaction(fn) {
      return async (...args) =>
        withTransaction(async (client) => {
          const txDb = {
            ...makeExecutor((text, params) => client.query(text, params)),
            transaction: () => {
              throw new Error("Nested transactions are not supported.");
            },
          };
          return fn(txDb, ...args);
        });
    },
  };
}