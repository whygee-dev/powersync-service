import * as lib_postgres from '@powersync/lib-service-postgres';
import {
  container,
  DatabaseConnectionError,
  ErrorCode,
  errors,
  logger,
  ReplicationAbortedError,
  ReplicationAssertionError
} from '@powersync/lib-services-framework';
import { getUuidReplicaIdentityBson, MetricsEngine, SourceEntityDescriptor, storage } from '@powersync/service-core';
import * as pgwire from '@powersync/service-jpgwire';
import { DatabaseInputRow, SqliteRow, SqlSyncRules, TablePattern, toSyncRulesRow } from '@powersync/service-sync-rules';
import * as pg_utils from '../utils/pgwire_utils.js';

import { PgManager } from './PgManager.js';
import { getPgOutputRelation, getRelId } from './PgRelation.js';
import { checkSourceConfiguration, getReplicationIdentityColumns } from './replication-utils.js';
import { ReplicationMetric } from '@powersync/service-types';

export interface WalStreamOptions {
  connections: PgManager;
  storage: storage.SyncRulesBucketStorage;
  metrics: MetricsEngine;
  abort_signal: AbortSignal;
}

interface InitResult {
  /** True if initial snapshot is not yet done. */
  needsInitialSync: boolean;
  /** True if snapshot must be started from scratch with a new slot. */
  needsNewSlot: boolean;
}

export const ZERO_LSN = '00000000/00000000';
export const PUBLICATION_NAME = 'powersync';
export const POSTGRES_DEFAULT_SCHEMA = 'public';

export const KEEPALIVE_CONTENT = 'ping';
export const KEEPALIVE_BUFFER = Buffer.from(KEEPALIVE_CONTENT);
export const KEEPALIVE_STATEMENT: pgwire.Statement = {
  statement: /* sql */ `
    SELECT
      *
    FROM
      pg_logical_emit_message(FALSE, 'powersync', $1)
  `,
  params: [{ type: 'varchar', value: KEEPALIVE_CONTENT }]
} as const;

export const isKeepAliveMessage = (msg: pgwire.PgoutputMessage) => {
  return (
    msg.tag == 'message' &&
    msg.prefix == 'powersync' &&
    msg.content &&
    Buffer.from(msg.content).equals(KEEPALIVE_BUFFER)
  );
};

export const sendKeepAlive = async (db: pgwire.PgClient) => {
  await lib_postgres.retriedQuery(db, KEEPALIVE_STATEMENT);
};

export class MissingReplicationSlotError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class WalStream {
  sync_rules: SqlSyncRules;
  group_id: number;

  connection_id = 1;

  private readonly storage: storage.SyncRulesBucketStorage;
  private readonly metrics: MetricsEngine;
  private readonly slot_name: string;

  private connections: PgManager;

  private abort_signal: AbortSignal;

  private relation_cache = new Map<string | number, storage.SourceTable>();

  private startedStreaming = false;

  /**
   * Time of the oldest uncommitted change, according to the source db.
   * This is used to determine the replication lag.
   */
  private oldestUncommittedChange: Date | null = null;
  /**
   * Keep track of whether we have done a commit or keepalive yet.
   * We can only compute replication lag if isStartingReplication == false, or oldestUncommittedChange is present.
   */
  private isStartingReplication = true;

  constructor(options: WalStreamOptions) {
    this.storage = options.storage;
    this.metrics = options.metrics;
    this.sync_rules = options.storage.getParsedSyncRules({ defaultSchema: POSTGRES_DEFAULT_SCHEMA });
    this.group_id = options.storage.group_id;
    this.slot_name = options.storage.slot_name;
    this.connections = options.connections;

    this.abort_signal = options.abort_signal;
    this.abort_signal.addEventListener(
      'abort',
      () => {
        if (this.startedStreaming) {
          // Ping to speed up cancellation of streaming replication
          // We're not using pg_snapshot here, since it could be in the middle of
          // an initial replication transaction.
          const promise = sendKeepAlive(this.connections.pool);
          promise.catch((e) => {
            // Failures here are okay - this only speeds up stopping the process.
            logger.warn('Failed to ping connection', e);
          });
        } else {
          // If we haven't started streaming yet, it could be due to something like
          // and invalid password. In that case, don't attempt to ping.
        }
      },
      { once: true }
    );
  }

