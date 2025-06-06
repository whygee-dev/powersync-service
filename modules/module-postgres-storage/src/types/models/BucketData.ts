import * as t from 'ts-codec';
import { bigint, hexBuffer, pgwire_number } from '../codecs.js';

export enum OpType {
  PUT = 'PUT',
  REMOVE = 'REMOVE',
  MOVE = 'MOVE',
  CLEAR = 'CLEAR'
}

export const BucketData = t.object({
  group_id: pgwire_number,
  bucket_name: t.string,
  op_id: bigint,
  op: t.Enum(OpType),
  source_table: t.Null.or(t.string),
  source_key: t.Null.or(hexBuffer),
  table_name: t.string.or(t.Null),
  row_id: t.string.or(t.Null),
  checksum: bigint,
  data: t.Null.or(t.string),
  target_op: t.Null.or(bigint)
});

export type BucketData = t.Encoded<typeof BucketData>;
export type BucketDataDecoded = t.Decoded<typeof BucketData>;
