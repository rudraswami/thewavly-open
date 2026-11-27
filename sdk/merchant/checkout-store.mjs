// Use a merchant-owned SQLite database (node:sqlite DatabaseSync or better-sqlite3).
// One database per gateway account/environment. These records contain private release capabilities.
export function sqliteCheckoutStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS wavly_gateway_checkouts (
    gateway TEXT NOT NULL, order_id TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY (gateway, order_id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS wavly_gateway_reference ON wavly_gateway_checkouts(gateway, json_extract(record, '$.gateway_reference'))");
  const byReference = db.prepare("SELECT order_id FROM wavly_gateway_checkouts WHERE gateway=? AND json_extract(record, '$.gateway_reference')=?");
  const get = db.prepare("SELECT record FROM wavly_gateway_checkouts WHERE gateway=? AND order_id=?");
  const insert = db.prepare("INSERT INTO wavly_gateway_checkouts VALUES (?,?,?,?) ON CONFLICT(gateway,order_id) DO NOTHING");
  const update = db.prepare("UPDATE wavly_gateway_checkouts SET state=?, record=? WHERE gateway=? AND order_id=? AND state=?");
  const pending = db.prepare("SELECT order_id FROM wavly_gateway_checkouts WHERE gateway=? AND state IN ('redeeming','submitted','awaiting_finality','payment_seen','release_pending') AND order_id>? ORDER BY order_id LIMIT ?");
  return {
    get(gateway, orderId) {
      const row = get.get(gateway, orderId);
      return row ? JSON.parse(row.record) : null;
    },
    insert(record) {
      return insert.run(record.gateway, record.order_id, record.state, JSON.stringify(record)).changes === 1;
    },
    transition(expected, record) {
      return update.run(record.state, JSON.stringify(record), record.gateway, record.order_id, expected).changes === 1;
    },
    orderIdForReference(gateway, reference) { return byReference.get(gateway, reference)?.order_id ?? null; },
    pending(gateway, { after = "", limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit must be between 1 and 1000");
      return pending.all(gateway, after, limit).map(row => row.order_id);
    },
  };
}