  get stopped() {
    return this.abort_signal.aborted;
  }

  async getQualifiedTableNames(
    batch: storage.BucketStorageBatch,
    db: pgwire.PgConnection,
    tablePattern: TablePattern
  ): Promise<storage.SourceTable[]> {
    const schema = tablePattern.schema;
    if (tablePattern.connectionTag != this.connections.connectionTag) {
      return [];
    }

    let tableRows: any[];
    const prefix = tablePattern.isWildcard ? tablePattern.tablePrefix : undefined;
    if (tablePattern.isWildcard) {
      const result = await db.query({
        statement: `SELECT c.oid AS relid, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      AND c.relkind = 'r'
      AND c.relname LIKE $2`,
        params: [
          { type: 'varchar', value: schema },
          { type: 'varchar', value: tablePattern.tablePattern }
        ]
      });
      tableRows = pgwire.pgwireRows(result);
    } else {
      const result = await db.query({
        statement: `SELECT c.oid AS relid, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      AND c.relkind = 'r'
      AND c.relname = $2`,
        params: [
          { type: 'varchar', value: schema },
          { type: 'varchar', value: tablePattern.tablePattern }
        ]
      });

      tableRows = pgwire.pgwireRows(result);
    }
    let result: storage.SourceTable[] = [];

    for (let row of tableRows) {
      const name = row.table_name as string;
      if (typeof row.relid != 'bigint') {
        throw new ReplicationAssertionError(`Missing relid for ${name}`);
      }
      const relid = Number(row.relid as bigint);

      if (prefix && !name.startsWith(prefix)) {
        continue;
      }

      const rs = await db.query({
        statement: `SELECT 1 FROM pg_publication_tables WHERE pubname = $1 AND schemaname = $2 AND tablename = $3`,
        params: [
          { type: 'varchar', value: PUBLICATION_NAME },
          { type: 'varchar', value: tablePattern.schema },
          { type: 'varchar', value: name }
        ]
      });
      if (rs.rows.length == 0) {
        logger.info(`Skipping ${tablePattern.schema}.${name} - not part of ${PUBLICATION_NAME} publication`);
        continue;
      }

      const cresult = await getReplicationIdentityColumns(db, relid);

      const table = await this.handleRelation(
        batch,
        {
          name,
          schema,
          objectId: relid,
          replicationColumns: cresult.replicationColumns
        } as SourceEntityDescriptor,
        false
      );

      result.push(table);
    }
    return result;
  }

  async initSlot(): Promise<InitResult> {
    await checkSourceConfiguration(this.connections.pool, PUBLICATION_NAME);
    await this.ensureStorageCompatibility();

    const slotName = this.slot_name;

    const status = await this.storage.getStatus();
    const snapshotDone = status.snapshot_done && status.checkpoint_lsn != null;
    if (snapshotDone) {
      // Snapshot is done, but we still need to check the replication slot status
      logger.info(`${slotName} Initial replication already done`);
    }

    // Check if replication slot exists
    const rs = await this.connections.pool.query({
      statement: 'SELECT 1 FROM pg_replication_slots WHERE slot_name = $1',
      params: [{ type: 'varchar', value: slotName }]
    });
    const slotExists = rs.rows.length > 0;

    if (slotExists) {
      // This checks that the slot is still valid
      const r = await this.checkReplicationSlot();
      if (snapshotDone && r.needsNewSlot) {
        // We keep the current snapshot, and create a new replication slot
        throw new MissingReplicationSlotError(`Replication slot ${slotName} is not valid anymore`);
      }
      // We can have:
      //   needsInitialSync: true, needsNewSlot: true -> initial sync from scratch
      //   needsInitialSync: true, needsNewSlot: false -> resume initial sync
      //   needsInitialSync: false, needsNewSlot: true -> handled above
      //   needsInitialSync: false, needsNewSlot: false -> resume streaming replication
      return {
        needsInitialSync: !snapshotDone,
        needsNewSlot: r.needsNewSlot
      };
    } else {
      if (snapshotDone) {
        // This will create a new slot, while keeping the current sync rules active
        throw new MissingReplicationSlotError(`Replication slot ${slotName} is missing`);
      }
      // This will clear data and re-create the same slot
      return { needsInitialSync: true, needsNewSlot: true };
    }
  }

  /**
   * If a replication slot exists, check that it is healthy.
   */
  private async checkReplicationSlot(): Promise<{ needsNewSlot: boolean }> {
    let last_error = null;
    const slotName = this.slot_name;

    // Check that replication slot exists
    for (let i = 120; i >= 0; i--) {
      await touch();

      if (i == 0) {
        container.reporter.captureException(last_error, {
          level: errors.ErrorSeverity.ERROR,
          metadata: {
            replication_slot: slotName
          }
        });

        throw last_error;
      }
      try {
        // We peek a large number of changes here, to make it more likely to pick up replication slot errors.
        // For example, "publication does not exist" only occurs here if the peek actually includes changes related
        // to the slot.
        logger.info(`Checking ${slotName}`);

        // The actual results can be quite large, so we don't actually return everything
        // due to memory and processing overhead that would create.
        const cursor = await this.connections.pool.stream({
          statement: `SELECT 1 FROM pg_catalog.pg_logical_slot_peek_binary_changes($1, NULL, 1000, 'proto_version', '1', 'publication_names', $2)`,
          params: [
            { type: 'varchar', value: slotName },
            { type: 'varchar', value: PUBLICATION_NAME }
          ]
        });

        for await (let _chunk of cursor) {
          // No-op, just exhaust the cursor
        }

        // Success
        logger.info(`Slot ${slotName} appears healthy`);
        return { needsNewSlot: false };
      } catch (e) {
        last_error = e;
        logger.warn(`${slotName} Replication slot error`, e);

        if (this.stopped) {
          throw e;
        }

        // Could also be `publication "powersync" does not exist`, although this error may show up much later
        // in some cases.

        if (
          /incorrect prev-link/.test(e.message) ||
          /replication slot.*does not exist/.test(e.message) ||
          /publication.*does not exist/.test(e.message)
        ) {
          container.reporter.captureException(e, {
            level: errors.ErrorSeverity.WARNING,
            metadata: {
              try_index: i,
              replication_slot: slotName
            }
          });
          // Sample: record with incorrect prev-link 10000/10000 at 0/18AB778
          //   Seen during development. Some internal error, fixed by re-creating slot.
          //
          // Sample: publication "powersync" does not exist
          //   Happens when publication deleted or never created.
          //   Slot must be re-created in this case.
          logger.info(`${slotName} is not valid anymore`);

          return { needsNewSlot: true };
        }
        // Try again after a pause
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    throw new ReplicationAssertionError('Unreachable');
  }

  async estimatedCount(db: pgwire.PgConnection, table: storage.SourceTable): Promise<string> {
    const results = await db.query({
      statement: `SELECT reltuples::bigint AS estimate
FROM   pg_class
WHERE  oid = $1::regclass`,
      params: [{ value: table.qualifiedName, type: 'varchar' }]
    });
    const row = results.rows[0];
    if ((row?.[0] ?? -1n) == -1n) {
      return '?';
    } else {
      return `~${row[0]}`;
    }
  }

  /**
   * Start initial replication.
   *
   * If (partial) replication was done before on this slot, this clears the state
   * and starts again from scratch.
   */
  async startInitialReplication(replicationConnection: pgwire.PgConnection, status: InitResult) {
    // If anything here errors, the entire replication process is aborted,
    // and all connections are closed, including this one.
    const db = await this.connections.snapshotConnection();

    const slotName = this.slot_name;

    if (status.needsNewSlot) {
      // This happens when there is no existing replication slot, or if the
      // existing one is unhealthy.
      // In those cases, we have to start replication from scratch.
      // If there is an existing healthy slot, we can skip this and continue
      // initial replication where we left off.
      await this.storage.clear();

      await db.query({
        statement: 'SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = $1',
        params: [{ type: 'varchar', value: slotName }]
      });

      // We use the replication connection here, not a pool.
      // The replication slot must be created before we start snapshotting tables.
      await replicationConnection.query(`CREATE_REPLICATION_SLOT ${slotName} LOGICAL pgoutput`);

      logger.info(`Created replication slot ${slotName}`);
    }

    await this.initialReplication(db);
  }

  async initialReplication(db: pgwire.PgConnection) {
    const sourceTables = this.sync_rules.getSourceTables();
    await this.storage.startBatch(
      { zeroLSN: ZERO_LSN, defaultSchema: POSTGRES_DEFAULT_SCHEMA, storeCurrentData: true, skipExistingRows: true },
      async (batch) => {
        for (let tablePattern of sourceTables) {
          const tables = await this.getQualifiedTableNames(batch, db, tablePattern);
          for (let table of tables) {
            if (table.snapshotComplete) {
              logger.info(`${this.slot_name} Skipping ${table.qualifiedName} - snapshot already done`);
              continue;
            }
            await this.snapshotTable(batch, db, table);

            const rs = await db.query(`select pg_current_wal_lsn() as lsn`);
            const tableLsnNotBefore = rs.rows[0][0];
            await batch.markSnapshotDone([table], tableLsnNotBefore);
            await touch();
          }
        }

        // Always commit the initial snapshot at zero.
        // This makes sure we don't skip any changes applied before starting this snapshot,
        // in the case of snapshot retries.
        // We could alternatively commit at the replication slot LSN.
        await batch.commit(ZERO_LSN);
      }
    );
    /**
     * Send a keepalive message after initial replication.
     * In some edge cases we wait for a keepalive after the initial snapshot.
     * If we don't explicitly check the contents of keepalive messages then a keepalive is detected
     * rather quickly after initial replication - perhaps due to other WAL events.
     * If we do explicitly check the contents of messages, we need an actual keepalive payload in order
     * to advance the active sync rules LSN.
     */
    await sendKeepAlive(db);
  }

  static *getQueryData(results: Iterable<DatabaseInputRow>): Generator<SqliteRow> {
    for (let row of results) {
      yield toSyncRulesRow(row);
    }
  }

  private async snapshotTable(batch: storage.BucketStorageBatch, db: pgwire.PgConnection, table: storage.SourceTable) {
    logger.info(`${this.slot_name} Replicating ${table.qualifiedName}`);
    const estimatedCount = await this.estimatedCount(db, table);
    let at = 0;
    let lastLogIndex = 0;
    const cursor = db.stream({ statement: `SELECT * FROM ${table.escapedIdentifier}` });
    let columns: { i: number; name: string }[] = [];
    // pgwire streams rows in chunks.
    // These chunks can be quite small (as little as 16KB), so we don't flush chunks automatically.

    for await (let chunk of cursor) {
      if (chunk.tag == 'RowDescription') {
        let i = 0;
        columns = chunk.payload.map((c) => {
          return { i: i++, name: c.name };
        });
        continue;
      }

      const rows = chunk.rows.map((row) => {
        let q: DatabaseInputRow = {};
        for (let c of columns) {
          q[c.name] = row[c.i];
        }
        return q;
      });
      if (rows.length > 0 && at - lastLogIndex >= 5000) {
        logger.info(`${this.slot_name} Replicating ${table.qualifiedName} ${at}/${estimatedCount}`);
        lastLogIndex = at;
      }
      if (this.abort_signal.aborted) {
        throw new ReplicationAbortedError(`Aborted initial replication of ${this.slot_name}`);
      }

      for (const record of WalStream.getQueryData(rows)) {
        // This auto-flushes when the batch reaches its size limit
        await batch.save({
          tag: storage.SaveOperationTag.INSERT,
          sourceTable: table,
          before: undefined,
          beforeReplicaId: undefined,
          after: record,
          afterReplicaId: getUuidReplicaIdentityBson(record, table.replicaIdColumns)
        });
      }

      at += rows.length;
      this.metrics.getCounter(ReplicationMetric.ROWS_REPLICATED).add(rows.length);

      await touch();
    }

    await batch.flush();
  }

  async handleRelation(batch: storage.BucketStorageBatch, descriptor: SourceEntityDescriptor, snapshot: boolean) {
    if (!descriptor.objectId && typeof descriptor.objectId != 'number') {
      throw new ReplicationAssertionError(`objectId expected, got ${typeof descriptor.objectId}`);
    }
    const result = await this.storage.resolveTable({
      group_id: this.group_id,
      connection_id: this.connection_id,
      connection_tag: this.connections.connectionTag,
      entity_descriptor: descriptor,
      sync_rules: this.sync_rules
    });
    this.relation_cache.set(descriptor.objectId, result.table);

    // Drop conflicting tables. This includes for example renamed tables.
    await batch.drop(result.dropTables);

    // Snapshot if:
    // 1. Snapshot is requested (false for initial snapshot, since that process handles it elsewhere)
    // 2. Snapshot is not already done, AND:
    // 3. The table is used in sync rules.
    const shouldSnapshot = snapshot && !result.table.snapshotComplete && result.table.syncAny;

    if (shouldSnapshot) {
      // Truncate this table, in case a previous snapshot was interrupted.
      await batch.truncate([result.table]);

      let lsn: string = ZERO_LSN;
      // Start the snapshot inside a transaction.
      // We use a dedicated connection for this.
      const db = await this.connections.snapshotConnection();
      try {
        await db.query('BEGIN');
        try {
          await this.snapshotTable(batch, db, result.table);

          // Get the current LSN.
          // The data will only be consistent once incremental replication
          // has passed that point.
          // We have to get this LSN _after_ we have started the snapshot query.
          const rs = await db.query(`select pg_current_wal_lsn() as lsn`);
          lsn = rs.rows[0][0];

          await db.query('COMMIT');
        } catch (e) {
          await db.query('ROLLBACK');
          // TODO: Wrap with custom error type
          throw e;
        }
      } finally {
        await db.end();
      }
      const [table] = await batch.markSnapshotDone([result.table], lsn);
      return table;
    }

    return result.table;
  }

  private getTable(relationId: number): storage.SourceTable {
    const table = this.relation_cache.get(relationId);
    if (table == null) {
      // We should always receive a replication message before the relation is used.
      // If we can't find it, it's a bug.
      throw new ReplicationAssertionError(`Missing relation cache for ${relationId}`);
    }
    return table;
  }

  async writeChange(
    batch: storage.BucketStorageBatch,
    msg: pgwire.PgoutputMessage
  ): Promise<storage.FlushedResult | null> {
    if (msg.lsn == null) {
      return null;
    }
    if (msg.tag == 'insert' || msg.tag == 'update' || msg.tag == 'delete') {
      const table = this.getTable(getRelId(msg.relation));
      if (!table.syncAny) {
        logger.debug(`Table ${table.qualifiedName} not used in sync rules - skipping`);
        return null;
      }

      if (msg.tag == 'insert') {
        this.metrics.getCounter(ReplicationMetric.ROWS_REPLICATED).add(1);
        const baseRecord = pg_utils.constructAfterRecord(msg);
        return await batch.save({
          tag: storage.SaveOperationTag.INSERT,
          sourceTable: table,
          before: undefined,
          beforeReplicaId: undefined,
          after: baseRecord,
          afterReplicaId: getUuidReplicaIdentityBson(baseRecord, table.replicaIdColumns)
        });
      } else if (msg.tag == 'update') {
        this.metrics.getCounter(ReplicationMetric.ROWS_REPLICATED).add(1);
        // "before" may be null if the replica id columns are unchanged
        // It's fine to treat that the same as an insert.
        const before = pg_utils.constructBeforeRecord(msg);
        const after = pg_utils.constructAfterRecord(msg);
        return await batch.save({
          tag: storage.SaveOperationTag.UPDATE,
          sourceTable: table,
          before: before,
          beforeReplicaId: before ? getUuidReplicaIdentityBson(before, table.replicaIdColumns) : undefined,
          after: after,
          afterReplicaId: getUuidReplicaIdentityBson(after, table.replicaIdColumns)
        });
      } else if (msg.tag == 'delete') {
        this.metrics.getCounter(ReplicationMetric.ROWS_REPLICATED).add(1);
        const before = pg_utils.constructBeforeRecord(msg)!;

        return await batch.save({
          tag: storage.SaveOperationTag.DELETE,
          sourceTable: table,
          before: before,
          beforeReplicaId: getUuidReplicaIdentityBson(before, table.replicaIdColumns),
          after: undefined,
          afterReplicaId: undefined
        });
      }
    } else if (msg.tag == 'truncate') {
      let tables: storage.SourceTable[] = [];
      for (let relation of msg.relations) {
        const table = this.getTable(getRelId(relation));
        tables.push(table);
      }
      return await batch.truncate(tables);
    }
    return null;
  }

  async replicate() {
    try {
      // If anything errors here, the entire replication process is halted, and
      // all connections automatically closed, including this one.
      const replicationConnection = await this.connections.replicationConnection();
      await this.initReplication(replicationConnection);
      await this.streamChanges(replicationConnection);
    } catch (e) {
      await this.storage.reportError(e);
      throw e;
    }
  }

  async initReplication(replicationConnection: pgwire.PgConnection) {
    const result = await this.initSlot();
    if (result.needsInitialSync) {
      await this.startInitialReplication(replicationConnection, result);
    }
  }

  async streamChanges(replicationConnection: pgwire.PgConnection) {
    // When changing any logic here, check /docs/wal-lsns.md.

    const { createEmptyCheckpoints } = await this.ensureStorageCompatibility();

    const replicationOptions: Record<string, string> = {
      proto_version: '1',
      publication_names: PUBLICATION_NAME
    };

    /**
     * Viewing the contents of logical messages emitted with `pg_logical_emit_message`
     * is only supported on Postgres >= 14.0.
     * https://www.postgresql.org/docs/14/protocol-logical-replication.html
     */
    const exposesLogicalMessages = await this.checkLogicalMessageSupport();
    if (exposesLogicalMessages) {
      /**
       * Only add this option if the Postgres server supports it.
       * Adding the option to a server that doesn't support it will throw an exception when starting logical replication.
       * Error: `unrecognized pgoutput option: messages`
       */
      replicationOptions['messages'] = 'true';
    }

    const replicationStream = replicationConnection.logicalReplication({
      slot: this.slot_name,
      options: replicationOptions
    });

    this.startedStreaming = true;

    // Auto-activate as soon as initial replication is done
    await this.storage.autoActivate();

    await this.storage.startBatch(
      { zeroLSN: ZERO_LSN, defaultSchema: POSTGRES_DEFAULT_SCHEMA, storeCurrentData: true, skipExistingRows: false },
      async (batch) => {
        // We don't handle any plain keepalive messages while we have transactions.
        // While we have transactions, we use that to advance the position.
        // Replication never starts in the middle of a transaction, so this starts as false.
        let skipKeepalive = false;
        let count = 0;

        for await (const chunk of replicationStream.pgoutputDecode()) {
          await touch();

          if (this.abort_signal.aborted) {
            break;
          }

          // chunkLastLsn may come from normal messages in the chunk,
          // or from a PrimaryKeepalive message.
          const { messages, lastLsn: chunkLastLsn } = chunk;

          /**
           * We can check if an explicit keepalive was sent if `exposesLogicalMessages == true`.
           * If we can't check the logical messages, we should assume a keepalive if we
           * receive an empty array of messages in a replication event.
           */
          const assumeKeepAlive = !exposesLogicalMessages;
          let keepAliveDetected = false;
          const lastCommit = messages.findLast((msg) => msg.tag == 'commit');

          for (const msg of messages) {
            if (msg.tag == 'relation') {
              await this.handleRelation(batch, getPgOutputRelation(msg), true);
            } else if (msg.tag == 'begin') {
              // This may span multiple transactions in the same chunk, or even across chunks.
              skipKeepalive = true;
              if (this.oldestUncommittedChange == null) {
                this.oldestUncommittedChange = new Date(Number(msg.commitTime / 1000n));
              }
            } else if (msg.tag == 'commit') {
              this.metrics.getCounter(ReplicationMetric.TRANSACTIONS_REPLICATED).add(1);
              if (msg == lastCommit) {
                // Only commit if this is the last commit in the chunk.
                // This effectively lets us batch multiple transactions within the same chunk
                // into a single flush, increasing throughput for many small transactions.
                skipKeepalive = false;
                const didCommit = await batch.commit(msg.lsn!, {
                  createEmptyCheckpoints,
                  oldestUncommittedChange: this.oldestUncommittedChange
                });
                await this.ack(msg.lsn!, replicationStream);
                if (didCommit) {
                  this.oldestUncommittedChange = null;
                  this.isStartingReplication = false;
                }
              }
            } else {
              if (count % 100 == 0) {
                logger.info(`${this.slot_name} replicating op ${count} ${msg.lsn}`);
              }

              /**
               * If we can see the contents of logical messages, then we can check if a keepalive
               * message is present. We only perform a keepalive (below) if we explicitly detect a keepalive message.
               * If we can't see the contents of logical messages, then we should assume a keepalive is required
               * due to the default value of `assumeKeepalive`.
               */
              if (exposesLogicalMessages && isKeepAliveMessage(msg)) {
                keepAliveDetected = true;
              }

              count += 1;
              await this.writeChange(batch, msg);
            }
          }

          if (!skipKeepalive) {
            if (assumeKeepAlive || keepAliveDetected) {
              // Reset the detection flag.
              keepAliveDetected = false;

              // In a transaction, we ack and commit according to the transaction progress.
              // Outside transactions, we use the PrimaryKeepalive messages to advance progress.
              // Big caveat: This _must not_ be used to skip individual messages, since this LSN
              // may be in the middle of the next transaction.
              // It must only be used to associate checkpoints with LSNs.
              await batch.keepalive(chunkLastLsn);
              this.isStartingReplication = false;
            }

            // We receive chunks with empty messages often (about each second).
            // Acknowledging here progresses the slot past these and frees up resources.
            await this.ack(chunkLastLsn, replicationStream);
          }

          this.metrics.getCounter(ReplicationMetric.CHUNKS_REPLICATED).add(1);
        }
      }
    );
  }

  async ack(lsn: string, replicationStream: pgwire.ReplicationStream) {
    if (lsn == ZERO_LSN) {
      return;
    }

    replicationStream.ack(lsn);
  }

  /**
   * Ensures that the storage is compatible with the replication connection.
   * @throws {DatabaseConnectionError} If the storage is not compatible with the replication connection.
   */
  protected async ensureStorageCompatibility(): Promise<storage.ResolvedBucketBatchCommitOptions> {
    const supportsLogicalMessages = await this.checkLogicalMessageSupport();

    const storageIdentifier = await this.storage.factory.getSystemIdentifier();
    if (storageIdentifier.type != lib_postgres.POSTGRES_CONNECTION_TYPE) {
      return {
        // Keep the same behaviour as before allowing Postgres storage.
        createEmptyCheckpoints: true,
        oldestUncommittedChange: null
      };
    }

    const parsedStorageIdentifier = lib_postgres.utils.decodePostgresSystemIdentifier(storageIdentifier.id);
    /**
     * Check if the same server is being used for both the sync bucket storage and the logical replication.
     */
    const replicationIdentifier = await lib_postgres.utils.queryPostgresSystemIdentifier(this.connections.pool);

    if (!supportsLogicalMessages && replicationIdentifier.server_id == parsedStorageIdentifier.server_id) {
      throw new DatabaseConnectionError(
        ErrorCode.PSYNC_S1144,
        `Separate Postgres servers are required for the replication source and sync bucket storage when using Postgres versions below 14.0.`,
        new Error('Postgres version is below 14')
      );
    }

    return {
      /**
       * Don't create empty checkpoints if the same Postgres database is used for the data source
       * and sync bucket storage. Creating empty checkpoints will cause WAL feedback loops.
       */
      createEmptyCheckpoints: replicationIdentifier.database_name != parsedStorageIdentifier.database_name,
      oldestUncommittedChange: null
    };
  }

  /**
   * Check if the replication connection Postgres server supports
   * viewing the contents of logical replication messages.
   */
  protected async checkLogicalMessageSupport() {
    const version = await this.connections.getServerVersion();
    return version ? version.compareMain('14.0.0') >= 0 : false;
  }

  async getReplicationLagMillis(): Promise<number | undefined> {
    if (this.oldestUncommittedChange == null) {
      if (this.isStartingReplication) {
        // We don't have anything to compute replication lag with yet.
        return undefined;
      } else {
        // We don't have any uncommitted changes, so replication is up-to-date.
        return 0;
      }
    }
    return Date.now() - this.oldestUncommittedChange.getTime();
  }
}

async function touch() {
  // FIXME: The hosted Kubernetes probe does not actually check the timestamp on this.
  // FIXME: We need a timeout of around 5+ minutes in Kubernetes if we do start checking the timestamp,
  // or reduce PING_INTERVAL here.
  return container.probes.touch();
}
